import { describe, expect, it } from "vitest";
import { PLATFORM_CONTEXT_TAGS } from "@evimed/domain";
import { memoryExcerpt, readableMemory } from "./memoryText";

describe("a stored memory that is really a machine's own text", () => {
  // Eleven of these were active on the operator's account on 2026-09-16, each
  // a whole task brief stored as a durable preference at confidence 100%.
  const brief = "<evimed-brief> 请以《Therapeutic Reference Range》为题…完成证据评审。</evimed-brief>";

  it("shows the content without the envelope, and changes nothing else", () => {
    expect(readableMemory(brief)).toBe("请以《Therapeutic Reference Range》为题…完成证据评审。");
    expect(readableMemory("我希望回答控制在三段以内。")).toBe("我希望回答控制在三段以内。");
  });

  it("shortens a 4,000-character value without inventing a summary", () => {
    const long = `<evimed-brief>${"细节".repeat(3_000)}</evimed-brief>`;
    const excerpt = memoryExcerpt(long, 100);
    expect(excerpt).toHaveLength(101);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toContain("<evimed-brief>");
  });

  it("is case-insensitive and survives a repeated marker", () => {
    expect(readableMemory("<EVIMED-BRIEF>x</EVIMED-BRIEF>")).toBe("x");
    expect(readableMemory("<system-reminder>a</system-reminder> b <system-reminder>c</system-reminder>")).toBe("a b c");
  });

  it("knows every tag the platform writes, not the four it used to", () => {
    // The page's list is the domain's list; a tag the platform adds is
    // stripped here the day the domain names it.
    for (const entry of PLATFORM_CONTEXT_TAGS) {
      expect(readableMemory(`<${entry.tag} index="1">x</${entry.tag}>`)).toBe("x");
    }
    expect(readableMemory("<evimed-autopilot-episode>ep_1</evimed-autopilot-episode>")).toBe("ep_1");
  });

  it("drops the envelope around a correction the reader typed", () => {
    expect(readableMemory("<evimed-correction>剂量按肾功能调整</evimed-correction>")).toBe("剂量按肾功能调整");
  });
});
