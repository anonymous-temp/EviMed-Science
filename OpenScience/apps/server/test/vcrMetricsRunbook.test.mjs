// What the runbook tells an operator to watch for the module's matching work, held to what the gauges expose: every
// `open_science_vcr_*` name it writes is a family the module emits, every kind of the matching gauge is named and said
// in the words the gauge's own help uses, and nothing the gauge does not measure is promised from it. The runbook promised
// "unknowns, incomplete assessments, fact-write issues, eligible recall, latency and actual costs" from a gauge of six table
// counts (E-15); that sentence read as a monitoring plan and was a wish.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VCR_MATCHING_RECORD_KINDS, vcrMetricFamilies } from "../src/vcrComposition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runbook = await readFile(path.join(repoRoot, "docs/WEB_OPERATIONS_RUNBOOK.md"), "utf8");

/** The paragraph of the runbook that introduces the matching gauge: from its first mention to the next blank line. */
function gaugeParagraph() {
  const at = runbook.indexOf("open_science_vcr_matching_records");
  assert.notEqual(at, -1, "the runbook names the matching gauge");
  const start = runbook.lastIndexOf("\n\n", at) + 2;
  const end = runbook.indexOf("\n\n", at);
  // The runbook wraps its lines; a sentence is read across them.
  return runbook.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

const everything = /** @type {any} */ ({
  tables: { jobs: {}, studies: 1, active: 1 },
  matching: Object.fromEntries(Object.keys(VCR_MATCHING_RECORD_KINDS).map((kind, index) => [kind, index])),
  matchingProducers: [{ model: "deepseek-v4-flash", receipts: 1 }, { model: "unrecorded", receipts: 1 }],
  service: { studiesCreated: 0, reads: 0, writes: 0, writeIssues: 0, notFound: 0, tabs: 0 },
  jobs: { counters: { enqueued: 0, succeeded: 0, failed: 0 } },
  engine: { configured: true },
  // The plane's counters: which basis a cloud read stood on, and what a withdrawal and a changed basis did.
  cloud: { cloudReadsDeploymentAgreements: 0, cloudReadsSourcePermission: 0, cloudReadsRefused: 0, withdrawals: 0, documentsErased: 0,
    projectionsRetired: 0, filesOverwritten: 0, overwriteFailures: 0, marksWritten: 0, marksFailed: 0 },
});
const families = new Map(vcrMetricFamilies(true, everything).map((family) => [family.name, family]));

test("every open_science_vcr_* metric the runbook names is a family the module emits", () => {
  const named = [...new Set(runbook.match(/open_science_vcr_[a-z_]+/g) ?? [])];
  assert.ok(named.length >= 1);
  assert.deepEqual(named.filter((name) => !families.has(name)), []);
});

test("the runbook names each kind of the matching gauge and says what it counts, in the words of the gauge's help", () => {
  const gauge = families.get("open_science_vcr_matching_records");
  assert.ok(gauge);
  const kinds = gauge.series.map((series) => series.labels?.kind);
  assert.deepEqual([...kinds].sort(), Object.keys(VCR_MATCHING_RECORD_KINDS).sort(), "the gauge exposes exactly the kinds it declares");
  const paragraph = gaugeParagraph();
  for (const [kind, meaning] of Object.entries(VCR_MATCHING_RECORD_KINDS)) {
    assert.ok(paragraph.includes(`\`${kind}\``), `the runbook names ${kind}`);
    assert.ok(paragraph.includes(meaning), `the runbook says what ${kind} counts: ${meaning}`);
    assert.ok(gauge.help.includes(meaning), `and so does the gauge's help: ${meaning}`);
  }
});

test("the runbook sends operators to the series that measure the rest, and promises none of it from the matching gauge", () => {
  const paragraph = gaugeParagraph();
  // Refused writes and job outcomes are series of their own, and the label the runbook cites exists.
  assert.ok(paragraph.includes('open_science_vcr_service_total{kind="writeIssues"}'));
  assert.ok(families.get("open_science_vcr_service_total")?.series.some((series) => series.labels?.kind === "writeIssues"));
  assert.ok(paragraph.includes("open_science_vcr_jobs_total"));
  // What no gauge measures is placed where it is, by name, instead of being listed as something to compare from this gauge.
  assert.match(paragraph, /eligible recall[^.]*offline/);
  assert.match(paragraph, /latency[^.]*finished_at/);
  assert.match(paragraph, /spend[^.]*evimed_usage\.model_requests/);
  assert.doesNotMatch(paragraph, /Compare unknowns, incomplete assessments, fact-write issues, eligible recall, latency/);
});
