// Per-label scoring of three arms against the 58 human labels.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { coverageJudgeContext } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";
import { verifiedCoverageVerdicts } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/coverageJudge.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const labels = JSON.parse(readFileSync(path.join(root, "audit/coverage-labels.json"), "utf8")).labels;
const base = JSON.parse(readFileSync("/tmp/gate-baseline.json", "utf8"));
const now = JSON.parse(readFileSync("/tmp/gate-brief.json", "utf8"));

// ---- parse gate messages into structured alarms -----------------------------
const collapse = (v) => String(v ?? "").replace(/\s+/g, "");
function alarmsOf(store) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const [name, result] of Object.entries(store)) {
    const rq = name.slice(0, 5);
    const list = [];
    for (const raw of result.blockingIssues ?? []) {
      const text = String(raw);
      let m;
      if ((m = /^question-coverage\.json 条目 ([^把]+)把题面第 (\d+) 问登记为 answered，但这一问点名的(.+?)在报告全篇一次未出现/s.exec(text))) {
        const terms = [...m[3].matchAll(/「([^」]+)」/g)].map((x) => x[1]);
        list.push({ rule: "brief-item", rq, number: Number(m[2]), ids: m[1].split(/[、,]/).map((s) => s.trim()).filter(Boolean), terms, text });
      } else if ((m = /^题面第 (\d+) 问在 question-coverage\.json 中没有任何条目/.exec(text))) {
        list.push({ rule: "brief-missing", rq, number: Number(m[1]), text });
      } else if ((m = /^question-coverage\.json 条目 (\S+) 的 question 不是题面第 (\d+) 问的原文/.exec(text))) {
        list.push({ rule: "brief-mismatch", rq, number: Number(m[2]), ids: [m[1]], text });
      } else if ((m = /^question-coverage\.json 台账格式无效：条目 (.+?) 的编号指向题面第 (\d+) 问/.exec(text))) {
        list.push({ rule: "brief-extra", rq, number: Number(m[2]), text });
      } else if ((m = /^question-coverage\.json 条目 (\S+?)（「(.*?)」）登记为 gap，(\S+?)第 (\d+) 行/s.exec(text))) {
        list.push({ rule: "gap-asserted", rq, number: Number(/\d+/.exec(m[1])?.[0]), ids: [m[1]], line: Number(m[4]), section: m[3], text });
      } else if ((m = /^摘要重述研究范围时把问题数从 (\d+) 改小到 (\d+)/.exec(text))) {
        list.push({ rule: "scope-understated", rq, held: Number(m[1]), claimed: Number(m[2]), text });
      } else if (/^question-coverage\.json 台账格式无效：文件缺失/.test(text)) {
        list.push({ rule: "ledger-missing", rq, text });
      } else if (/^question-coverage\.json 条目/.test(text)) {
        list.push({ rule: "other-coverage", rq, ids: [/条目 (\S+)/.exec(text)?.[1] ?? ""], text });
      }
    }
    out[rq] = list;
  }
  return out;
}
const baseAlarms = alarmsOf(base);
const newAlarms = alarmsOf(now);

// ---- judge verdicts, re-verified against current rules ----------------------
const judgeRows = readFileSync(path.join(root, "audit/judgelive.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const judgeByRq = {};
for (const row of judgeRows) {
  const name = row.name; const rq = name.slice(0, 5);
  const coverage = path.join(root, "audit/coverage", `${name}.question-coverage.json`);
  const brief = path.join(briefRoot, `${name}.md`);
  const report = path.join(root, name, "clinical-evidence-report.md");
  if (![coverage, brief, report].every(existsSync) || !Array.isArray(row.rawVerdicts)) { judgeByRq[rq] = { judged: false, kept: [] }; continue; }
  const context = coverageJudgeContext({
    briefText: readFileSync(brief, "utf8"),
    questionCoverageText: readFileSync(coverage, "utf8"),
    reportText: readFileSync(report, "utf8"),
  });
  const { kept } = verifiedCoverageVerdicts(row.rawVerdicts, context);
  judgeByRq[rq] = { judged: true, kept, raw: row.rawVerdicts.length };
}

// ---- matching ---------------------------------------------------------------
const kindOf = { question_substituted: "answer-not-responsive", gap_as_conclusion: "gap-answered-in-verdict", false_gap_declared: "false-gap" };
const qnum = (label) => Number(/\d+/.exec(String(label.briefQuestion ?? ""))?.[0]);
const absentSiblings = (label) => (label.siblingsChecked ?? []).filter((s) => s.present === false || s.present === "partial").map((s) => String(s.item));

function termMatchesLabel(term, label) {
  const t = collapse(term);
  if (t.length < 2) return false;
  const targets = [String(label.briefItem ?? ""), ...absentSiblings(label)].map(collapse);
  return targets.some((target) => target.includes(t) || t.includes(target));
}

const rows = [];
for (const label of labels) {
  const number = qnum(label);
  const bl = baseAlarms[label.rq] ?? [];
  const nw = newAlarms[label.rq] ?? [];
  const judge = judgeByRq[label.rq] ?? { judged: false, kept: [] };
  // baseline
  let baseHit = null;
  for (const alarm of bl) {
    if (alarm.rule === "scope-understated" && label.defectType === "scope_understated") baseHit = alarm;
    if (alarm.rule === "gap-asserted" && (label.defectType === "gap_as_conclusion" || label.defectType === "false_gap_declared") && alarm.number === number) baseHit = alarm;
  }
  // new deterministic
  let detHit = null;
  for (const alarm of nw) {
    if (alarm.rule === "brief-item" && alarm.number === number && alarm.terms.some((t) => termMatchesLabel(t, label))) detHit = detHit ?? alarm;
    if (alarm.rule === "brief-missing" && alarm.number === number) detHit = detHit ?? alarm;
    if (alarm.rule === "brief-mismatch" && alarm.number === number) detHit = detHit ?? alarm;
    if (alarm.rule === "gap-asserted" && alarm.number === number && (label.defectType === "gap_as_conclusion" || label.defectType === "false_gap_declared")) detHit = detHit ?? alarm;
  }
  // weaker: same question flagged by brief-item but term does not match the labelled item
  const detSameQuestion = nw.find((a) => a.rule === "brief-item" && a.number === number);
  // judge
  const wantKind = kindOf[label.defectType];
  const judgeHit = wantKind ? (judge.kept ?? []).find((v) => v.kind === wantKind && Number(/\d+/.exec(v.entryId)?.[0]) === number) : null;
  rows.push({
    labelId: label.labelId, rq: label.rq, q: number, type: label.defectType, missReason: label.missReason,
    item: String(label.briefItem ?? "").slice(0, 40),
    base: baseHit ? baseHit.rule : "",
    det: detHit ? `${detHit.rule}${detHit.terms ? "「" + detHit.terms.filter((t) => termMatchesLabel(t, label)).join("/") + "」" : ""}` : "",
    detWeak: !detHit && detSameQuestion ? `same-question「${detSameQuestion.terms.join("/")}」` : "",
    judge: judgeHit ? `${judgeHit.kind}@${judgeHit.entryId}L${judgeHit.line}` : "",
  });
}
console.log(JSON.stringify({ rows }, null, 1));
