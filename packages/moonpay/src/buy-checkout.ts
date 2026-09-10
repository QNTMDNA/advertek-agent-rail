import { randomUUID } from "node:crypto";
import { buildPaymentMemo } from "@advertek/payments";
import { z } from "zod";
import type { MoonPayConfig } from "./config.js";
import { baseUnitsToDecimalString } from "./money.js";
import { hashAllowedIpAddress, signWidgetUrl } from "./signing.js";

/**
 * Fiat on-ramp for an order: a signed MoonPay Buy widget URL that has the
 * customer pay in fiat (card, Apple/Google Pay, bank transfer) while MoonPay
 * delivers the order's exact USDC amount straight to Advertek's settlement
 * wallet. Settlement therefore lands in the same wallet, asset, and treasury
 * sweep as direct Solana payments — only the confirmation source differs
 * (MoonPay webhook instead of QuickNode memo match).
 *
 * The order id travels in `externalTransactionId`, encoded with the same
 * `advertek:order:{orderId}:{nonce}` scheme as the Solana memo so both rails
 * share `parseOrderIdFromMemo`.
 */
export const buyCheckoutInputSchema = z.object({
  orderId: z.string().min(1),
  amountBaseUnits: z.bigint().positive(),
  /** Lowercase ISO-4217 code; defaults to the configured fiat currency. */
  fiatCurrencyCode: z.string().length(3).optional(),
  customerEmail: z.string().email().optional(),
  /** Stable identifier for the buyer (tenant / customer id) for MoonPay reporting. */
  externalCustomerId: z.string().min(1).optional(),
  /** Public IP the widget will be opened from. Required by MoonPay for live widgets. */
  customerIpAddress: z.string().ip().optional(),
  redirectUrl: z.string().url().optional(),
  memoNonce: z.string().min(1).optional(),
});

export type BuyCheckoutInput = z.infer<typeof buyCheckoutInputSchema>;

export interface MoonPayBuyCheckout {
  readonly orderId: string;
  readonly externalTransactionId: string;
  readonly amountBaseUnits: bigint;
  readonly currencyCode: string;
  readonly fiatCurrencyCode: string;
  readonly settlementWallet: string;
  /** Signed widget URL — hand this to the customer or agent to open. */
  readonly url: string;
}

export interface CreateBuyCheckoutDeps {
  readonly config: MoonPayConfig;
  readonly generateNonce?: () => string;
}

export function createMoonPayBuyCheckout(
  deps: CreateBuyCheckoutDeps,
  rawInput: BuyCheckoutInput,
): MoonPayBuyCheckout {
  const input = buyCheckoutInputSchema.parse(rawInput);
  const { config } = deps;
  const nonce = input.memoNonce ?? (deps.generateNonce ?? randomUUID)();
  const externalTransactionId = buildPaymentMemo(input.orderId, nonce);
  const fiatCurrencyCode = (input.fiatCurrencyCode ?? config.defaultFiatCurrencyCode).toLowerCase();

  const params = new URLSearchParams();
  params.set("apiKey", config.publishableKey);
  params.set("currencyCode", config.usdcCurrencyCode);
  params.set("walletAddress", config.settlementWallet);
  params.set("baseCurrencyCode", fiatCurrencyCode);
  params.set(
    "quoteCurrencyAmount",
    baseUnitsToDecimalString(input.amountBaseUnits, config.usdcDecimals),
  );
  params.set("lockAmount", "true");
  params.set("externalTransactionId", externalTransactionId);
  if (input.externalCustomerId) {
    params.set("externalCustomerId", input.externalCustomerId);
  }
  if (input.customerEmail) {
    params.set("email", input.customerEmail);
  }
  if (input.redirectUrl) {
    params.set("redirectURL", input.redirectUrl);
  }
  if (input.customerIpAddress) {
    params.set("allowedIpAddress", hashAllowedIpAddress(input.customerIpAddress, config.secretKey));
  }

  const unsigned = `${config.buyWidgetBaseUrl}?${params.toString()}`;
  return {
    orderId: input.orderId,
    externalTransactionId,
    amountBaseUnits: input.amountBaseUnits,
    currencyCode: config.usdcCurrencyCode,
    fiatCurrencyCode,
    settlementWallet: config.settlementWallet,
    url: signWidgetUrl(unsigned, config.secretKey),
  };
}
