import { describe, expect, it } from "vitest";
import {
  baseUnitsToDecimalString,
  decimalStringToMinorUnits,
  jsonNumberToMinorUnits,
} from "./money.js";

describe("baseUnitsToDecimalString", () => {
  it("formats USDC base units without trailing zeros", () => {
    expect(baseUnitsToDecimalString(12_500_000n, 6)).toBe("12.5");
    expect(baseUnitsToDecimalString(1n, 6)).toBe("0.000001");
    expect(baseUnitsToDecimalString(5_000_000n, 6)).toBe("5");
    expect(baseUnitsToDecimalString(0n, 6)).toBe("0");
  });

  it("rejects negatives", () => {
    expect(() => baseUnitsToDecimalString(-1n, 6)).toThrow(RangeError);
  });
});

describe("decimalStringToMinorUnits", () => {
  it("parses cents and USDC, rounding half-up past the precision", () => {
    expect(decimalStringToMinorUnits("12.34", 2)).toBe(1234n);
    expect(decimalStringToMinorUnits("12.345", 2)).toBe(1235n);
    expect(decimalStringToMinorUnits("12.344", 2)).toBe(1234n);
    expect(decimalStringToMinorUnits("7", 6)).toBe(7_000_000n);
    expect(decimalStringToMinorUnits("0.0000005", 6)).toBe(1n);
  });

  it("rejects negatives and junk", () => {
    expect(() => decimalStringToMinorUnits("-1", 2)).toThrow();
    expect(() => decimalStringToMinorUnits("1e3", 2)).toThrow();
  });
});

describe("jsonNumberToMinorUnits", () => {
  it("converts vendor floats via their decimal representation", () => {
    expect(jsonNumberToMinorUnits(19.99, 2)).toBe(1999n);
    expect(jsonNumberToMinorUnits(0.1 + 0.2, 2)).toBe(30n);
    expect(jsonNumberToMinorUnits(12.5, 6)).toBe(12_500_000n);
    expect(jsonNumberToMinorUnits(1e-7, 6)).toBe(0n);
    expect(jsonNumberToMinorUnits(123456789.123456, 6)).toBe(123_456_789_123_456n);
  });

  it("rejects NaN, Infinity and negatives", () => {
    expect(() => jsonNumberToMinorUnits(Number.NaN, 2)).toThrow();
    expect(() => jsonNumberToMinorUnits(Number.POSITIVE_INFINITY, 2)).toThrow();
    expect(() => jsonNumberToMinorUnits(-0.01, 2)).toThrow();
  });
});
