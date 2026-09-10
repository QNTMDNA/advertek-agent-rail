import type { ConfirmedOrderPayment, OrderStatus } from "@advertek/payments";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MoonPayWebhookSignatureError } from "./signing.js";
import {
  handleMoonPayWebhook,
  MoonPayWebhookPayloadError,
  type HandleMoonPayWebhookDeps,
} from "./webhook.js";

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const WEBHOOK_KEY = "wk_test";
const NOW_SECONDS = 1_700_000_000;

const config = { settlementWallet: WALLET, usdcCurrencyCode: "usdc_sol", usdcDecimals: 6 };

function completedTx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tx_1",
    status: "completed",
    updatedAt: "2026-09-10T12:00:00.000Z",
    baseCurrencyAmount: 17.55,
    quoteCurrencyAmount: 12.5,
    walletAddress: WALLET,
    cryptoTransactionId: "5SolanaSig",
    externalTransactionId: "advertek:order:ord_123:n1",
    currency: { code: "USDC_SOL" },
    baseCurrency: { code: "CAD" },
    ...overrides,
  };
}

function signedRequest(body: unknown, timestamp = NOW_SECONDS, key = WEBHOOK_KEY) {
  const rawBody = JSON.stringify(body);
  const sig = createHmac("sha256", key).update(`${String(timestamp)}.${rawBody}`).digest("hex");
  return { headers: { "moonpay-signature-v2": `t=${String(timestamp)},s=${sig}` }, rawBody };
}

function makeDeps(overrides: Partial<HandleMoonPayWebhookDeps> = {}) {
  const updateOrderStatus =
    vi.fn<(payment: ConfirmedOrderPayment, status: OrderStatus) => Promise<void>>();
  updateOrderStatus.mockResolvedValue(undefined);
  const deps: HandleMoonPayWebhookDeps = {
    webhookKey: WEBHOOK_KEY,
    config,
    updateOrderStatus,
    now: () => new Date(NOW_SECONDS * 1000),
    ...overrides,
  };
  return { deps, updateOrderStatus };
}

describe("handleMoonPayWebhook", () => {
  it("marks the order paid for a completed Buy into the settlement wallet", async () => {
    const { deps, updateOrderStatus } = makeDeps();
    const result = await handleMoonPayWebhook(
      deps,
      signedRequest({ type: "transaction_updated", data: completedTx() }),
    );

    expect(result).toEqual({
      type: "transaction_updated",
      transactionId: "tx_1",
      paidOrderId: "ord_123",
      ignoredReason: undefined,
    });
    expect(updateOrderStatus).toHaveBeenCalledTimes(1);
    expect(updateOrderStatus).toHaveBeenCalledWith(
      { orderId: "ord_123", signature: "5SolanaSig", amountBaseUnits: 12_500_000n, slot: 0 },
      "paid",
    );
  });

  it("falls back to a moonpay: pseudo-signature when the chain tx id is absent", async () => {
    const { deps, updateOrderStatus } = makeDeps();
    await handleMoonPayWebhook(
      deps,
      signedRequest({
        type: "transaction_updated",
        data: completedTx({ cryptoTransactionId: null }),
      }),
    );
    expect(updateOrderStatus.mock.calls[0]?.[0].signature).toBe("moonpay:tx_1");
  });

  it("rejects missing, invalid and stale signatures before parsing", async () => {
    const { deps, updateOrderStatus } = makeDeps();
    const body = { type: "transaction_updated", data: completedTx() };

    await expect(
      handleMoonPayWebhook(deps, { headers: {}, rawBody: JSON.stringify(body) }),
    ).rejects.toBeInstanceOf(MoonPayWebhookSignatureError);
    await expect(
      handleMoonPayWebhook(deps, signedRequest(body, NOW_SECONDS, "wrong")),
    ).rejects.toBeInstanceOf(MoonPayWebhookSignatureError);
    await expect(
      handleMoonPayWebhook(deps, signedRequest(body, NOW_SECONDS - 3600)),
    ).rejects.toBeInstanceOf(MoonPayWebhookSignatureError);
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it("acknowledges non-terminal statuses without touching the order", async () => {
    const { deps, updateOrderStatus } = makeDeps();
    for (const status of ["waitingPayment", "pending", "waitingAuthorization", "failed"]) {
      const result = await handleMoonPayWebhook(
        deps,
        signedRequest({ type: "transaction_updated", data: completedTx({ status }) }),
      );
      expect(result.paidOrderId).toBeUndefined();
      expect(result.ignoredReason).toContain(status);
    }
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it("ignores completed transactions that are not ours", async () => {
    const { deps, updateOrderStatus } = makeDeps();
    const cases: [Record<string, unknown>, string][] = [
      [{ externalTransactionId: "someone-elses-ref" }, "externalTransactionId"],
      [{ externalTransactionId: null }, "externalTransactionId"],
      [{ currency: { code: "eth" } }, "currency"],
      [{ walletAddress: "OtherWallet" }, "settlement wallet"],
    ];
    for (const [overrides, reason] of cases) {
      const result = await handleMoonPayWebhook(
        deps,
        signedRequest({ type: "transaction_updated", data: completedTx(overrides) }),
      );
      expect(result.paidOrderId).toBeUndefined();
      expect(result.ignoredReason).toContain(reason);
    }
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it("ignores sell / unknown event types", async () => {
    const { deps, updateOrderStatus } = makeDeps();
    const result = await handleMoonPayWebhook(
      deps,
      signedRequest({ type: "sell_transaction_updated", data: { id: "sell_1" } }),
    );
    expect(result.ignoredReason).toContain("sell_transaction_updated");
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it("dedupes replays via markDeliveryProcessed", async () => {
    const seen = new Set<string>();
    const { deps, updateOrderStatus } = makeDeps({
      markDeliveryProcessed: (id) => {
        const isNew = !seen.has(id);
        seen.add(id);
        return Promise.resolve(isNew);
      },
    });
    const request = signedRequest({ type: "transaction_updated", data: completedTx() });
    const first = await handleMoonPayWebhook(deps, request);
    const second = await handleMoonPayWebhook(deps, request);
    expect(first.paidOrderId).toBe("ord_123");
    expect(second.paidOrderId).toBeUndefined();
    expect(second.ignoredReason).toBe("replayed delivery");
    expect(updateOrderStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects verified-but-malformed payloads as payload errors", async () => {
    const { deps } = makeDeps();
    await expect(
      handleMoonPayWebhook(
        deps,
        signedRequest({ type: "transaction_updated", data: { id: "tx_1", status: "bogus" } }),
      ),
    ).rejects.toBeInstanceOf(MoonPayWebhookPayloadError);
    await expect(
      handleMoonPayWebhook(
        deps,
        signedRequest({
          type: "transaction_updated",
          data: completedTx({ quoteCurrencyAmount: null }),
        }),
      ),
    ).rejects.toBeInstanceOf(MoonPayWebhookPayloadError);
  });
});
