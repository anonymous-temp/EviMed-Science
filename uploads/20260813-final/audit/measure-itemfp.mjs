// Needs a temp module: copy clinicalEvidenceQuality.mjs to src/__probeExports.mjs and append
// `export { briefEnumerations, briefDroppedItems, parseBriefQuestions, briefCollapse };`
// Every item the brief-item rule actually names, taken from the rule's own
// functions, then screened for near-misses and mis-cut spans.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { briefDroppedItems, parseBriefQuestions, briefCollapse } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/__probeExports.mjs";
const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const names = readdirSync(root).filter((n) => /^RQ-\d+_/.test(n) && existsSync(path.join(root, n, "clinical-evidence-report.md"))).sort();
const rows = [];
for (const name of names) {
  const brief = path.join(briefRoot, `${name}.md`);
  const ledgerPath = path.join(root, "audit/coverage", `${name}.question-coverage.json`);
  if (!existsSync(brief) || !existsSync(ledgerPath)) continue;
  const questions = parseBriefQuestions(readFileSync(brief, "utf8")) ?? [];
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const reportRaw = readFileSync(path.join(root, name, "clinical-evidence-report.md"), "utf8");
  const report = briefCollapse(reportRaw);
  const variantReport = report.replace(/证/g, "症");
  for (const q of questions) {
    const covered = ledger.entries.filter((e) => Number(/\d+/.exec(e.id)?.[0]) === q.number);
    if (!covered.some((e) => e.status === "answered")) continue;
    for (const term of briefDroppedItems(q.text, report)) {
      const t = briefCollapse(term);
      let verdict = "absent";
      if (/[^\p{Script=Han}A-Za-z0-9]/u.test(t)) verdict = "MIS-CUT-SPAN";
      else if (variantReport.includes(t.replace(/证/g, "症"))) verdict = "VARIANT-PRESENT";
      else {
        const near = [];
        for (let i = 0; i < t.length; i += 1) { const cut = t.slice(0, i) + t.slice(i + 1); if (cut.length >= 3 && report.includes(cut)) near.push(cut); }
        if (near.length) verdict = "NEAR:" + [...new Set(near)][0];
      }
      rows.push([name.slice(0, 5), "q" + q.number, term, verdict].join(" | "));
    }
  }
}
console.log(rows.join("\n"));
const total = rows.length;
console.log(`\nitems named ${total}; clean-absent ${rows.filter((r) => r.endsWith("| absent")).length}; suspect ${rows.filter((r) => !r.endsWith("| absent")).length}`);
