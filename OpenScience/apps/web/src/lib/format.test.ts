import { describe, expect, it } from "vitest";
import { formatClock, formatDateTime, humanSize } from "./format";

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
