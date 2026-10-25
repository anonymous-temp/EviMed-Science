// The notices a GEO project's person reads name an action the page really has, and open where it is (review 2026-10-25): the
// diagnosis-empty notice told the reader to press 「让 AI 做」 on 「诊断页」, and neither exists any more.
import assert from "node:assert/strict";
import test from "node:test";
import { createGeoNotifier, geoNoticeHref } from "../src/geoNotify.mjs";

test("a diagnosis that measured nothing names the 「需要你」 row's 接着做 and opens the overview it is on", async () => {
  /** @type {any[]} */
  const sent = [];
  const notifier = createGeoNotifier({
    notifications: { create: async (/** @type {string} */ userId, /** @type {any} */ input) => { sent.push({ userId, ...input }); return { id: "n1" }; } },
    store: { memberRows: async () => [] },
  });
  await notifier.diagnosisEmpty({ id: "geo_1", userId: "alice", projectId: "p-1", product: { brandName: "信尔美" } }, { roundId: "r-1" });
  assert.equal(sent.length, 1);
  const [notice] = sent;
  assert.equal(notice.title, "信尔美：诊断没有测到回答");
  assert.match(notice.body, /“需要你”里点“接着做”/);
  assert.doesNotMatch(notice.body, /让 AI 做|诊断页|探测/, "no retired button, no retired page, no measuring internals");
  assert.equal(geoNoticeHref(notice.source.id), "/app/geo/geo_1/overview");
});
