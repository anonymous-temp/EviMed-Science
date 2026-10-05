import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { digest } from "../../../evals/paper-gold/evaluator.mjs";
import { runCalibrationAcceptance } from "../../../scripts/ops/evolution-calibration-acceptance.mjs";
test("calibration acceptance separates tracks, emits no gold and resumes frozen cycles without model calls", async () => {
  const evaluationDataDir = await mkdtemp(path.join(os.tmpdir(), "calibration-acceptance-"));
  try {
    const calls = [], outputs = [];
    const app = { evolution: { paperGold: { async prepareCalibration(request) {
      calls.push(request);
      const directory = path.join(evaluationDataDir, "paper-gold/cycles", request.cycleId);
      await mkdir(directory, { recursive: true });
      const definition = { track: request.track, cases: [{ gold: { numeric: { hidden: 12345.6789 } } }], unavailable: [{ reason: "unavailable" }] };
      const evaluatorCodeHash = "b".repeat(64);
      await writeFile(path.join(directory, "definition.json"), JSON.stringify({ hash: digest({ definition, evaluatorCodeHash }), evaluatorCodeHash, definition }));
    } } } };
    const first = await runCalibrationAcceptance({ app, evaluationDataDir, output: row => outputs.push(row) });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(row => row.track), ["meta", "pharmacovigilance", "mr"]);
    assert.ok(calls.every(row => row.userId === "evolution-acceptance"));
    assert.ok(first.every(row => row.count === 2 && row.admissible === 1 && row.missing === 1 && row.scored === false));
    assert.doesNotMatch(JSON.stringify(outputs), /12345|numeric|gold|hidden/);
    const second = await runCalibrationAcceptance({ app, evaluationDataDir, output: row => outputs.push(row) });
    assert.equal(calls.length, 3);
    assert.ok(second.every(row => row.resumed === true));
  } finally { await rm(evaluationDataDir, { recursive: true, force: true }); }
});
test("calibration acceptance rejects malformed frozen track and duplicate selection", async () => {
  const evaluationDataDir = await mkdtemp(path.join(os.tmpdir(), "calibration-acceptance-"));
  try {
    await assert.rejects(runCalibrationAcceptance({ app: {}, evaluationDataDir, tracks: ["meta", "meta"] }), /distinct/);
    const directory = path.join(evaluationDataDir, "paper-gold/cycles/acceptance-calibration-meta-v1");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "definition.json"), JSON.stringify({ hash: "a".repeat(64), definition: { track: "mr", cases: [], unavailable: [] } }));
    await assert.rejects(runCalibrationAcceptance({ app: {}, evaluationDataDir, tracks: ["meta"] }), /another track/);
  } finally { await rm(evaluationDataDir, { recursive: true, force: true }); }
});
