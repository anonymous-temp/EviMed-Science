import { describe, expect, it } from "vitest";
import type { GeoDiagnosis, GeoProject } from "@/lib/geoClient";
import { cell, diagnosisFilled, geoProject } from "./__fixtures__/geoTabs";
import {
  denominatorLine,
  engineConclusion,
  engineTrendConclusion,
  engineMatrix,
  headlineSentence,
  nextSteps,
  overviewTiles,
  railSteps,
  readingDelta,
  rivalRanking,
  severeOpenErrors,
  statedValue,
  trendConclusion,
} from "./geoOverviewModel";

/**
 * The honesty 总览 rests on. These are the rules the old board broke one at a
 * time: a rate with no denominator, a rise reported inside the noise, a
 * dropped engine counted as zero, a ranking with no reading behind it.
 */

const project = (overrides: Partial<GeoProject> = {}): GeoProject => geoProject({}, overrides);

describe("the denominator", () => {
  it("is the round's own, and names every engine it does not cover", () => {
    expect(denominatorLine(project(), diagnosisFilled))
      .toBe("按 3 个引擎、310 次有效回答计算 · 元宝、Kimi、千问本轮未测");
  });

  it("is not stated at all before anything was measured", () => {
    expect(denominatorLine(project(), null)).toBeNull();
    expect(denominatorLine(project(), { ...diagnosisFilled, round: null } as GeoDiagnosis)).toBeNull();
  });
});

describe("the headline", () => {
  it("says where we stand, whether it moved, and what is still open", () => {
    const moved = project({
      overview: {
        ...geoProject().overview,
        metrics: [{ key: "gvi", cell: { value: 61, numerator: null, denominator: 310, ciLow: null, ciHigh: null, status: "ok", dataType: "measured" }, target: 65, trend: [{ date: "a", value: 44 }, { date: "b", value: 61 }] }],
      },
    });
    const severe = { ...diagnosisFilled, errors: [{ ...diagnosisFilled.errors[0], severity: "S3" as const, status: "open" as const }] };
    expect(headlineSentence(moved, severe)).toBe("综合可见度 61，比上次高 17，目标 65；还有 1 条严重讲错待处理。");
  });

  it("calls a change inside the fluctuation band 持平", () => {
    const wobble = project({
      overview: {
        ...geoProject().overview,
        metrics: [{ key: "gvi", cell: { value: 46, numerator: null, denominator: 310, ciLow: null, ciHigh: null, status: "ok", dataType: "measured" }, target: null, trend: [{ date: "a", value: 44 }, { date: "b", value: 46 }] }],
      },
    });
    // The round measured a band of ±3, so two points is not a rise.
    expect(headlineSentence(wobble, diagnosisFilled)).toContain("与上次持平");
  });

  it("says nothing was measured rather than inventing a zero", () => {
    const fresh = project({ overview: { metrics: [], week: [], steps: {} } });
    expect(headlineSentence(fresh, null)).toBe("还没有测过各家 AI 怎么回答这个产品。");
  });

  it("counts only the grades that would reach a patient", () => {
    expect(severeOpenErrors(diagnosisFilled)).toBe(0);
    expect(severeOpenErrors({ ...diagnosisFilled, errors: [{ ...diagnosisFilled.errors[0], severity: "S4" }] })).toBe(1);
    expect(severeOpenErrors({ ...diagnosisFilled, errors: [{ ...diagnosisFilled.errors[0], severity: "S3", status: "closed" }] })).toBe(0);
  });
});

describe("the tiles", () => {
  it("lead with the index and end with the safety count", () => {
    const tiles = overviewTiles(project(), diagnosisFilled);
    expect(tiles[0].key).toBe("gvi");
    expect(tiles[0].lead).toBe(true);
    expect(tiles[tiles.length - 1].key).toBe("safety");
    expect(tiles.filter((tile) => tile.lead)).toHaveLength(1);
  });

  it("withhold a rate the sample cannot carry", () => {
    const thin = overviewTiles(project(), diagnosisFilled).find((tile) => tile.key === "citation");
    expect(thin?.value).toBe("样本不足");
    expect(thin?.value).not.toContain("6");
  });

  it("apply the fluctuation band to the index alone", () => {
    const tiles = overviewTiles(project(), diagnosisFilled);
    expect(tiles.find((tile) => tile.key === "gvi")?.noise).toBe(3);
    expect(tiles.find((tile) => tile.key === "mention")?.noise).toBeNull();
  });

  it("keep the sample in the tooltip, never in the tile", () => {
    const mention = overviewTiles(project(), diagnosisFilled).find((tile) => tile.key === "mention");
    expect(mention?.hint).toContain("310 次里 65 次");
    // The number and its unit are separate: `StatTile` sets 「%」 small beside
    // the figure, once, so a tile reads 「21 %」 at two sizes rather than 「21%」
    // at one. `tileValue` is where that split happens.
    expect(mention?.value).toBe("21");
    expect(mention?.unit).toBe("%");
  });
});

describe("the engine matrix", () => {
  it("states the best and worst engine instead of naming the chart", () => {
    // 「各引擎的走势」 is the chart's name, which a reader can already see.
    const rows = [
      { engine: "doubao", points: [{ cell: cell(44, 27, 62) }] },
      { engine: "deepseek", points: [{ cell: cell(12, 7, 60) }] },
    ];
    expect(engineTrendConclusion(rows as never)).toBe("豆包提及最多，DeepSeek最少");
    expect(engineTrendConclusion([{ engine: "doubao", points: [{ cell: cell(44, 27, 62) }] }] as never))
      .toBe("本轮只有豆包测到读数");
    // Nothing stated is not a zero and not a guess: the chart keeps its name.
    expect(engineTrendConclusion([{ engine: "kimi", points: [{ cell: cell(null, null, 12, { status: "insufficient" }) }] }] as never))
      .toBe("各引擎的最新读数");
    expect(engineTrendConclusion(null)).toBe("各引擎的最新读数");
  });

  it("gives an engine that dropped out a reason instead of a zero", () => {
    const matrix = engineMatrix(project(), diagnosisFilled);
    const qianwen = matrix.rows.find((row) => row.key === "qianwen");
    expect(qianwen?.unmeasured).toBe("本轮未测");
    expect(qianwen?.cells).toEqual([]);
  });

  it("says 只测提及 where the channel can only see a mention", () => {
    const baidu = engineMatrix(project(), diagnosisFilled).rows.find((row) => row.key === "baidu");
    expect(baidu?.cells.slice(1).map((cell) => cell.text)).toEqual(["只测提及", "只测提及", "只测提及"]);
    expect(baidu?.cells.slice(1).every((cell) => cell.value === null)).toBe(true);
  });

  it("names the engine that mentions us most, and says so when none does", () => {
    expect(engineConclusion(project(), diagnosisFilled)).toBe("豆包提到信尔美最多");
    expect(engineConclusion(project(), null)).toBe("这一轮还没有可以比较的引擎读数");
  });
});

describe("the ranking", () => {
  it("is drawn from readings, and is empty when there are none", () => {
    expect(rivalRanking(project(), null)).toEqual([]);
    expect(rivalRanking(project(), { ...diagnosisFilled, byPool: [{ pool: "P2", mention: diagnosisFilled.byPool[1].mention, topCompetitor: null, mainIssue: null }] })).toEqual([]);
  });

  it("puts us in it once, marked, beside the rivals actually measured", () => {
    const rows = rivalRanking(project(), diagnosisFilled);
    expect(rows.map((row) => [row.name, row.value, row.ours])).toEqual([
      ["司美格鲁肽", 48, false],
      ["信尔美", 21, true],
    ]);
    expect(rows.filter((row) => row.ours)).toHaveLength(1);
  });
});

describe("the rail and the next step", () => {
  it("marks the budget as the step waiting on the reader", () => {
    const waiting = geoProject({ sources: "done", distribution: "running" }, { budget: null });
    const rail = railSteps(waiting, () => "/x");
    expect(rail.find((step) => step.key === "distribution")).toMatchObject({ state: "waiting", note: "待你确认预算" });
    expect(nextSteps(waiting)[0]).toMatchObject({ key: "budget", state: "waiting" });
  });

  it("stops calling it a wait once the budget is set", () => {
    const funded = geoProject({ distribution: "running" }, { budget: { totalCny: 8000, dailyCny: 800 } });
    expect(railSteps(funded, () => "/x").find((step) => step.key === "distribution")).toMatchObject({ state: "active" });
    expect(nextSteps(funded).some((step) => step.key === "budget")).toBe(false);
  });
});

describe("a chart's heading", () => {
  it("is the conclusion, never the metric's bare name", () => {
    const cell = { value: 61, numerator: null, denominator: 310, ciLow: null, ciHigh: null, status: "ok" as const, dataType: "measured" as const };
    expect(trendConclusion("综合可见度", cell, 17, 3, "index")).toBe("综合可见度 61，比上次高 17");
    expect(trendConclusion("综合可见度", cell, 2, 3, "index")).toBe("综合可见度 61，与上次持平");
    expect(trendConclusion("综合可见度", cell, null, null, "index")).toBe("综合可见度基线 61");
    expect(trendConclusion("综合可见度", null, null, null, "index")).toBe("综合可见度这一轮还没有测到");
  });
});

describe("a reading", () => {
  it("is withheld under thirty answers", () => {
    expect(statedValue({ date: "a", value: 21, n: 22, k: 5 })).toBeNull();
    expect(statedValue({ date: "a", value: 21, n: 310, k: 65 })).toBe(21);
  });

  it("has no change to report before there are two of them", () => {
    expect(readingDelta([44])).toBeNull();
    expect(readingDelta([44, null, 61])).toBe(17);
  });
});
