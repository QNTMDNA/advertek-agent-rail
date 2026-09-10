import { z } from "zod";
import type { MoonPayConfig } from "./config.js";
import type { MoonPayHttpClient } from "./http-client.js";

const ipAddressResponseSchema = z.object({
  alpha2: z.string().length(2),
  state: z.string().default(""),
  isAllowed: z.boolean(),
  isBuyAllowed: z.boolean(),
  isSellAllowed: z.boolean(),
});

export interface MoonPayGeo {
  /** ISO-3166-1 alpha-2, uppercase. */
  readonly countryCode: string;
  readonly stateCode: string | undefined;
  readonly isBuyAllowed: boolean;
  readonly isSellAllowed: boolean;
}

export interface GeoDeps {
  readonly client: MoonPayHttpClient;
}

/**
 * MoonPay's own geolocation of a customer IP and whether MoonPay will serve
 * it. https://dev.moonpay.com/api-reference/widget/getipaddress
 */
export async function lookupMoonPayGeo(deps: GeoDeps, ipAddress: string): Promise<MoonPayGeo> {
  const raw = await deps.client.request({
    method: "GET",
    path: "/v3/ip_address",
    query: { ipAddress },
    auth: "public",
  });
  const geo = ipAddressResponseSchema.parse(raw);
  return {
    countryCode: geo.alpha2.toUpperCase(),
    stateCode: geo.state === "" ? undefined : geo.state,
    isBuyAllowed: geo.isAllowed && geo.isBuyAllowed,
    isSellAllowed: geo.isAllowed && geo.isSellAllowed,
  };
}

export type MoonPayIneligibleReason = "country-not-allowed" | "moonpay-buy-blocked";

export type MoonPayBuyEligibility =
  | { readonly eligible: true; readonly countryCode: string }
  | {
      readonly eligible: false;
      readonly countryCode: string;
      readonly reason: MoonPayIneligibleReason;
    };

export interface BuyEligibilityDeps {
  readonly config: Pick<MoonPayConfig, "allowedCountryCodes">;
  readonly client: MoonPayHttpClient;
}

export interface BuyEligibilityInput {
  /** Buyer's country as asserted by the caller (agent / checkout form). */
  readonly countryCode?: string;
  /** Buyer's public IP; resolved via MoonPay when given. */
  readonly ipAddress?: string;
}

/**
 * Whether we will hand this buyer a MoonPay Buy URL. MoonPay geoblocks USDC
 * for several countries (notably CA), so we restrict the rail to
 * `allowedCountryCodes`. When an IP is supplied MoonPay's geolocation wins
 * over the asserted country; both must be present in the allow-list.
 */
export async function checkMoonPayBuyEligibility(
  deps: BuyEligibilityDeps,
  input: BuyEligibilityInput,
): Promise<MoonPayBuyEligibility> {
  const allowed = new Set(deps.config.allowedCountryCodes);

  if (input.ipAddress !== undefined) {
    const geo = await lookupMoonPayGeo({ client: deps.client }, input.ipAddress);
    if (!allowed.has(geo.countryCode)) {
      return { eligible: false, countryCode: geo.countryCode, reason: "country-not-allowed" };
    }
    if (!geo.isBuyAllowed) {
      return { eligible: false, countryCode: geo.countryCode, reason: "moonpay-buy-blocked" };
    }
    if (input.countryCode === undefined) {
      return { eligible: true, countryCode: geo.countryCode };
    }
  }

  const asserted = input.countryCode?.toUpperCase();
  if (asserted === undefined) {
    throw new Error("checkMoonPayBuyEligibility requires a countryCode or an ipAddress");
  }
  if (!allowed.has(asserted)) {
    return { eligible: false, countryCode: asserted, reason: "country-not-allowed" };
  }
  return { eligible: true, countryCode: asserted };
}
