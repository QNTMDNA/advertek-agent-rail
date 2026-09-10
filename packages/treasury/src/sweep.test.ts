import { MEMO_PROGRAM_ID, buildPaymentMemo } from "@advertek/payments";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type { TreasurySolanaRpcClient } from "./inbound-transfers.js";
import type { OkxHttpClient, OkxRequestInput } from "./okx-client.js";
import { createInMemorySweepLedger } from "./sweep-ledger.js";
import { runUsdcToCadSweep, type RunSweepDeps } from "./sweep.js";

const settlement = Keypair.generate();
const mint = Keypair.generate();
const settlementWallet = settlement.publicKey.toBase58();
const usdcMintAddress = mint.publicKey.toBase58();
const settlementAta = getAssociatedTokenAddressSync(mint.publicKey, settlement.publicKey).toBase58();

function transferTx(
  amountBaseUnits: bigint,
  memo: string | undefined,
  slot: number,
): ParsedTransactionWithMeta {
  return {
    slot,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: [],
        recentBlockhash: "hash",
        instructions: [
          {
            program: "spl-token",
            programId: PublicKey.default,
            parsed: {
              type: "transferChecked",
              info: {
                destination: settlementAta,
                mint: usdcMintAddress,
                tokenAmount: { amount: amountBaseUnits.toString() },
              },
            },
          },
          ...(memo === undefined
            ? []
            : [{ program: "spl-memo", programId: MEMO_PROGRAM_ID, parsed: memo }]),
        ],
      },
    },
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], logMessages: [] },
  };
}

const memoA = buildPaymentMemo("ord_a", "n1");
const memoB = buildPaymentMemo("ord_b", "n2");

function createRpcClient(): {
  connection: TreasurySolanaRpcClient;
  getSignaturesForAddress: ReturnType<typeof vi.fn>;
} {
  const getSignaturesForAddress = vi.fn(() =>
    Promise.resolve([
      { signature: "sig_b", slot: 2, err: null } as never,
      { signature: "sig_a", slot: 1, err: null } as never,
    ]),
  );
  const getParsedTransaction = vi.fn((signature: string) => {
    if (signature === "sig_a") {
      return Promise.resolve(transferTx(60_000_000n, memoA, 1));
    }
    if (signature === "sig_b") {
      return Promise.resolve(transferTx(40_000_000n, memoB, 2));
    }
    return Promise.resolve(null);
  });
  return { connection: { getSignaturesForAddress, getParsedTransaction }, getSignaturesForAddress };
}

function createOkxClientStub(overrides: {
  cnvtPx?: string;
  fillQuoteSz?: string;
} = {}): { client: OkxHttpClient; request: ReturnType<typeof vi.fn> } {
  const cnvtPx = overrides.cnvtPx ?? "1.35";
  const fillQuoteSz = overrides.fillQuoteSz ?? "134.80";
  const request = vi.fn((input: OkxRequestInput) => {
    if (input.path === "/api/v5/asset/convert/estimate-quote") {
      return Promise.resolve([
        {
          quoteId: "q1",
          baseCcy: "USDC",
          quoteCcy: "CAD",
          cnvtPx,
          rfqSz: "100",
          rfqSzCcy: "USDC",
          ttlMs: "10000",
        },
      ]);
    }
    if (input.path === "/api/v5/asset/convert/trade") {
      return Promise.resolve([
        {
          quoteId: "q1",
          tradeId: "t1",
          baseCcy: "USDC",
          quoteCcy: "CAD",
          fillBaseSz: "100",
          fillQuoteSz,
          state: "filled",
          ts: "1700000000000",
        },
      ]);
    }
    throw new Error(`Unexpected OKX path in test stub: ${input.path}`);
  });
  return { client: { request }, request };
}

function baseDeps(overrides: {
  connection?: TreasurySolanaRpcClient;
  tradingOkxClient?: OkxHttpClient;
  minSweepAmountBaseUnits?: bigint;
} = {}): RunSweepDeps {
  return {
    connection: overrides.connection ?? createRpcClient().connection,
    settlementWallet,
    usdcMintAddress,
    usdcDecimals: 6,
    tradingOkxClient: overrides.tradingOkxClient ?? createOkxClientStub().client,
    ledger: createInMemorySweepLedger(),
    depositToOkx: vi.fn(() => Promise.resolve({ signature: "deposit_sig_1" })),
    getOkxUsdcDepositAddress: vi.fn(() => Promise.resolve("OkxDepositWalletAddr")),
    minSweepAmountBaseUnits: overrides.minSweepAmountBaseUnits ?? 0n,
    now: () => new Date("2024-06-15T12:00:00.000Z"),
    createSweepId: () => "sweep_test_1",
  };
}

describe("runUsdcToCadSweep", () => {
  it("sweeps all new memo-tagged inbound transfers, deposits to OKX, converts, and records the sweep", async () => {
    const deps = baseDeps();

    const result = await runUsdcToCadSweep(deps);

    expect(result.swept).toBe(true);
    expect(result.sweep).toEqual({
      sweepId: "sweep_test_1",
      initiatedAt: "2024-06-15T12:00:00.000Z",
      coveredTransfers: [
        { signature: "sig_b", orderId: "ord_b", amountBaseUnits: 40_000_000n },
        { signature: "sig_a", orderId: "ord_a", amountBaseUnits: 60_000_000n },
      ],
      coveredAmountBaseUnits: 100_000_000n,
      newestCoveredSignature: "sig_b",
      depositTransactionSignature: "deposit_sig_1",
      okxQuoteId: "q1",
      okxTradeId: "t1",
      estimatedFiatAmountMinorUnits: 13_500n,
      actualFiatAmountMinorUnits: 13_480n,
      fiatCurrency: "CAD",
    });

    expect(deps.depositToOkx).toHaveBeenCalledWith({
      amountBaseUnits: 100_000_000n,
      okxDepositAddress: "OkxDepositWalletAddr",
    });

    const recorded = await deps.ledger.getMostRecent();
    expect(recorded?.sweepId).toBe("sweep_test_1");
  });

  it("attributes memo-less transfers (e.g. MoonPay deliveries) via the signature lookup and skips unknown ones", async () => {
    const getSignaturesForAddress = vi.fn(() =>
      Promise.resolve([
        { signature: "sig_unknown", slot: 3, err: null } as never,
        { signature: "sig_moonpay", slot: 2, err: null } as never,
        { signature: "sig_a", slot: 1, err: null } as never,
      ]),
    );
    const getParsedTransaction = vi.fn((signature: string) => {
      if (signature === "sig_a") {
        return Promise.resolve(transferTx(60_000_000n, memoA, 1));
      }
      if (signature === "sig_moonpay") {
        return Promise.resolve(transferTx(12_500_000n, undefined, 2));
      }
      if (signature === "sig_unknown") {
        return Promise.resolve(transferTx(1_000_000n, undefined, 3));
      }
      return Promise.resolve(null);
    });
    const findOrderIdByPaymentSignature = vi.fn((signature: string) =>
      Promise.resolve(signature === "sig_moonpay" ? "ord_moonpay" : undefined),
    );
    const deps: RunSweepDeps = {
      ...baseDeps({ connection: { getSignaturesForAddress, getParsedTransaction } }),
      orderIdBySignature: { findOrderIdByPaymentSignature },
    };

    const result = await runUsdcToCadSweep(deps);

    expect(result.swept).toBe(true);
    expect(result.sweep?.coveredTransfers).toEqual([
      { signature: "sig_moonpay", orderId: "ord_moonpay", amountBaseUnits: 12_500_000n },
      { signature: "sig_a", orderId: "ord_a", amountBaseUnits: 60_000_000n },
    ]);
    expect(result.sweep?.coveredAmountBaseUnits).toBe(72_500_000n);
    expect(findOrderIdByPaymentSignature).toHaveBeenCalledWith("sig_moonpay");
    expect(findOrderIdByPaymentSignature).toHaveBeenCalledWith("sig_unknown");
    expect(findOrderIdByPaymentSignature).not.toHaveBeenCalledWith("sig_a");
  });

  it("does not sweep, deposit, or call OKX when there are no new memo-tagged transfers", async () => {
    const getSignaturesForAddress = vi.fn(() => Promise.resolve([]));
    const connection: TreasurySolanaRpcClient = {
      getSignaturesForAddress,
      getParsedTransaction: vi.fn(),
    };
    const { client: tradingOkxClient, request } = createOkxClientStub();
    const deps = baseDeps({ connection, tradingOkxClient });

    const result = await runUsdcToCadSweep(deps);

    expect(result.swept).toBe(false);
    expect(result.reason).toMatch(/no new/);
    expect(deps.depositToOkx).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not sweep when accumulated USDC is below the configured threshold", async () => {
    const deps = baseDeps({ minSweepAmountBaseUnits: 1_000_000_000n });

    const result = await runUsdcToCadSweep(deps);

    expect(result.swept).toBe(false);
    expect(result.reason).toMatch(/threshold/);
    expect(deps.depositToOkx).not.toHaveBeenCalled();
  });

  it("uses the previous sweep's newestCoveredSignature as the incremental scan cursor", async () => {
    const { connection, getSignaturesForAddress } = createRpcClient();
    const deps = baseDeps({ connection });
    await deps.ledger.record({
      sweepId: "previous",
      initiatedAt: "2024-06-01T00:00:00.000Z",
      coveredTransfers: [],
      coveredAmountBaseUnits: 0n,
      newestCoveredSignature: "sig_from_previous_sweep",
      depositTransactionSignature: "prev_deposit",
      okxQuoteId: "prev_q",
      okxTradeId: "prev_t",
      estimatedFiatAmountMinorUnits: 0n,
      actualFiatAmountMinorUnits: 0n,
      fiatCurrency: "CAD",
    });

    await runUsdcToCadSweep(deps);

    expect(getSignaturesForAddress).toHaveBeenCalledWith(
      expect.any(PublicKey),
      { limit: 1000, until: "sig_from_previous_sweep" },
      "confirmed",
    );
  });

  it("never touches withdrawal-permission functionality — only the trading client and deposit fn are called", async () => {
    const { client: tradingOkxClient, request } = createOkxClientStub();
    const deps = baseDeps({ tradingOkxClient });
    await runUsdcToCadSweep(deps);

    // The RunSweepDeps type itself has no withdrawal-credential field, so this
    // is enforced at compile time too; this assertion documents the runtime
    // behavior for the tradingOkxClient specifically.
    const calledPaths = request.mock.calls.map((call) => (call[0] as OkxRequestInput).path);
    expect(calledPaths).not.toContain("/api/v5/asset/withdrawal");
  });
});
