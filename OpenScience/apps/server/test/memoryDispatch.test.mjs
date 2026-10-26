// A reused conversation (a scheduled task) keeps every execution's instruction as user-role text. The instruction is the
// platform's, sent by the control plane, and never the person's words — in the first execution, in a later one, or after the
// person types into the same conversation (2026-10-14: a daily literature task's template became an active work habit). Which runs
// the platform started is decided here, once, by route and mark, never by a word.
import assert from "node:assert/strict";
import test from "node:test";

import { EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX, EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON, evidenceProgrammeRouteReason } from "@evimed/domain";
import { VERIFICATION_ROUTE_REASON } from "../src/autopilotService.mjs";
import { isPlatformStartedRun } from "../src/memoryDispatch.mjs";

test("which runs the platform started: a harness, a scheduled execution and its verification, a module's run, a continuation", () => {
  for (const run of [{ automated: true }, { effectiveRouteReason: "autopilot:routine" }, { effectiveRouteReason: "autopilot:literature-sentinel" },
    { effectiveRouteReason: "autopilot:evidence:evidence-update" }, { effectiveRouteReason: "autopilot-verify" }, { effectiveRouteReason: "autopilot-verify:evidence" },
    { effectiveRouteReason: "geo:probe" }, { effectiveRouteReason: "vcr:analysis" }, { effectiveRouteReason: "platform-evolution" },
    { effectiveRouteReason: "loopx-continuation" }, { effectiveRouteReason: "adopted:runtime-ui:loopx-continuation" }]) {
    assert.equal(isPlatformStartedRun(run), true, JSON.stringify(run));
  }
  for (const run of [null, {}, { effectiveRouteReason: "adopted:runtime-ui" }, { effectiveRouteReason: "matched:safety-medicine" }, { effectiveRouteReason: "choice:vcr-protocol" },
    { effectiveRouteReason: "session-binding" }, { effectiveRouteReason: "llm:literature" }]) {
    assert.equal(isPlatformStartedRun(run), false, JSON.stringify(run));
  }
});

// An independent verification of a scheduled task's claims is dispatched by the platform with `automated` unset (production:
// fourteen such runs on one account by 2026-10-14), so the route reason is the only structure there is. Every reason the
// dispatchers can write is named here from the constants that mint it, so a renamed route breaks this test and not memory.
const VERIFICATION_ROUTES = [VERIFICATION_ROUTE_REASON, EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON];
const SCHEDULED_ROUTES = [...["routine", "literature-sentinel", "evidence-update", "data-prospecting"].map((type) => `autopilot:${type}`),
  ...["evidence-update", "literature-sentinel"].map((type) => evidenceProgrammeRouteReason(type))];

test("every route reason the autopilot and the evidence programme mint is a run the platform started", () => {
  assert.equal(VERIFICATION_ROUTE_REASON, "autopilot-verify");
  assert.ok(EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX.startsWith("autopilot:"));
  for (const reason of [...VERIFICATION_ROUTES, ...SCHEDULED_ROUTES]) {
    assert.equal(isPlatformStartedRun({ effectiveRouteReason: reason }), true, reason);
    assert.equal(isPlatformStartedRun({ effectiveRouteReason: `adopted:runtime-ui:${reason}` }), false, "a person's turn adopted from the page is not a dispatch, whatever route it was given");
  }
});
