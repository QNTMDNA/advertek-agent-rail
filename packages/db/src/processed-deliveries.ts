import type { SqlExecutor } from "./executor.js";

export type DeliverySource = "quicknode" | "advertek" | "moonpay";

/**
 * Idempotency store for inbound webhook deliveries. QuickNode retries Streams
 * deliveries and Advertek retries up to 5 times, so every handler must treat
 * "already seen this delivery" as a first-class case: record-before-process,
 * and skip side effects (fulfillment submission, status fan-out) on replays.
 */
export interface ProcessedDeliveriesStore {
  /**
   * Records the delivery. Resolves `true` if this call recorded it (first
   * sighting — caller should process), `false` if it was already recorded
   * (replay — caller must skip side effects).
   */
  markProcessed(source: DeliverySource, deliveryId: string): Promise<boolean>;
  isProcessed(source: DeliverySource, deliveryId: string): Promise<boolean>;
}

export function createProcessedDeliveriesStore(
  executor: SqlExecutor,
): ProcessedDeliveriesStore {
  return {
    async markProcessed(source, deliveryId) {
      const rows = await executor.query<{ delivery_id: string }>(
        `INSERT INTO processed_deliveries (source, delivery_id)
         VALUES ($1, $2)
         ON CONFLICT (source, delivery_id) DO NOTHING
         RETURNING delivery_id`,
        [source, deliveryId],
      );
      return rows.length > 0;
    },
    async isProcessed(source, deliveryId) {
      const rows = await executor.query<{ delivery_id: string }>(
        `SELECT delivery_id FROM processed_deliveries
         WHERE source = $1 AND delivery_id = $2`,
        [source, deliveryId],
      );
      return rows.length > 0;
    },
  };
}
