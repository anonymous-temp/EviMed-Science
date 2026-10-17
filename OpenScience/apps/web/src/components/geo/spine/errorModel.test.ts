import { describe, expect, it } from "vitest";
import type { GeoErrorRow } from "@/lib/geoClient";
import { actionFixture } from "../__fixtures__/geoSpine";
import {
  claimRows,
  claimRowsOfEngine,
  correctionBrief,
  correctionsOf,
  enginesOf,
  errorSourceCounts,
  errorTrace,
  filterErrors,
  traceLine,
  traceSummary,
} from "./errorModel";

function row(overrides: Partial<GeoErrorRow> & Pick<GeoErrorRow, "id">): GeoErrorRow {
  return {
    engine: "doubao",
    statement: "每天注射一次",
    severity: "S3",
    errorType: "number",
    stability: "stable",
    citedSource: null,
    action: null,
    status: "open",
    snapshotId: "snap_1",
    firstSnapshotId: "snap_1",
    questionId: "q_1",
    fingerprint: "fp_a",
    claimId: "clm_a",
    evidenceQuote: "每周一次。",
    ...overrides,
  };
}

const traced = (domain: string, attribute: string | null = null) => ({ url: `https://${domain}/p`, domain, attribute, basis: "inline_marker" } as GeoErrorRow["citedSource"]);

describe("errorTrace", () => {
  it("reads the basis the server wrote", () => {
    expect(errorTrace({ citedSource: { url: null, domain: "a.cn", attribute: null, basis: "inline_marker" } })).toBe("traced");
    expect(errorTrace({ citedSource: { url: null, domain: null, attribute: null, basis: "not_attributable" } })).toBe("unattributable");
    expect(errorTrace({ citedSource: { url: null, domain: null, attribute: "none", basis: "no_retrieval" } })).toBe("noRetrieval");
  });

  it("reads a row written before the field the way those were written, and a row with no trace at all as not tied to a page", () => {
    expect(errorTrace({ citedSource: { url: "https://a.cn/p", domain: "a.cn", attribute: "owned" } })).toBe("traced");
    expect(errorTrace({ citedSource: { url: null, domain: null, attribute: "none" } })).toBe("noRetrieval");
    expect(errorTrace({ citedSource: null })).toBe("unattributable");
  });

  it("counts the three", () => {
    const counts = errorSourceCounts([
      row({ id: "a", citedSource: traced("a.cn") }),
      row({ id: "b", citedSource: traced("b.cn") }),
      row({ id: "c", citedSource: { url: null, domain: null, attribute: "none", basis: "no_retrieval" } }),
      row({ id: "d" }),
    ]);
    expect(counts).toEqual({ traced: 2, unattributable: 1, noRetrieval: 1 });
  });
});

describe("claimRows", () => {
  const rows = [
    row({ id: "a1", engine: "doubao", citedSource: traced("jiankang.cn", "farm") }),
    row({ id: "a2", engine: "yuanbao", citedSource: traced("baike.baidu.com", "encyclopedia") }),
    row({ id: "a3", engine: "qianwen", citedSource: { url: null, domain: null, attribute: "none", basis: "no_retrieval" } }),
    row({ id: "b1", engine: "deepseek", fingerprint: "fp_b", severity: "S4", statement: "孕期可用", claimId: "clm_b" }),
    row({ id: "c1", engine: "kimi", fingerprint: "fp_c", severity: "S2", status: "acting", statement: "可以掰开", claimId: null }),
    row({ id: "d1", engine: "doubao", fingerprint: "fp_d", severity: "S4", status: "closed", statement: "已经纠正过的", claimId: null }),
  ];

  it("makes one row of a claim told by several engines, with every engine and the gravest grade", () => {
    const claims = claimRows(rows);
    const a = claims.find((claim) => claim.key === "fp_a");
    expect(a?.engines).toEqual(["doubao", "yuanbao", "qianwen"]);
    expect(a?.count).toBe(3);
    expect(a?.severity).toBe("S3");
    expect(a?.rows.map((entry) => entry.id)).toEqual(["a1", "a2", "a3"]);
    expect(a?.traces).toEqual(["traced", "noRetrieval"]);
    expect(a?.evidenceQuote).toBe("每周一次。");
    expect(claims).toHaveLength(4);
  });

  it("puts the gravest live claim first and a closed one last, however grave it was", () => {
    expect(claimRows(rows).map((claim) => claim.key)).toEqual(["fp_b", "fp_a", "fp_c", "fp_d"]);
  });

  it("groups what is left after a narrowing: the engines of a claim are the engines that remain", () => {
    const only = filterErrors(rows, { show: "all", engine: "yuanbao" });
    const claims = claimRows(only);
    expect(claims).toHaveLength(1);
    expect(claims[0].engines).toEqual(["yuanbao"]);
    expect(claims[0].count).toBe(1);
    expect(claimRowsOfEngine(rows, "doubao").map((claim) => claim.key)).toEqual(["fp_a", "fp_d"]);
  });

  it("keys a row without a fingerprint by its claim, then by itself", () => {
    const loose = [row({ id: "x1", fingerprint: null, claimId: "clm_x" }), row({ id: "x2", fingerprint: null, claimId: "clm_x", engine: "kimi" }), row({ id: "y1", fingerprint: null, claimId: null })];
    expect(claimRows(loose).map((claim) => [claim.key, claim.count]).sort()).toEqual([["clm_x", 2], ["y1", 1]]);
  });

  it("lists the engines by how many rows each tells", () => {
    expect(enginesOf(rows)).toEqual(["doubao", "yuanbao", "qianwen", "deepseek", "kimi"]);
    expect(enginesOf([...rows, row({ id: "z1", engine: "kimi" }), row({ id: "z2", engine: "kimi" })])[0]).toBe("kimi");
  });
});

describe("filterErrors", () => {
  const rows = [
    row({ id: "s3", severity: "S3", status: "open" }),
    row({ id: "s1", severity: "S1", status: "open", engine: "kimi", errorType: "unfounded", questionId: "q_2", statement: "吃了就瘦" }),
    row({ id: "ac", severity: "S2", status: "awaiting_remeasure", citedSource: traced("x.cn") }),
    row({ id: "cl", severity: "S4", status: "closed" }),
  ];

  it("severe means a live S3 or S4; a closed one is never severe", () => {
    expect(filterErrors(rows, { show: "severe" }).map((error) => error.id)).toEqual(["s3"]);
    expect(filterErrors(rows, { show: "open" }).map((error) => error.id)).toEqual(["s3", "s1"]);
    expect(filterErrors(rows, { show: "acting" }).map((error) => error.id)).toEqual(["ac"]);
    expect(filterErrors(rows, { show: "all" })).toHaveLength(4);
  });

  it("narrows by engine, type, trace, the questions of a group and a word", () => {
    expect(filterErrors(rows, { show: "all", engine: "kimi" }).map((error) => error.id)).toEqual(["s1"]);
    expect(filterErrors(rows, { show: "all", type: "unfounded" }).map((error) => error.id)).toEqual(["s1"]);
    expect(filterErrors(rows, { show: "all", trace: "traced" }).map((error) => error.id)).toEqual(["ac"]);
    expect(filterErrors(rows, { show: "all", questions: new Set(["q_2"]) }).map((error) => error.id)).toEqual(["s1"]);
    expect(filterErrors(rows, { show: "all", query: "吃了" }).map((error) => error.id)).toEqual(["s1"]);
  });
});

describe("what the row says of its trace", () => {
  it("names the first page, how many more, and otherwise the one fact there is", () => {
    const claim = { rows: [row({ id: "a", citedSource: traced("jiankang.cn", "farm") }), row({ id: "b", citedSource: traced("baike.baidu.com", "encyclopedia") })] };
    expect(traceLine(claim)).toBe("出处 jiankang.cn（内容农场） 等 2 处");
    expect(traceSummary(claim)).toMatchObject({ more: 1, unattributable: 0, noRetrieval: 0 });
    expect(traceLine({ rows: [row({ id: "c", citedSource: { url: null, domain: null, attribute: null, basis: "not_attributable" } })] })).toBe("出处没有对应到某一页");
    expect(traceLine({ rows: [row({ id: "d", citedSource: { url: null, domain: null, attribute: "none", basis: "no_retrieval" } })] })).toBe("回答没有引用来源");
  });
});

describe("corrections", () => {
  it("an action that names any row of the claim is its correction, whatever its kind", () => {
    const claim = { rows: [row({ id: "a1" }), row({ id: "a2" })] };
    const mine = actionFixture({ key: "fill_gap:g:wrong", kind: "correct_error", need: { ...actionFixture({ key: "k", kind: "maintain" }).need, errorIds: ["a2"] } });
    const other = actionFixture({ key: "maintain:g:M-01", kind: "maintain" });
    expect(correctionsOf(claim, [other, mine])).toEqual([mine]);
    expect(correctionsOf(claim, [other])).toEqual([]);
  });

  it("writes the brief with who said what and what the label says, for the conversation to start from", () => {
    const [claim] = claimRows([row({ id: "a1", engine: "doubao" }), row({ id: "a2", engine: "kimi" })]);
    const brief = correctionBrief(claim, "信尔美");
    expect(brief).toContain("“每天注射一次”");
    expect(brief).toContain("信尔美的说明书不一致");
    expect(brief).toContain("说明书：每周一次。");
  });
});
