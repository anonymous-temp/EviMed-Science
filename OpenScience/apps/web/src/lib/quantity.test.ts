import { describe, expect, it } from "vitest";
import { formatQuantity, parseQuantity, type QuantityPolicy } from "./quantity";
const scalar: QuantityPolicy = { scale: "scalar", unit: "", exponent: true };
describe("scientific quantities", () => {
  it("never coerces blank, partial exponent, nonfinite or whitespace to zero", () => {
    for (const draft of ["", " ", "1e", "-", "NaN", "Infinity", "1e400", "12mg"]) expect(parseQuantity(draft, scalar).ok).toBe(false);
    expect(parseQuantity("0", scalar)).toEqual({ ok: true, value: 0 });
    expect(parseQuantity("1e-3", scalar)).toEqual({ ok: true, value: 0.001 });
  });
  it("converts display percentages exactly once and bounds canonical values", () => {
    const percent: QuantityPolicy = { scale: "percent", unit: "%", min: 0, max: 1 };
    const parsed = parseQuantity("25", percent);
    expect(parsed).toEqual({ ok: true, value: .25 });
    expect(formatQuantity(.25, percent)).toBe("25");
    expect(parseQuantity("101", percent).ok).toBe(false);
    // Not by multiplying: 14.3 / 100 and 0.07 * 100 are not exact in binary floating point.
    expect(parseQuantity("14.3", percent)).toEqual({ ok: true, value: 0.143 });
    expect(formatQuantity(0.07, percent)).toBe("7");
    expect(formatQuantity(0.143, percent)).toBe("14.3");
    for (const shown of ["0.1", "0.7", "7", "14.3", "33.3", "57.1", "99.99", "0.000001", "100"]) {
      const parsed = parseQuantity(shown, percent);
      expect(parsed.ok && formatQuantity(parsed.value, percent), shown).toBe(shown);
    }
    expect(formatQuantity(0, percent)).toBe("0");
    expect(parseQuantity("0.25", { ...percent, scale: "fraction" })).toEqual({ ok: true, value: .25 });
  });
  it("enforces integer, exponent and precision policy without clamping", () => {
    expect(parseQuantity("1.5", { ...scalar, integer: true }).ok).toBe(false);
    expect(parseQuantity("1e2", { ...scalar, exponent: false }).ok).toBe(false);
    expect(parseQuantity("1.234", { ...scalar, precision: 2 }).ok).toBe(false);
    expect(parseQuantity("0", { ...scalar, gt: 0 }).ok).toBe(false);
  });
});
