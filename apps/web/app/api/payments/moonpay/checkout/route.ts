import {
  checkMoonPayBuyEligibility,
  createMoonPayBuyCheckout,
  createMoonPayHttpClient,
  getMoonPayBuyQuote,
  loadMoonPayConfig,
  MoonPayApiError,
} from "@advertek/moonpay";
import { z, ZodError } from "zod";
import { jsonResponse } from "@/lib/json";

export const runtime = "nodejs";

/**
 * Fiat checkout for an order: returns a signed MoonPay Buy URL that charges
 * the customer in fiat and delivers the order's exact USDC amount to the
 * settlement wallet, plus an indicative all-in fiat quote. The order id is
 * bound into the URL (`externalTransactionId`) so the MoonPay webhook can
 * mark the right order paid. The URL is opened by the customer (D2C) or
 * handed to a human by the agent (A2A) — this route never redirects.
 *
 * MoonPay is a US-only rail for us (MoonPay geoblocks USDC for Canadian
 * residents), so the caller must identify the buyer's country and/or IP;
 * ineligible buyers get a 403 and should be routed to another rail.
 */
const checkoutRequestSchema = z.object({
  orderId: z.string().min(1),
  /** Buyer's ISO-3166-1 alpha-2 country, as known to the agent / checkout. */
  customerCountry: z.string().length(2).optional(),
  /** USDC base units as a base-10 integer string (JSON has no bigint). */
  amountBaseUnits: z.string().regex(/^\d+$/, "must be a base-10 integer string"),
  fiatCurrencyCode: z.string().length(3).optional(),
  customerEmail: z.string().email().optional(),
  externalCustomerId: z.string().min(1).optional(),
  redirectUrl: z.string().url().optional(),
  /**
   * Public IP the widget will be opened from. MoonPay requires it for live
   * widgets; pass it only when the caller is the customer's own browser
   * session (an agent's server IP would lock the human out).
   */
  customerIpAddress: z.string().ip().optional(),
}).refine((body) => body.customerCountry !== undefined || body.customerIpAddress !== undefined, {
  message: "customerCountry or customerIpAddress is required",
  path: ["customerCountry"],
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = checkoutRequestSchema.parse(await request.json());
    const config = loadMoonPayConfig();
    const amountBaseUnits = BigInt(body.amountBaseUnits);
    const client = createMoonPayHttpClient(config);

    const eligibility = await checkMoonPayBuyEligibility(
      { config, client },
      {
        ...(body.customerCountry ? { countryCode: body.customerCountry } : {}),
        ...(body.customerIpAddress ? { ipAddress: body.customerIpAddress } : {}),
      },
    );
    if (!eligibility.eligible) {
      return jsonResponse(
        {
          ok: false,
          rail: "moonpay-buy",
          error: `MoonPay checkout is not available to buyers in ${eligibility.countryCode}`,
          reason: eligibility.reason,
          countryCode: eligibility.countryCode,
          allowedCountries: config.allowedCountryCodes,
        },
        { status: 403 },
      );
    }

    const checkout = createMoonPayBuyCheckout(
      { config },
      {
        orderId: body.orderId,
        amountBaseUnits,
        ...(body.fiatCurrencyCode ? { fiatCurrencyCode: body.fiatCurrencyCode } : {}),
        ...(body.customerEmail ? { customerEmail: body.customerEmail } : {}),
        ...(body.externalCustomerId ? { externalCustomerId: body.externalCustomerId } : {}),
        ...(body.redirectUrl ? { redirectUrl: body.redirectUrl } : {}),
        ...(body.customerIpAddress ? { customerIpAddress: body.customerIpAddress } : {}),
      },
    );

    const quote = await getMoonPayBuyQuote(
      { config, client },
      {
        amountBaseUnits,
        ...(body.fiatCurrencyCode ? { fiatCurrencyCode: body.fiatCurrencyCode } : {}),
      },
    ).catch((error: unknown) => {
      if (error instanceof MoonPayApiError) {
        return undefined;
      }
      throw error;
    });

    return jsonResponse({
      ok: true,
      orderId: checkout.orderId,
      rail: "moonpay-buy",
      countryCode: eligibility.countryCode,
      url: checkout.url,
      amountBaseUnits: checkout.amountBaseUnits,
      currencyCode: checkout.currencyCode,
      fiatCurrencyCode: checkout.fiatCurrencyCode,
      indicativeFiat: quote
        ? {
            currencyCode: quote.fiatCurrencyCode,
            totalMinorUnits: quote.totalMinorUnits,
            feeMinorUnits:
              quote.moonPayFeeMinorUnits + quote.partnerFeeMinorUnits + quote.networkFeeMinorUnits,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid checkout request",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    return jsonResponse({ ok: false, error: "Checkout creation failed" }, { status: 500 });
  }
}
