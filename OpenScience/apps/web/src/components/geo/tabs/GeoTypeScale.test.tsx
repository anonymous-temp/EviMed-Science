import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  articlesFilled,
  diagnosisFilled,
  distributionFilled,
  evidenceFilled,
  geoProject,
  journeyFilled,
  monitoringFilled,
  questionsFilled,
  sourcesFilled,
} from "../__fixtures__/geoTabs";
import { AccuracyTab } from "./AccuracyTab";
import { ActionsTab } from "./ActionsTab";
import { OverviewTab } from "./OverviewTab";
import { PlanTab } from "./PlanTab";
import { QuestionsTab } from "./QuestionsTab";
import { SourcesTab } from "./SourcesTab";
import { VisibilityTab } from "./VisibilityTab";

/**
 * “一页至多四种字号 × 字重” (design spec §5.2 rule 1, acceptance row 4),
 * held per GEO tab. The measure is the one the fusion audit took by hand
 * (`walk-f-borders.json`: 7–15 on these pages): every element that carries
 * visible text of its own, read as the size its nearest type rung names and
 * the weight its nearest weight class names. It reads classes, not computed
 * styles, because jsdom computes none; the rungs are the token table's.
 */

const client = vi.hoisted(() => ({
  getGeoValue: vi.fn(async () => ({ version: 0, data: {}, research: [], impacts: [], observations: [], coverage: { assessed: 0, value: null } })),
  getGeoEvidence: vi.fn(),
  getGeoJourney: vi.fn(),
  getGeoQuestions: vi.fn(),
  getGeoDiagnosis: vi.fn(),
  getGeoSources: vi.fn(),
  getGeoArticles: vi.fn(),
  getGeoDistribution: vi.fn(),
  getGeoMonitoring: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

/** Every rung by its class, in px (the token table's `TYPE_SCALE`). */
const RUNG_PX: Readonly<Record<string, number>> = Object.freeze({
  badge: 12, meta: 12, caption: 12, compact: 13, ui: 14, "ui-sm": 14, body: 16, wordmark: 16, section: 18, heading: 20,
  title: 24, "doc-title": 24, display: 24, metric: 32, "metric-lg": 40, hero: 40,
});
const WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  "font-normal": 400, "font-medium": 500, "font-semibold": 600, "font-bold": 700,
});
const SIZE_CLASS = new RegExp(`^text-(${Object.keys(RUNG_PX).map((rung) => rung.replace("-", "\\-")).join("|")})$`);

function classOf(element: Element, read: (name: string) => number | null): number | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    for (const name of Array.from(node.classList)) {
      const value = read(name);
      if (value !== null) return value;
    }
    if (node.tagName === "STRONG" || node.tagName === "B") {
      if (read === weightOf) return 600;
    }
  }
  return null;
}

function sizeOf(name: string): number | null {
  const match = SIZE_CLASS.exec(name);
  return match ? RUNG_PX[match[1]] : null;
}

function weightOf(name: string): number | null {
  return WEIGHTS[name] ?? null;
}

function hidden(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.classList.contains("sr-only") || node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden")) return true;
  }
  return false;
}

/** The distinct “size × weight” pairs of the text inside `root`, e.g. `14/400`. */
function typeCombos(root: Element): string[] {
  const combos = new Set<string>();
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const text = Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim().length > 0);
    if (!text || hidden(element)) continue;
    combos.add(`${classOf(element, sizeOf) ?? RUNG_PX.ui}/${classOf(element, weightOf) ?? 400}`);
  }
  return [...combos].sort();
}

/**
 * What each tab may carry today — a ratchet, not the target. Measured on
 * 2026-09-27 after the GEO files were moved onto the named levels (metric-lg
 * 40/600 once a page, the title 18/600, body 14/400, meta 12/400): 总览 13 → 11,
 * 可见度 7 → 6, 准确与安全 10 → 10, 问题与回答 4 → 4, 信源 6 → 5, 行动 8 → 7,
 * 方案 6 → 5. Every pair above four comes from a shared primitive the GEO
 * files do not own: `StatTile` (unit 14/500, a non-lead number 32/600, a
 * placeholder word 20/600), `Delta` (12/500), `Rank` and `SeverityBadge`
 * (12/600), `FilterChips`' selected chip and a small `Button` (13/500),
 * `DataTable`'s highlighted row (14/500). A new pair fails here; a primitive
 * moving onto 400/600 only ever shrinks a set, so tighten the ceiling then.
 */
const CEILING: Readonly<Record<string, readonly string[]>> = Object.freeze({
  总览: ["12/400", "12/500", "12/600", "13/400", "13/500", "14/400", "14/500", "18/600", "20/600", "32/600", "40/600"],
  可见度: ["12/400", "13/400", "13/500", "14/400", "14/500", "18/600"],
  准确与安全: ["12/400", "12/500", "12/600", "13/400", "13/500", "14/400", "14/500", "18/600", "32/600", "40/600"],
  问题与回答: ["12/400", "13/400", "13/500", "14/400"],
  信源: ["12/400", "13/400", "13/500", "14/400", "18/600"],
  行动: ["12/400", "13/400", "13/500", "14/400", "14/500", "18/600", "32/600"],
  方案: ["12/400", "13/400", "13/500", "14/400", "14/600"],
});

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getGeoValue.mockResolvedValue({ version: 0, data: {}, research: [], impacts: [], observations: [], coverage: { assessed: 0, value: null } });
  client.getGeoEvidence.mockResolvedValue(evidenceFilled);
  client.getGeoJourney.mockResolvedValue(journeyFilled);
  client.getGeoQuestions.mockResolvedValue(questionsFilled);
  client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
  client.getGeoSources.mockResolvedValue(sourcesFilled);
  client.getGeoArticles.mockResolvedValue(articlesFilled);
  client.getGeoDistribution.mockResolvedValue(distributionFilled);
  client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
});

async function measured(tab: ReactElement, ready: string): Promise<string[]> {
  const { container } = render(<MemoryRouter>{tab}</MemoryRouter>);
  await screen.findAllByText(ready);
  await waitFor(() => expect(container.querySelector("[data-geo-tab-loading], .animate-pulse")).toBeNull());
  return typeCombos(container);
}

const props = { geoId: "geo_1", project: geoProject({ evidence: "done", questions: "done", diagnosis: "done", sources: "done", content: "done" }) };

describe("每个页签至多四种字号 × 字重 (ratchet)", () => {
  it.each([
    ["总览", () => <OverviewTab {...props} />, "下一步"],
    ["可见度", () => <VisibilityTab {...props} />, "哪一类问题里最容易被提到"],
    ["准确与安全", () => <AccuracyTab {...props} />, "事实准确率"],
    ["问题与回答", () => <QuestionsTab {...props} />, "恶心呕吐与胃肠反应"],
    ["信源", () => <SourcesTab {...props} />, "预期匹配"],
    ["行动", () => <ActionsTab {...props} />, "投放"],
    ["方案", () => <PlanTab {...props} />, "信尔美"],
  ] as const)("%s", async (name, tab, ready) => {
    const combos = await measured(tab(), ready);
    // The walk proves it walked: a tab that rendered nothing would pass any ceiling.
    expect(combos).toContain("12/400");
    expect(combos.filter((combo) => !CEILING[name].includes(combo)), `${name}: ${combos.join(" ")}`).toEqual([]);
    // Nothing is bold: Chinese is set at 400 or 600 (the 500s above are the primitives').
    expect(combos.filter((combo) => combo.endsWith("/700"))).toEqual([]);
  });
});
