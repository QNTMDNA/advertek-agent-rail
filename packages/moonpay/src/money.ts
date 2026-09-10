/**
 * Integer minor-unit <-> decimal-string conversions for the MoonPay boundary.
 * MoonPay's REST API and widget parameters speak decimal amounts; internally
 * money stays a `bigint` in base units (USDC 6 decimals, fiat cents).
 */

export function baseUnitsToDecimalString(amountBaseUnits: bigint, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(`decimals must be a non-negative integer, got ${String(decimals)}`);
  }
  if (amountBaseUnits < 0n) {
    throw new RangeError("amounts must be non-negative");
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = amountBaseUnits / divisor;
  const fraction = (amountBaseUnits % divisor).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length > 0 ? `${whole.toString()}.${trimmed}` : whole.toString();
}

/** Parses a decimal string into minor units, rounding half-up on extra digits. */
export function decimalStringToMinorUnits(value: string, minorUnitDecimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Not a valid non-negative decimal string: ${value}`);
  }
  const [, wholePart = "0", fractionRaw = ""] = match;
  const kept = fractionRaw.slice(0, minorUnitDecimals).padEnd(minorUnitDecimals, "0");
  const roundingDigit = fractionRaw.charAt(minorUnitDecimals);
  let minorUnits = BigInt(wholePart + kept);
  if (roundingDigit !== "" && Number(roundingDigit) >= 5) {
    minorUnits += 1n;
  }
  return minorUnits;
}

/**
 * MoonPay returns amounts as JSON numbers. They are converted via their
 * shortest round-trip decimal representation (never via arithmetic) so the
 * only float involved is the one the vendor already emitted.
 */
export function jsonNumberToMinorUnits(value: number, minorUnitDecimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Not a valid non-negative amount: ${String(value)}`);
  }
  // toFixed avoids exponent notation for very small/large values.
  const asDecimal = value.toFixed(Math.min(20, minorUnitDecimals + 4));
  return decimalStringToMinorUnits(asDecimal, minorUnitDecimals);
}
