// A claim's `validUntil` was stored and never read (completeness review
// 2026-09-28): a claim past it still read as current on the evidence page and
// to a run through geo_read. The plan (§3.1) says such a claim is re-checked.
import assert from "node:assert/strict";
import test from "node:test";
import { claimStatusAt } from "../src/geoService.mjs";

test("an active claim past its validity reads as expired (待重核); everything else keeps its status", () => {
  const now = new Date("2027-01-02T00:00:00.000Z");
  assert.equal(claimStatusAt({ status: "active", validUntil: "2026-12-31T00:00:00.000Z" }, now), "expired");
  // The 88 production claims valid until 2026-12-31 are current today.
  assert.equal(claimStatusAt({ status: "active", validUntil: "2026-12-31T00:00:00.000Z" }, new Date("2026-09-28T00:00:00.000Z")), "active");
  assert.equal(claimStatusAt({ status: "active", validUntil: null }, now), "active", "no validity recorded is not an expiry");
  assert.equal(claimStatusAt({ status: "active", validUntil: "not a date" }, now), "active");
  assert.equal(claimStatusAt({ status: "retired", validUntil: "2026-01-01T00:00:00.000Z" }, now), "retired", "a retired claim stays retired");
  assert.equal(claimStatusAt({ status: "expired", validUntil: null }, now), "expired");
  assert.equal(claimStatusAt({ validUntil: "2026-01-01T00:00:00.000Z" }, now), "expired", "a claim written without a status is active until then");
});
