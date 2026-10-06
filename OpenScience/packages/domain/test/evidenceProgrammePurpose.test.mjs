// The platform's own evidence programme books its model spend as `evidence` and never as anyone's (evidence-flywheel F01, 2026-10-05).
// Its runs keep the `autopilot:` family's prefix, so the completion fold and the usage keys that recognise an autopilot run still do, and
// one word after it makes the run the platform's.
import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_PROGRAMME_ERROR_CODES, EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX, EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON, ERROR_CODE_MESSAGES, ALL_ERROR_CODES,
  evidenceDisclosure, evidenceProgrammeRouteReason, isChargeableResearchRun, isEvidenceProgrammeRouteReason, isResearcherOwnedWork, usagePurposeOfRun,
} from "../index.mjs";

test("a programme episode and its verification resolve to purpose `evidence`, and are never chargeable or a researcher's own work", () => {
  for (const reason of [evidenceProgrammeRouteReason("evidence-update"), evidenceProgrammeRouteReason("signal-monitoring"), EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON]) {
    const run = { effectiveAgentId: "clinical-evidence-synthesis", effectiveRouteReason: reason };
    assert.equal(usagePurposeOfRun(run), "evidence", reason);
    assert.equal(isChargeableResearchRun(run), false, reason);
    assert.equal(isResearcherOwnedWork({ ...run, automated: false }), false, reason);
    assert.equal(isEvidenceProgrammeRouteReason(reason), true, reason);
  }
  assert.ok(evidenceProgrammeRouteReason("evidence-update").startsWith("autopilot:"), "still an autopilot run to everything that reads the prefix");
  assert.ok(evidenceProgrammeRouteReason("evidence-update").startsWith(EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX));
});

test("a researcher's autopilot run, and any look-alike, is unchanged: the kernel's, chargeable", () => {
  for (const reason of ["autopilot:evidence-update", "autopilot-verify", "autopilot:evidence", "autopilot-evidence:evidence-update", "evidence", ""]) {
    const run = { effectiveAgentId: "clinical-evidence-synthesis", effectiveRouteReason: reason };
    assert.equal(usagePurposeOfRun(run), "kernel", `"${reason}"`);
    assert.equal(isEvidenceProgrammeRouteReason(reason), false, `"${reason}"`);
  }
  assert.equal(isChargeableResearchRun({ effectiveAgentId: "clinical-evidence-synthesis", effectiveRouteReason: "autopilot:evidence-update" }), true);
});

test("the programme's error codes are registered with a Chinese sentence", () => {
  assert.deepEqual([...EVIDENCE_PROGRAMME_ERROR_CODES], ["evidence_programme_decision_required", "evidence_programme_budget_spent", "evidence_programme_slot_busy", "evidence_programme_original_weekly_cap"]);
  for (const code of EVIDENCE_PROGRAMME_ERROR_CODES) {
    assert.ok(ALL_ERROR_CODES.includes(code), `${code} is a known code`);
    assert.match(/** @type {Record<string, string>} */ (ERROR_CODE_MESSAGES)[code], /[一-鿿]/, code);
  }
});

test("a disclosure may name the reporting standard an analysis was written to, and says nothing of it otherwise", () => {
  const base = { model: "deepseek-flash", generatedAt: "2026-10-05T01:00:00.000Z", aiSteps: ["search", "synthesize"] };
  assert.equal(evidenceDisclosure({ ...base, reportingStandard: " READUS-PV " })?.reportingStandard, "READUS-PV");
  assert.equal(Object.hasOwn(evidenceDisclosure(base) ?? {}, "reportingStandard"), false);
  assert.throws(() => evidenceDisclosure({ ...base, reportingStandard: "x".repeat(201) }), { code: "evidence_invalid" });
  assert.throws(() => evidenceDisclosure({ ...base, reportingStandard: 7 }), { code: "evidence_invalid" });
});
