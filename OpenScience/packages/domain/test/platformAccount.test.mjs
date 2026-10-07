import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_ERROR_CODES,
  ERROR_CODE_MESSAGES,
  EVIDENCE_PLATFORM_ERROR_CODES,
  PLATFORM_ACCOUNT_AUTH_TYPE,
  PLATFORM_PUBLISHER_NAME,
  PLATFORM_PUBLISHER_USER_ID,
  errorCodeOutcome,
  isPlatformAccountId,
  isPlatformAccountName,
} from "../index.mjs";

test("the publisher account is one id, one name and one auth type, written once", () => {
  assert.equal(PLATFORM_PUBLISHER_USER_ID, "evimed-evidence-center");
  assert.equal(PLATFORM_PUBLISHER_NAME, "EviMed 证据中心");
  assert.equal(PLATFORM_ACCOUNT_AUTH_TYPE, "platform");
  // The id must be a legal account id, or the account could never be inserted by the store's own rules.
  assert.match(PLATFORM_PUBLISHER_USER_ID, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
});

test("the id is recognised however it is spelled, so a lookalike registration is refused too", () => {
  for (const id of ["evimed-evidence-center", "Evimed-Evidence-Center", "EVIMED-EVIDENCE-CENTER", " evimed-evidence-center "]) {
    assert.equal(isPlatformAccountId(id), true, JSON.stringify(id));
  }
  for (const id of ["evimed-evidence-center2", "evimed-evidence", "evimed-evidence-centre", "", null, undefined, 7]) {
    assert.equal(isPlatformAccountId(id), false, JSON.stringify(id));
  }
});

test("the display name is the publisher's alone: normalised, case-folded, whitespace removed", () => {
  for (const name of ["EviMed 证据中心", "EviMed证据中心", "evimed 证据中心", " ＥviMed  证据中心 "]) {
    assert.equal(isPlatformAccountName(name), true, JSON.stringify(name));
  }
  for (const name of ["EviMed 证据中心团队", "EviMed", "证据中心", "", null, 3]) {
    assert.equal(isPlatformAccountName(name), false, JSON.stringify(name));
  }
});

test("its three codes are registered with a Chinese sentence and a class", () => {
  for (const code of EVIDENCE_PLATFORM_ERROR_CODES) {
    assert.ok(ALL_ERROR_CODES.includes(code), `${code} is in no registry list`);
    assert.match(/** @type {Record<string, string>} */ (ERROR_CODE_MESSAGES)[code] ?? "", /[一-鿿]/, `${code} has no sentence`);
  }
  assert.equal(errorCodeOutcome("evidence_upkeep_no_allowance"), "capped", "waiting for an allowance is a ceiling, not a failure");
  assert.equal(errorCodeOutcome("platform_account_protected"), "upstream");
  assert.ok(/不会替你付/.test(/** @type {Record<string, string>} */ (ERROR_CODE_MESSAGES).evidence_upkeep_no_allowance), "the owner is told the platform will not pay");
});
