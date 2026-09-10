import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * MoonPay widget URL signing: HMAC-SHA256 over the URL's query string
 * (including the leading `?`, values already URL-encoded), keyed by the
 * secret key, base64-encoded, appended as the final `signature` parameter.
 * Required whenever `walletAddress` is pre-filled.
 * https://dev.moonpay.com/widget/on-ramp/customization/url-signing
 */
export function signWidgetUrl(url: string, secretKey: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has("signature")) {
    throw new Error("URL already carries a signature parameter");
  }
  const signature = createHmac("sha256", secretKey)
    .update(parsed.search, "utf8")
    .digest("base64");
  return `${url}&signature=${encodeURIComponent(signature)}`;
}

/**
 * `allowedIpAddress` is mandatory for live on-ramp widgets: MoonPay only
 * loads the widget when this hash matches the IP it observes. The value is
 * a base64 HMAC-SHA256 of the customer's public IP keyed by the secret key.
 */
export function hashAllowedIpAddress(ipAddress: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(ipAddress, "utf8").digest("base64");
}

export class MoonPayWebhookSignatureError extends Error {
  override readonly name = "MoonPayWebhookSignatureError";
}

export interface ParsedMoonPaySignature {
  readonly timestamp: string;
  readonly signatureHex: string;
}

/** Parses a `Moonpay-Signature-V2` header of the form `t=<unix>,s=<hex>`. */
export function parseMoonPaySignatureHeader(header: string): ParsedMoonPaySignature {
  let timestamp: string | undefined;
  let signatureHex: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      timestamp = value;
    } else if (key === "s") {
      signatureHex = value;
    }
  }
  if (!timestamp || !signatureHex) {
    throw new MoonPayWebhookSignatureError(
      "Moonpay-Signature-V2 header must contain t= and s= parts",
    );
  }
  return { timestamp, signatureHex };
}

export interface VerifyMoonPayWebhookSignatureInput {
  readonly signatureHeader: string;
  /** Raw request body exactly as received (unparsed JSON text). */
  readonly rawBody: string;
  readonly webhookKey: string;
  readonly now: () => Date;
  /** Reject deliveries whose `t=` is further than this from `now()`. */
  readonly toleranceSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verifies `Moonpay-Signature-V2`: HMAC-SHA256 over `${t}.${rawBody}` keyed
 * by the webhook API key, hex-encoded, compared timing-safely, with a replay
 * window on the timestamp.
 * https://dev.moonpay.com/api-reference/widget/webhooks/signature
 */
export function verifyMoonPayWebhookSignature(
  input: VerifyMoonPayWebhookSignatureInput,
): boolean {
  const { timestamp, signatureHex } = parseMoonPaySignatureHeader(input.signatureHeader);

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const nowSeconds = Math.floor(input.now().getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    return false;
  }

  const expectedHex = createHmac("sha256", input.webhookKey)
    .update(`${timestamp}.${input.rawBody}`, "utf8")
    .digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const provided = parseHexBuffer(signatureHex);
  if (!provided || provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

function parseHexBuffer(hex: string): Buffer | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return undefined;
  }
  return Buffer.from(hex, "hex");
}
