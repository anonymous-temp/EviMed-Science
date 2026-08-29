// Does the verification layer let a TRUE semantic defect through?
//
// The judge's whole safety argument is that code re-checks everything the model
// says. That argument is worthless if the checks also discard correct verdicts.
// This probe replays the human-labelled semantic defects as if a perfect model
// had reported each one — real entry id, real report line, verbatim quote — and
// counts how many survive verification. It needs no model and no network.
//
// Second arm (ADVERSARIAL=1): the same labels with invented entry ids, invented
// lines and paraphrased quotes. None of those may survive. Falsifying every
// field at once only ever exercises the first check, so one axis at a time is
// available too: ADVERSARIAL=entry|line|unseen-line|quote|why.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { coverageJudgeContext } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";
import { verifiedCoverageVerdicts } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/coverageJudge.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const labels = JSON.parse(readFileSync(path.join(root, "audit", "coverage-labels.json"), "utf8")).labels;

const collapse = (value) => String(value ?? "").replace(/\s+/g, "");
const kindOf = {
  question_substituted: "answer-not-responsive",
  gap_as_conclusion: "gap-answered-in-verdict",
  false_gap_declared: "false-gap",
};

const contexts = new Map();
function contextFor(rq) {
  if (contexts.has(rq)) return contexts.get(rq);
  const name = `${rq}_研究任务`;
  const dir = path.join(root, name);
  const coverage = path.join(root, "audit", "coverage", `${name}.question-coverage.json`);
  const brief = path.join(briefRoot, `${name}.md`);
  const report = path.join(dir, "clinical-evidence-report.md");
  const built = [coverage, brief, report].every((file) => existsSync(file))
    ? coverageJudgeContext({
        briefText: readFileSync(brief, "utf8"),
        questionCoverageText: readFileSync(coverage, "utf8"),
        reportText: readFileSync(report, "utf8"),
      })
    : null;
  contexts.set(rq, built);
  return built;
}

const adversarial = process.env.ADVERSARIAL ?? "";
const tally = { total: 0, noContext: 0, quoteNotInReport: 0, noEntry: 0, kept: 0, discarded: {} };
const detail = [];

for (const label of labels) {
  const kind = kindOf[label.defectType];
  if (!kind) continue;
  tally.total += 1;
  const context = contextFor(label.rq);
  if (!context) { tally.noContext += 1; continue; }

  // The line the labelled quotation is on, found the way the gate finds
  // anything: by collapsed substring, over the excerpt the judge was shown.
  const quote = String(label.reportQuote ?? "").slice(0, 60);
  const line = context.excerpt.find((item) => collapse(item.text).includes(collapse(quote).slice(0, 20)));
  if (!line || collapse(quote).length < 12) { tally.quoteNotInReport += 1; continue; }

  // The brief question the label names, and any ledger entry registered under
  // it with the status this defect kind implies.
  const number = Number(/\d+/.exec(String(label.briefQuestion ?? ""))?.[0]);
  const wantStatus = kind === "answer-not-responsive" ? "answered" : "gap";
  const entry = context.entries.find((item) => Number(/\d+/.exec(item.id)?.[0]) === number && item.status === wantStatus);
  if (!entry) { tally.noEntry += 1; continue; }

  // The honest verdict a perfect model would have produced: this entry, this
  // line, and what a model copying character for character out of the line it
  // was shown would write. (The labelled quotation is an audit note with
  // ellipses in it, not a transcription.)
  const verdict = {
    entryId: entry.id,
    kind,
    reportLine: line.line,
    quote: line.text.trim().slice(0, 40),
    why: String(label.note ?? label.findingTitle ?? "").slice(0, 100),
  };
  // ADVERSARIAL=1 falsifies every field at once, which only ever exercises the
  // first check. ADVERSARIAL=<axis> falsifies exactly one, so each check is
  // measured on the corpus rather than only on the unit fixtures.
  if (adversarial === "entry" || adversarial === "1") verdict.entryId = `${entry.id}9`;
  if (adversarial === "line" || adversarial === "1") verdict.reportLine = context.totalLines + 5;
  if (adversarial === "quote" || adversarial === "1") verdict.quote = `${quote.slice(0, 20)}（改写）`;
  if (adversarial === "unseen-line") {
    // A real line of the report that was never in the excerpt.
    const hidden = Array.from({ length: context.totalLines }, (_, index) => index + 1)
      .find((candidate) => !context.excerptLines.has(candidate) && context.hasSubstance(candidate));
    verdict.reportLine = hidden ?? context.totalLines;
    verdict.quote = context.lineText(verdict.reportLine).trim().slice(0, 40);
  }
  if (adversarial === "why") verdict.why = "  ";
  const { kept, discarded } = verifiedCoverageVerdicts([verdict], context);
  if (kept.length) {
    tally.kept += 1;
    detail.push({ labelId: label.labelId, rq: label.rq, kind, entryId: entry.id, line: line.line, outcome: "kept" });
  } else {
    const reason = Object.keys(discarded)[0] ?? "unknown";
    tally.discarded[reason] = (tally.discarded[reason] ?? 0) + 1;
    detail.push({ labelId: label.labelId, rq: label.rq, kind, entryId: entry.id, line: line.line, outcome: reason });
  }
}

console.log(JSON.stringify({ arm: adversarial ? `adversarial:${adversarial}` : "ideal-model", tally, detail }, null, 1));
