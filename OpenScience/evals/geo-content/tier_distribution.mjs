#!/usr/bin/env node
/**
 * What the measurement notices actually fire on, across real runs.
 *
 * The five notices in the geo-content-pack contract ship as advisory because the
 * system holds six blocking points and a seventh has to be argued from an
 * observed distribution rather than from how bad a failure sounds. This is how
 * that distribution gets collected: run the real gate over each recorded run's
 * ledger and count what fires.
 *
 * It reports metrics too, because a notice that never fires and a notice that
 * fires on everything are both useless, and only the counts can tell you which
 * one you have.
 *
 *   node evals/geo-content/tier_distribution.mjs
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGate } from "../../packages/domain/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");

/** The ledger is the only file these notices read; everything else is absent on
 *  purpose, so what fires is attributable to the measurement and not to a
 *  half-written content pack. */
async function ledgersOf(runDir) {
  const out = [];
  for (const name of await readdir(runDir)) {
    if (name.startsWith("geo-probe-log") && name.endsWith(".jsonl")) {
      out.push([name, await readFile(path.join(runDir, name), "utf8")]);
    }
  }
  return out;
}

const rows = [];
const fired = new Map();
let ledgersSeen = 0;

for (const runId of (await readdir(resultsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
  for (const [name, body] of await ledgersOf(path.join(resultsDir, runId))) {
    ledgersSeen += 1;
    const verdict = runGate({
      contractKind: "geo-content-pack",
      files: new Map([["geo-probe-log.jsonl", body]]),
      expectedOutputs: [{ path: "geo-probe-log.jsonl", required: true }],
    });
    const notices = verdict.issues.filter((issue) => issue.code.startsWith("geo_"));
    for (const issue of notices) fired.set(issue.code, (fired.get(issue.code) ?? 0) + 1);
    rows.push({
      run: `${runId}/${name.replace("geo-probe-log", "").replace(".jsonl", "") || "/branded"}`,
      rounds: verdict.metrics.geoProbeRounds,
      measured: verdict.metrics.geoMeasuredRounds,
      failed: verdict.metrics.geoFailedRounds,
      questions: verdict.metrics.geoQuestionsMeasured,
      platforms: (verdict.metrics.geoPlatformsMeasured ?? []).length,
      notices: notices.map((issue) => issue.code),
    });
  }
}

// A sweep that read nothing reports a clean distribution, which is the same
// shape as a clean distribution.
if (!ledgersSeen) {
  console.error(`no ledgers found under ${resultsDir}`);
  process.exit(1);
}

console.log(`${ledgersSeen} ledger(s) from ${new Set(rows.map((r) => r.run.split("/")[0])).size} run(s)\n`);
console.log("run                                    rounds  measured  failed  q   p   notices");
for (const row of rows) {
  console.log(
    `${row.run.padEnd(38)}${String(row.rounds).padStart(6)}${String(row.measured).padStart(10)}`
    + `${String(row.failed).padStart(8)}${String(row.questions).padStart(4)}${String(row.platforms).padStart(4)}   `
    + (row.notices.join(", ") || "—"),
  );
}

// A control, because a column of zeros is exactly what a disconnected check
// produces. Every notice is fired once against a ledger built to trip it; if one
// of them cannot be provoked here, its zero above means "wired to nothing"
// rather than "found nothing", and those look identical in a report.
const round = (over = {}) => JSON.stringify({
  question: "q", provider: "deepseek", status: "ok", inDenominator: true,
  surface: { mode: "default", session: "new_chat" }, ...over,
});
const PROVOCATIONS = {
  geo_measurement_absent: { "geo-probe-log.jsonl": round({ status: "busy", inDenominator: false }) },
  geo_probe_log_unreadable: { "geo-probe-log.jsonl": `${round()}\n{"broken":` },
  geo_failed_round_counted: { "geo-probe-log.jsonl": round({ status: "busy" }) },
  geo_surface_undeclared: { "geo-probe-log.jsonl": round({ surface: { mode: "deep" } }) },
  geo_denominator_overstated: {
    "geo-probe-log.jsonl": round(),
    "geo-content-pack.json": JSON.stringify({ measurement: { measured: 99 } }),
  },
  geo_probe_host_in_prose: {
    "geo-probe-log.jsonl": round(),
    "geo-content-pack.md": "测量来自 43.248.117.249:9999。",
  },
};
const inert = [];
for (const [code, files] of Object.entries(PROVOCATIONS)) {
  const verdict = runGate({
    contractKind: "geo-content-pack",
    files: new Map(Object.entries(files)),
    expectedOutputs: [{ path: "geo-probe-log.jsonl", required: true }],
  });
  if (!verdict.issues.some((issue) => issue.code === code)) inert.push(code);
}

const ALL = [
  "geo_measurement_absent",
  "geo_probe_log_unreadable",
  "geo_failed_round_counted",
  "geo_surface_undeclared",
  "geo_denominator_overstated",
  "geo_probe_host_in_prose",
];
console.log("\nnotice                        fired / ledgers    reading");
for (const code of ALL) {
  const count = fired.get(code) ?? 0;
  const reading = inert.includes(code)
    ? "WIRED TO NOTHING — could not be provoked even by a ledger built to trip it"
    : count === 0
    ? "never fired on real data (but does fire when provoked)"
    : count === ledgersSeen
      ? "fires on everything — either a real systemic defect or a check that says nothing"
      : "fires selectively — the shape a candidate for blocking has";
  console.log(`${code.padEnd(30)}${String(count).padStart(3)} / ${ledgersSeen}          ${reading}`);
}

const totals = rows.reduce((acc, row) => ({
  rounds: acc.rounds + row.rounds, measured: acc.measured + row.measured, failed: acc.failed + row.failed,
}), { rounds: 0, measured: 0, failed: 0 });
console.log(
  `\nacross every recorded run: ${totals.rounds} attempts, ${totals.measured} measured, `
  + `${totals.failed} failed (${(totals.failed / totals.rounds * 100).toFixed(0)}% of attempts never became a measurement)`,
);
if (inert.length) {
  console.log(`\n${inert.length} notice(s) could not be provoked at all: ${inert.join(", ")}`);
  process.exitCode = 1;
}

console.log(
  "\nRead the zeros carefully. Every ledger above was written by measure.mjs, which"
  + "\ncannot overstate a denominator, omit a surface, or leave a line unparsed — so a"
  + "\nzero here is mostly a fact about the collector, not about the notices. What these"
  + "\nnotices were built to catch is what a MODEL-driven run does to a ledger, and no"
  + "\nsuch run has been recorded yet (the runtime needs a container this host cannot"
  + "\nstart). Until one is, the honest reading is: the checks are live and provable,"
  + "\nthe distribution is not yet evidence of anything."
  + "\n\nA seventh blocking point needs a notice that fires on real defects and stays quiet"
  + "\notherwise. Nothing here has the runs behind it to make that case.",
);
