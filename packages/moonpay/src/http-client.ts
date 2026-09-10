import { z } from "zod";
import type { MoonPayConfig } from "./config.js";

export class MoonPayApiError extends Error {
  override readonly name = "MoonPayApiError";
  readonly httpStatus: number;
  readonly vendorType: string | undefined;

  constructor(message: string, httpStatus: number, vendorType?: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.vendorType = vendorType;
  }
}

export type MoonPayFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** `public` endpoints take `?apiKey=pk_…`; `secret` endpoints take `Authorization: Api-Key sk_…`. */
export type MoonPayAuth = "public" | "secret";

export interface MoonPayRequestInput {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: Record<string, unknown>;
  readonly auth: MoonPayAuth;
}

export interface MoonPayHttpClient {
  request(input: MoonPayRequestInput): Promise<unknown>;
}

const moonPayErrorSchema = z.object({
  message: z.string().optional(),
  type: z.string().optional(),
});

export interface CreateMoonPayHttpClientOptions {
  readonly fetchImpl?: MoonPayFetchLike;
}

export function createMoonPayHttpClient(
  config: Pick<MoonPayConfig, "apiBaseUrl" | "publishableKey" | "secretKey">,
  options: CreateMoonPayHttpClientOptions = {},
): MoonPayHttpClient {
  const fetchImpl: MoonPayFetchLike = options.fetchImpl ?? fetch;

  return {
    async request(input) {
      const url = new URL(input.path, config.apiBaseUrl);
      for (const [key, value] of Object.entries(input.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const headers: Record<string, string> = { accept: "application/json" };
      if (input.auth === "public") {
        url.searchParams.set("apiKey", config.publishableKey);
      } else {
        headers["authorization"] = `Api-Key ${config.secretKey}`;
      }
      let body: string | undefined;
      if (input.body) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(input.body);
      }

      const response = await fetchImpl(url.toString(), {
        method: input.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });

      if (response.status === 204) {
        return null;
      }
      const json = await response.json();
      if (response.status < 200 || response.status >= 300) {
        const parsed = moonPayErrorSchema.safeParse(json);
        const message = parsed.success && parsed.data.message ? parsed.data.message : "request failed";
        throw new MoonPayApiError(
          `MoonPay ${input.method} ${input.path} -> ${String(response.status)}: ${message}`,
          response.status,
          parsed.success ? parsed.data.type : undefined,
        );
      }
      return json;
    },
  };
}
