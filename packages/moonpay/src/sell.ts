import { z } from "zod";
import type { MoonPayConfig } from "./config.js";
import type { MoonPayHttpClient } from "./http-client.js";
import { baseUnitsToDecimalString, jsonNumberToMinorUnits } from "./money.js";
import { signWidgetUrl } from "./signing.js";

/**
 * Off-ramp (treasury) side of the MoonPay integration: sell USDC from the
 * settlement wallet for fiat paid out to Advertek's bank. This is an
 * operator-driven alternative to the OKX sweep — MoonPay Sell is a widget
 * flow (KYC'd account, bank details, deposit address per transaction), not
 * a headless API, so the worker's role is to (1) mint the signed widget URL,
 * (2) look up the resulting transaction's deposit address by our external
 * id, and (3) fund it from the settlement keypair. Step 3 is the only
 * key-bearing action and belongs in `apps/treasury-worker`, never the web app.
 *
 * Note: MoonPay's documented sell payout currencies do not include CAD; USD
 * is the closest payout for a Canadian entity (multi-currency account or a
 * subsequent bank FX step is required).
 */
export const sellCheckoutInputSchema = z.object({
  /** Our identifier for this off-ramp (e.g. the sweep id). */
  externalTransactionId: z.string().min(1),
  amountBaseUnits: z.bigint().positive(),
  /** Lowercase ISO-4217 payout currency, e.g. `usd`. */
  fiatCurrencyCode: z.string().length(3),
  payoutMethod: z.string().min(1).optional(),
  operatorEmail: z.string().email().optional(),
  redirectUrl: z.string().url().optional(),
});

export type SellCheckoutInput = z.infer<typeof sellCheckoutInputSchema>;

export interface MoonPaySellCheckout {
  readonly externalTransactionId: string;
  readonly amountBaseUnits: bigint;
  readonly currencyCode: string;
  readonly fiatCurrencyCode: string;
  readonly refundWallet: string;
  readonly url: string;
}

export interface CreateSellCheckoutDeps {
  readonly config: MoonPayConfig;
}

export function createMoonPaySellCheckout(
  deps: CreateSellCheckoutDeps,
  rawInput: SellCheckoutInput,
): MoonPaySellCheckout {
  const input = sellCheckoutInputSchema.parse(rawInput);
  const { config } = deps;
  const fiatCurrencyCode = input.fiatCurrencyCode.toLowerCase();

  const params = new URLSearchParams();
  params.set("apiKey", config.publishableKey);
  params.set("baseCurrencyCode", config.usdcCurrencyCode);
  params.set("baseCurrencyAmount", baseUnitsToDecimalString(input.amountBaseUnits, config.usdcDecimals));
  params.set("lockAmount", "true");
  params.set("quoteCurrencyCode", fiatCurrencyCode);
  params.set("refundWalletAddress", config.settlementWallet);
  params.set("externalTransactionId", input.externalTransactionId);
  if (input.payoutMethod) {
    params.set("paymentMethod", input.payoutMethod);
  }
  if (input.operatorEmail) {
    params.set("email", input.operatorEmail);
  }
  if (input.redirectUrl) {
    params.set("redirectURL", input.redirectUrl);
  }

  const unsigned = `${config.sellWidgetBaseUrl}?${params.toString()}`;
  return {
    externalTransactionId: input.externalTransactionId,
    amountBaseUnits: input.amountBaseUnits,
    currencyCode: config.usdcCurrencyCode,
    fiatCurrencyCode,
    refundWallet: config.settlementWallet,
    url: signWidgetUrl(unsigned, config.secretKey),
  };
}

export const moonPaySellStatusSchema = z.enum([
  "waitingForDeposit",
  "pending",
  "failed",
  "completed",
  "requoteRequired",
]);

export type MoonPaySellStatus = z.infer<typeof moonPaySellStatusSchema>;

export const moonPaySellTransactionSchema = z.object({
  id: z.string().min(1),
  status: moonPaySellStatusSchema,
  baseCurrencyAmount: z.number().nonnegative(),
  quoteCurrencyAmount: z.number().nonnegative().nullable().optional(),
  depositWalletAddress: z.string().nullable().optional(),
  depositWalletAddressTag: z.string().nullable().optional(),
  depositHash: z.string().nullable().optional(),
  externalTransactionId: z.string().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  updatedAt: z.string().min(1),
  baseCurrency: z.object({ code: z.string() }).optional(),
  quoteCurrency: z.object({ code: z.string() }).optional(),
});

export type MoonPaySellTransactionRaw = z.infer<typeof moonPaySellTransactionSchema>;

export interface MoonPaySellTransaction {
  readonly id: string;
  readonly status: MoonPaySellStatus;
  readonly externalTransactionId: string | undefined;
  readonly cryptoAmountBaseUnits: bigint;
  readonly fiatPayoutMinorUnits: bigint | undefined;
  /** Where to send the USDC once the transaction is `waitingForDeposit`. */
  readonly depositWalletAddress: string | undefined;
  readonly depositHash: string | undefined;
  readonly failureReason: string | undefined;
  readonly updatedAt: Date;
}

export function normalizeSellTransaction(
  raw: MoonPaySellTransactionRaw,
  usdcDecimals: number,
): MoonPaySellTransaction {
  return {
    id: raw.id,
    status: raw.status,
    externalTransactionId: raw.externalTransactionId ?? undefined,
    cryptoAmountBaseUnits: jsonNumberToMinorUnits(raw.baseCurrencyAmount, usdcDecimals),
    fiatPayoutMinorUnits:
      raw.quoteCurrencyAmount == null ? undefined : jsonNumberToMinorUnits(raw.quoteCurrencyAmount, 2),
    depositWalletAddress: raw.depositWalletAddress ?? undefined,
    depositHash: raw.depositHash ?? undefined,
    failureReason: raw.failureReason ?? undefined,
    updatedAt: new Date(raw.updatedAt),
  };
}

export interface SellLookupDeps {
  readonly config: Pick<MoonPayConfig, "usdcDecimals">;
  readonly client: MoonPayHttpClient;
}

/**
 * MoonPay cannot guarantee `externalTransactionId` uniqueness, so this
 * returns every match; callers pick the newest non-failed one.
 * https://dev.moonpay.com/api-reference/widget/getselltransactionbyexternalid
 */
export async function getMoonPaySellTransactionsByExternalId(
  deps: SellLookupDeps,
  externalTransactionId: string,
): Promise<readonly MoonPaySellTransaction[]> {
  const raw = await deps.client.request({
    method: "GET",
    path: `/v3/sell_transactions/ext/${encodeURIComponent(externalTransactionId)}`,
    auth: "secret",
  });
  return z
    .array(moonPaySellTransactionSchema)
    .parse(raw)
    .map((tx) => normalizeSellTransaction(tx, deps.config.usdcDecimals));
}
