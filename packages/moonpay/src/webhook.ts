import { parseOrderIdFromMemo, type OrderStatusUpdater } from "@advertek/payments";
import { z } from "zod";
import type { MoonPayConfig } from "./config.js";
import { jsonNumberToMinorUnits } from "./money.js";
import { MoonPayWebhookSignatureError, verifyMoonPayWebhookSignature } from "./signing.js";

export class MoonPayWebhookPayloadError extends Error {
  override readonly name = "MoonPayWebhookPayloadError";
}

export const moonPayBuyStatusSchema = z.enum([
  "waitingPayment",
  "pending",
  "waitingAuthorization",
  "failed",
  "completed",
]);

export type MoonPayBuyStatus = z.infer<typeof moonPayBuyStatusSchema>;

export const moonPayBuyTransactionSchema = z.object({
  id: z.string().min(1),
  status: moonPayBuyStatusSchema,
  updatedAt: z.string().min(1),
  baseCurrencyAmount: z.number().nonnegative().nullable().optional(),
  quoteCurrencyAmount: z.number().nonnegative().nullable().optional(),
  walletAddress: z.string().nullable().optional(),
  cryptoTransactionId: z.string().nullable().optional(),
  externalTransactionId: z.string().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  currency: z.object({ code: z.string() }).nullable().optional(),
  baseCurrency: z.object({ code: z.string() }).nullable().optional(),
});

export const moonPayBuyEventTypeSchema = z.enum([
  "transaction_created",
  "transaction_updated",
  "transaction_failed",
]);

export const moonPayWebhookEventSchema = z.object({
  type: z.string().min(1),
  data: z.unknown(),
  externalCustomerId: z.string().nullable().optional(),
});

export type MoonPayBuyEventType = z.infer<typeof moonPayBuyEventTypeSchema>;
export type MoonPayBuyTransaction = z.infer<typeof moonPayBuyTransactionSchema>;

export interface MoonPayWebhookHeaders {
  readonly "moonpay-signature-v2"?: string | undefined;
}

export interface MoonPayWebhookRequest {
  readonly headers: MoonPayWebhookHeaders;
  /** Raw body exactly as received (unparsed JSON text). */
  readonly rawBody: string;
}

export interface HandleMoonPayWebhookDeps {
  readonly webhookKey: string;
  readonly config: Pick<MoonPayConfig, "settlementWallet" | "usdcCurrencyCode" | "usdcDecimals">;
  readonly updateOrderStatus: OrderStatusUpdater["updateOrderStatus"];
  /**
   * Idempotency gate keyed on the MoonPay transaction id. Resolves `true`
   * on first sight (proceed), `false` on a replay (skip side effects).
   */
  readonly markDeliveryProcessed?: (transactionId: string) => Promise<boolean>;
  readonly now?: () => Date;
  /** Called for verified non-terminal / unmatched events; useful for logging. */
  readonly onIgnored?: (event: IgnoredMoonPayEvent) => void;
}

export interface IgnoredMoonPayEvent {
  readonly type: string;
  readonly transactionId: string | undefined;
  readonly reason: string;
}

export interface MoonPayWebhookResult {
  readonly type: string;
  readonly transactionId: string | undefined;
  /** Set when the event marked an order paid. */
  readonly paidOrderId: string | undefined;
  readonly ignoredReason: string | undefined;
}

/**
 * Receiver for MoonPay Buy webhooks. Verifies `Moonpay-Signature-V2` before
 * touching the payload; then, only for `completed` Buy transactions that
 * (a) reference one of our order ids via `externalTransactionId`,
 * (b) delivered our USDC currency, and (c) landed in our settlement wallet,
 * calls `updateOrderStatus(..., "paid")`. Every other event (pending,
 * failed, other currency/wallet, sell events) is acknowledged and ignored.
 *
 * MoonPay delivery is at-least-once and unordered; `markDeliveryProcessed`
 * dedupes on the transaction id so a replayed `completed` event is a no-op.
 */
export async function handleMoonPayWebhook(
  deps: HandleMoonPayWebhookDeps,
  request: MoonPayWebhookRequest,
): Promise<MoonPayWebhookResult> {
  const signatureHeader = request.headers["moonpay-signature-v2"];
  if (!signatureHeader) {
    throw new MoonPayWebhookSignatureError("Missing Moonpay-Signature-V2 header");
  }
  const verified = verifyMoonPayWebhookSignature({
    signatureHeader,
    rawBody: request.rawBody,
    webhookKey: deps.webhookKey,
    now: deps.now ?? (() => new Date()),
  });
  if (!verified) {
    throw new MoonPayWebhookSignatureError("MoonPay webhook signature verification failed");
  }

  let event: z.infer<typeof moonPayWebhookEventSchema>;
  try {
    event = moonPayWebhookEventSchema.parse(JSON.parse(request.rawBody) as unknown);
  } catch (error) {
    throw new MoonPayWebhookPayloadError(
      `Verified MoonPay webhook body failed schema validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const ignore = (transactionId: string | undefined, reason: string): MoonPayWebhookResult => {
    deps.onIgnored?.({ type: event.type, transactionId, reason });
    return { type: event.type, transactionId, paidOrderId: undefined, ignoredReason: reason };
  };

  if (!moonPayBuyEventTypeSchema.safeParse(event.type).success) {
    return ignore(undefined, `event type ${event.type} is not a Buy transaction event`);
  }

  const parsedTx = moonPayBuyTransactionSchema.safeParse(event.data);
  if (!parsedTx.success) {
    throw new MoonPayWebhookPayloadError(
      `MoonPay Buy transaction failed schema validation: ${parsedTx.error.message}`,
    );
  }
  const tx = parsedTx.data;

  if (tx.status !== "completed") {
    return ignore(tx.id, `status ${tx.status} is not terminal-success`);
  }
  const orderId = tx.externalTransactionId
    ? parseOrderIdFromMemo(tx.externalTransactionId)
    : undefined;
  if (!orderId) {
    return ignore(tx.id, "externalTransactionId does not reference an Advertek order");
  }
  if ((tx.currency?.code ?? "").toLowerCase() !== deps.config.usdcCurrencyCode) {
    return ignore(tx.id, `currency ${tx.currency?.code ?? "?"} is not ${deps.config.usdcCurrencyCode}`);
  }
  if (tx.walletAddress !== deps.config.settlementWallet) {
    return ignore(tx.id, "walletAddress is not the settlement wallet");
  }
  if (tx.quoteCurrencyAmount == null) {
    throw new MoonPayWebhookPayloadError(
      `Completed MoonPay transaction ${tx.id} has no quoteCurrencyAmount`,
    );
  }

  if (deps.markDeliveryProcessed && !(await deps.markDeliveryProcessed(tx.id))) {
    return ignore(tx.id, "replayed delivery");
  }

  await deps.updateOrderStatus(
    {
      orderId,
      // Solana signature of MoonPay's delivery when known; the treasury sweep
      // uses it to attribute the memo-less on-chain transfer to this order.
      signature: tx.cryptoTransactionId ?? `moonpay:${tx.id}`,
      amountBaseUnits: jsonNumberToMinorUnits(tx.quoteCurrencyAmount, deps.config.usdcDecimals),
      slot: 0,
    },
    "paid",
  );

  return { type: event.type, transactionId: tx.id, paidOrderId: orderId, ignoredReason: undefined };
}
