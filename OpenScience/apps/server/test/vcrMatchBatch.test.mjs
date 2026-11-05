import assert from "node:assert/strict";
import test from "node:test";

import { VCR_MIN_CELL_SIZE } from "@evimed/domain";
import { matchBatchMinCell, resultOutcome } from "../src/vcrMatchBatch.mjs";

test("the head count a model is shown is the domain's floor, raised and never lowered by the deployment", () => {
  assert.equal(matchBatchMinCell({}), VCR_MIN_CELL_SIZE);
  assert.equal(matchBatchMinCell({ vcrMinCellSize: VCR_MIN_CELL_SIZE - 1 }), VCR_MIN_CELL_SIZE);
  assert.equal(matchBatchMinCell({ vcrMinCellSize: VCR_MIN_CELL_SIZE + 3 }), VCR_MIN_CELL_SIZE + 3);
  assert.equal(matchBatchMinCell({ vcrMinCellSize: 2.5 }), VCR_MIN_CELL_SIZE);
});

test("a batch says what it did: all of it is estimable, some of it is limited, none of it is a failure with its commonest reason", () => {
  const whole = resultOutcome({ finished: 5, total: 5, failed: 0, stopped: false, failures: {}, noun: "对", verb: "判定" });
  assert.deepEqual([whole.status, whole.conclusion, whole.issues], ["succeeded", "estimable", []]);
  const part = resultOutcome({ finished: 3, total: 5, failed: 1, stopped: true, failures: { upstream_unavailable: 1 }, noun: "对", verb: "判定" });
  assert.deepEqual([part.status, part.conclusion, part.issues[0].code], ["succeeded", "limited", "upstream_unavailable"]);
  assert.match(part.issues[0].message, /判定完 3 对.*1 对没判定成.*中途停下/);
  const none = resultOutcome({ finished: 0, total: 5, failed: 5, stopped: false, failures: { a: 1, b: 3 }, noun: "对", verb: "判定" });
  assert.deepEqual([none.status, none.conclusion, none.issues[0].code], ["failed", "not_estimable", "b"]);
  const stoppedEarly = resultOutcome({ finished: 2, total: 5, failed: 0, stopped: false, failures: {}, noun: "对", verb: "判定" });
  assert.equal(stoppedEarly.issues[0].code, "vcr_match_stopped_early");
});
