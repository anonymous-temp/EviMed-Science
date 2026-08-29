// Needs a temp module: copy clinicalEvidenceQuality.mjs to src/__probeExports.mjs and append
// `export { briefEnumerations, briefDroppedItems, parseBriefQuestions, briefCollapse };`
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { briefEnumerations, briefDroppedItems, parseBriefQuestions, briefCollapse } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/__probeExports.mjs";
const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const labels = JSON.parse(readFileSync(path.join(root, "audit/coverage-labels.json"), "utf8")).labels;
const collapse = (v) => String(v ?? "").replace(/\s+/g, "");
for (const label of labels) {
  const n = Number(/\d+/.exec(String(label.briefQuestion ?? ""))?.[0]);
  if (!n) continue;
  const name = `${label.rq}_研究任务`;
  const brief = readFileSync(path.join(briefRoot, `${name}.md`), "utf8");
  const report = readFileSync(path.join(root, name, "clinical-evidence-report.md"), "utf8");
  const ledgerPath = path.join(root, "audit/coverage", `${name}.question-coverage.json`);
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { entries: [] };
  const questions = parseBriefQuestions(brief) ?? [];
  const q = questions.find((x) => x.number === n);
  const entries = ledger.entries.filter((e) => Number(/\d+/.exec(e.id)?.[0]) === n);
  const statuses = [...new Set(entries.map((e) => e.status))].join("/") || "none";
  const runs = q ? briefEnumerations(q.text) : [];
  const dropped = q ? briefDroppedItems(q.text, briefCollapse(report)) : [];
  const absent = (label.siblingsChecked ?? []).filter((s) => s.present === false).map((s) => String(s.item));
  const targets = [String(label.briefItem ?? ""), ...absent];
  // does any extracted item correspond to something the label calls absent?
  const allItems = runs.flat();
  const itemInRun = allItems.filter((t) => targets.some((tt) => collapse(tt).includes(collapse(t)) || collapse(t).includes(collapse(tt))));
  const droppedMatch = dropped.filter((t) => targets.some((tt) => collapse(tt).includes(collapse(t)) || collapse(t).includes(collapse(tt))));
  // are the labelled absent siblings literally absent from the report?
  const literal = absent.map((a) => `${a}=${briefCollapse(report).includes(briefCollapse(a)) ? "PRESENT" : "absent"}`);
  console.log([
    label.labelId, label.rq, "q" + n, label.defectType, label.missReason,
    "| ledger:" + statuses + "(" + entries.length + ")",
    "| runs:" + runs.length + "/" + allItems.length,
    "| itemInRun:" + (itemInRun.join(",") || "-"),
    "| dropped:" + (dropped.join(",") || "-"),
    "| droppedMatch:" + (droppedMatch.join(",") || "-"),
    "| absentLiteral:" + (literal.join(",") || "-"),
  ].join(" "));
}
