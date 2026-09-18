import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluationLines, researchAgentUi } from "./researchAgentUi";
import type { WebResearchAgent } from "./apiClient";

// The catalogue the browser renders is `GET /api/agents`: every capability
// package that is not `visibility: internal`. A capability without a row here
// still renders, in English, and to a Chinese-speaking researcher that reads
// as "not really available". This walks the real package directory so a new
// capability cannot ship untranslated.
const capabilitiesDir = path.resolve(__dirname, "../../../../capabilities");

function publicCapabilityIds(): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(capabilitiesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readFileSync(path.join(capabilitiesDir, entry.name, "capability.yaml"), "utf8");
    const id = manifest.match(/^id:\s*(\S+)\s*$/m)?.[1];
    if (!id) throw new Error(`${entry.name}/capability.yaml has no id`);
    if (/^visibility:\s*internal\s*$/m.test(manifest)) continue;
    ids.push(id);
  }
  return ids.sort();
}

function stub(id: string): WebResearchAgent {
  return {
    id, version: "1.0.0", title: "English Title", category: "Category", description: "English description.", skill: id,
    estimatedMinutes: [10, 20], starterPrompts: ["English starter."], requiredInputs: [], optionalInputs: [], requiredTools: [],
    optionalTools: [], dataSources: [], outputs: [], completionChecks: [], runtimeAgent: `evimed-${id}`,
  } as WebResearchAgent;
}

describe("researchAgentUi", () => {
  it("translates every public capability the catalogue serves", () => {
    const ids = publicCapabilityIds();
    // Prove the walk walked: a broken path would yield [] and pass vacuously.
    expect(ids.length).toBeGreaterThanOrEqual(15);
    expect(ids).toContain("adr-analysis");
    const untranslated = ids.filter((id) => {
      const shown = researchAgentUi(stub(id));
      return shown.title === "English Title" || !/[一-鿿]/.test(shown.title) || !/[一-鿿]/.test(shown.description)
        || !shown.starterPrompts.length || !/[一-鿿]/.test(shown.starterPrompts[0]);
    });
    expect(untranslated).toEqual([]);
  });

  // The two-letter monograms (SA, CS, CE…) carried no information in a
  // Chinese interface (appendix D §10.4); a line icon and the name replace them.
  it("tells a researcher what each capability gives, what it cannot do, and how long it takes", () => {
    for (const id of publicCapabilityIds()) {
      const shown = researchAgentUi(stub(id));
      expect(shown.deliverables.length, `${id} lists no deliverable`).toBeGreaterThan(0);
      expect(shown.estimatedMinutes[0]).toBeLessThanOrEqual(shown.estimatedMinutes[1]);
      // The reader's "usually" comes from the display block, not the stub's planning estimate.
      expect(shown.estimatedMinutes).not.toEqual([10, 20]);
    }
  });

  it("keeps an unknown agent renderable instead of hiding it", () => {
    const shown = researchAgentUi(stub("not-a-capability"));
    expect(shown.title).toBe("English Title");
    expect(shown.deliverables).toEqual([]);
    expect(shown.evaluation).toBeNull();
  });

  it("says how well a capability has done only from what evals/ recorded", () => {
    expect(evaluationLines(null)).toEqual([]);
    expect(evaluationLines({ lastStatus: "not-run", lastRunAt: null })).toEqual(["还没有真实交付的记录。"]);
    expect(evaluationLines({ lastStatus: "accepted", lastRunAt: "2026-09-10", runs: 3, delivered: 2, typicalMinutes: 14 })).toEqual([
      "最近一次真实交付（2026年9月10日）已通过验收。",
      "评测记录 3 次，其中 2 次交付成功。",
      "交付成功的那几次，用时中位数约 14 分钟。",
    ]);
    expect(evaluationLines({ lastStatus: "failed", lastRunAt: "2026-09-08", runs: 1, delivered: 0, typicalMinutes: null })).toEqual([
      "最近一次真实交付（2026年9月8日）没有通过验收。",
      "评测记录 1 次，其中 0 次交付成功。",
    ]);
  });
});
