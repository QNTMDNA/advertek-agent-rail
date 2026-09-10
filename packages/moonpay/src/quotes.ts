import { z } from "zod";
import type { MoonPayConfig } from "./config.js";
import type { MoonPayHttpClient } from "./http-client.js";
import { baseUnitsToDecimalString, jsonNumberToMinorUnits } from "./money.js";

const FIAT_DECIMALS = 2;

const buyQuoteResponseSchema = z.object({
  baseCurrencyAmount: z.number().nonnegative(),
  quoteCurrencyAmount: z.number().nonnegative(),
  quoteCurrencyPrice: z.number().nonnegative(),
  feeAmount: z.number().nonnegative(),
  extraFeeAmount: z.number().nonnegative().default(0),
  networkFeeAmount: z.number().nonnegative().default(0),
  totalAmount: z.number().nonnegative(),
  paymentMethod: z.string().optional(),
  baseCurrency: z.object({ code: z.string() }),
  quoteCurrency: z.object({ code: z.string() }),
});

export interface MoonPayBuyQuote {
  readonly fiatCurrencyCode: string;
  readonly cryptoCurrencyCode: string;
  /** USDC the customer receives, in base units. */
  readonly cryptoAmountBaseUnits: bigint;
  /** Fiat spent on crypto before fees, in minor units (cents). */
  readonly fiatAmountMinorUnits: bigint;
  readonly moonPayFeeMinorUnits: bigint;
  readonly partnerFeeMinorUnits: bigint;
  readonly networkFeeMinorUnits: bigint;
  /** All-in fiat charge to the customer, in minor units. */
  readonly totalMinorUnits: bigint;
  readonly paymentMethod: string | undefined;
}

export interface GetBuyQuoteInput {
  readonly amountBaseUnits: bigint;
  readonly fiatCurrencyCode?: string;
  readonly paymentMethod?: string;
}

export interface QuoteDeps {
  readonly config: Pick<
    MoonPayConfig,
    "usdcCurrencyCode" | "defaultFiatCurrencyCode" | "usdcDecimals"
  >;
  readonly client: MoonPayHttpClient;
}

/**
 * What the customer will be charged in fiat for the order's USDC amount,
 * including MoonPay's fees. Informational: the widget re-quotes at checkout.
 * https://dev.moonpay.com/api-reference/widget/getbuyquote
 */
export async function getMoonPayBuyQuote(
  deps: QuoteDeps,
  input: GetBuyQuoteInput,
): Promise<MoonPayBuyQuote> {
  const fiat = (input.fiatCurrencyCode ?? deps.config.defaultFiatCurrencyCode).toLowerCase();
  const query: Record<string, string> = {
    baseCurrencyCode: fiat,
    quoteCurrencyAmount: baseUnitsToDecimalString(input.amountBaseUnits, deps.config.usdcDecimals),
  };
  if (input.paymentMethod) {
    query["paymentMethod"] = input.paymentMethod;
  }
  const raw = await deps.client.request({
    method: "GET",
    path: `/v3/currencies/${deps.config.usdcCurrencyCode}/buy_quote`,
    query,
    auth: "public",
  });
  const quote = buyQuoteResponseSchema.parse(raw);
  return {
    fiatCurrencyCode: quote.baseCurrency.code.toLowerCase(),
    cryptoCurrencyCode: quote.quoteCurrency.code.toLowerCase(),
    cryptoAmountBaseUnits: jsonNumberToMinorUnits(
      quote.quoteCurrencyAmount,
      deps.config.usdcDecimals,
    ),
    fiatAmountMinorUnits: jsonNumberToMinorUnits(quote.baseCurrencyAmount, FIAT_DECIMALS),
    moonPayFeeMinorUnits: jsonNumberToMinorUnits(quote.feeAmount, FIAT_DECIMALS),
    partnerFeeMinorUnits: jsonNumberToMinorUnits(quote.extraFeeAmount, FIAT_DECIMALS),
    networkFeeMinorUnits: jsonNumberToMinorUnits(quote.networkFeeAmount, FIAT_DECIMALS),
    totalMinorUnits: jsonNumberToMinorUnits(quote.totalAmount, FIAT_DECIMALS),
    paymentMethod: quote.paymentMethod,
  };
}

const sellQuoteResponseSchema = z.object({
  baseCurrencyAmount: z.number().nonnegative(),
  quoteCurrencyAmount: z.number().nonnegative(),
  quoteCurrencyPrice: z.number().nonnegative(),
  feeAmount: z.number().nonnegative(),
  extraFeeAmount: z.number().nonnegative().default(0),
  payoutMethod: z.string().optional(),
  baseCurrency: z.object({ code: z.string() }),
  quoteCurrency: z.object({ code: z.string() }),
});

export interface MoonPaySellQuote {
  readonly cryptoCurrencyCode: string;
  readonly fiatCurrencyCode: string;
  readonly cryptoAmountBaseUnits: bigint;
  /** Fiat paid out after fees, in minor units. */
  readonly fiatPayoutMinorUnits: bigint;
  readonly moonPayFeeMinorUnits: bigint;
  readonly partnerFeeMinorUnits: bigint;
  readonly payoutMethod: string | undefined;
}

export interface GetSellQuoteInput {
  readonly amountBaseUnits: bigint;
  readonly fiatCurrencyCode?: string;
  readonly payoutMethod?: string;
}

/**
 * Off-ramp quote: fiat payout for selling USDC from the settlement wallet.
 * Alternative to the OKX Convert path in `@advertek/treasury`.
 * https://dev.moonpay.com/api-reference/widget/getsellquote
 */
export async function getMoonPaySellQuote(
  deps: QuoteDeps,
  input: GetSellQuoteInput,
): Promise<MoonPaySellQuote> {
  const fiat = (input.fiatCurrencyCode ?? deps.config.defaultFiatCurrencyCode).toLowerCase();
  const query: Record<string, string> = {
    quoteCurrencyCode: fiat,
    baseCurrencyAmount: baseUnitsToDecimalString(input.amountBaseUnits, deps.config.usdcDecimals),
  };
  if (input.payoutMethod) {
    query["payoutMethod"] = input.payoutMethod;
  }
  const raw = await deps.client.request({
    method: "GET",
    path: `/v3/currencies/${deps.config.usdcCurrencyCode}/sell_quote`,
    query,
    auth: "public",
  });
  const quote = sellQuoteResponseSchema.parse(raw);
  return {
    cryptoCurrencyCode: quote.baseCurrency.code.toLowerCase(),
    fiatCurrencyCode: quote.quoteCurrency.code.toLowerCase(),
    cryptoAmountBaseUnits: jsonNumberToMinorUnits(
      quote.baseCurrencyAmount,
      deps.config.usdcDecimals,
    ),
    fiatPayoutMinorUnits: jsonNumberToMinorUnits(quote.quoteCurrencyAmount, FIAT_DECIMALS),
    moonPayFeeMinorUnits: jsonNumberToMinorUnits(quote.feeAmount, FIAT_DECIMALS),
    partnerFeeMinorUnits: jsonNumberToMinorUnits(quote.extraFeeAmount, FIAT_DECIMALS),
    payoutMethod: quote.payoutMethod,
  };
}
