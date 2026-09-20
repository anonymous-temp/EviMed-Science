import { describe, expect, it } from "vitest";
import { PLATFORM_CONTEXT_TAGS } from "@evimed/domain";
import {
  MEMORY_BASIS_LABELS, STATED_BASES, evidenceSourceLabel, looksInjected, memoryExcerpt, memoryStrength, memoryUsage, readableMemory,
} from "./memoryText";

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

  it("knows every tag the platform writes, not the four it used to", () => {
    // The page's list is the domain's list; a tag the platform adds is
    // recognised here the day the domain names it.
    for (const entry of PLATFORM_CONTEXT_TAGS.filter((item) => item.role === "injected")) {
      expect(looksInjected(`<${entry.tag} index="1">x</${entry.tag}>`)).toBe(true);
    }
    expect(looksInjected("<evimed-autopilot-episode>ep_1</evimed-autopilot-episode>")).toBe(true);
  });

  it("treats a correction the reader typed as theirs, and still drops the envelope", () => {
    const correction = "<evimed-correction>剂量按肾功能调整</evimed-correction>";
    expect(looksInjected(correction)).toBe(false);
    expect(readableMemory(correction)).toBe("剂量按肾功能调整");
  });
});

describe("how established a memory is", () => {
  it("is counted from its evidence, never a percentage", () => {
    expect(memoryStrength({ basis: "stated", observations: 3, runs: 2, conversations: 2 })).toBe("你说过 3 次 · 2 次对话");
    expect(memoryStrength({ basis: "inferred", observations: 5, runs: 4, conversations: 3 })).toBe("在 4 次研究中观察到");
    expect(memoryStrength({ basis: "confirmed", observations: 1, runs: 1, conversations: 1 })).toBe("你确认过 · 观察到 1 次");
    expect(memoryStrength({ basis: "tool", observations: 2, runs: 1, conversations: 1 })).toBe("2 处依据");
    for (const line of [
      memoryStrength({ basis: "stated", observations: 1, runs: 1, conversations: 1 }),
      memoryStrength(undefined, 2),
    ]) expect(line).not.toMatch(/%|置信/);
  });
});

// 「用过 7 次，上次 9月18日」. Counted at the one port every recall passes
// through, so a memory the platform never actually uses says so plainly rather
// than showing a zero the reader has to interpret.
describe("how often a memory has been used", () => {
  const day = (value: string) => new Date(value).toISOString().slice(5, 10);

  it("is a count and a date, or a plain sentence when there is neither", () => {
    expect(memoryUsage({ count: 7, lastUsedAt: "2026-09-18T00:00:00.000Z" }, day)).toBe("用过 7 次，上次 09-18");
    expect(memoryUsage({ count: 3, lastUsedAt: null }, day)).toBe("用过 3 次");
    expect(memoryUsage({ count: 0, lastUsedAt: null }, day)).toBe("还没用过");
    expect(memoryUsage(undefined, day)).toBe("还没用过");
  });
});

// The four words the page has for where a memory came from. 「来自工具结果」 and
// 「来自对话中的分析」 were the same thing said twice.
describe("where a memory came from", () => {
  it("is one of four labels, and an inference is never the researcher's own word", () => {
    expect(MEMORY_BASIS_LABELS.stated).toBe("你说的");
    expect(MEMORY_BASIS_LABELS.inferred).toBe("EviMed 推断");
    expect(MEMORY_BASIS_LABELS.tool).toBe("来自研究");
    expect(MEMORY_BASIS_LABELS.assistant).toBe("来自研究");
    for (const basis of ["stated", "confirmed", "edited"]) expect(STATED_BASES.has(basis)).toBe(true);
    for (const basis of ["inferred", "tool", "assistant"]) expect(STATED_BASES.has(basis)).toBe(false);
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
