import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMoonPayBuyCheckout } from "./buy-checkout.js";
import type { MoonPayConfig } from "./config.js";
import { createMoonPaySellCheckout } from "./sell.js";

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const config: MoonPayConfig = {
  environment: "sandbox",
  publishableKey: "pk_test_pub",
  secretKey: "sk_test_sec",
  apiBaseUrl: "https://api.moonpay.com",
  buyWidgetBaseUrl: "https://buy-sandbox.moonpay.com",
  sellWidgetBaseUrl: "https://sell-sandbox.moonpay.com",
  usdcCurrencyCode: "usdc_sol",
  defaultFiatCurrencyCode: "cad",
  settlementWallet: WALLET,
  usdcDecimals: 6,
};

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("createMoonPayBuyCheckout", () => {
  it("builds a locked, order-bound, signed widget URL to the settlement wallet", () => {
    const checkout = createMoonPayBuyCheckout(
      { config, generateNonce: () => "n1" },
      { orderId: "ord_123", amountBaseUnits: 12_500_000n },
    );

    expect(checkout.externalTransactionId).toBe("advertek:order:ord_123:n1");
    expect(checkout.url.startsWith("https://buy-sandbox.moonpay.com?")).toBe(true);

    const params = paramsOf(checkout.url);
    expect(params.get("apiKey")).toBe("pk_test_pub");
    expect(params.get("currencyCode")).toBe("usdc_sol");
    expect(params.get("walletAddress")).toBe(WALLET);
    expect(params.get("baseCurrencyCode")).toBe("cad");
    expect(params.get("quoteCurrencyAmount")).toBe("12.5");
    expect(params.get("lockAmount")).toBe("true");
    expect(params.get("externalTransactionId")).toBe("advertek:order:ord_123:n1");
    expect(params.has("email")).toBe(false);
    expect(params.has("allowedIpAddress")).toBe(false);
    expect(params.has("signature")).toBe(true);
    // never leaks the secret key
    expect(checkout.url).not.toContain("sk_test_sec");
  });

  it("signature is HMAC over the query string preceding it", () => {
    const { url } = createMoonPayBuyCheckout(
      { config, generateNonce: () => "n1" },
      { orderId: "ord_123", amountBaseUnits: 1_000_000n },
    );
    const [, query] = url.split("?");
    const [unsignedQuery, signature] = (query ?? "").split("&signature=");
    const expected = createHmac("sha256", config.secretKey)
      .update(`?${unsignedQuery ?? ""}`)
      .digest("base64");
    expect(decodeURIComponent(signature ?? "")).toBe(expected);
  });

  it("passes optional customer fields and hashes the IP", () => {
    const { url } = createMoonPayBuyCheckout(
      { config, generateNonce: () => "n1" },
      {
        orderId: "ord_1",
        amountBaseUnits: 1_000_000n,
        fiatCurrencyCode: "USD",
        customerEmail: "buyer@example.com",
        externalCustomerId: "tenant_9",
        redirectUrl: "https://advertek.io/orders/ord_1",
        customerIpAddress: "203.0.113.9",
      },
    );
    const params = paramsOf(url);
    expect(params.get("baseCurrencyCode")).toBe("usd");
    expect(params.get("email")).toBe("buyer@example.com");
    expect(params.get("externalCustomerId")).toBe("tenant_9");
    expect(params.get("redirectURL")).toBe("https://advertek.io/orders/ord_1");
    expect(params.get("allowedIpAddress")).toBe(
      createHmac("sha256", config.secretKey).update("203.0.113.9").digest("base64"),
    );
  });

  it("rejects zero amounts and bad input", () => {
    expect(() =>
      createMoonPayBuyCheckout({ config }, { orderId: "ord_1", amountBaseUnits: 0n }),
    ).toThrow();
    expect(() =>
      createMoonPayBuyCheckout(
        { config },
        { orderId: "ord_1", amountBaseUnits: 1n, customerIpAddress: "not-an-ip" },
      ),
    ).toThrow();
  });
});

describe("createMoonPaySellCheckout", () => {
  it("builds a signed sell URL refunding to the settlement wallet", () => {
    const checkout = createMoonPaySellCheckout(
      { config },
      {
        externalTransactionId: "advertek:sweep:sw_1",
        amountBaseUnits: 250_000_000n,
        fiatCurrencyCode: "usd",
      },
    );
    expect(checkout.url.startsWith("https://sell-sandbox.moonpay.com?")).toBe(true);
    const params = paramsOf(checkout.url);
    expect(params.get("apiKey")).toBe("pk_test_pub");
    expect(params.get("baseCurrencyCode")).toBe("usdc_sol");
    expect(params.get("baseCurrencyAmount")).toBe("250");
    expect(params.get("lockAmount")).toBe("true");
    expect(params.get("quoteCurrencyCode")).toBe("usd");
    expect(params.get("refundWalletAddress")).toBe(WALLET);
    expect(params.get("externalTransactionId")).toBe("advertek:sweep:sw_1");
    expect(params.has("signature")).toBe(true);
    expect(checkout.refundWallet).toBe(WALLET);
  });
});
