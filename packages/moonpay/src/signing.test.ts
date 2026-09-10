import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashAllowedIpAddress,
  MoonPayWebhookSignatureError,
  parseMoonPaySignatureHeader,
  signWidgetUrl,
  verifyMoonPayWebhookSignature,
} from "./signing.js";

const SECRET = "sk_test_secret";

describe("signWidgetUrl", () => {
  it("appends a url-encoded base64 HMAC-SHA256 of the query string (with leading ?)", () => {
    const url = "https://buy-sandbox.moonpay.com?apiKey=pk_test_1&currencyCode=usdc_sol";
    const signed = signWidgetUrl(url, SECRET);
    const expected = createHmac("sha256", SECRET)
      .update("?apiKey=pk_test_1&currencyCode=usdc_sol")
      .digest("base64");
    expect(signed).toBe(`${url}&signature=${encodeURIComponent(expected)}`);
  });

  it("verifies the signature is over the query only, not the host", () => {
    const a = signWidgetUrl("https://buy.moonpay.com?apiKey=x", SECRET);
    const b = signWidgetUrl("https://buy-sandbox.moonpay.com?apiKey=x", SECRET);
    expect(a.split("signature=")[1]).toBe(b.split("signature=")[1]);
  });
});

describe("hashAllowedIpAddress", () => {
  it("is base64 HMAC-SHA256 of the ip", () => {
    expect(hashAllowedIpAddress("203.0.113.9", SECRET)).toBe(
      createHmac("sha256", SECRET).update("203.0.113.9").digest("base64"),
    );
  });
});

describe("parseMoonPaySignatureHeader", () => {
  it("parses t and s", () => {
    expect(parseMoonPaySignatureHeader("t=1700000000,s=abcd")).toEqual({
      timestamp: "1700000000",
      signatureHex: "abcd",
    });
  });

  it("rejects malformed headers", () => {
    expect(() => parseMoonPaySignatureHeader("t=1700000000")).toThrow(
      MoonPayWebhookSignatureError,
    );
    expect(() => parseMoonPaySignatureHeader("garbage")).toThrow(MoonPayWebhookSignatureError);
  });
});

describe("verifyMoonPayWebhookSignature", () => {
  const webhookKey = "wk_test";
  const rawBody = '{"type":"transaction_updated","data":{"id":"tx_1"}}';
  const nowSeconds = 1_700_000_000;
  const now = () => new Date(nowSeconds * 1000);

  function sign(timestamp: number, body = rawBody, key = webhookKey): string {
    const sig = createHmac("sha256", key).update(`${String(timestamp)}.${body}`).digest("hex");
    return `t=${String(timestamp)},s=${sig}`;
  }

  it("accepts a valid signature within tolerance", () => {
    expect(
      verifyMoonPayWebhookSignature({
        signatureHeader: sign(nowSeconds - 30),
        rawBody,
        webhookKey,
        now,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyMoonPayWebhookSignature({
        signatureHeader: sign(nowSeconds),
        rawBody: rawBody.replace("tx_1", "tx_2"),
        webhookKey,
        now,
      }),
    ).toBe(false);
  });

  it("rejects the wrong key", () => {
    expect(
      verifyMoonPayWebhookSignature({
        signatureHeader: sign(nowSeconds, rawBody, "other"),
        rawBody,
        webhookKey,
        now,
      }),
    ).toBe(false);
  });

  it("rejects stale timestamps (replay window)", () => {
    expect(
      verifyMoonPayWebhookSignature({
        signatureHeader: sign(nowSeconds - 301),
        rawBody,
        webhookKey,
        now,
      }),
    ).toBe(false);
    expect(
      verifyMoonPayWebhookSignature({
        signatureHeader: sign(nowSeconds - 301),
        rawBody,
        webhookKey,
        now,
        toleranceSeconds: 600,
      }),
    ).toBe(true);
  });

  it("rejects non-hex or wrong-length signatures without throwing", () => {
    expect(
      verifyMoonPayWebhookSignature({
        signatureHeader: `t=${String(nowSeconds)},s=zz`,
        rawBody,
        webhookKey,
        now,
      }),
    ).toBe(false);
    expect(
      verifyMoonPayWebhookSignature({
        signatureHeader: `t=${String(nowSeconds)},s=abcd`,
        rawBody,
        webhookKey,
        now,
      }),
    ).toBe(false);
  });
});
