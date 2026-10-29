// The official packs as the repository keeps them: what a method file must be, and what the shipped folder says.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closedSetFindings } from "../src/capsuleScan.mjs";
import {
  OFFICIAL_METHOD_LIMITS, OFFICIAL_PACKS_DIR, officialMethodId, officialMethodName, parseOfficialMethod, parseOfficialMethodId, readOfficialPackSources,
} from "../src/officialPackSources.mjs";

const GOOD = "---\nscope: conversation, meta-analysis\nwhenToUse: 写周报时。\n---\n# 周报：事实只用你给的\n\n- 没给的栏留空。\n";

test("a method file is a frontmatter, a heading and a body", () => {
  const parsed = parseOfficialMethod(GOOD, "daily", "weekly");
  assert.ok("method" in parsed);
  const method = /** @type {any} */ (parsed).method;
  assert.equal(method.key, "official:daily:weekly");
  assert.equal(method.name, "official-daily-weekly");
  assert.deepEqual(method.scope, ["conversation", "meta-analysis"]);
  assert.equal(method.title, "周报：事实只用你给的");
  assert.equal(method.whenToUse, "写周报时。");
  assert.equal(method.body, "- 没给的栏留空。");
  assert.equal(method.content, "# 周报：事实只用你给的\n\n适用：写周报时。\n\n- 没给的栏留空。");
  assert.deepEqual(parseOfficialMethodId(method.key), { packId: "daily", methodId: "weekly" });
  assert.equal(parseOfficialMethodId("method:learned:x"), null);
  assert.equal(officialMethodId("daily", "weekly"), "official:daily:weekly");
  assert.equal(officialMethodName("daily", "weekly"), "official-daily-weekly");
});

test("what is not a method is named, and nothing is guessed", () => {
  const issue = (/** @type {string} */ text) => /** @type {any} */ (parseOfficialMethod(text, "p", "m")).issue;
  assert.equal(issue("# 无前置\n\n正文"), "no_frontmatter");
  assert.equal(issue("---\nscope: conversation\nwhenToUse: x\n---\n没有标题"), "no_heading");
  assert.equal(issue("---\nscope: conversation\nwhenToUse: x\nowner: me\n---\n# 标题\n\n正文"), "frontmatter_key_unknown");
  assert.equal(issue("---\nscope: Conversation Now\nwhenToUse: x\n---\n# 标题\n\n正文"), "scope_invalid");
  assert.equal(issue("---\nscope: conversation, conversation\nwhenToUse: x\n---\n# 标题\n\n正文"), "scope_invalid");
  assert.equal(issue("---\nscope: conversation\n---\n# 标题\n\n正文"), "when_to_use_invalid");
  assert.equal(issue(`---\nscope: conversation\nwhenToUse: x\n---\n# 标题\n\n${"字".repeat(OFFICIAL_METHOD_LIMITS.body + 1)}`), "body_invalid");
  assert.equal(issue("---\nscope: conversation\nwhenToUse: x\n---\n# 标题\n\n"), "body_invalid");
});

test("a folder is read pack by pack; a pack or a method that is wrong is left out and named", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-official-sources-"));
  try {
    await mkdir(path.join(root, "good")); await mkdir(path.join(root, "empty")); await mkdir(path.join(root, "Bad_Id")); await mkdir(path.join(root, "nocard"));
    await writeFile(path.join(root, "good", "pack.json"), JSON.stringify({ title: "好", summary: "一句话", order: 2 }));
    await writeFile(path.join(root, "good", "weekly.md"), GOOD);
    await writeFile(path.join(root, "good", "broken.md"), "没有前置");
    await writeFile(path.join(root, "empty", "pack.json"), JSON.stringify({ title: "空", summary: "没有做法" }));
    await writeFile(path.join(root, "Bad_Id", "pack.json"), "{}");
    const { packs, issues } = await readOfficialPackSources(root);
    assert.deepEqual(packs.map((pack) => pack.id), ["good"]);
    assert.deepEqual(packs[0].methods.map((method) => method.id), ["weekly"]);
    assert.deepEqual(issues.map((entry) => `${entry.pack}/${entry.method ?? ""}:${entry.issue}`).sort(),
      ["Bad_Id/:pack_id_invalid", "empty/:no_method", "good/broken:no_frontmatter", "nocard/:pack_json_unreadable"]);
    assert.deepEqual((await readOfficialPackSources(path.join(root, "missing"))).issues, [{ pack: "", issue: "directory_missing" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a pack's version is the hash of what it says: the same text is the same version, a changed word is another", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-official-hash-"));
  try {
    await mkdir(path.join(root, "p"));
    await writeFile(path.join(root, "p", "pack.json"), JSON.stringify({ title: "包", summary: "摘要" }));
    await writeFile(path.join(root, "p", "m.md"), GOOD);
    const first = (await readOfficialPackSources(root)).packs[0].contentHash;
    assert.equal((await readOfficialPackSources(root)).packs[0].contentHash, first);
    await writeFile(path.join(root, "p", "m.md"), GOOD.replace("留空", "留白"));
    assert.notEqual((await readOfficialPackSources(root)).packs[0].contentHash, first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------- the shipped folder

test("the shipped folder holds four or five packs of two to four methods each, and every text in it is accepted", async () => {
  const { packs, issues } = await readOfficialPackSources(OFFICIAL_PACKS_DIR);
  assert.deepEqual(issues, [], "no text of the repository is refused at start");
  assert.ok(packs.length >= 4 && packs.length <= 5, `${packs.length} packs`);
  for (const pack of packs) assert.ok(pack.methods.length >= 2 && pack.methods.length <= 4, `${pack.id}: ${pack.methods.length} methods`);
  const keys = packs.flatMap((pack) => pack.methods.map((method) => method.key));
  assert.equal(new Set(keys).size, keys.length);
});

test("no shipped text names a tool or a path of the platform's or carries a link that acts by itself", async () => {
  const { packs } = await readOfficialPackSources(OFFICIAL_PACKS_DIR);
  for (const pack of packs) for (const method of pack.methods) {
    assert.deepEqual(closedSetFindings(method.content), [], `${method.key} would be dropped by the scan`);
    assert.doesNotMatch(method.content, /<\/?[a-z][^>]*>/i, `${method.key} carries markup`);
  }
});

test("a layout's places are filled only from what the person gave: each daily-writing method says to leave a place empty or to ask", async () => {
  const { packs } = await readOfficialPackSources(OFFICIAL_PACKS_DIR);
  const daily = packs.find((pack) => pack.id === "daily-writing");
  assert.ok(daily, "the daily-writing pack is shipped");
  for (const method of daily.methods) {
    assert.match(method.body, /用户[^。]*没(?:给|说)|没(?:给|说)[^。]*用户|材料里没/, `${method.key} says what to do with what was not given`);
    assert.match(method.body, /留空|留出空位|未说明|待补充|问一句|请用户(?:确认|补)|标出来/, `${method.key} leaves it empty or asks`);
  }
  assert.ok(daily.methods.some((method) => /不替用户补写|不替人指派|不替用户做承诺/.test(method.body)));
});
