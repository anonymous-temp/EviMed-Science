import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceDate, evidenceDay } from "./evidenceDate";

// Review L-7: the evidence pages wrote 「2026/10/1」 (Intl's zh-CN default) where the rest of the app writes 「10月1日」.
describe("a date on an evidence page", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-10T08:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("is the app's own day: 10月1日 within this year, the full date before it", () => {
    expect(evidenceDay("2026-10-01T12:00:00Z")).toBe("10月1日");
    expect(evidenceDay("2025-09-22T12:00:00Z")).toBe("2025-09-22");
  });
  it("never uses the slash form", () => {
    for (const value of ["2026-10-01T12:00:00Z", "2025-09-22T12:00:00Z"]) {
      expect(evidenceDay(value)).not.toMatch(/\d\/\d/);
      expect(evidenceDate(value)).not.toMatch(/\d\/\d/);
    }
  });
  it("adds the clock to the folded record's date, and shows what is not a date as it was written", () => {
    expect(evidenceDate("2026-10-01T12:00:00Z")).toMatch(/^10月1日 \d{2}:\d{2}$/);
    expect(evidenceDay("下周")).toBe("下周");
    expect(evidenceDate("下周")).toBe("下周");
  });
});
