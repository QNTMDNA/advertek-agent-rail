import {
  baseUnitsToDecimalString,
  decimalStringToMinorUnits,
  multiplyDecimalStrings,
} from "./money.js";
import {
  estimateOkxConvertQuote,
  executeOkxConvertTrade,
  type OkxHttpClient,
} from "./okx-client.js";
import {
  listInboundUsdcTransfers,
  type TreasurySolanaRpcClient,
} from "./inbound-transfers.js";
import type { SweepLedger, SweepRecord } from "./sweep-ledger.js";

export interface DepositFn {
  (input: { amountBaseUnits: bigint; okxDepositAddress: string }): Promise<{
    signature: string;
  }>;
}

/**
 * Resolves an order id for an inbound transfer that carries no memo. Used
 * for rails where a third party (e.g. MoonPay) delivers the USDC on the
 * buyer's behalf and we learned the on-chain signature from their webhook
 * instead of from a memo we asked the payer to attach.
 */
export interface OrderIdBySignatureLookup {
  findOrderIdByPaymentSignature(signature: string): Promise<string | undefined>;
}

export interface RunSweepDeps {
  readonly connection: TreasurySolanaRpcClient;
  readonly settlementWallet: string;
  readonly usdcMintAddress: string;
  readonly usdcDecimals: number;
  /** Must be built from read/trade-permission credentials only. */
  readonly tradingOkxClient: OkxHttpClient;
  readonly ledger: SweepLedger;
  readonly depositToOkx: DepositFn;
  readonly getOkxUsdcDepositAddress: () => Promise<string>;
  readonly minSweepAmountBaseUnits: bigint;
  readonly orderIdBySignature?: OrderIdBySignatureLookup;
  readonly now?: () => Date;
  readonly createSweepId?: () => string;
}

export interface RunSweepResult {
  readonly swept: boolean;
  readonly sweep?: SweepRecord;
  readonly reason?: string;
}

const FIAT_CURRENCY = "CAD";
const CAD_MINOR_UNIT_DECIMALS = 2;

/**
 * (1) Reads what's accumulated in the settlement wallet since the last
 * sweep, (2) if it clears the configured threshold, moves it on-chain into
 * OKX and converts USDC -> CAD via the trading-permission client, and
 * (3) records the sweep. Never touches withdrawal-permission credentials —
 * getting fiat out of OKX to a bank remains a separate, deliberate action.
 */
export async function runUsdcToCadSweep(deps: RunSweepDeps): Promise<RunSweepResult> {
  const previousSweep = await deps.ledger.getMostRecent();

  const { transfers, newestSignatureScanned } = await listInboundUsdcTransfers(
    {
      connection: deps.connection,
      settlementWallet: deps.settlementWallet,
      usdcMintAddress: deps.usdcMintAddress,
    },
    previousSweep ? { untilSignature: previousSweep.newestCoveredSignature } : {},
  );

  const coveredTransfers: { signature: string; orderId: string; amountBaseUnits: bigint }[] = [];
  for (const transfer of transfers) {
    const orderId =
      transfer.orderId ??
      (await deps.orderIdBySignature?.findOrderIdByPaymentSignature(transfer.signature));
    if (orderId === undefined) {
      continue;
    }
    coveredTransfers.push({
      signature: transfer.signature,
      orderId,
      amountBaseUnits: transfer.amountBaseUnits,
    });
  }

  const coveredAmountBaseUnits = coveredTransfers.reduce(
    (sum, transfer) => sum + transfer.amountBaseUnits,
    0n,
  );

  if (coveredTransfers.length === 0 || coveredAmountBaseUnits < deps.minSweepAmountBaseUnits) {
    return {
      swept: false,
      reason:
        coveredTransfers.length === 0
          ? "no new order-matched inbound USDC transfers since the last sweep"
          : "accumulated USDC is below the configured sweep threshold",
    };
  }

  const now = deps.now ?? (() => new Date());
  const sweepId = (deps.createSweepId ?? defaultSweepId)();

  const okxDepositAddress = await deps.getOkxUsdcDepositAddress();
  const deposit = await deps.depositToOkx({
    amountBaseUnits: coveredAmountBaseUnits,
    okxDepositAddress,
  });

  const rfqSz = baseUnitsToDecimalString(coveredAmountBaseUnits, deps.usdcDecimals);
  const quote = await estimateOkxConvertQuote(deps.tradingOkxClient, {
    baseCcy: "USDC",
    quoteCcy: FIAT_CURRENCY,
    rfqSz,
    rfqSzCcy: "USDC",
    clQReqId: sweepId,
  });
  const trade = await executeOkxConvertTrade(deps.tradingOkxClient, {
    quoteId: quote.quoteId,
    baseCcy: "USDC",
    quoteCcy: FIAT_CURRENCY,
    sz: rfqSz,
    szCcy: "USDC",
    clTReqId: sweepId,
  });

  // cnvtPx is quote-currency (CAD) per 1 unit of base currency (USDC), per
  // OKX Convert's estimate-quote contract; verify against a live sandbox
  // call before relying on this for real fiat reconciliation.
  const estimatedFiatAmountMinorUnits = decimalStringToMinorUnits(
    multiplyDecimalStrings(rfqSz, quote.cnvtPx),
    CAD_MINOR_UNIT_DECIMALS,
  );
  const actualFiatAmountMinorUnits = decimalStringToMinorUnits(
    trade.fillQuoteSz,
    CAD_MINOR_UNIT_DECIMALS,
  );

  const newestCoveredSignature = newestSignatureScanned ?? coveredTransfers[0]?.signature;
  if (!newestCoveredSignature) {
    throw new Error("Expected at least one scanned signature when a sweep has covered transfers");
  }

  const sweep: SweepRecord = {
    sweepId,
    initiatedAt: now().toISOString(),
    coveredTransfers,
    coveredAmountBaseUnits,
    newestCoveredSignature,
    depositTransactionSignature: deposit.signature,
    okxQuoteId: quote.quoteId,
    okxTradeId: trade.tradeId,
    estimatedFiatAmountMinorUnits,
    actualFiatAmountMinorUnits,
    fiatCurrency: FIAT_CURRENCY,
  };

  await deps.ledger.record(sweep);
  return { swept: true, sweep };
}

function defaultSweepId(): string {
  return `sweep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
