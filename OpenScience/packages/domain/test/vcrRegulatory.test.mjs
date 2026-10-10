/**
 * How long a regulatory contact's words may run and how many a study keeps: the numbers the page's route and the runtime's writer both
 * check against (`vcrScheduleView.mjs`), so that the two refuse the same things.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_REGULATORY_LIMITS } from "@evimed/domain";

test("the limits of a regulatory contact are closed numbers", () => {
  assert.ok(Object.isFrozen(VCR_REGULATORY_LIMITS));
  assert.deepEqual(Object.keys(VCR_REGULATORY_LIMITS).sort(), ["agency", "attachment", "attachments", "contacts", "outcome", "summary", "type"]);
  for (const value of Object.values(VCR_REGULATORY_LIMITS)) assert.ok(Number.isInteger(value) && value > 0);
  assert.ok(VCR_REGULATORY_LIMITS.summary >= 1_000 && VCR_REGULATORY_LIMITS.outcome >= 1_000, "a meeting's discussion and the agency's conclusion are not one line");
});
