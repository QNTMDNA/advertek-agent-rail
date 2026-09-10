import {
  createPostgresOrderDetailsLookup,
  createPostgresOrderStore,
  createProcessedDeliveriesStore,
} from "@advertek/db";
import {
  createAdvertekFulfillmentClient,
  createFulfillmentOrderStatusUpdater,
  loadFulfillmentConfig,
} from "@advertek/fulfillment";
import {
  handleMoonPayWebhook,
  loadMoonPayConfig,
  loadMoonPayWebhookConfig,
  MoonPayWebhookPayloadError,
  MoonPayWebhookSignatureError,
} from "@advertek/moonpay";
import { getDb } from "@/lib/db";
import { jsonResponse } from "@/lib/json";
import { readRawBody } from "@/lib/raw-body";

export const runtime = "nodejs";

/**
 * MoonPay Buy webhook receiver — the fiat on-ramp's payment confirmation,
 * mirroring `/api/webhooks/quicknode` for the direct USDC rail.
 *
 * Pipeline: `Moonpay-Signature-V2` verification (inside
 * `handleMoonPayWebhook`) -> only `completed` Buy transactions for our
 * settlement wallet/currency/order id proceed -> idempotency check (MoonPay
 * transaction id) -> persist "paid" -> submit the order to Advertek -> stamp
 * the vendor order id. Non-terminal and unrelated events return 200 so
 * MoonPay stops retrying them.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await readRawBody(request);
    const { webhookKey } = loadMoonPayWebhookConfig();
    const config = loadMoonPayConfig();

    const executor = getDb();
    const deliveries = createProcessedDeliveriesStore(executor);
    const orderStore = createPostgresOrderStore(executor);
    const fulfillmentUpdater = createFulfillmentOrderStatusUpdater({
      orderDetailsLookup: createPostgresOrderDetailsLookup(executor),
      fulfillmentClient: createAdvertekFulfillmentClient(loadFulfillmentConfig()),
      onOrderSubmitted: (result) =>
        orderStore.setVendorOrderId(result.internalOrderId, result.vendorOrderId),
    });

    const result = await handleMoonPayWebhook(
      {
        webhookKey,
        config,
        markDeliveryProcessed: (transactionId) =>
          deliveries.markProcessed("moonpay", transactionId),
        updateOrderStatus: async (payment, status) => {
          await orderStore.updateOrderStatus(payment, status);
          await fulfillmentUpdater.updateOrderStatus(payment, status);
        },
      },
      {
        headers: {
          "moonpay-signature-v2": request.headers.get("moonpay-signature-v2") ?? undefined,
        },
        rawBody,
      },
    );

    return jsonResponse({
      ok: true,
      type: result.type,
      transactionId: result.transactionId,
      paidOrderId: result.paidOrderId,
      ignored: result.ignoredReason,
    });
  } catch (error) {
    if (error instanceof MoonPayWebhookSignatureError) {
      return jsonResponse({ ok: false, error: error.message }, { status: 401 });
    }
    if (error instanceof MoonPayWebhookPayloadError) {
      return jsonResponse({ ok: false, error: error.message }, { status: 400 });
    }
    return jsonResponse(
      { ok: false, error: "Internal error processing webhook" },
      { status: 500 },
    );
  }
}
