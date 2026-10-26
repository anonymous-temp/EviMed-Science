// Which other statements of an account's memory say what a forgotten one said (`nativeMemoryForgetEverywhere.mjs`): the rejection list's
// containment in code, then its one judge for the lines that are only near. The model's answer is read only as far as it stands.
import assert from "node:assert/strict";
import test from "node:test";

import { actOf, duplicatesOf } from "../src/nativeMemoryForgetEverywhere.mjs";
import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";

const files = (entries) => Object.entries(entries).map(([uri, statements]) => ({ uri, type: "preferences", statements }));

/** A judge that says what it is told to, and records what it was asked. */
function judge(sameOf) {
  const asked = [];
  return { asked, same: async (request) => {
    asked.push(request);
    return { same: new Map(request.candidates.flatMap((candidate, index) => (sameOf(candidate.text) ? [[index, candidate.removed[0].fingerprint]] : []))), stated: new Set() };
  } };
}

test("a line that contains the forgotten words is decided in code, with no model asked, and the forgotten line itself is not its own duplicate", async () => {
  resetNativeMemoryMetrics();
  const asked = judge(() => true);
  const found = await duplicatesOf({
    userId: "u1", judge: asked, removed: ["我平时骑车通勤，单程约 40 分钟"],
    files: files({ "a.md": ["我平时骑车通勤，单程约 40 分钟 (as of 2026-10-01)", "我喜欢跑步"], "b.md": ["工作日我平时骑车通勤，单程约 40 分钟，风雨无阻"] }),
  });
  // `a.md` holds the forgotten line itself (dated), which is not a duplicate of itself; `b.md` holds it with more around it.
  assert.deepEqual([...found], [["b.md", ["工作日我平时骑车通勤，单程约 40 分钟，风雨无阻"]]]);
  assert.equal(asked.asked.length, 0, "containment is code");
});

test("the forgotten line's own fingerprint is skipped, whatever date it wears", async () => {
  const found = await duplicatesOf({ userId: "u1", judge: null, removed: ["我骑车通勤"], files: files({ "a.md": ["我骑车通勤 (as of 2026-10-02)"] }) });
  assert.equal(found.size, 0, "the same line, dated, is the forgotten line and is not removed twice");
});

test("a line that is only near goes to the one judge, the best-scored first, and only what it says is the same goes", async () => {
  resetNativeMemoryMetrics();
  const asked = judge((text) => text.includes("自行车"));
  const found = await duplicatesOf({
    userId: "u1", judge: asked, removed: ["我平时骑车通勤，单程约 40 分钟"],
    files: files({ "b.md": ["通勤方式：骑自行车，单程约 40 分钟", "通勤时我平时坐地铁，单程约 40 分钟", "我喜欢先看结论再看细节"] }),
  });
  assert.equal(asked.asked.length, 1, "one call");
  assert.deepEqual([...found.keys()], ["b.md"]);
  assert.deepEqual(found.get("b.md"), ["通勤方式：骑自行车，单程约 40 分钟"], "the subway line shares words and is not the same thing");
  assert.equal(nativeMemoryCounters().forgetDuplicates.kept, 1);
  assert.deepEqual(asked.asked[0].candidates.map((candidate) => candidate.removed[0].fingerprint), asked.asked[0].candidates.map(() => lineFingerprint("我平时骑车通勤，单程约 40 分钟")));
});

test("with no judge, or a judge that says nothing, the near lines stay: a forget never fails for it", async () => {
  resetNativeMemoryMetrics();
  const near = files({ "b.md": ["通勤方式：骑自行车，单程约 40 分钟"] });
  assert.equal((await duplicatesOf({ userId: "u1", judge: null, removed: ["我平时骑车通勤，单程约 40 分钟"], files: near })).size, 0);
  assert.equal(nativeMemoryCounters().forgetDuplicates.judge_failed, 1);
  assert.equal((await duplicatesOf({ userId: "u1", judge: { same: async () => ({ same: new Map(), stated: new Set() }) }, removed: ["我平时骑车通勤，单程约 40 分钟"], files: near })).size, 0);
});

test("a short forgotten line is no phrase to forbid every line that holds it, and an unrelated line is never asked about", async () => {
  const asked = judge(() => true);
  const found = await duplicatesOf({ userId: "u1", judge: asked, removed: ["骑车"], files: files({ "b.md": ["周末骑车去郊外", "我是心内科医生"] }) });
  assert.equal(found.size, 0);
  assert.equal(asked.asked.length, 0, "four characters is below what the prefilter looks at");
});

test("an act is read back from a reason, and only a marker of the one shape is one", () => {
  assert.equal(actOf("forgotten on the memory page [act:0123456789ab]"), "0123456789ab");
  assert.equal(actOf("forgotten on the memory page"), null);
  assert.equal(actOf("forgotten [act:xyz]"), null);
});
