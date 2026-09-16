import assert from "node:assert/strict";
import test from "node:test";
import { socketToolResult } from "../src/dshRuntimeAdapter.mjs";
import { kernelToolText } from "./helpers/kernelToolText.mjs";

// Verbatim from a production transcript, 2026-09-16 (project
// eval-memory-ablation-v7-545d9b64, run run_fb43cb32590bf489f199e9135f98a66e).
const LIVE_OK = 'ok\n{\n  "verdicts": [\n    {\n      "claimId": "CLM-095",\n      "verdict": "stands",\n      "grounds": "placeholder"\n    }\n  ],\n  "blocking": false\n}';
const LIVE_FAILED = "failed: specialist_evidence_traceability_failed\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S02 is not cited by the report.";
const LIVE_DELEGATE_HEAD = 'ok\n{\n  "deliverableId": "mimic-sepsis-prognosis-scoping",\n  "childSessionId": "8765be77-2ac4-4655-bd9a-7c16c266a70e",\n  "report": {\n    "deliverableId": "mimic-sepsis-prognosis-scoping",\n    "submitted": true\n  }\n}';

test("a socket tool result is read in the form the kernel actually records", () => {
  assert.deepEqual(socketToolResult(LIVE_OK), { ok: true, data: { verdicts: [{ claimId: "CLM-095", verdict: "stands", grounds: "placeholder" }], blocking: false } });
  assert.equal(socketToolResult(LIVE_DELEGATE_HEAD).data.childSessionId, "8765be77-2ac4-4655-bd9a-7c16c266a70e");
  assert.deepEqual(socketToolResult(LIVE_FAILED), {
    ok: false,
    code: "specialist_evidence_traceability_failed",
    issues: [
      { severity: "required", code: "specialist_evidence_traceability_failed", message: "Evidence matrix claim CLM-S01 is not cited by the report." },
      { severity: "required", code: "specialist_evidence_traceability_failed", message: "Evidence matrix claim CLM-S02 is not cited by the report." },
    ],
  });
});

test("the test helper renders exactly what the live samples hold", () => {
  // If this fails, the helper has drifted from the wire and every fixture
  // built with it proves nothing about a live run.
  assert.equal(kernelToolText({ ok: true, data: JSON.parse(LIVE_OK.slice(3)) }), LIVE_OK);
  assert.equal(kernelToolText({ ok: false, code: "specialist_evidence_traceability_failed", issues: socketToolResult(LIVE_FAILED).issues }), LIVE_FAILED);
});

test("bare {ok} JSON still reads, and anything else is not a socket result", () => {
  assert.deepEqual(socketToolResult('{"ok":true,"data":{"childSessionId":"c1"}}'), { ok: true, data: { childSessionId: "c1" } });
  assert.equal(socketToolResult('{"status":"success","data":{}}'), null, "an MCP result has no ok field");
  assert.equal(socketToolResult("Error: {\"status\":\"error\"}"), null);
  assert.equal(socketToolResult("okay then"), null);
  assert.equal(socketToolResult(undefined), null);
  assert.deepEqual(socketToolResult("ok"), { ok: true, data: null });
});
