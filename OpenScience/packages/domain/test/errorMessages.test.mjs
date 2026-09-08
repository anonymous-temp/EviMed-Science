/**
 * The error dictionary is the only dictionary.
 *
 * Three substitutes shipped in the browser because this registry could not
 * answer for the codes production actually emits, and the worst of them
 * answered 「运行未通过核验。」 for every code it did not know — a false claim
 * about the researcher's own work whenever the cause was a stall timer, a
 * cancel or an outage. These tests hold the two properties that make the
 * substitutes unnecessary: every code this build knows has a Chinese sentence,
 * and every code that can end a run has an exact one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_ERROR_CODES,
  CONTROL_PLANE_ERROR_CODES,
  ERROR_CODE_FAMILIES,
  ERROR_CODE_MESSAGES,
  ERROR_DETAIL_FIELDS,
  RUN_OUTCOME_KINDS,
  RUN_VERDICT_ERROR_CODES,
  errorCodeMessage,
  errorCodeOutcome,
  knownErrorCodeMessage,
  runOutcomeKind,
} from "../index.mjs";

/** Any CJK ideograph. A sentence without one is not the Chinese this UI needs.
 *  @param {string} text */
const hasChinese = (text) => /[一-鿿]/.test(text);
/** The shape of a code, which is what a reader must never be handed alone.
 *  @param {string} text */
const looksLikeAnIdentifier = (text) => /^[a-z][a-z0-9_.-]*$/.test(text);
/** The table is keyed by literal, and every lookup here is by a runtime string.
 *  @param {string} code @returns {string | undefined} */
const sentenceFor = (code) => /** @type {Record<string, string>} */ (ERROR_CODE_MESSAGES)[code];

test("every known code has a Chinese sentence, and the walk proves it walked", () => {
  let exact = 0;
  let family = 0;
  for (const code of ALL_ERROR_CODES) {
    const message = knownErrorCodeMessage(code);
    assert.ok(message, `${code} has neither an exact sentence nor a family`);
    assert.notEqual(message.trim(), "", `${code} has an empty sentence`);
    assert.ok(hasChinese(message), `${code} is answered with non-Chinese text: ${message}`);
    assert.equal(looksLikeAnIdentifier(message), false, `${code} is answered with a bare identifier`);
    assert.notEqual(message, code, `${code} is answered with itself`);
    if (sentenceFor(code)) exact += 1;
    else family += 1;
  }
  // A walk that silently matches nothing passes forever. Both counts are
  // asserted because the interesting regression is one of them collapsing to
  // zero — every code exact would mean the family mechanism died, every code
  // family would mean the verdict sentences were deleted.
  assert.ok(exact >= 90, `only ${exact} codes have an exact sentence`);
  assert.ok(family >= 100, `only ${family} codes are covered by a family`);
  assert.equal(exact + family, ALL_ERROR_CODES.length);
  assert.ok(ALL_ERROR_CODES.length > 250, `the registry walked only ${ALL_ERROR_CODES.length} codes`);
  assert.equal(new Set(ALL_ERROR_CODES).size, ALL_ERROR_CODES.length, "duplicate error code");
});

test("no message key is an orphan, and every family sentence is usable Chinese", () => {
  // `illegal_state_transition` was a message for a code in no list at all — a
  // sentence nothing could ever ask for. Keys and codes have to agree or the
  // registry's own doc comment ("every code this build knows") is false.
  const known = new Set(ALL_ERROR_CODES);
  const orphans = Object.keys(ERROR_CODE_MESSAGES).filter((code) => !known.has(code));
  assert.deepEqual(orphans, [], `message keys for codes in no list: ${orphans.join(", ")}`);
  assert.ok(ERROR_CODE_FAMILIES.length >= 15, `only ${ERROR_CODE_FAMILIES.length} families are declared`);
  for (const [pattern, message] of ERROR_CODE_FAMILIES) {
    assert.ok(pattern instanceof RegExp);
    assert.ok(hasChinese(message), `family ${pattern} answers with non-Chinese text`);
  }
});

test("every code that can end a run has an exact sentence, not a family one", () => {
  assert.ok(RUN_VERDICT_ERROR_CODES.length >= 35, `only ${RUN_VERDICT_ERROR_CODES.length} run verdicts are declared`);
  for (const code of [...RUN_VERDICT_ERROR_CODES, ...CONTROL_PLANE_ERROR_CODES]) {
    const message = sentenceFor(code);
    assert.ok(message, `${code} can be shown as a verdict and has only a family sentence`);
    assert.ok(hasChinese(message), `${code} is answered with non-Chinese text`);
  }
});

test("a run the platform stopped is never described as a failed verification", () => {
  // The exact defect being deleted: 「运行未通过核验。」 for a fifteen-minute
  // stall timer. A quality claim is only ever true of the gate half.
  const stopped = [
    "runtime_monitor_stalled",
    "runtime_monitor_timeout",
    "runtime_monitor_failed",
    "runtime_canceled",
    "runtime_stopped",
    "runtime_error",
    "superseded_by_dispatch",
  ];
  for (const code of stopped) {
    assert.equal(errorCodeOutcome(code), "stopped", code);
    assert.equal(/核验|质量门/.test(sentenceFor(code) ?? ""), false, `${code} claims a quality verdict`);
  }
  // And the gate half does say so, or the distinction is not being drawn.
  assert.equal(errorCodeOutcome("specialist_evidence_traceability_failed"), "gated");
  assert.ok(/质量门|核验/.test(ERROR_CODE_MESSAGES.specialist_evidence_traceability_failed));
});

test("a gate refusal says the files are still there", () => {
  // 28 of 179 production runs were refused with `artifacts: []` while a
  // complete package sat on disk; the sentences are where the researcher first
  // learns the work was not deleted.
  const naming = [
    "specialist_deliverable_not_accepted",
    "specialist_required_output_missing",
    "specialist_evidence_traceability_failed",
    "specialist_evidence_repair_failed",
    "runtime_monitor_stalled",
    "runtime_monitor_timeout",
  ];
  for (const code of naming) {
    assert.ok(/工作区/.test(sentenceFor(code) ?? ""), `${code} does not say where the work is`);
  }
});

test("an unrecognized code gets an honest sentence that still carries the code", () => {
  // The vocabulary is open by construction: `sanitizeErrorCode` admits any
  // well-formed identifier and the run monitor forwards whatever the runtime
  // controller raised, so this path is reachable however complete the table is.
  const message = errorCodeMessage("a_code_nobody_wrote");
  assert.ok(hasChinese(message));
  assert.equal(looksLikeAnIdentifier(message), false);
  assert.ok(message.includes("a_code_nobody_wrote"), "support loses its only handle on the run");
  assert.equal(/核验|质量门|交付物/.test(message), false, "the fallback guesses at a cause");
  assert.equal(knownErrorCodeMessage("a_code_nobody_wrote"), null);
  assert.equal(errorCodeOutcome("a_code_nobody_wrote"), "unknown");
  // Empty and null must not print an empty bubble either.
  assert.ok(hasChinese(errorCodeMessage("")));
  assert.ok(hasChinese(errorCodeMessage(/** @type {any} */ (null))));
});

test("outcome classification is total and lands each class on a real code", () => {
  for (const code of ALL_ERROR_CODES) {
    const kind = errorCodeOutcome(code);
    assert.ok(RUN_OUTCOME_KINDS.includes(kind), `${code} classified as ${kind}`);
    assert.notEqual(kind, "unknown", `${code} is in the registry but classified as unknown`);
  }
  assert.equal(errorCodeOutcome("credits_daily_limit_reached"), "capped");
  assert.equal(errorCodeOutcome("runtime_reserved_for_autopilot"), "capped");
  assert.equal(errorCodeOutcome("full_text_not_available"), "upstream");
  assert.equal(errorCodeOutcome("declared-appraisal-must-execute"), "gated");
  assert.equal(errorCodeOutcome("verification_run_failed"), "stopped");
});

test("a run that shipped with reservations is not reported as a clean success", () => {
  // 「已交付，但未完成核验」 and 「暂无交付物。」 sat six lines apart in the same
  // card because the copy keyed on `verification` and nothing keyed on both.
  assert.equal(runOutcomeKind({ status: "succeeded", errorCode: null, verification: null }), "delivered");
  assert.equal(runOutcomeKind({ status: "succeeded", errorCode: null, verification: "unverified" }), "qualified");
  assert.equal(runOutcomeKind({ status: "succeeded", errorCode: null, verification: "unchecked" }), "qualified");
  assert.equal(runOutcomeKind({ status: "failed", errorCode: "runtime_monitor_timeout" }), "stopped");
  assert.equal(runOutcomeKind({ status: "canceled", errorCode: null }), "stopped");
  assert.equal(runOutcomeKind({}), "unknown");
  assert.equal(runOutcomeKind(/** @type {any} */ (null)), "unknown");
});

test("a refusal's declared numbers are declared once, for every ceiling that raises one", () => {
  // The daily and weekly ceilings computed the amount, the limit and the reset
  // time and shipped none of them, because only `usage_budget_exceeded` had a
  // declared shape. A ceiling that cannot say how much is left leaves
  // 「请重试」 as advice that provably cannot work.
  for (const code of ["usage_budget_exceeded", "credits_daily_limit_reached", "credits_weekly_limit_reached"]) {
    const fields = ERROR_DETAIL_FIELDS[code];
    assert.ok(fields, `${code} declares no detail shape`);
    assert.equal(errorCodeOutcome(code), "capped");
    for (const [key, kind] of Object.entries(fields)) {
      // Every acceptor is a finite number or a closed vocabulary. An open
      // string here would let a path, a hostname or a credential leave through
      // this channel, which is the one property `security.mjs` guarantees.
      assert.ok(kind === "number" || Array.isArray(kind), `${code}.${key} is neither a number nor a closed set`);
      if (Array.isArray(kind)) assert.ok(kind.length > 0 && kind.every((value) => typeof value === "string"));
    }
  }
  assert.deepEqual(ERROR_DETAIL_FIELDS.credits_daily_limit_reached.window, ["day"]);
  assert.deepEqual(ERROR_DETAIL_FIELDS.credits_weekly_limit_reached.window, ["week"]);
});
