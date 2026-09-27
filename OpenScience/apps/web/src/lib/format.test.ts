import { describe, expect, it } from "vitest";
import {
  formatApproxCount,
  formatClock,
  formatConfidenceInterval,
  formatDate,
  formatDateTime,
  formatDay,
  formatDose,
  formatDuration,
  formatNumber,
  formatPercent,
  formatPValue,
  formatRange,
  formatRelativeTime,
  humanSize,
} from "./format";

const MINUS = "−";
const NBSP = " ";

describe("formatDate (spec §14.3)", () => {
  const day = new Date(2026, 8, 6, 14, 5);
  it("writes prose, table and short forms, never 2026/9/6", () => {
    expect(formatDate(day, "prose")).toBe("2026年9月6日");
    expect(formatDate(day, "iso")).toBe("2026-09-06");
    expect(formatDate(day)).toBe("2026-09-06");
    expect(formatDate(day, "short")).toBe("9月6日");
    expect(formatDate("2026-09-06", "prose")).toBe("2026年9月6日");
    expect(formatDate("nonsense")).toBe("");
    expect(formatDate(null)).toBe("");
  });
});

describe("formatRelativeTime (spec §14.4)", () => {
  const now = new Date(2026, 8, 26, 16, 0);
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts);
  it("walks the table: 刚刚, N 分钟前, a clock, 昨天, this year, before", () => {
    expect(formatRelativeTime(at(2026, 8, 26, 15, 59), now)).toBe("1 分钟前");
    expect(formatRelativeTime(new Date(now.getTime() - 20_000), now)).toBe("刚刚");
    expect(formatRelativeTime(at(2026, 8, 26, 15, 18), now)).toBe("42 分钟前");
    expect(formatRelativeTime(at(2026, 8, 26, 14, 5), now)).toBe("14:05");
    expect(formatRelativeTime(at(2026, 8, 25, 9, 7), now)).toBe("昨天 09:07");
    expect(formatRelativeTime(at(2026, 8, 14, 9, 7), now)).toBe("9月14日");
    expect(formatRelativeTime(at(2025, 8, 14, 9, 7), now)).toBe("2025-09-14");
  });
  it("never writes a negative age for a clock slightly ahead", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 90_000), now)).toBe("16:01");
    expect(formatRelativeTime("", now)).toBe("");
  });
});

describe("formatDuration (spec §14.4 rule 5)", () => {
  const s = 1_000;
  const min = 60 * s;
  const h = 60 * min;
  const d = 24 * h;
  it("writes the spec's own examples", () => {
    expect(formatDuration(45 * s)).toBe("45 秒");
    expect(formatDuration(2 * min + 30 * s)).toBe("2 分 30 秒");
    expect(formatDuration(25 * min)).toBe("25 分钟");
    expect(formatDuration(h + 5 * min)).toBe("1 小时 5 分");
    expect(formatDuration(3 * d)).toBe("3 天");
  });
  it("uses at most two units: seconds only under an hour, minutes only under a day", () => {
    expect(formatDuration(h + 5 * min + 40 * s)).toBe("1 小时 6 分");
    expect(formatDuration(2 * h)).toBe("2 小时");
    expect(formatDuration(d + 5 * h + 20 * min)).toBe("1 天 5 小时");
    expect(formatDuration(59 * min + 59 * s)).toBe("59 分 59 秒");
  });
  it("carries a rounding into the next unit instead of writing 60 秒 or 60 分", () => {
    expect(formatDuration(59.6 * s)).toBe("1 分钟");
    expect(formatDuration(h - 0.4 * s)).toBe("1 小时");
    expect(formatDuration(d - 20 * s)).toBe("1 天");
    expect(formatDuration(0)).toBe("0 秒");
  });
  it("is empty for a value that is not a duration", () => {
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(null)).toBe("");
  });
});

describe("numbers (spec §14.2)", () => {
  it("separates thousands and writes a real minus", () => {
    expect(formatNumber(1284)).toBe("1,284");
    expect(formatNumber(12345.678, 1)).toBe("12,345.7");
    expect(formatNumber(-3.25, 1)).toBe(`${MINUS}3.3`);
    expect(formatNumber(-0.001, 1)).toBe("0.0");
    expect(formatNumber(0.5)).toBe("0.5");
    expect(formatNumber(Number.NaN)).toBe("");
  });
  it("writes an approximate count in 万 and 亿, never k or w", () => {
    expect(formatApproxCount(9876)).toBe("9,876");
    expect(formatApproxCount(12_000)).toBe("1.2万");
    expect(formatApproxCount(10_000)).toBe("1万");
    expect(formatApproxCount(125_000)).toBe("12.5万");
    expect(formatApproxCount(340_000_000)).toBe("3.4亿");
    expect(formatApproxCount(99_999_999)).toBe("1亿");
  });
  it("sets % tight against one decimal", () => {
    expect(formatPercent(12.34)).toBe("12.3%");
    expect(formatPercent(61, 0)).toBe("61%");
    expect(formatPercent(-3.1)).toBe(`${MINUS}3.1%`);
  });
});

describe("units and ranges (spec §14.1, §14.5)", () => {
  it("joins a value to its unit with a no-break space, tight for % and °", () => {
    expect(formatDose(5, "mg")).toBe(`5${NBSP}mg`);
    expect(formatDose(37.5, "℃")).toBe(`37.5${NBSP}℃`);
    expect(formatDose(45, "%")).toBe("45%");
    expect(formatDose(null, "mg")).toBe("");
  });
  it("writes a range with ～ and the unit once, or on both ends for %, 万 and 亿", () => {
    expect(formatRange(5, 10, { unit: "mg" })).toBe(`5～10${NBSP}mg`);
    expect(formatRange(10, 20, { unit: "%" })).toBe("10%～20%");
    expect(formatRange(1, 2, { unit: "万" })).toBe("1万～2万");
    expect(formatRange("2026-09-01", "2026-09-26")).toBe("2026-09-01～2026-09-26");
    expect(formatRange(15, 25, { unit: "分钟" })).toBe(`15～25${NBSP}分钟`);
  });
  it("switches to 至 when an end is negative", () => {
    expect(formatRange(-4.1, -0.9)).toBe(`${MINUS}4.1 至 ${MINUS}0.9`);
    expect(formatRange(-4.1, 0.9, { unit: "mmHg" })).toBe(`${MINUS}4.1 至 0.9${NBSP}mmHg`);
    expect(formatRange(5, null)).toBe("");
  });
});

describe("statistics (spec §15.4)", () => {
  it("writes P values by the rules: two decimals, three below 0.01 or across 0.05, bounds at the ends", () => {
    expect(formatPValue(0.03)).toBe("P = 0.03");
    expect(formatPValue(0.004)).toBe("P = 0.004");
    expect(formatPValue(0.0004)).toBe("P < 0.001");
    expect(formatPValue(0.996)).toBe("P > 0.99");
    expect(formatPValue(0.046)).toBe("P = 0.046");
    expect(formatPValue(0.21)).toBe("P = 0.21");
    expect(formatPValue(1.2)).toBe("");
    expect(formatPValue(0)).toBe("P < 0.001");
  });
  it("writes an effect with its interval, 至 and U+2212 for a negative end", () => {
    expect(formatConfidenceInterval(0.76, 0.62, 0.91, { measure: "HR" })).toBe("HR 0.76（95% CI 0.62～0.91）");
    expect(formatConfidenceInterval(-2.5, -4.1, -0.9, { measure: "MD", unit: "mmHg", digits: 1 })).toBe(
      `MD ${MINUS}2.5${NBSP}mmHg（95% CI ${MINUS}4.1 至 ${MINUS}0.9）`,
    );
    expect(formatConfidenceInterval(1, null, 2)).toBe("");
  });
});

describe("humanSize", () => {
  it("formats bytes, KB, and MB", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1024)).toBe("1 KB");
    expect(humanSize(2048)).toBe("2 KB");
    expect(humanSize(1024 * 1024)).toBe("1 MB");
    expect(humanSize(1536 * 1024)).toBe("1.5 MB");
    expect(humanSize(50 * 1024 * 1024)).toBe("50 MB");
    expect(humanSize(1024 ** 3)).toBe("1 GB");
  });

  it("is one vocabulary and leaves what is not a size blank", () => {
    // U14: three copies disagreed, one saying KiB for the same number.
    expect(humanSize(1024 * 1024 * 3)).not.toMatch(/iB/);
    expect(humanSize(null)).toBe("");
    expect(humanSize(Number.NaN)).toBe("");
    expect(humanSize(-1)).toBe("");
  });
});

describe("formatClock", () => {
  it("is hour and minute in one locale, and blank for a value that is not a time", () => {
    expect(formatClock(new Date(2026, 0, 1, 14, 5).toISOString())).toBe("14:05");
    expect(formatClock(null)).toBe("");
    expect(formatClock("not a time")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("renders zh-CN date-time text", () => {
    const text = formatDateTime(new Date(2026, 0, 5, 13, 7));
    expect(text).toContain("2026");
    expect(text).toContain("13");
  });

  it("honours Intl field options", () => {
    const text = formatDateTime(new Date(2026, 6, 5, 13, 7), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(text).toContain("2026");
    expect(text).toContain("7");
  });
});

describe("formatDay", () => {
  const now = new Date(2026, 8, 24, 10, 0);

  // Appendix E #28: a list dates last year as 2025-12-31, not in prose form.
  it("dates a day as 9月22日 this year and 2025-12-31 before it", () => {
    expect(formatDay(new Date(2026, 8, 22, 23, 30).toISOString(), now)).toBe("9月22日");
    expect(formatDay(new Date(2025, 11, 31, 8, 0).toISOString(), now)).toBe("2025-12-31");
    expect(formatDay("2024-03-05", now)).toBe("2024-03-05");
  });

  it("reads a bare calendar day as written, not as UTC midnight", () => {
    expect(formatDay("2026-09-06", now)).toBe("9月6日");
    expect(formatDay("", now)).toBe("");
    expect(formatDay("not a date", now)).toBe("");
  });
});
