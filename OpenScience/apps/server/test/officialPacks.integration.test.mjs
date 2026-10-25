// The platform's official starter packs end to end, against a real PostgreSQL: published once and only when their text changes, held by every
// ordinary account without counting towards its eight, kept off by an account that switched one off, stopped for everyone by what their runs say.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateMemorySettings } from "../src/memorySettingsPersistence.mjs";
import { OfficialPacks } from "../src/officialPacks.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const PUBLISHER = "evimed-evidence-center";
const person = `official_person_${randomUUID()}`;
const other = `official_other_${randomUUID()}`;
const subject = `official_subject_${randomUUID()}`;
/** @type {any} */ let directory; /** @type {any} */ let sources; /** @type {any} */ let database; /** @type {any} */ let documents;
/** @type {any} */ let capsules; /** @type {any} */ let transfers; /** @type {any} */ let official;
/** @type {{ calls: number, entries: string[][] }} */ const scans = { calls: 0, entries: [] };

/** A pack folder as the repository keeps them. @param {string} pack @param {Record<string, string>} files */
async function writePack(pack, files) {
  await mkdir(path.join(sources, pack), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(sources, pack, name), text);
}
/** @param {string} title @param {string} body @param {string} [scope] */
const methodFile = (title, body, scope = "conversation") => `---\nscope: ${scope}\nwhenToUse: 写周报的时候。\n---\n# ${title}\n\n${body}\n`;
const CARD = (/** @type {string} */ title) => JSON.stringify({ title, summary: `${title}的摘要`, order: 1 });

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-official-");
  sources = path.join(directory, "official");
  await mkdir(sources);
  await writePack("daily", { "pack.json": CARD("日常文稿"), "weekly.md": methodFile("周报：事实只用你给的", "没给的栏留空。"), "mail.md": methodFile("邮件：写清要对方做什么", "一封一件事。") });
  await writePack("review", { "pack.json": CARD("系统综述"), "pooling.md": methodFile("合并之前先看异质性", "可比性不够就不合并。", "conversation, meta-analysis") });
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateMemorySettings(database);
  // A database of its own (the product-state run gives each file one) has no product ledger yet: the publisher's records live there.
  await migrateProductStore(database);
  await clearPublisher();
  await database.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Person','development'),($2,'Other','development'),($3,'Subject',NULL)`.replace("NULL", "'subject'"),
    [person, other, subject]);
  assert.equal((await database.query("SELECT auth_type FROM evimed_control.users WHERE id=$1", [PUBLISHER])).rows[0]?.auth_type, "platform", "the migration made the publisher account");
  documents = new ProductDocuments(database);
  capsules = new CapsuleService(documents);
  transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(directory), dataDir: directory });
  const scanner = { scan: async (/** @type {any} */ _owner, /** @type {any[]} */ entries) => {
    scans.calls += 1; scans.entries.push(entries.map((entry) => entry.id));
    return { kept: entries.map((entry) => entry.id), unchecked: [], held: [], dropped: [], safety: [], model: "ok", checkedAt: new Date().toISOString() };
  } };
  official = new OfficialPacks({ documents, database, transfers, scanner, sourcesDir: sources, report: (line) => process.stderr.write(`${line}\n`) });
  capsules.official = official;
});

/** The publisher's records are one platform's, shared by every test file that starts the app against this database: this file owns them while it runs. */
async function clearPublisher() {
  await database.query("DELETE FROM evimed_product.documents WHERE user_id=$1 AND kind='preferences' AND payload->>'recordType' IN ('official-pack','official-method','official-promoted','capsule-snapshot')", [PUBLISHER]);
}

after(async () => {
  if (database) {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[person, other, subject]]);
    await clearPublisher();
    await database.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a pack is published once, as a signed snapshot of the publisher, and is left alone while its text is the same", options, async () => {
  const first = await official.publishAll();
  assert.deepEqual(first.map((result) => [result.packId, result.state, result.version]).sort(), [["daily", "published", 1], ["review", "published", 1]]);
  assert.equal(scans.calls, 2, "one scan per pack version");
  const record = await documents.get(PUBLISHER, "preferences", "official-pack:daily");
  assert.equal(record.payload.status, "published");
  assert.equal(record.payload.card.author, "EviMed 证据中心");
  assert.equal(record.payload.methods.length, 2);
  const snapshot = await documents.get(PUBLISHER, "preferences", record.payload.snapshotId);
  assert.equal(snapshot.payload.recordType, "capsule-snapshot");
  assert.equal(snapshot.payload.status, "active");
  assert.equal(snapshot.payload.channel, "official");
  const again = await official.publishAll();
  assert.deepEqual(again.map((result) => result.state).sort(), ["unchanged", "unchanged"]);
  assert.equal(scans.calls, 2, "an unchanged pack is not scanned again");
  assert.equal((await documents.get(PUBLISHER, "preferences", "official-pack:daily")).revision, record.revision, "and not written again");
});

test("an ordinary account finds the packs on its shelf, enabled, and they are not among the eight in force", options, async () => {
  const shelf = await capsules.received(person);
  assert.deepEqual(shelf.map((pack) => pack.official?.packId).sort(), ["daily", "review"]);
  for (const pack of shelf) {
    assert.equal(pack.enabled, true);
    assert.equal(pack.card.author, "EviMed 证据中心");
    assert.equal(pack.sharedFrom.label, "EviMed 证据中心的默认做法");
  }
  assert.deepEqual(shelf.find((pack) => pack.official?.packId === "daily")?.methods.sort(), ["周报：事实只用你给的", "邮件：写清要对方做什么"].sort());
  assert.deepEqual((await capsules.active(person)).items, [], "the account's list of capsules in force is untouched");
  const methods = await capsules.officialMethods(person);
  assert.deepEqual(methods.map((method) => method.key), ["official:daily:mail", "official:daily:weekly", "official:review:pooling"]);
  assert.deepEqual(methods.find((method) => method.methodId === "pooling")?.scope, ["conversation", "meta-analysis"]);
});

test("an account that cannot hold a capsule of its own is given none, and a second read makes nothing new", options, async () => {
  assert.equal(await official.ensureFor(subject), null);
  assert.deepEqual(await capsules.received(subject), []);
  const before = (await documents.list(person, "capsule", { limit: 100 })).items.length;
  await capsules.received(person);
  official.settled.clear();
  await capsules.received(person);
  assert.equal((await documents.list(person, "capsule", { limit: 100 })).items.length, before);
});

test("two readers at once make one copy of each pack", options, async () => {
  await Promise.all([official.ensureFor(other), (async () => { official.inflight.clear(); return official.ensureFor(other); })(), (async () => { official.inflight.clear(); return official.ensureFor(other); })()]);
  const copies = (await documents.list(other, "capsule", { limit: 100, filter: { imported: true } })).items;
  assert.deepEqual(copies.map((copy) => copy.id).sort(), ["official-copy:daily", "official-copy:review"]);
  const facts = (await documents.list(other, "fact", { limit: 100, filter: { capsuleId: "official-copy:daily" } })).items;
  assert.equal(facts.length, 2, "no pack was written twice");
});

test("switching a pack off keeps it off across versions, and a new version reaches the account that kept it on", options, async () => {
  const daily = "official-copy:daily";
  assert.deepEqual(await capsules.disable(person, daily), { disabled: true, lists: 0 });
  assert.equal((await capsules.received(person)).find((pack) => pack.id === daily)?.enabled, false);
  assert.deepEqual((await capsules.officialMethods(person)).map((method) => method.key), ["official:review:pooling"], "an off pack mounts nothing");
  // The folder changes: one method rewritten, one added.
  await writePack("daily", { "weekly.md": methodFile("周报：事实只用你给的（改）", "没给的栏留空，或者问一句。"), "minutes.md": methodFile("纪要：只记会上说过的", "负责人没说就写未说明。") });
  const second = await official.publishAll();
  assert.deepEqual(second.map((result) => [result.packId, result.state, result.version]).sort(), [["daily", "published", 2], ["review", "unchanged", 1]]);
  const record = await documents.get(PUBLISHER, "preferences", "official-pack:daily");
  assert.equal(record.payload.previous.version, 1);
  assert.equal(record.payload.card.changelog, "新增 2 条、移除 1 条、保留 1 条");
  const previousSnapshot = await documents.get(PUBLISHER, "preferences", record.payload.previous.snapshotId);
  assert.equal(previousSnapshot.payload.status, "revoked", "the version before it goes");
  const shelf = await capsules.received(person);
  const copy = shelf.find((pack) => pack.id === daily);
  assert.equal(copy.enabled, false, "still off after the upgrade");
  assert.deepEqual(copy.methods.sort(), ["周报：事实只用你给的（改）", "纪要：只记会上说过的", "邮件：写清要对方做什么"].sort());
  assert.ok(copy.upgradedAt, "continued in place, not a second pack");
  assert.equal((await documents.list(person, "capsule", { limit: 100, filter: { imported: true } })).items.length, 2);
  // The account that left it on has the new text as soon as it reads.
  const others = await capsules.officialMethods(other);
  assert.deepEqual(others.filter((method) => method.packId === "daily").map((method) => method.methodId).sort(), ["mail", "minutes", "weekly"]);
  assert.match(others.find((method) => method.methodId === "weekly")?.body ?? "", /或者问一句/);
  await capsules.enableReceived(person, daily);
  assert.equal((await capsules.received(person)).find((pack) => pack.id === daily)?.enabled, true);
});

test("what runs say counts across accounts: a body that is corrected again and again is stopped for everyone, and an operator gives it back", options, async () => {
  const held = (await capsules.officialMethods(other)).find((method) => method.key === "official:review:pooling");
  assert.ok(held);
  const at = (/** @type {number} */ n) => new Date(Date.UTC(2026, 9, 25, 10, n)).toISOString();
  // Three corrections are not yet a finding; each run is counted once.
  for (let n = 0; n < 3; n += 1) assert.deepEqual(await official.recordApplied({ key: held.key, sha: held.sha, runId: `run_${n}`, outcome: "corrected", at: at(n), userId: person }), { changed: true, stopped: false });
  assert.deepEqual(await official.recordApplied({ key: held.key, sha: held.sha, runId: "run_0", outcome: "corrected", at: at(0), userId: person }), { changed: false, stopped: false }, "a run is counted once");
  assert.equal((await capsules.officialMethods(other)).some((method) => method.key === held.key), true);
  // A fourth correction from the same account would be a finding, but one account does not stop a body every account is given.
  assert.deepEqual(await official.recordApplied({ key: held.key, sha: held.sha, runId: "run_3", outcome: "corrected", at: at(3), userId: person }), { changed: true, stopped: false });
  assert.deepEqual(await official.recordApplied({ key: held.key, sha: held.sha, runId: "run_4", outcome: "corrected", at: at(4), userId: other }), { changed: true, stopped: true });
  // Stopped for every account at once, with the numbers it was stopped on, and gone from the shelf's list of what a pack holds.
  assert.equal((await capsules.officialMethods(other)).some((method) => method.key === held.key), false);
  assert.equal((await capsules.officialMethods(person)).some((method) => method.key === held.key), false);
  const record = await documents.get(PUBLISHER, "preferences", `official-method:review:pooling:${held.sha.slice(0, 12)}`);
  assert.equal(record.payload.status, "stopped");
  assert.deepEqual([record.payload.stopped.reason, record.payload.stopped.runs, record.payload.stopped.bad], ["harm", 4, 4]);
  assert.deepEqual((await capsules.received(other)).find((pack) => pack.official?.packId === "review")?.methods, []);
  assert.deepEqual(await official.recordApplied({ key: held.key, sha: held.sha, runId: "run_9", outcome: "clean", at: at(9) }), { changed: false, stopped: true }, "nothing more is counted for a stopped body");
  // One call gives it back, counted from nothing; a body that was not stopped cannot be "restored".
  assert.equal(await official.restore(held.key, held.sha), true);
  assert.equal(await official.restore(held.key, held.sha), false);
  assert.equal((await capsules.officialMethods(other)).some((method) => method.key === held.key), true);
  const snapshot = await official.snapshot();
  assert.deepEqual(snapshot.methods.map((method) => [method.key, method.status, method.runs]), [[held.key, "active", 0]]);
  assert.deepEqual(snapshot.packs.map((pack) => [pack.packId, pack.status]).sort(), [["daily", "published"], ["review", "published"]]);
  assert.equal(official.stats().stopped, 1);
  assert.equal(official.stats().restored, 1);
});

test("a pack an account deleted is not made again, and a taken-down copy stays down", options, async () => {
  const review = await capsules.get(person, "official-copy:review");
  await capsules.documents.remove(person, "capsule", review.id, review.revision);
  official.settled.clear();
  const shelf = await capsules.received(person);
  assert.deepEqual(shelf.map((pack) => pack.official?.packId), ["daily"]);
  // The operator's takedown of everything the platform published reaches the copies, as it does for any author.
  const result = await transfers.takeDown({ authorId: PUBLISHER, by: "operator", reason: "test" });
  assert.ok(result.copies >= 1 || result.copies.length >= 1);
  official.settled.clear();
  const after = await capsules.received(other);
  assert.ok(after.every((pack) => pack.takenDown && pack.enabled === false));
  assert.deepEqual(await capsules.officialMethods(other), []);
});

test("a pack the folder no longer has is taken off the shelves, but a folder that is missing or holds nothing takes nothing off", options, async () => {
  const published = async (/** @type {string} */ pack) => (await documents.get(PUBLISHER, "preferences", `official-pack:${pack}`)).payload.status;
  const lost = new OfficialPacks({ documents, database, transfers, scanner: { scan: async () => { throw new Error("not asked"); } }, sourcesDir: path.join(directory, "no-such-folder") });
  assert.deepEqual(await lost.publishAll(), []);
  const emptyDir = path.join(directory, "empty");
  await mkdir(emptyDir);
  assert.deepEqual(await new OfficialPacks({ documents, database, transfers, scanner: /** @type {any} */ (null), sourcesDir: emptyDir }).publishAll(), []);
  assert.deepEqual([await published("daily"), await published("review")], ["published", "published"], "an image that lost its folder is not an instruction to empty every shelf");
  // The folder lost one pack on purpose.
  await rm(path.join(sources, "review"), { recursive: true });
  await official.publishAll();
  assert.deepEqual([await published("daily"), await published("review")], ["published", "withdrawn"]);
  const withdrawn = await documents.get(PUBLISHER, "preferences", "official-pack:review");
  assert.equal((await documents.get(PUBLISHER, "preferences", withdrawn.payload.snapshotId)).payload.status, "revoked");
  official.settled.clear();
  await capsules.received(other);
  assert.equal(await documents.get(other, "capsule", "official-copy:review"), null);
});

test("a person's general method that passed the promotion gates is published as a method of the pack 「大家的做法」 for every account, and nothing of its author travels with it", options, async () => {
  const { createOfficialPromotion } = await import("../src/officialPromotion.mjs");
  const promotion = createOfficialPromotion({
    documents, officialPacks: official, perDay: 5, facts: async () => ({ names: [] }),
    judge: async () => ({ general: true, class: "reporting-and-delivery" }),
    review: async () => ({ independent: true, general: true, class: "reporting-and-delivery" }),
    established: async (ids) => new Set(ids),
  });
  const payload = {
    status: "approved", contentDigest: "sha256:" + "d".repeat(64),
    frontmatter: { name: "send-the-table-with-its-question", description: "Name the question a table answers before the table.", whenToUse: "A report carries a table." },
    display: { title: "表格先写它回答的问题", summary: "每张表前面先交代它回答什么问题。" },
    body: ["## Purpose", "Say what a table answers before showing it, so a reader knows what to look for.", "## Workflow", "1. Write the question in one sentence above the table.", "2. Keep the question and the columns consistent."].join("\n"),
    provenance: { scope: "conversation", sourceProjectId: "private-project", runId: "private-run" },
  };
  assert.deepEqual(await promotion.consider({ userId: person, method: { id: "method:learned:send-the-table-with-its-question", payload } }), { state: "candidate" });
  assert.deepEqual(await promotion.tick(), { judged: 0, rechecked: 1 });
  const pack = await documents.get(PUBLISHER, "preferences", "official-pack:shared-practices");
  assert.equal(pack.payload.status, "published", "published at once, by the re-check");
  assert.equal(pack.payload.methods.length, 1);
  // Held by every ordinary account, as a pack of the platform's, labelled as everyone's.
  official.settled.clear();
  const shelf = await capsules.received(other);
  const shared = shelf.find((entry) => entry.official?.packId === "shared-practices");
  assert.ok(shared, "on the shelf");
  assert.equal(shared.card.title, "大家的做法");
  assert.equal(shared.enabled, true);
  assert.deepEqual(shared.methods, ["表格先写它回答的问题"]);
  const methods = await capsules.officialMethods(other);
  const promoted = methods.find((method) => method.packId === "shared-practices");
  assert.ok(promoted && promoted.scope.join() === "conversation");
  // What was written down about it names no account, project, run or method of its author.
  const everything = JSON.stringify([(await documents.list(PUBLISHER, "preferences", { limit: 100 })).items, (await documents.list(other, "fact", { limit: 100 })).items]);
  for (const secret of [person, "private-project", "private-run", "method:learned:send-the-table-with-its-question"]) assert.equal(everything.includes(secret), false, secret);
});
