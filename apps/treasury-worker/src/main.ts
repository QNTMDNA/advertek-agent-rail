#!/usr/bin/env node
import {
  applyMigrations,
  createPostgresExecutor,
  createPostgresOrderStore,
  createPostgresSweepLedger,
  loadDbConfig,
  loadPackageMigrations,
} from "@advertek/db";
import {
  createDefaultSendAndConfirm,
  createDefaultTreasurySolanaRpcClient,
  createOkxHttpClient,
  createSweepScheduler,
  depositUsdcToOkx,
  getOkxDepositAddress,
  loadOkxTradingCredentials,
  loadOnChainConfig,
  loadSettlementSignerConfig,
  loadSweepScheduleConfig,
  runUsdcToCadSweep,
  type RunSweepDeps,
} from "@advertek/treasury";
import { Connection } from "@solana/web3.js";

/**
 * Always-on treasury worker: runs the USDC -> OKX -> CAD sweep on the
 * configured interval against the Postgres sweep ledger.
 *
 * Security invariant: this process is the ONLY automated holder of
 * money-moving secrets — the settlement wallet's secret key (on-chain
 * deposit leg) and the OKX *trading* credentials (Convert USDC -> CAD).
 * OKX withdrawal credentials (`OKX_WITHDRAWAL_API_*`) must never be present
 * in this process's environment; moving fiat out of OKX stays a separate,
 * deliberate action. The Vercel web app holds no signing keys at all.
 *
 * Usage: `node dist/main.js` (schedule loop) or `node dist/main.js --once`
 * (single sweep, for manual/ops runs).
 */
async function main(): Promise<void> {
  const onChain = loadOnChainConfig();
  const signer = loadSettlementSignerConfig();
  const okxCredentials = loadOkxTradingCredentials();
  const schedule = loadSweepScheduleConfig();

  const executor = createPostgresExecutor(loadDbConfig());
  await applyMigrations(executor, loadPackageMigrations());
  const ledger = createPostgresSweepLedger(executor);
  const orderStore = createPostgresOrderStore(executor);

  const connection = new Connection(onChain.quicknodeRpcUrl, "confirmed");
  const tradingOkxClient = createOkxHttpClient(okxCredentials);

  const sweepDeps: RunSweepDeps = {
    connection: createDefaultTreasurySolanaRpcClient(onChain.quicknodeRpcUrl),
    settlementWallet: onChain.settlementWallet,
    usdcMintAddress: onChain.usdcMintAddress,
    usdcDecimals: onChain.usdcDecimals,
    tradingOkxClient,
    ledger,
    minSweepAmountBaseUnits: schedule.minSweepAmountBaseUnits,
    orderIdBySignature: orderStore,
    depositToOkx: ({ amountBaseUnits, okxDepositAddress }) =>
      depositUsdcToOkx(
        { sendAndConfirm: createDefaultSendAndConfirm(connection) },
        {
          settlementSecretKey: signer.secretKey,
          usdcMintAddress: onChain.usdcMintAddress,
          usdcDecimals: onChain.usdcDecimals,
          amountBaseUnits,
          okxDepositAddress,
        },
      ),
    getOkxUsdcDepositAddress: async () => {
      const addresses = await getOkxDepositAddress(tradingOkxClient, "USDC");
      const solanaAddress = addresses.find((address) =>
        address.chain.toLowerCase().includes("solana"),
      );
      if (!solanaAddress) {
        throw new Error("OKX returned no Solana USDC deposit address");
      }
      return solanaAddress.addr;
    },
  };

  const scheduler = createSweepScheduler({
    runSweep: () => runUsdcToCadSweep(sweepDeps),
    intervalMs: schedule.intervalMs,
    onResult: (result) => {
      console.log(
        result.swept
          ? `sweep ${result.sweep?.sweepId ?? "?"} recorded`
          : `sweep skipped: ${result.reason ?? "unknown reason"}`,
      );
    },
    onError: (error) => {
      console.error("sweep failed", error);
    },
  });

  if (process.argv.includes("--once")) {
    await scheduler.runOnce();
    await executor.close();
    return;
  }

  scheduler.start();
  console.log(`treasury worker started; sweep interval ${String(schedule.intervalMs)}ms`);

  const shutdown = (): void => {
    scheduler.stop();
    executor
      .close()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("error during shutdown", error);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
