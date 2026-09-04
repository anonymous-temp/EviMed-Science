import { describe, expect, it } from "vitest";
import { formatDateTime, humanSize } from "./format";

describe("humanSize", () => {
  it("formats bytes, KB, and MB", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1024)).toBe("1 KB");
    expect(humanSize(2048)).toBe("2 KB");
    expect(humanSize(1024 * 1024)).toBe("1.0 MB");
    expect(humanSize(1536 * 1024)).toBe("1.5 MB");
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
