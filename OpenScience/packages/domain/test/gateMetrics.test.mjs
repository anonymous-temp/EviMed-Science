// Which contract kinds report the four verification metrics, and which do not.
//
// The metrics — citation coverage, the confidence mix, the disputed share and
// the unresolved count — are a notice, never a gate: no threshold has been
// calibrated for any of them, and a metric whose threshold nobody has set is a
// coin toss dressed as a rule (principle 4, the blocking budget).
//
// This file exists because the split between kinds that carry them and kinds
// that do not was true but unwritten. Nothing failed if a new contract kind
// arrived carrying no metrics, so "this kind has no evidence to measure" and
// "nobody thought about this kind" produced identical output. Adding a kind now
// forces the decision to be made and recorded here.
//
// The rule the split encodes: a **report-shaped** kind synthesizes prose from
// sources, so coverage over its evidence matrix means something. A
// **JSON-shaped** kind is a structured deliverable checked against its own
// schema, with no matrix and no citation ledger — computing coverage over it
// yields a hard 0.0, which reads as total failure rather than as inapplicable.
// Emitting nothing is the honest answer; emitting zero is a false one.
import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_KINDS, runGate } from "../index.mjs";

const VERIFICATION_METRICS = ["citationCoverage", "confidenceMix", "disputedShare", "unresolved"];

/** Kinds whose deliverable is structured JSON checked against its own schema. */
const JSON_SHAPED = new Set([
  "episode-plan",
  "agenda-delta",
  "analysis-plan",
  "reproducibility-pack",
  "surveillance-diff",
  "hypothesis-set",
]);

/** Kinds that measure something else entirely, and say so in their own metrics. */
const OWN_METRICS = new Map([
  ["grant-proposal-package", ["grantRequirements", "grantMilestones"]],
  ["geo-content-pack", ["geoProbeRounds", "geoMeasuredRounds", "geoFailedRounds"]],
]);

test("every contract kind has a decided position on the verification metrics", () => {
  /** @type {string[]} */
  const undecided = [];
  /** Kinds this test actually put through the gate, counted as it goes.
   *  Asserted after the loop rather than before it: reading
   *  `CONTRACT_KINDS.length` up front proves the registry is big, not that
   *  anything was examined, so a loop that iterated nothing would still pass.
   *  That is the failure this guard exists to catch, and the first version of
   *  it had exactly that bug. */
  const examined = [];
  for (const kind of CONTRACT_KINDS) {
    examined.push(kind);
    const metrics = runGate({ contractKind: kind, files: new Map(), declaredOutputs: [] }).metrics ?? {};
    const carries = VERIFICATION_METRICS.every((name) => name in metrics);
    if (OWN_METRICS.has(kind)) {
      for (const name of OWN_METRICS.get(kind)) {
        assert.ok(name in metrics, `${kind} is listed as measuring its own thing but does not report ${name}`);
      }
      continue;
    }
    if (JSON_SHAPED.has(kind)) {
      assert.equal(
        carries,
        false,
        `${kind} is listed as JSON-shaped but reports the verification metrics; either it grew an evidence matrix, in which case move it out of JSON_SHAPED, or it is reporting zeros that read as failure`,
      );
      continue;
    }
    if (!carries) undecided.push(kind);
  }

  assert.ok(
    examined.length >= 20,
    `only ${examined.length} contract kinds were put through the gate; the scan, not the registry, is wrong — an empty scan agrees with itself`,
  );

  assert.deepEqual(
    undecided,
    [],
    `${undecided.join(", ")} report no verification metrics and are in no exempt list. ` +
      "A report-shaped kind must carry them; if this kind is not report-shaped, add it to JSON_SHAPED or OWN_METRICS with the reason.",
  );
});

test("a report-shaped kind reports the metrics as numbers, not as a promise", () => {
  const verdict = runGate({ contractKind: "research-brief", files: new Map(), declaredOutputs: [] });
  assert.equal(typeof verdict.metrics.citationCoverage, "number");
  assert.equal(typeof verdict.metrics.disputedShare, "number");
  assert.equal(typeof verdict.metrics.unresolved, "number");
  assert.equal(typeof verdict.metrics.confidenceMix, "object");
  // The mix names every level it counts even at zero, so a reader can tell
  // "no synthesized claims" from "this level was never counted".
  assert.deepEqual(Object.keys(verdict.metrics.confidenceMix).sort(), ["high", "low", "moderate", "unlabelled"]);
});

test("the metrics never block: they are advisory whatever they say", () => {
  // The budget is six blocking points system-wide, and none of them is a
  // metric. A verdict's ok-ness comes from its issues, never from a number.
  for (const kind of ["research-brief", "appraisal-table", "manuscript-section"]) {
    const verdict = runGate({ contractKind: kind, files: new Map(), declaredOutputs: [] });
    const blocking = verdict.issues.filter((issue) => issue.severity === "required");
    const fromMetrics = blocking.filter((issue) => VERIFICATION_METRICS.some((name) => String(issue.message).includes(name)));
    assert.deepEqual(fromMetrics, [], `${kind} turned a verification metric into a blocking issue`);
  }
});
