// Six evasion constructions on one real delivered package (RQ-17), each run
// through BOTH halves of the new pipeline: the deterministic gate (with brief)
// and the live semantic judge.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { validateClinicalEvidencePackage, coverageJudgeContext } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";
import { CoverageJudge } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/coverageJudge.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const NAME = "RQ-17_研究任务";
const dir = path.join(root, NAME);
const read = (p, n) => (existsSync(path.join(p, n)) ? readFileSync(path.join(p, n), "utf8") : "");
const briefText = read(briefRoot, `${NAME}.md`);
const baseReport = read(dir, "clinical-evidence-report.md");
const baseLedger = JSON.parse(read(path.join(root, "audit/coverage"), `${NAME}.question-coverage.json`));
const key = readFileSync("/home/coder/workspace/EviMedScience/.evimed-local/secrets/deepseek.api-key", "utf8").trim();
const outPath = "/tmp/meas/redteam.jsonl";
const done = new Set(existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);

function gateInputs(reportText, ledger) {
  let matrix = null; let runReceipt = null;
  try { matrix = JSON.parse(read(dir, "clinical-evidence-matrix.json")); } catch { matrix = null; }
  try { runReceipt = JSON.parse(read(dir, "clinical-evidence-run.json")); } catch { runReceipt = null; }
  const sourceArtifacts = {};
  const addQuote = (p, q) => { if (typeof p === "string" && typeof q === "string") sourceArtifacts[p] = `${sourceArtifacts[p] ?? ""}\n\n${q}`; };
  for (const claim of matrix?.claims ?? []) { addQuote(claim.artifactPath, claim.supportQuote); for (const s of claim.supportingSources ?? []) addQuote(s.artifactPath, s.supportQuote); }
  for (const p of runReceipt?.successfulSourceArtifacts ?? []) sourceArtifacts[p] ??= "";
  const searchLogText = read(dir, "clinical-evidence-search.json");
  let queries = null;
  try { queries = (JSON.parse(searchLogText).queries ?? []).map((q) => q.query ?? q.queryString ?? q); } catch { queries = null; }
  return {
    reportText, matrix, runReceipt, sourceArtifacts, executedSearchQueries: queries, searchLogText,
    referencesText: read(dir, "references.bib"),
    citationLedgerText: read(dir, "citation-ledger.csv"),
    citationAuditText: read(dir, "citation-audit.md"),
    questionCoverageText: JSON.stringify(ledger),
    briefText,
  };
}
const coverageOnly = (issues) => issues.filter((i) => /^question-coverage\.json|^题面第|^工作区里的题面/.test(i));

const ASSERT = "无心血管诊断青年人为预防猝死而常备自服本品缺乏临床结局证据，减少咖啡因对心悸发作的干预证据为弱或阴性。";
const REWORDED = "未获心血管诊断的年轻人群把本品当作猝死预防药随身携带并自行服用，其临床结局证据为弱或阴性。";

const clone = (v) => JSON.parse(JSON.stringify(v));
function moveSentenceToDiscussion(report) {
  const lines = report.split("\n");
  const idx = lines.findIndex((l) => l.includes(ASSERT));
  lines[idx] = lines[idx].replace(ASSERT, "");
  const discussion = lines.findIndex((l) => /^##\s+讨论/.test(l));
  // first non-blank paragraph line of the discussion
  let target = discussion + 1;
  while (target < lines.length && !lines[target].trim()) target += 1;
  lines[target] = `${lines[target]}${ASSERT}`;
  return lines.join("\n");
}

const cases = [];
// C1 少登记: the ledger simply has no entry for the brief's fifth question.
{
  const ledger = clone(baseLedger);
  ledger.entries = ledger.entries.filter((e) => !e.id.startsWith("5."));
  cases.push({ id: "C1-under-register", report: baseReport, ledger, judge: false });
}
// C2a 合并 (one entry stands for two questions, count kept right by dropping the other)
{
  const ledger = clone(baseLedger);
  const fifth = ledger.entries.filter((e) => e.id.startsWith("5."));
  ledger.entries = ledger.entries.filter((e) => !e.id.startsWith("5."));
  const fourth = ledger.entries.find((e) => e.id === "4.1");
  fourth.question = `${fourth.question}；并及第五问：${fifth[0].question}`;
  cases.push({ id: "C2a-merge-drop", report: baseReport, ledger, judge: false });
}
// C2b 合并 (five ids kept, but one of them transcribes another question)
{
  const ledger = clone(baseLedger);
  const fourth = ledger.entries.find((e) => e.id === "4.1");
  const fifth = ledger.entries.find((e) => e.id === "5.1");
  fifth.question = fourth.question;
  cases.push({ id: "C2b-merge-retype", report: baseReport, ledger, judge: false });
}
// C3 假 answered: a gap flipped to answered against a real, anchored line that
// answers a different sub-question.
{
  const ledger = clone(baseLedger);
  const entry = ledger.entries.find((e) => e.id === "5.4");
  const donor = ledger.entries.find((e) => e.id === "1.1");
  delete entry.searches;
  entry.status = "answered";
  entry.reportLines = clone(donor.reportLines);
  entry.claimIds = clone(donor.claimIds);
  cases.push({ id: "C3-false-answered", report: baseReport, ledger, judge: true });
}
// C4 假 gap: an answered sub-question re-registered as a gap, with a search that
// really ran.
{
  const ledger = clone(baseLedger);
  const entry = ledger.entries.find((e) => e.id === "1.1");
  const donor = ledger.entries.find((e) => e.id === "5.2");
  delete entry.reportLines; delete entry.claimIds;
  entry.status = "gap";
  entry.searches = clone(donor.searches);
  cases.push({ id: "C4-false-gap", report: baseReport, ledger, judge: true });
}
// C5 绕开共享跨度: the same assertion in the same abstract, reworded so no
// eight-character span survives against the registered gap's question.
cases.push({ id: "C5-reword-around-span", report: baseReport.replace(ASSERT, REWORDED), ledger: clone(baseLedger), judge: true });
// C6 挪到讨论: the assertion word for word, moved out of the abstract.
cases.push({ id: "C6-move-to-discussion", report: moveSentenceToDiscussion(baseReport), ledger: clone(baseLedger), judge: true });
// Control: the package as delivered.
cases.push({ id: "C0-control", report: baseReport, ledger: clone(baseLedger), judge: true });

const wanted = process.argv.slice(2);
const selected = cases.filter((c) => (!wanted.length || wanted.includes(c.id)) && !done.has(c.id));

async function runCase(item) {
  const result = validateClinicalEvidencePackage(gateInputs(item.report, item.ledger));
  const record = {
    id: item.id,
    gate: coverageOnly(result.blockingIssues ?? []).map((i) => i.slice(0, 150).replace(/\s+/g, " ")),
    gateAll: (result.blockingIssues ?? []).length,
    verdicts: [], judged: null, failure: null,
  };
  if (item.judge && !process.env.NOJUDGE) {
    const context = coverageJudgeContext({ briefText, questionCoverageText: JSON.stringify(item.ledger), reportText: item.report });
    const judge = new CoverageJudge({
      coverageJudgeEnabled: true, coverageJudgeTimeoutMs: 420_000,
      deepseekProviderEnabled: true, deepseekApiKey: key,
      deepseekBaseUrl: "https://api.deepseek.com", deepseekModel: "deepseek-v4-pro", production: false,
    });
    const judged = await judge.judge(context);
    record.judged = judged.judged;
    record.failure = judge.lastFailure;
    record.verdicts = judged.verdicts.map((v) => ({ entryId: v.entryId, kind: v.kind, line: v.line, quote: v.quote.slice(0, 40), why: v.why }));
  }
  appendFileSync(outPath, `${JSON.stringify(record)}\n`);
  process.stderr.write(`${item.id}: gate=${record.gate.length} verdicts=${record.verdicts.length} judged=${record.judged}\n`);
}
await Promise.all(selected.map(runCase));
