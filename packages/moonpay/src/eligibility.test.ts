import { describe, expect, it, vi, type Mock } from "vitest";
import { checkMoonPayBuyEligibility, lookupMoonPayGeo } from "./eligibility.js";
import type { MoonPayHttpClient } from "./http-client.js";

function clientReturning(body: unknown): { client: MoonPayHttpClient; request: Mock } {
  const request = vi.fn().mockResolvedValue(body);
  return { client: { request }, request };
}

const US = {
  alpha2: "US",
  state: "NY",
  isAllowed: true,
  isBuyAllowed: true,
  isSellAllowed: true,
};
const CA = { ...US, alpha2: "CA", state: "QC", isSellAllowed: false };

const config = { allowedCountryCodes: ["US"] };

describe("lookupMoonPayGeo", () => {
  it("queries /v3/ip_address with the public key and normalizes the result", async () => {
    const { client, request } = clientReturning({ ...US, state: "" });
    const geo = await lookupMoonPayGeo({ client }, "8.8.8.8");
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v3/ip_address",
      query: { ipAddress: "8.8.8.8" },
      auth: "public",
    });
    expect(geo).toEqual({
      countryCode: "US",
      stateCode: undefined,
      isBuyAllowed: true,
      isSellAllowed: true,
    });
  });

  it("treats isAllowed=false as blocking buy and sell", async () => {
    const geo = await lookupMoonPayGeo(
      { client: clientReturning({ ...US, isAllowed: false }).client },
      "1.1.1.1",
    );
    expect(geo.isBuyAllowed).toBe(false);
    expect(geo.isSellAllowed).toBe(false);
  });
});

describe("checkMoonPayBuyEligibility", () => {
  it("accepts an asserted allowed country without a network call", async () => {
    const { client, request } = clientReturning(US);
    await expect(checkMoonPayBuyEligibility({ config, client }, { countryCode: "us" })).resolves.toEqual({
      eligible: true,
      countryCode: "US",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an asserted country outside the allow-list", async () => {
    await expect(
      checkMoonPayBuyEligibility({ config, client: clientReturning(US).client }, { countryCode: "CA" }),
    ).resolves.toEqual({ eligible: false, countryCode: "CA", reason: "country-not-allowed" });
  });

  it("lets MoonPay's geolocation of the IP override an asserted US country", async () => {
    await expect(
      checkMoonPayBuyEligibility(
        { config, client: clientReturning(CA).client },
        { countryCode: "US", ipAddress: "142.112.0.1" },
      ),
    ).resolves.toEqual({ eligible: false, countryCode: "CA", reason: "country-not-allowed" });
  });

  it("rejects when MoonPay itself blocks buying from that IP", async () => {
    await expect(
      checkMoonPayBuyEligibility(
        { config, client: clientReturning({ ...US, isBuyAllowed: false }).client },
        { ipAddress: "8.8.8.8" },
      ),
    ).resolves.toEqual({ eligible: false, countryCode: "US", reason: "moonpay-buy-blocked" });
  });

  it("accepts an allowed IP with no asserted country", async () => {
    await expect(
      checkMoonPayBuyEligibility({ config, client: clientReturning(US).client }, { ipAddress: "8.8.8.8" }),
    ).resolves.toEqual({ eligible: true, countryCode: "US" });
  });

  it("requires at least one signal", async () => {
    await expect(checkMoonPayBuyEligibility({ config, client: clientReturning(US).client }, {})).rejects.toThrow(
      /countryCode or an ipAddress/,
    );
  });
});
