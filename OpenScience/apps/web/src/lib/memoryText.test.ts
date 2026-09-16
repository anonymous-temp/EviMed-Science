import { describe, expect, it } from "vitest";
import { evidenceSourceLabel, looksInjected, memoryExcerpt, readableMemory } from "./memoryText";

describe("a stored memory that is really a machine's own text", () => {
  // Eleven of these were active on the operator's account on 2026-09-16, each
  // a whole task brief stored as a durable preference at confidence 100%.
  const brief = "<evimed-brief> 请以《Therapeutic Reference Range》为题…完成证据评审。</evimed-brief>";

  it("is recognisable by its marker", () => {
    expect(looksInjected(brief)).toBe(true);
    expect(looksInjected("我希望回答控制在三段以内。")).toBe(false);
  });

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
    expect(looksInjected("<EVIMED-BRIEF>x</EVIMED-BRIEF>")).toBe(true);
    expect(readableMemory("<system-reminder>a</system-reminder> b <system-reminder>c</system-reminder>")).toBe("a b c");
  });
});

describe("where a memory's evidence came from", () => {
  // M6: the store's enum was printed as-is under each quote.
  it("reads as a phrase, and never as the store's identifier", () => {
    expect(evidenceSourceLabel("conversation_message")).toBe("对话中的原话");
    expect(evidenceSourceLabel("agent_run")).toBe("一次运行的记录");
    expect(evidenceSourceLabel("something_new")).toBe("其他来源");
  });
});
