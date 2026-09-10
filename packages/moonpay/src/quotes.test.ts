import { describe, expect, it, vi } from "vitest";
import { createMoonPayHttpClient, MoonPayApiError, type MoonPayFetchLike } from "./http-client.js";
import { getMoonPayBuyQuote, getMoonPaySellQuote } from "./quotes.js";
import { getMoonPaySellTransactionsByExternalId } from "./sell.js";

const config = {
  apiBaseUrl: "https://api.moonpay.com",
  publishableKey: "pk_test_pub",
  secretKey: "sk_test_sec",
  usdcCurrencyCode: "usdc_sol",
  defaultFiatCurrencyCode: "cad",
  usdcDecimals: 6,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createMoonPayHttpClient", () => {
  it("uses the publishable key as a query param for public endpoints", async () => {
    const fetchImpl = vi.fn<MoonPayFetchLike>().mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const client = createMoonPayHttpClient(config, { fetchImpl });
    await client.request({ method: "GET", path: "/v3/currencies", auth: "public" });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.moonpay.com/v3/currencies?apiKey=pk_test_pub");
    expect((init?.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("uses Api-Key authorization for secret endpoints and never the query string", async () => {
    const fetchImpl = vi.fn<MoonPayFetchLike>().mockResolvedValue(jsonResponse(200, []));
    const client = createMoonPayHttpClient(config, { fetchImpl });
    await client.request({ method: "GET", path: "/v3/sell_transactions/ext/x", auth: "secret" });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("sk_test_sec");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe("Api-Key sk_test_sec");
  });

  it("maps non-2xx responses to MoonPayApiError", async () => {
    const fetchImpl = vi
      .fn<MoonPayFetchLike>()
      .mockResolvedValue(jsonResponse(400, { message: "Unsupported currency", type: "BadRequestError" }));
    const client = createMoonPayHttpClient(config, { fetchImpl });
    await expect(
      client.request({ method: "GET", path: "/v3/currencies", auth: "public" }),
    ).rejects.toMatchObject({
      name: "MoonPayApiError",
      httpStatus: 400,
      vendorType: "BadRequestError",
    } satisfies Partial<MoonPayApiError>);
  });
});

describe("getMoonPayBuyQuote", () => {
  it("requests the fiat cost of an exact USDC amount and normalizes to minor units", async () => {
    const fetchImpl = vi.fn<MoonPayFetchLike>().mockResolvedValue(
      jsonResponse(200, {
        baseCurrencyAmount: 17.55,
        quoteCurrencyAmount: 12.5,
        quoteCurrencyPrice: 1.37,
        feeAmount: 4.99,
        extraFeeAmount: 0.5,
        networkFeeAmount: 0.01,
        totalAmount: 23.05,
        paymentMethod: "credit_debit_card",
        baseCurrency: { code: "CAD" },
        quoteCurrency: { code: "USDC_SOL" },
      }),
    );
    const client = createMoonPayHttpClient(config, { fetchImpl });
    const quote = await getMoonPayBuyQuote(
      { config, client },
      { amountBaseUnits: 12_500_000n, paymentMethod: "credit_debit_card" },
    );

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v3/currencies/usdc_sol/buy_quote");
    expect(url.searchParams.get("baseCurrencyCode")).toBe("cad");
    expect(url.searchParams.get("quoteCurrencyAmount")).toBe("12.5");
    expect(url.searchParams.get("paymentMethod")).toBe("credit_debit_card");

    expect(quote).toEqual({
      fiatCurrencyCode: "cad",
      cryptoCurrencyCode: "usdc_sol",
      cryptoAmountBaseUnits: 12_500_000n,
      fiatAmountMinorUnits: 1755n,
      moonPayFeeMinorUnits: 499n,
      partnerFeeMinorUnits: 50n,
      networkFeeMinorUnits: 1n,
      totalMinorUnits: 2305n,
      paymentMethod: "credit_debit_card",
    });
  });

  it("rejects malformed vendor payloads", async () => {
    const fetchImpl = vi
      .fn<MoonPayFetchLike>()
      .mockResolvedValue(jsonResponse(200, { totalAmount: "23.05" }));
    const client = createMoonPayHttpClient(config, { fetchImpl });
    await expect(
      getMoonPayBuyQuote({ config, client }, { amountBaseUnits: 1n }),
    ).rejects.toThrow();
  });
});

describe("getMoonPaySellQuote", () => {
  it("normalizes the payout for a USDC amount", async () => {
    const fetchImpl = vi.fn<MoonPayFetchLike>().mockResolvedValue(
      jsonResponse(200, {
        baseCurrencyAmount: 250,
        quoteCurrencyAmount: 245.12,
        quoteCurrencyPrice: 0.99,
        feeAmount: 2.5,
        extraFeeAmount: 0,
        payoutMethod: "ach_bank_transfer",
        baseCurrency: { code: "USDC_SOL" },
        quoteCurrency: { code: "USD" },
      }),
    );
    const client = createMoonPayHttpClient(config, { fetchImpl });
    const quote = await getMoonPaySellQuote(
      { config, client },
      { amountBaseUnits: 250_000_000n, fiatCurrencyCode: "usd" },
    );
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v3/currencies/usdc_sol/sell_quote");
    expect(url.searchParams.get("quoteCurrencyCode")).toBe("usd");
    expect(url.searchParams.get("baseCurrencyAmount")).toBe("250");
    expect(quote.cryptoAmountBaseUnits).toBe(250_000_000n);
    expect(quote.fiatPayoutMinorUnits).toBe(24_512n);
    expect(quote.moonPayFeeMinorUnits).toBe(250n);
    expect(quote.fiatCurrencyCode).toBe("usd");
  });
});

describe("getMoonPaySellTransactionsByExternalId", () => {
  it("returns every match normalized, via the secret-key endpoint", async () => {
    const fetchImpl = vi.fn<MoonPayFetchLike>().mockResolvedValue(
      jsonResponse(200, [
        {
          id: "sell_1",
          status: "waitingForDeposit",
          baseCurrencyAmount: 250,
          quoteCurrencyAmount: null,
          depositWalletAddress: "DepositAddr111",
          depositHash: null,
          externalTransactionId: "advertek:sweep:sw_1",
          updatedAt: "2026-09-10T12:00:00.000Z",
        },
        {
          id: "sell_2",
          status: "completed",
          baseCurrencyAmount: 250,
          quoteCurrencyAmount: 245.12,
          depositHash: "5abc",
          externalTransactionId: "advertek:sweep:sw_1",
          updatedAt: "2026-09-10T13:00:00.000Z",
        },
      ]),
    );
    const client = createMoonPayHttpClient(config, { fetchImpl });
    const txs = await getMoonPaySellTransactionsByExternalId(
      { config, client },
      "advertek:sweep:sw_1",
    );
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v3/sell_transactions/ext/advertek%3Asweep%3Asw_1");
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({
      id: "sell_1",
      status: "waitingForDeposit",
      cryptoAmountBaseUnits: 250_000_000n,
      fiatPayoutMinorUnits: undefined,
      depositWalletAddress: "DepositAddr111",
    });
    expect(txs[1]).toMatchObject({
      status: "completed",
      fiatPayoutMinorUnits: 24_512n,
      depositHash: "5abc",
      updatedAt: new Date("2026-09-10T13:00:00.000Z"),
    });
  });
});
