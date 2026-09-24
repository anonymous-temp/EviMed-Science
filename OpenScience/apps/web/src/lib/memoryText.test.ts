import { describe, expect, it } from "vitest";
import { PLATFORM_CONTEXT_TAGS } from "@evimed/domain";
import {
  STATED_BASES, evidenceSourceLabel, isInference, looksInjected, memoryExcerpt, readableMemory,
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

// 「推断」 is the one mark a memory row keeps (2026-09-23 plan §5.6): whatever
// the researcher did not say, confirm or correct themselves.
describe("whether a memory is an inference", () => {
  const provenance = (basis: "stated" | "confirmed" | "edited" | "inferred" | "tool" | "assistant") =>
    ({ basis, observations: 1, runs: 1, conversations: 1 });

  it("is anything the researcher did not say, confirm or correct", () => {
    for (const basis of ["stated", "confirmed", "edited"] as const) {
      expect(STATED_BASES.has(basis)).toBe(true);
      expect(isInference({ provenance: provenance(basis), summary: "我是临床药师" })).toBe(false);
    }
    for (const basis of ["inferred", "tool", "assistant"] as const) {
      expect(isInference({ provenance: provenance(basis), summary: "常做老年用药研究" })).toBe(true);
    }
  });

  it("reads a record without provenance by its origin, and a machine envelope as never the researcher's word", () => {
    expect(isInference({ origin: "explicit", summary: "我是临床药师" })).toBe(false);
    expect(isInference({ origin: "inferred", summary: "常做老年用药研究" })).toBe(true);
    expect(isInference({ provenance: provenance("stated"), summary: "<evimed-brief>请以某某为题完成证据评审。</evimed-brief>" })).toBe(true);
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
