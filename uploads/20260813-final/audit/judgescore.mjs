// Score judgelive.jsonl: re-verify every stored RAW model verdict against the
// current verification rules (so a rule change is re-measured without re-buying
// 29 model calls), then match what survives against the human labels.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { coverageJudgeContext } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";
import { verifiedCoverageVerdicts } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/coverageJudge.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const rows = readFileSync(path.join(root, "audit", "judgelive.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((line) => JSON.parse(line));
const labels = JSON.parse(readFileSync(path.join(root, "audit", "coverage-labels.json"), "utf8")).labels;
const kindOf = {
  question_substituted: "answer-not-responsive",
  gap_as_conclusion: "gap-answered-in-verdict",
  false_gap_declared: "false-gap",
};

function contextFor(name) {
  const coverage = path.join(root, "audit", "coverage", `${name}.question-coverage.json`);
  const brief = path.join(briefRoot, `${name}.md`);
  const report = path.join(root, name, "clinical-evidence-report.md");
  if (![coverage, brief, report].every((file) => existsSync(file))) return null;
  return coverageJudgeContext({
    briefText: readFileSync(brief, "utf8"),
    questionCoverageText: readFileSync(coverage, "utf8"),
    reportText: readFileSync(report, "utf8"),
  });
}

const perPackage = new Map();
const discardTotals = {};
let rawTotal = 0;
for (const row of rows) {
  const context = contextFor(row.name);
  if (!context || !Array.isArray(row.rawVerdicts)) {
    perPackage.set(row.name, { kept: [], judged: false, failure: row.failure ?? "no-raw" });
    continue;
  }
  rawTotal += row.rawVerdicts.length;
  const { kept, discarded } = verifiedCoverageVerdicts(row.rawVerdicts, context);
  for (const [reason, count] of Object.entries(discarded)) discardTotals[reason] = (discardTotals[reason] ?? 0) + count;
  perPackage.set(row.name, { kept, judged: true, failure: null });
}

const keptTotal = [...perPackage.values()].reduce((sum, item) => sum + item.kept.length, 0);
const byKind = {};
for (const item of perPackage.values()) for (const verdict of item.kept) byKind[verdict.kind] = (byKind[verdict.kind] ?? 0) + 1;

const semantic = labels.filter((label) => kindOf[label.defectType]);
let exact = 0;
let sameKind = 0;
let sameQuestion = 0;
const missed = [];
for (const label of semantic) {
  const item = perPackage.get(`${label.rq}_研究任务`);
  const number = Number(/\d+/.exec(String(label.briefQuestion ?? ""))?.[0]);
  const kept = item?.kept ?? [];
  const kind = kept.filter((verdict) => verdict.kind === kindOf[label.defectType]);
  const question = kept.filter((verdict) => Number(/\d+/.exec(verdict.entryId)?.[0]) === number);
  if (kind.some((verdict) => Number(/\d+/.exec(verdict.entryId)?.[0]) === number)) exact += 1;
  else missed.push(`${label.labelId} ${label.rq} ${label.defectType} -> ${item?.judged ? (kind.length ? `kind hit on ${kind.map((v) => v.entryId).join(",")}` : "no verdict of this kind") : `NOT JUDGED (${item?.failure})`}`);
  if (kind.length) sameKind += 1;
  if (question.length) sameQuestion += 1;
}

console.log(JSON.stringify({
  packages: perPackage.size,
  judged: [...perPackage.values()].filter((item) => item.judged).length,
  rawVerdicts: rawTotal,
  keptVerdicts: keptTotal,
  discarded: discardTotals,
  byKind,
  labels: {
    semantic: semantic.length,
    exactQuestionAndKind: exact,
    labelledQuestionNamedByAnyVerdict: sameQuestion,
    sameKindSomewhereInPackage: sameKind,
  },
}, null, 1));
console.log(missed.join("\n"));
if (process.env.DUMP) {
  for (const [name, item] of perPackage) {
    for (const verdict of item.kept) {
      console.log([name, verdict.entryId, verdict.kind, verdict.line, verdict.quote.replace(/\s+/g, " "), verdict.why].join(" | "));
    }
  }
}
