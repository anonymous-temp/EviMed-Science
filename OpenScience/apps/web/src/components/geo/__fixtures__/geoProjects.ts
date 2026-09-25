/**
 * GEO fixtures in the shapes of build spec §3, for the shell's tests and the
 * UI walk: three products on the home list (a running program with a wrong
 * statement, a later one, a single-step one), and one project read in full.
 */
import type { GeoCell, GeoProject, GeoProjectSummary } from "@/lib/geoClient";

export function cell(value: number | null, numerator: number | null, denominator: number | null, status: GeoCell["status"] = "ok"): GeoCell {
  return { value, numerator, denominator, ciLow: null, ciHigh: null, status, dataType: "measured" };
}

const NONE = cell(null, null, null, "not_measurable");

export const GEO_SUMMARIES: GeoProjectSummary[] = [
  {
    id: "geo_masi",
    projectId: "p-masi",
    name: "玛仕度肽注射液",
    product: { brandName: "信尔美", genericName: "玛仕度肽注射液" },
    coverageDays: 92,
    engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"],
    status: "active",
    steps: {
      evidence: { status: "done", requested: true },
      journey: { status: "done", requested: true },
      questions: { status: "done", requested: true },
      diagnosis: { status: "done", requested: true },
      sources: { status: "done", requested: true },
      content: { status: "running", requested: true, note: "14/20" },
      distribution: { status: "running", requested: true, note: "8/20" },
      monitoring: { status: "running", requested: true, note: "第 3 周" },
    },
    headline: {
      gvi: { ...cell(38, null, 1240), target: 55, trend: [31, 33, 36, 38] },
      mention: cell(18, 56, 310),
    },
    alert: { wrongOurs: 2, safety: 0, text: null },
    startedAt: "2026-10-01",
    updatedAt: "2026-10-20T08:00:00Z",
  },
  {
    id: "geo_mitiao",
    projectId: "p-mitiao",
    name: "米曲菌胰酶片",
    product: { brandName: null, genericName: "米曲菌胰酶片" },
    coverageDays: 91,
    engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"],
    status: "active",
    steps: {
      evidence: { status: "done", requested: true },
      journey: { status: "done", requested: true },
      questions: { status: "done", requested: true },
      diagnosis: { status: "done", requested: true },
      sources: { status: "done", requested: true },
      content: { status: "done", requested: true },
      distribution: { status: "done", requested: true },
      monitoring: { status: "running", requested: true },
    },
    headline: {
      gvi: { ...cell(61, null, 1500), target: 62, trend: [48, 55, 59, 61] },
      mention: cell(44, 20, 12, "insufficient"),
    },
    alert: { wrongOurs: 0, safety: 0, text: null },
    startedAt: "2026-09-01",
    updatedAt: "2026-10-20T08:00:00Z",
  },
  {
    id: "geo_xinli",
    projectId: "p-xinli",
    name: "注射用重组人脑利钠肽",
    product: { brandName: null, genericName: "注射用重组人脑利钠肽" },
    coverageDays: 90,
    engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"],
    status: "active",
    steps: {
      evidence: { status: "minimal", requested: false },
      diagnosis: { status: "minimal", requested: false },
      sources: { status: "done", requested: true },
    },
    headline: { gvi: { ...NONE, target: null, trend: [] }, mention: NONE },
    alert: { wrongOurs: 0, safety: 0, text: null },
    updatedAt: "2026-10-18T08:00:00Z",
  },
];

export const GEO_PROJECT: GeoProject = {
  id: "geo_masi",
  projectId: "p-masi",
  name: "玛仕度肽注射液",
  product: { brandName: "信尔美", genericName: "玛仕度肽注射液", identityStatus: "confirmed" },
  competitors: [{ brandName: "诺和盈", genericName: "司美格鲁肽注射液", reason: "同适应证" }],
  coverageDays: 92,
  engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"],
  tier: "2",
  budget: { totalCny: 8000, dailyCny: 800 },
  status: "active",
  steps: GEO_SUMMARIES[0].steps,
  sessionId: "ses_geo_masi",
  startedAt: "2026-10-01",
  overview: {
    steps: GEO_SUMMARIES[0].steps,
    metrics: [
      { key: "gvi", cell: cell(38, null, 1240), target: 55, trend: [{ date: "2026-09-29", value: 31 }, { date: "2026-10-06", value: 33 }, { date: "2026-10-13", value: 33 }, { date: "2026-10-20", value: 38 }] },
      { key: "mention", cell: cell(18, 56, 310), target: 35, trend: [{ date: "2026-10-06", value: 9 }, { date: "2026-10-13", value: 12 }, { date: "2026-10-20", value: 18 }] },
      { key: "accuracy", cell: cell(92, 285, 310), target: 98, trend: [{ date: "2026-10-06", value: 88 }, { date: "2026-10-13", value: 92 }] },
      { key: "citation", cell: cell(6, 2, 24, "insufficient"), target: 20, trend: [{ date: "2026-10-06", value: 2 }, { date: "2026-10-13", value: 6 }] },
    ],
    week: [
      { kind: "first_cited", text: "豆包在「打了减重针恶心要不要停药」一类问题里开始引用你在 39 健康网发布的科普稿。", tab: "answers", ref: { snapshotId: "snap_1" }, at: "2026-10-20T02:00:00Z" },
      { kind: "wrong_ours", text: "DeepSeek 仍把用法说成「每天注射一次」，出处是一条百科词条，纠错已提交。", tab: "answers", ref: { snapshotId: "snap_2" }, at: "2026-10-20T01:00:00Z" },
      { kind: "competitor", text: "「和司美格鲁肽怎么选」一类问题，头部竞品提及率上升 9 个点。", tab: "sources", ref: null, at: "2026-10-19T01:00:00Z" },
      { kind: "indexed", text: "6 篇证据卡片已被百度收录。", tab: "distribution", ref: null, at: "2026-10-17T01:00:00Z" },
    ],
  },
};
