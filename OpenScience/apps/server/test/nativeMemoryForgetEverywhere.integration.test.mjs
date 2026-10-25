// Forget means forget everywhere (2026-10-25, S4 of `evals/capsule-longitudinal`): a commute stated once was kept in two files; the person's
// 「忘记」 on one left the other, and the next conversation said it again. On a real PostgreSQL and a stub engine: the other line goes in the same
// act, as a revision of it, on the rejection list under its own type, and comes back with the line the person restores.
import assert from "node:assert/strict";
import { test } from "node:test";

import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

/** A judge that calls a line the same when `same(text)` says so. */
function judge(same) {
  const asked = [];
  return { asked, same: async (request) => {
    asked.push(request);
    return { same: new Map(request.candidates.flatMap((candidate, index) => (same(candidate.text) ? [[index, candidate.removed[0].fingerprint]] : []))), stated: new Set() };
  } };
}

const PROFILE = "# 用户\n- 我平时骑车通勤，单程约 40 分钟 (as of 2026-10-13)\n- 我喜欢跑步 (as of 2026-10-13)";

/** A commute by bicycle, said either way. */
const bicycle = (text) => text.includes("骑车") || text.includes("自行车");

async function commute(t, { judge: held = judge(bicycle) } = {}) {
  const f = await fixture(t);
  f.store.rejectionJudge = held;
  const profile = f.seed("profile.md", PROFILE, { type: "profile" });
  const preference = f.seed("preferences/self/通勤.md", "- 通勤方式：骑自行车，单程约 40 分钟\n- 回复先给结论", { type: "preferences" });
  const other = f.seed("preferences/self/运动.md", "- 周末去跑步", { type: "preferences" });
  return { f, held, profile, preference, other };
}

const line = async (f, text) => (await f.store.records(f.userId)).find((record) => record.document && record.value === text);

test("forgetting a line forgets the line elsewhere that says the same, as revisions of one act", options, async (t) => {
  const { f, held, profile, preference, other } = await commute(t);
  const target = await line(f, "我平时骑车通勤，单程约 40 分钟");
  const answer = await f.store.update(f.userId, target.id, { status: "archived", expectedVersion: target.version });
  assert.equal(answer.status, "archived");
  assert.equal(held.asked.length, 1, "one call for the near lines");
  // The profile lost its line and kept the other; the preference lost the one bullet and kept the other.
  assert.equal(f.stub.files.get(profile).includes("骑车"), false);
  assert.match(f.stub.files.get(profile), /我喜欢跑步/);
  assert.equal(f.stub.files.get(preference), "- 回复先给结论");
  assert.match(f.stub.files.get(other), /周末去跑步/, "a line about something else stays");
  // Both are revisions of the same act and both are on the forgotten list, with their words.
  const forgotten = (await f.store.forgotten(f.userId)).filter((entry) => entry.value.includes("骑") || entry.value.includes("通勤"));
  assert.equal(forgotten.length, 2);
  assert.equal(new Set(forgotten.map((entry) => entry.act)).size, 1, "one act");
  assert.ok(forgotten[0].act);
  // Their wordings are on the rejection lists of their own types.
  assert.ok((await f.overlay.rejectedFingerprints(f.userId, "profile")).has(lineFingerprint("我平时骑车通勤，单程约 40 分钟")));
  assert.ok((await f.overlay.rejectedFingerprints(f.userId, "preferences")).has(lineFingerprint("通勤方式：骑自行车，单程约 40 分钟")));
  assert.equal(nativeMemoryCounters().forgetDuplicates.removed, 1);
});

test("restoring either of them brings both back, and lifts both rejections", options, async (t) => {
  const { f, profile, preference } = await commute(t);
  const target = await line(f, "我平时骑车通勤，单程约 40 分钟");
  await f.store.update(f.userId, target.id, { status: "archived", expectedVersion: target.version });
  // The duplicate is restored on its own: the line it repeated comes with it.
  const duplicate = (await f.store.forgotten(f.userId)).find((entry) => entry.value.includes("骑自行车"));
  await f.store.update(f.userId, duplicate.id, { status: "active", expectedVersion: duplicate.version });
  assert.match(f.stub.files.get(profile), /骑车通勤/);
  assert.match(f.stub.files.get(preference), /骑自行车/);
  assert.equal((await f.store.forgotten(f.userId)).length, 0, "nothing is left on the list");
  assert.equal((await f.overlay.rejectedFingerprints(f.userId, "profile")).has(lineFingerprint("我平时骑车通勤，单程约 40 分钟")), false);
  assert.equal((await f.overlay.rejectedFingerprints(f.userId, "preferences")).has(lineFingerprint("通勤方式：骑自行车，单程约 40 分钟")), false);
});

test("a file left with nothing is forgotten whole, and the undo of a forgotten file brings back what went with it", options, async (t) => {
  const f = await fixture(t);
  f.store.rejectionJudge = judge(bicycle);
  const profile = f.seed("profile.md", PROFILE, { type: "profile" });
  const preference = f.seed("preferences/self/通勤.md", "- 通勤方式：骑自行车，单程约 40 分钟", { type: "preferences" });
  const record = (await f.store.records(f.userId)).find((entry) => entry.uri === preference);
  await f.store.update(f.userId, record.id, { status: "archived", expectedVersion: record.version });
  assert.equal(f.stub.files.has(preference), false, "the file that held the line is forgotten");
  assert.equal(f.stub.files.get(profile).includes("骑车通勤"), false, "and the profile line that said the same");
  const undone = await f.store.undo(f.userId, record.id, { expectedVersion: 0 });
  assert.equal(undone.undone, "restored");
  assert.equal(f.stub.files.has(preference), true);
  assert.match(f.stub.files.get(profile), /骑车通勤/, "the line that went with the file comes back with it");
});

test("a line that contains the forgotten words goes by code alone, and a hard delete keeps no text of either", options, async (t) => {
  const f = await fixture(t);
  const held = judge(() => true);
  f.store.rejectionJudge = held;
  const profile = f.seed("profile.md", PROFILE, { type: "profile" });
  const preference = f.seed("preferences/self/通勤.md", "- 工作日我平时骑车通勤，单程约 40 分钟，风雨无阻\n- 回复先给结论", { type: "preferences" });
  const target = await line(f, "我平时骑车通勤，单程约 40 分钟");
  await f.store.remove(f.userId, target.id, { keepText: false });
  assert.equal(held.asked.length, 0, "containment is decided in code");
  assert.equal(f.stub.files.get(preference), "- 回复先给结论");
  assert.equal(f.stub.files.get(profile).includes("骑车"), false);
  const texts = [];
  for (const uri of [profile, preference]) for (const revision of await f.overlay.revisionsOf(f.userId, uri)) texts.push(revision.before ?? "", revision.after ?? "");
  assert.equal(texts.some((text) => text.includes("骑车通勤")), false, "a delete takes the words out of the history, the duplicate's too");
  assert.deepEqual(await f.store.forgotten(f.userId), [], "and puts nothing on the list that could be restored");
  assert.ok((await f.overlay.rejectedFingerprints(f.userId, "preferences")).size >= 1, "but the wording is on the rejection list");
});

test("a judge that cannot be reached leaves the other line where it is, and the forget itself stands", options, async (t) => {
  const { f, preference } = await commute(t, { judge: { same: async () => { throw new Error("model unreachable"); } } });
  const target = await line(f, "我平时骑车通勤，单程约 40 分钟");
  const answer = await f.store.update(f.userId, target.id, { status: "archived", expectedVersion: target.version });
  assert.equal(answer.status, "archived", "the person's forget is done");
  assert.match(f.stub.files.get(preference), /骑自行车/, "the line the judge could not place stays");
  assert.equal((await f.store.forgotten(f.userId)).length, 1);
});

test("the conversation's forget tool forgets everywhere too, and a forget with nothing like it is as before", options, async (t) => {
  const { f, profile, preference } = await commute(t);
  const out = await f.store.forget({ id: f.userId }, null, preference);
  assert.equal(out.removed, true);
  assert.equal(f.stub.files.has(preference), false);
  assert.equal(f.stub.files.get(profile).includes("骑车通勤"), false, "the profile line that said the same went with the file");
  const alone = await fixture(t);
  alone.store.rejectionJudge = judge(() => true);
  const uri = alone.seed("preferences/self/a.md", "- 回复先给结论", { type: "preferences" });
  alone.seed("preferences/self/b.md", "- 文件名用 YYYYMMDD_序号", { type: "preferences" });
  assert.equal((await alone.store.forget({ id: alone.userId }, null, uri)).removed, true);
  assert.equal((await alone.store.forgotten(alone.userId)).every((entry) => !entry.act), true, "no act when nothing went with it");
});
