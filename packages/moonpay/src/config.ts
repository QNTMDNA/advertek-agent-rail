import { z } from "zod";

const solanaAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Must be a base58 Solana address");

const moonPayEnvSchema = z.object({
  MOONPAY_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MOONPAY_PUBLISHABLE_KEY: z
    .string()
    .regex(/^pk_(test|live)_/, "Must be a MoonPay publishable key (pk_test_… / pk_live_…)"),
  MOONPAY_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_/, "Must be a MoonPay secret key (sk_test_… / sk_live_…)"),
  MOONPAY_USDC_CURRENCY_CODE: z.string().min(1).default("usdc_sol"),
  MOONPAY_CRYPTO_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  MOONPAY_DEFAULT_FIAT_CURRENCY: z.string().length(3).default("cad"),
  ADVERTEK_SETTLEMENT_WALLET: solanaAddressSchema,
});

export type MoonPayEnvironment = "sandbox" | "production";

export type MoonPayConfig = {
  readonly environment: MoonPayEnvironment;
  /** `pk_*` key — safe to appear in widget URLs, identifies the account. */
  readonly publishableKey: string;
  /** `sk_*` key — signs widget URLs and authenticates REST calls. Server-side only. */
  readonly secretKey: string;
  readonly apiBaseUrl: string;
  readonly buyWidgetBaseUrl: string;
  readonly sellWidgetBaseUrl: string;
  /**
   * MoonPay's currency code for the settlement asset (`usdc_sol`). `usdc_sol`
   * has no MoonPay test mode, so sandbox setups point this at a test-mode
   * Solana asset (e.g. `sol`) and set MOONPAY_CRYPTO_DECIMALS to match.
   */
  readonly usdcCurrencyCode: string;
  /** Lowercase ISO-4217 code the widget defaults to for fiat. */
  readonly defaultFiatCurrencyCode: string;
  readonly settlementWallet: string;
  readonly usdcDecimals: number;
};

const ENVIRONMENT_URLS: Record<
  MoonPayEnvironment,
  Pick<MoonPayConfig, "apiBaseUrl" | "buyWidgetBaseUrl" | "sellWidgetBaseUrl">
> = {
  sandbox: {
    apiBaseUrl: "https://api.moonpay.com",
    buyWidgetBaseUrl: "https://buy-sandbox.moonpay.com",
    sellWidgetBaseUrl: "https://sell-sandbox.moonpay.com",
  },
  production: {
    apiBaseUrl: "https://api.moonpay.com",
    buyWidgetBaseUrl: "https://buy.moonpay.com",
    sellWidgetBaseUrl: "https://sell.moonpay.com",
  },
};

export function loadMoonPayConfig(env: NodeJS.ProcessEnv = process.env): MoonPayConfig {
  const parsed = moonPayEnvSchema.safeParse({
    MOONPAY_ENV: env["MOONPAY_ENV"],
    MOONPAY_PUBLISHABLE_KEY: env["MOONPAY_PUBLISHABLE_KEY"],
    MOONPAY_SECRET_KEY: env["MOONPAY_SECRET_KEY"],
    MOONPAY_USDC_CURRENCY_CODE: env["MOONPAY_USDC_CURRENCY_CODE"],
    MOONPAY_CRYPTO_DECIMALS: env["MOONPAY_CRYPTO_DECIMALS"],
    MOONPAY_DEFAULT_FIAT_CURRENCY: env["MOONPAY_DEFAULT_FIAT_CURRENCY"],
    ADVERTEK_SETTLEMENT_WALLET: env["ADVERTEK_SETTLEMENT_WALLET"],
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid MoonPay configuration: ${details}`);
  }

  const { MOONPAY_ENV: environment } = parsed.data;
  const liveKeys =
    parsed.data.MOONPAY_PUBLISHABLE_KEY.startsWith("pk_live_") &&
    parsed.data.MOONPAY_SECRET_KEY.startsWith("sk_live_");
  if (environment === "production" && !liveKeys) {
    throw new Error(
      "Invalid MoonPay configuration: MOONPAY_ENV=production requires pk_live_/sk_live_ keys",
    );
  }
  if (environment === "sandbox" && liveKeys) {
    throw new Error(
      "Invalid MoonPay configuration: live keys supplied while MOONPAY_ENV=sandbox",
    );
  }

  return {
    environment,
    publishableKey: parsed.data.MOONPAY_PUBLISHABLE_KEY,
    secretKey: parsed.data.MOONPAY_SECRET_KEY,
    ...ENVIRONMENT_URLS[environment],
    usdcCurrencyCode: parsed.data.MOONPAY_USDC_CURRENCY_CODE.toLowerCase(),
    defaultFiatCurrencyCode: parsed.data.MOONPAY_DEFAULT_FIAT_CURRENCY.toLowerCase(),
    settlementWallet: parsed.data.ADVERTEK_SETTLEMENT_WALLET,
    usdcDecimals: parsed.data.MOONPAY_CRYPTO_DECIMALS,
  };
}

const moonPayWebhookEnvSchema = z.object({
  MOONPAY_WEBHOOK_KEY: z.string().min(1),
});

export type MoonPayWebhookConfig = {
  /** "Webhook API key" from the MoonPay dashboard; keys the
   *  `Moonpay-Signature-V2` HMAC. Distinct from the secret key. */
  readonly webhookKey: string;
};

export function loadMoonPayWebhookConfig(
  env: NodeJS.ProcessEnv = process.env,
): MoonPayWebhookConfig {
  const parsed = moonPayWebhookEnvSchema.safeParse({
    MOONPAY_WEBHOOK_KEY: env["MOONPAY_WEBHOOK_KEY"],
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid MoonPay webhook configuration: ${details}`);
  }

  return { webhookKey: parsed.data.MOONPAY_WEBHOOK_KEY };
}
