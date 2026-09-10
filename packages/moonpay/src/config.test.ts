import { describe, expect, it } from "vitest";
import { loadMoonPayConfig, loadMoonPayWebhookConfig } from "./config.js";

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const sandboxEnv = {
  MOONPAY_PUBLISHABLE_KEY: "pk_test_abc",
  MOONPAY_SECRET_KEY: "sk_test_abc",
  ADVERTEK_SETTLEMENT_WALLET: WALLET,
};

describe("loadMoonPayConfig", () => {
  it("defaults to sandbox with usdc_sol / usd, US-only, and sandbox widget hosts", () => {
    const config = loadMoonPayConfig(sandboxEnv);
    expect(config.environment).toBe("sandbox");
    expect(config.usdcCurrencyCode).toBe("usdc_sol");
    expect(config.defaultFiatCurrencyCode).toBe("usd");
    expect(config.usdcDecimals).toBe(6);
    expect(config.allowedCountryCodes).toEqual(["US"]);
    expect(config.buyWidgetBaseUrl).toBe("https://buy-sandbox.moonpay.com");
    expect(config.sellWidgetBaseUrl).toBe("https://sell-sandbox.moonpay.com");
    expect(config.settlementWallet).toBe(WALLET);
  });

  it("lowercases currency codes", () => {
    const config = loadMoonPayConfig({
      ...sandboxEnv,
      MOONPAY_USDC_CURRENCY_CODE: "USDC_SOL",
      MOONPAY_DEFAULT_FIAT_CURRENCY: "USD",
    });
    expect(config.usdcCurrencyCode).toBe("usdc_sol");
    expect(config.defaultFiatCurrencyCode).toBe("usd");
  });

  it("allows a test-mode asset with different decimals for sandbox", () => {
    const config = loadMoonPayConfig({
      ...sandboxEnv,
      MOONPAY_USDC_CURRENCY_CODE: "sol",
      MOONPAY_CRYPTO_DECIMALS: "9",
    });
    expect(config.usdcCurrencyCode).toBe("sol");
    expect(config.usdcDecimals).toBe(9);
    expect(() =>
      loadMoonPayConfig({ ...sandboxEnv, MOONPAY_CRYPTO_DECIMALS: "abc" }),
    ).toThrow(/MOONPAY_CRYPTO_DECIMALS/);
  });

  it("parses MOONPAY_ALLOWED_COUNTRIES as an uppercase list", () => {
    expect(
      loadMoonPayConfig({ ...sandboxEnv, MOONPAY_ALLOWED_COUNTRIES: "us, gb ," }).allowedCountryCodes,
    ).toEqual(["US", "GB"]);
    expect(() => loadMoonPayConfig({ ...sandboxEnv, MOONPAY_ALLOWED_COUNTRIES: "usa" })).toThrow(
      /MOONPAY_ALLOWED_COUNTRIES/,
    );
  });

  it("uses production widget hosts with live keys", () => {
    const config = loadMoonPayConfig({
      ...sandboxEnv,
      MOONPAY_ENV: "production",
      MOONPAY_PUBLISHABLE_KEY: "pk_live_abc",
      MOONPAY_SECRET_KEY: "sk_live_abc",
    });
    expect(config.buyWidgetBaseUrl).toBe("https://buy.moonpay.com");
    expect(config.sellWidgetBaseUrl).toBe("https://sell.moonpay.com");
  });

  it("rejects test keys in production", () => {
    expect(() => loadMoonPayConfig({ ...sandboxEnv, MOONPAY_ENV: "production" })).toThrow(
      /requires pk_live_\/sk_live_/,
    );
  });

  it("rejects live keys in sandbox", () => {
    expect(() =>
      loadMoonPayConfig({
        ...sandboxEnv,
        MOONPAY_PUBLISHABLE_KEY: "pk_live_abc",
        MOONPAY_SECRET_KEY: "sk_live_abc",
      }),
    ).toThrow(/live keys supplied while MOONPAY_ENV=sandbox/);
  });

  it("names missing variables", () => {
    expect(() => loadMoonPayConfig({})).toThrow(/MOONPAY_PUBLISHABLE_KEY/);
  });
});

describe("loadMoonPayWebhookConfig", () => {
  it("loads the webhook key", () => {
    expect(loadMoonPayWebhookConfig({ MOONPAY_WEBHOOK_KEY: "wk_1" }).webhookKey).toBe("wk_1");
  });

  it("throws when missing", () => {
    expect(() => loadMoonPayWebhookConfig({})).toThrow(/MOONPAY_WEBHOOK_KEY/);
  });
});
