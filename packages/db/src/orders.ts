import type { OrderStatusUpdater } from "@advertek/payments";
import { fulfillmentOrderInputSchema, type FulfillmentOrderInput } from "@advertek/fulfillment";
import type { OrderStatus } from "@advertek/types";
import type { SqlExecutor } from "./executor.js";
import { decodePersistedJson, encodePersistedJson } from "./json-codec.js";

export class OrderNotFoundError extends Error {
  override readonly name = "OrderNotFoundError";
}

/**
 * Postgres-backed order store. Implements `@advertek/payments`'
 * `OrderStatusUpdater` seam (payment confirmation -> "paid") and adds the
 * writes the rest of the order lifecycle needs: agent-facing status events
 * from Advertek webhooks, vendor order ids from fulfillment submissions, and
 * the fulfillment payload itself (written at order intake).
 */
export interface OrderStore extends OrderStatusUpdater {
  /** Persists the fulfillment payload for an order at intake time. */
  saveFulfillmentInput(input: FulfillmentOrderInput): Promise<void>;
  /** Records an agent-facing status transition and reflects it on the order. */
  recordStatusEvent(
    orderId: string,
    status: OrderStatus,
    occurredAt: Date,
  ): Promise<void>;
  /** Stamps Advertek's vendor order id once fulfillment submits the order. */
  setVendorOrderId(orderId: string, vendorOrderId: string): Promise<void>;
  /**
   * Reverse lookup from an on-chain signature to the order it paid for. Lets
   * the treasury sweep attribute memo-less transfers (e.g. USDC delivered by
   * MoonPay on a buyer's behalf) whose signature we learned from a webhook.
   */
  findOrderIdByPaymentSignature(signature: string): Promise<string | undefined>;
}

export function createPostgresOrderStore(executor: SqlExecutor): OrderStore {
  return {
    async updateOrderStatus(payment, status) {
      await executor.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO orders (id, status, payment_signature, payment_amount_base_units, payment_slot)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             payment_signature = EXCLUDED.payment_signature,
             payment_amount_base_units = EXCLUDED.payment_amount_base_units,
             payment_slot = EXCLUDED.payment_slot,
             updated_at = now()`,
          [
            payment.orderId,
            status,
            payment.signature,
            payment.amountBaseUnits.toString(),
            payment.slot,
          ],
        );
        await tx.query(
          `INSERT INTO order_status_events (order_id, status, occurred_at)
           VALUES ($1, $2, now())`,
          [payment.orderId, status],
        );
      });
    },

    async saveFulfillmentInput(input) {
      const parsed = fulfillmentOrderInputSchema.parse(input);
      await executor.query(
        `INSERT INTO orders (id, fulfillment_input)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           fulfillment_input = EXCLUDED.fulfillment_input,
           updated_at = now()`,
        [parsed.internalOrderId, encodePersistedJson(parsed)],
      );
    },

    async recordStatusEvent(orderId, status, occurredAt) {
      await executor.transaction(async (tx) => {
        const updated = await tx.query<{ id: string }>(
          `UPDATE orders SET status = $2, updated_at = now()
           WHERE id = $1
           RETURNING id`,
          [orderId, status],
        );
        if (updated.length === 0) {
          throw new OrderNotFoundError(`Unknown order: ${orderId}`);
        }
        await tx.query(
          `INSERT INTO order_status_events (order_id, status, occurred_at)
           VALUES ($1, $2, $3)`,
          [orderId, status, occurredAt],
        );
      });
    },

    async setVendorOrderId(orderId, vendorOrderId) {
      const updated = await executor.query<{ id: string }>(
        `UPDATE orders SET vendor_order_id = $2, updated_at = now()
         WHERE id = $1
         RETURNING id`,
        [orderId, vendorOrderId],
      );
      if (updated.length === 0) {
        throw new OrderNotFoundError(`Unknown order: ${orderId}`);
      }
    },

    async findOrderIdByPaymentSignature(signature) {
      const rows = await executor.query<{ id: string }>(
        "SELECT id FROM orders WHERE payment_signature = $1 LIMIT 1",
        [signature],
      );
      return rows[0]?.id;
    },
  };
}

export interface OrderRow {
  readonly id: string;
  readonly status: string;
  readonly payment_signature: string | null;
  readonly payment_amount_base_units: string | null;
  readonly payment_slot: number | null;
  readonly vendor_order_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Reads the decoded fulfillment payload for an order, or `undefined`. */
export async function readFulfillmentInput(
  executor: SqlExecutor,
  orderId: string,
): Promise<FulfillmentOrderInput | undefined> {
  const rows = await executor.query<{ fulfillment_input: unknown }>(
    "SELECT fulfillment_input FROM orders WHERE id = $1",
    [orderId],
  );
  const raw = rows[0]?.fulfillment_input;
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return fulfillmentOrderInputSchema.parse(decodePersistedJson(text));
}
