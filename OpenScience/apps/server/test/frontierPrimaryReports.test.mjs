// A top journal's research paper read through the reports of it (c3-primary, 2026-10-25): the pure parts — who the paper is, what the
// model's answer must hold, the text and its hash, the reader-text order, the longer wait — and the lever's place in the deployment.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { frontierLeadInstructions, buildLeadInput, frontierWriteLead } from "../src/frontierLead.mjs";
import { FRONTIER_PRIMARY_GIVE_UP_MS, FRONTIER_TEXT_GIVE_UP_MS, frontierReaderText, frontierTextGiveUpMs, frontierTextGivenUp } from "../src/frontierPipeline.mjs";
import {
  FRONTIER_PRIMARY_LIMITS, FRONTIER_REPORTS_BASIS, FRONTIER_REPORTS_LEAD_LINE, buildReportsInput, frontierLexicalScore, frontierPrimarySource,
  frontierReportBody, frontierReportsSha, frontierReportsText, verifyReportsAnswer,
} from "../src/frontierPrimaryReports.mjs";
import { frontierSettledParagraphs, frontierTidyBasis } from "../src/frontierReaderTidy.mjs";
import { frontierTextTokens } from "../src/frontierEvents.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const DAY = 86_400_000;

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return loadConfig({ rootDir: repoRoot }); } finally { process.env = saved; }
}

test("a top journal is a journal of authority four or five", () => {
  assert.equal(frontierPrimarySource({ source_type: "journal", authority: 5 }), true);
  assert.equal(frontierPrimarySource({ source_type: "journal", authority: "4" }), true);
  assert.equal(frontierPrimarySource({ source_type: "journal", authority: 3 }), false);
  assert.equal(frontierPrimarySource({ source_type: "media", authority: 5 }), false);
  assert.equal(frontierPrimarySource(null), false);
});

test("a top journal's entry is waited for twenty-one days, the others fourteen — for the item's give-up too", () => {
  assert.equal(FRONTIER_PRIMARY_GIVE_UP_MS, 21 * DAY);
  assert.equal(frontierTextGiveUpMs({ source_type: "journal", authority: 5 }), 21 * DAY);
  assert.equal(frontierTextGiveUpMs({ source_type: "journal", authority: 3 }), FRONTIER_TEXT_GIVE_UP_MS);
  const now = new Date("2026-10-25T00:00:00Z");
  const item = (/** @type {number} */ days) => ({ first_seen_at: new Date(now.getTime() - days * DAY).toISOString() });
  const top = { source_type: "journal", authority: 5 };
  assert.equal(frontierTextGivenUp({ item: item(15), now, source: top }), false);
  assert.equal(frontierTextGivenUp({ item: item(21), now, source: top }), true);
  assert.equal(frontierTextGivenUp({ item: item(15), now, source: { source_type: "journal", authority: 3 } }), true);
  assert.equal(frontierTextGivenUp({ item: item(15), now }), true, "without a source: the usual fourteen days");
});

const shown = [
  { title: "DeLLphi-305：tarlatamab联合度伐利尤单抗 / #ESMO26: DeLLphi-305 with tarlatamab", body: "DeLLphi-305试验显著改善总生存。" },
  { title: "Roche's giredestrant trial", body: "罗氏的giredestrant在乳腺癌3期试验中读出结果。" },
];

test("the answer holds only reports that were shown, each with a phrase of its own words; a paper that is not research takes none", () => {
  const good = verifyReportsAnswer({ paper: "research", reports: [{ id: "r1", anchor: "dellphi-305试验" }] }, shown);
  assert.deepEqual(good.issues, []);
  assert.deepEqual(good.output, { paper: "research", reports: [{ index: 0, anchor: "dellphi-305试验" }] });
  assert.deepEqual(verifyReportsAnswer({ paper: "research", reports: [] }, shown).issues, [], "no report is an answer");
  assert.deepEqual(verifyReportsAnswer({ paper: "other", reports: [{ id: "r1", anchor: "DeLLphi-305" }] }, shown).output, { paper: "other", reports: [] });
  const bad = verifyReportsAnswer({ paper: "maybe", reports: [{ id: "r9", anchor: "DeLLphi-305" }, { id: "r2", anchor: "tarlatamab" }, { id: "r1", anchor: "abc" }] }, shown);
  assert.equal(bad.issues.length, 4);
  assert.match(bad.issues.join(" "), /research 或 other/);
  assert.match(bad.issues.join(" "), /没有这个报道编号：r9/);
  assert.match(bad.issues.join(" "), /r2 的 anchor/);
  assert.match(bad.issues.join(" "), /r1 的 anchor/);
  assert.deepEqual(verifyReportsAnswer(null, shown).output, { paper: "other", reports: [] });
  const twice = verifyReportsAnswer({ paper: "research", reports: [{ id: "r1", anchor: "DeLLphi-305" }, { id: "r1", anchor: "总生存" }] }, shown);
  assert.equal(twice.output.reports.length, 1, "a report is named once");
});

test("the model is shown the paper and the numbered reports, bounded", () => {
  const input = JSON.parse(buildReportsInput({ paper: { titleRaw: "T".repeat(500), journal: "NEJM", doi: "10.1056/x" }, candidates: shown.map((c, i) => ({ sourceName: `S${i}`, ...c })) }));
  assert.equal(input.paper.title.length, 400);
  assert.deepEqual(input.reports.map((/** @type {any} */ r) => [r.id, r.source]), [["r1", "S0"], ["r2", "S1"]]);
  assert.equal(frontierReportBody({ lead_zh: "导读。", summary_zh: "摘要。" }), "导读。", "the 导读 where there is one");
  assert.equal(frontierReportBody({ lead_zh: " ", summary_zh: "摘要。" }), "摘要。");
  assert.equal(frontierReportBody({ summary_zh: "x".repeat(2000) }).length, FRONTIER_PRIMARY_LIMITS.reportChars);
});

test("the reports' text is one paragraph per report under its source's name, and its hash is its own basis", () => {
  const text = frontierReportsText([{ sourceName: "Endpoints News", body: "死亡风险降低58%。" }, { sourceName: "医学界", body: "" }, { sourceName: "ESMO on X", body: "总生存改善。" }]);
  assert.equal(text, "Endpoints News：死亡风险降低58%。\n\nESMO on X：总生存改善。");
  assert.equal(frontierReportsText([{ sourceName: "x", body: " " }]), null);
  assert.ok(frontierReportsSha(text ?? "").startsWith(FRONTIER_REPORTS_BASIS));
  assert.notEqual(frontierReportsSha("a"), frontierReportsSha("b"));
  const texts = { reader_reports: text };
  assert.deepEqual(frontierTidyBasis(texts, "reports"), { text, sha: frontierReportsSha(text ?? "") });
  // A verdict made for this text keeps its paragraphs; a verdict for another does not.
  assert.deepEqual(frontierSettledParagraphs(text ?? "", "reports", { source: "reports", sha: frontierReportsSha(text ?? ""), drop: [0] }).length, 1);
});

test("the reports are the last of the reader's texts: the summary, the excerpt, the abstract and the body come before them", () => {
  const texts = { reader_reports: "Endpoints News：x" };
  assert.deepEqual(frontierReaderText(texts), { source: "reports", text: "Endpoints News：x" });
  assert.equal(frontierReaderText({ ...texts, reader_summary: "A summary of a record." })?.source, "summary");
  assert.equal(frontierReaderText({ ...texts, body_excerpt: "A page." })?.source, "excerpt");
  assert.equal(frontierReaderText({ ...texts, abstract_raw: "Background: x." })?.source, "abstract");
  assert.equal(frontierReaderText({ ...texts, body_text: "The whole text." })?.source, "body");
  assert.equal(frontierReaderText({ reader_reports: " " }), null);
});

test("without an embedder a report is a candidate when it shares the paper's words, or one long name it holds", () => {
  const paper = frontierTextTokens("Tarlatamab–Durvalumab Maintenance for Extensive-Stage Small-Cell Lung Cancer");
  const overlap = (/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) => [...a].filter((t) => b.has(t)).length / Math.min(a.size, b.size);
  const trial = frontierTextTokens("#ESMO26 DeLLphi-305 with the bispecific T-cell engager tarlatamab 联合度伐利尤单抗");
  const other = frontierTextTokens("Roche's giredestrant trial reads out in breast cancer 罗氏");
  assert.ok(frontierLexicalScore(paper, trial, overlap(paper, trial)) >= FRONTIER_PRIMARY_LIMITS.minOverlap, "tarlatamab is shared");
  assert.ok(frontierLexicalScore(paper, other, overlap(paper, other)) < FRONTIER_PRIMARY_LIMITS.minOverlap);
  const same = frontierTextTokens("Tarlatamab–Durvalumab Maintenance for Extensive-Stage Small-Cell Lung Cancer");
  assert.equal(frontierLexicalScore(paper, same, 1), 1 + 0, "a full overlap stays the overlap");
});

test("the 导读 of a paper read through reports is told whose reports they are, and every other basis is written as before", async () => {
  const base = frontierLeadInstructions("paper");
  assert.ok(!base.includes("据 {来源名"), "the shared instructions carry no word of it");
  assert.match(FRONTIER_REPORTS_LEAD_LINE, /据 \{来源名，用顿号隔开\}报道/);
  /** @type {string[]} */
  const seen = [];
  const editor = { writeJson: async (/** @type {string} */ instructions) => { seen.push(instructions); return { output: { lead_zh: null }, verification: "passed", error: null }; } };
  const input = { sourceName: "NEJM", titleRaw: "Tarlatamab", text: "Endpoints News：死亡风险降低58%。", genre: "paper" };
  await frontierWriteLead(editor, { ...input, kind: "reports" });
  await frontierWriteLead(editor, { ...input, kind: "abstract" });
  assert.equal(seen[0], `${base}\n${FRONTIER_REPORTS_LEAD_LINE}`);
  assert.equal(seen[1], base);
  assert.match(buildLeadInput({ ...input, kind: "reports" }), /\n正文（媒体报道摘编）：\nEndpoints News/);
});

test("the lever is read, forwarded to the container and written in the example environment", async () => {
  assert.equal(configUnder({}).frontierPrimaryReportsEnabled, true);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_PRIMARY_REPORTS_ENABLED: "false" }).frontierPrimaryReportsEnabled, false);
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.match(compose, /\n\s+OPEN_SCIENCE_FRONTIER_PRIMARY_REPORTS_ENABLED:\n/);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.match(example, /\nOPEN_SCIENCE_FRONTIER_PRIMARY_REPORTS_ENABLED=true\n/);
});
