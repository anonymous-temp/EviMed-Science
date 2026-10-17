import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { SKILL_DISPLAY, SKILL_DISPLAY_GEO_GROUP, SKILL_DISPLAY_GROUPS, SKILL_DISPLAY_LOOPX_GROUP } from "@evimed/domain/skill-display";
import { RUNTIME_INVENTORY_WORDS } from "@evimed/domain/runtime-inventory";
import { createPlatformSkillCatalogue, readSkillFolder, splitSkillText } from "../src/platformSkillCatalogue.mjs";
import { createSkillLibraryRoutes } from "../src/skillLibraryRoutes.mjs";
import { SkillLibraryService } from "../src/skillLibraryService.mjs";
import { HttpError, sendError } from "../src/security.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reader = { id: "reader" };
const scratch = [];
after(async () => { for (const dir of scratch) await fs.rm(dir, { recursive: true, force: true }); });
async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "platform-skills-"));
  scratch.push(dir);
  return dir;
}
async function skill(root, relative, text, extra = {}) {
  const dir = path.join(root, relative);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), text);
  for (const [name, body] of Object.entries(extra)) { await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fs.writeFile(path.join(dir, name), body); }
}

test("the list is every shipped skill in Chinese, in their groups, answered from the packages alone", async () => {
  const catalogue = createPlatformSkillCatalogue({ rootDir: repoRoot });
  const { groups, geoGroup, items } = await catalogue.list(reader);
  assert.deepEqual(groups, [...SKILL_DISPLAY_GROUPS]);
  assert.equal(geoGroup, SKILL_DISPLAY_GEO_GROUP, "the page is told which group is the module's, so it names none itself");
  assert.equal(items.length, Object.keys(SKILL_DISPLAY).length, "one row for each skill the table describes");
  assert.ok(items.every((item) => /[㐀-鿿]/.test(item.title) && /[㐀-鿿]/.test(item.use)), "every row is in Chinese");
  assert.ok(items.every((item) => item.directory === undefined && item.when === undefined), "a row names no folder on the server and carries no full text");
  // Rows come in the groups' order and, inside a group, in the table's own order.
  const rank = (group) => SKILL_DISPLAY_GROUPS.indexOf(group);
  assert.deepEqual(items.map((item) => rank(item.group)), [...items.map((item) => rank(item.group))].sort((left, right) => left - right));
  const first = items.filter((item) => item.group === "科研分析").map((item) => item.name);
  assert.deepEqual(first, Object.keys(SKILL_DISPLAY).filter((name) => SKILL_DISPLAY[name].group === "科研分析"));
  assert.equal(items.find((item) => item.name === "dsh-ppt")?.source, "community");
  assert.equal(items.find((item) => item.name === "survival-analysis")?.source, "platform");
});

test("one skill reads as its words and its full text without the file's front matter", async () => {
  const catalogue = createPlatformSkillCatalogue({ rootDir: repoRoot });
  const row = await catalogue.read("curated:survival-analysis", reader);
  assert.equal(row.title, "生存分析");
  assert.equal(row.when, SKILL_DISPLAY["survival-analysis"].when);
  assert.ok(row.instructions && row.instructions.length > 200);
  assert.ok(!row.instructions.startsWith("---"), "the front matter is not the text");
  await assert.rejects(catalogue.read("curated:no-such-skill", reader), { status: 404, code: "skill_platform_not_found" });
});

test("a folder this image does not carry still lists, says no text and offers no copy — and never fails the list", async () => {
  const root = await tempRoot();
  await skill(root, "runtime/skills/curated-scientific/survival-analysis", "---\nname: survival-analysis\ndescription: x\n---\n\nBody text.\n");
  const catalogue = createPlatformSkillCatalogue({ rootDir: root });
  const { items } = await catalogue.list(reader);
  assert.equal(items.length, Object.keys(SKILL_DISPLAY).length);
  const present = items.find((item) => item.name === "survival-analysis");
  const absent = items.find((item) => item.name === "dsh-ppt");
  assert.equal(present.canCopy, true);
  assert.equal(absent.canCopy, false);
  assert.equal((await catalogue.read("community:dsh-ppt", reader)).instructions, null);
  assert.equal((await catalogue.read("curated:survival-analysis", reader)).instructions, "Body text.\n");
  await assert.rejects(catalogue.snapshot("community:dsh-ppt", reader), { status: 409, code: "skill_platform_not_copyable" });
});

test("the method pack is listed under its own group where its folder is present, readable and never copyable — and only to an account the module is open to", async () => {
  const root = await tempRoot();
  await skill(root, "runtime/skills/geo-private/skills/geo-demo", "---\nname: geo-demo\ndescription: >\n  Audit a delivery package. Second sentence stays out.\n---\n\nPack text.\n");
  const allowed = new Set(["member"]);
  const catalogue = createPlatformSkillCatalogue({ rootDir: root, packAllowed: (user) => allowed.has(user.id) });
  const member = { id: "member" };
  const { items } = await catalogue.list(member);
  const geo = items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP);
  assert.deepEqual(geo.map((item) => [item.id, item.title, item.use, item.canCopy]), [["geo-private:geo-demo", "geo-demo", "Audit a delivery package.", false]]);
  assert.equal((await catalogue.read("geo-private:geo-demo", member)).instructions, "Pack text.\n");
  await assert.rejects(catalogue.snapshot("geo-private:geo-demo", member), { code: "skill_platform_not_copyable" });
  // An account outside the module sees neither the group nor the text, and reads it as a skill that does not exist.
  assert.equal((await catalogue.list(reader)).items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP).length, 0);
  await assert.rejects(catalogue.read("geo-private:geo-demo", reader), { status: 404, code: "skill_platform_not_found" });
  const without = await createPlatformSkillCatalogue({ rootDir: await tempRoot(), packAllowed: () => true }).list(member);
  assert.equal(without.items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP).length, 0, "no folder, no group");
});

test("the web image's index lists the method pack where the folder is not, and a name that is not a skill folder is not a skill", async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, "runtime/skills/geo-private"), { recursive: true });
  await fs.writeFile(path.join(root, "runtime/skills/geo-private/geo-pack-index.json"), JSON.stringify({
    schemaVersion: 1, package: "geo-skills", version: "3.0.1",
    skills: [
      { name: "geo-care-nodes", title: "geo-care-nodes", use: "Maps the nodes of a care pathway." },
      { name: "../escape", title: "x", use: "never" },
      { name: "geo-verify-product-label", title: "Verify the label", use: "Checks the claim against the label." },
    ],
  }));
  const member = { id: "member" };
  const catalogue = createPlatformSkillCatalogue({ rootDir: root, packAllowed: (user) => user.id === "member" });
  const geo = (await catalogue.list(member)).items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP);
  assert.deepEqual(geo.map((item) => [item.id, item.title, item.use, item.canCopy]), [
    ["geo-private:geo-care-nodes", "geo-care-nodes", "Maps the nodes of a care pathway.", false],
    ["geo-private:geo-verify-product-label", "Verify the label", "Checks the claim against the label.", false],
  ]);
  const detail = await catalogue.read("geo-private:geo-care-nodes", member);
  assert.equal(detail.instructions, null, "the index holds no text: the drawer says so plainly");
  await assert.rejects(catalogue.snapshot("geo-private:geo-care-nodes", member), { code: "skill_platform_not_copyable" });
  assert.equal((await catalogue.list(reader)).items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP).length, 0, "an account outside the module sees none");

  // The folder, where there is one, wins: the text is there to read.
  await skill(root, "runtime/skills/geo-private/skills/geo-demo", "---\nname: geo-demo\ndescription: Folder wins.\n---\n\nText\n");
  catalogue.reset();
  assert.deepEqual((await catalogue.list(member)).items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP).map((item) => item.name), ["geo-demo"]);
});

test("the deployment's own index lists the method pack where the image's lists none — the CI web image carries an index of no skills", async () => {
  const root = await tempRoot(), data = await tempRoot();
  // What the public CI build writes: the one file, with no skill in it.
  await fs.mkdir(path.join(root, "runtime/skills/geo-private"), { recursive: true });
  await fs.writeFile(path.join(root, "runtime/skills/geo-private/geo-pack-index.json"), JSON.stringify({ schemaVersion: 1, package: "geo-skills", version: null, skills: [] }));
  // What the release step places in the data volume.
  await fs.mkdir(path.join(data, ".openscience"), { recursive: true });
  await fs.writeFile(path.join(data, ".openscience/geo-pack-index.json"), JSON.stringify({
    schemaVersion: 1, package: "geo-skills", version: "3.0.1",
    skills: [{ name: "geo-care-nodes", title: "geo-care-nodes", use: "Maps the nodes of a care pathway." }, { name: "a/b", title: "x", use: "never" }],
  }));
  const member = { id: "member" };
  const names = async (catalogue) => (await catalogue.list(member)).items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP).map((item) => item.name);
  assert.deepEqual(await names(createPlatformSkillCatalogue({ rootDir: root, dataDir: data, packAllowed: () => true })), ["geo-care-nodes"]);
  assert.deepEqual(await names(createPlatformSkillCatalogue({ rootDir: root, packAllowed: () => true })), [], "without a data directory: no such group");
  assert.deepEqual(await names(createPlatformSkillCatalogue({ rootDir: root, dataDir: await tempRoot(), packAllowed: () => true })), [], "no file there: no such group");
  // An account outside the module is shown none of it, whichever file the names came from.
  assert.equal((await createPlatformSkillCatalogue({ rootDir: root, dataDir: data, packAllowed: () => false }).list(member)).items.filter((item) => item.group === SKILL_DISPLAY_GEO_GROUP).length, 0);
});

test("the long task's entry skill is a row of its own group where LoopX is on — the CLI's other skills are not rows — and is told in the item's words", async () => {
  const off = createPlatformSkillCatalogue({ rootDir: repoRoot });
  assert.equal((await off.list(reader)).items.filter((item) => item.group === SKILL_DISPLAY_LOOPX_GROUP).length, 0, "LoopX off: no row");
  const on = createPlatformSkillCatalogue({ rootDir: repoRoot, loopxEnabled: true });
  const listed = await on.list(reader);
  assert.equal(listed.loopxGroup, SKILL_DISPLAY_LOOPX_GROUP);
  const rows = listed.items.filter((item) => item.group === SKILL_DISPLAY_LOOPX_GROUP);
  assert.deepEqual(rows.map((item) => [item.id, item.name, item.title, item.canCopy, item.source]), [["loopx:loopx", "loopx", "长任务", false, "platform"]]);
  assert.equal(rows[0].use, RUNTIME_INVENTORY_WORDS.items.loopx.use, "the words are the inventory item's, not a second copy");
  assert.equal(rows[0].when, undefined, "a list row carries no `when`");
  const detail = await on.read("loopx:loopx", reader);
  assert.equal(detail.when, RUNTIME_INVENTORY_WORDS.items.loopx.how);
  assert.equal(detail.instructions, null);
  await assert.rejects(on.read("loopx:loopx-pr-review", reader), { status: 404, code: "skill_platform_not_found" });
  await assert.rejects(on.snapshot("loopx:loopx", reader), { status: 409, code: "skill_platform_not_copyable" });
  // Groups are told in the order the page lists them: the long task's comes before the method pack's.
  assert.ok(listed.groups.indexOf(SKILL_DISPLAY_LOOPX_GROUP) < listed.groups.indexOf(SKILL_DISPLAY_GEO_GROUP));
});

test("a skill is listed by what it is for: the community presentation skill is under 办公文档, still marked as the community's", async () => {
  const { items } = await createPlatformSkillCatalogue({ rootDir: repoRoot }).list(reader);
  const ppt = items.find((item) => item.name === "dsh-ppt");
  assert.deepEqual([ppt?.group, ppt?.source], ["办公文档", "community"]);
  assert.equal(items.find((item) => item.name === "deep-structural-analysis")?.group, "写作与核查");
  assert.ok(items.every((item) => item.group !== "社区"));
});

test("a copy reads the whole folder and refuses links, odd names and anything past a limit", async () => {
  const root = await tempRoot();
  await skill(root, "good", "---\nname: good\n---\n\nText\n", { "scripts/run.py": "print(1)\n", "资料/证据.csv": "a,b\n" });
  const entries = await readSkillFolder(path.join(root, "good"));
  assert.deepEqual(entries.map((entry) => entry.path).sort(), ["SKILL.md", "scripts/run.py", "资料/证据.csv"]);
  assert.ok(entries.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.digest) && Buffer.from(entry.bytesBase64, "base64").length === entry.size));
  await skill(root, "linked", "---\nname: linked\n---\n\nText\n");
  await fs.symlink("/etc/hostname", path.join(root, "linked", "leak.txt"));
  await assert.rejects(readSkillFolder(path.join(root, "linked")), { code: "skill_platform_unreadable" });
  await skill(root, "twin", "---\nname: twin\n---\n\nText\n", { "docs/skill.md": "second" });
  await assert.rejects(readSkillFolder(path.join(root, "twin")), { code: "skill_platform_unreadable" });
  await fs.mkdir(path.join(root, "empty"));
  await assert.rejects(readSkillFolder(path.join(root, "empty")), { code: "skill_platform_unreadable" });
});

test("splitSkillText takes folded descriptions and survives a file with no front matter", () => {
  assert.deepEqual(splitSkillText("no front matter"), { meta: {}, body: "no front matter" });
  assert.equal(splitSkillText("---\nname: a\ndescription: >\n  one\n  two\n---\nbody").meta.description.trim(), "one two");
  assert.deepEqual(splitSkillText("---\n: : :\n---\nbody").meta, {});
});

function copyFixture(rootDir) {
  const rows = new Map(), calls = [];
  const documents = {
    async put(user, kind, id, payload, { expectedRevision }) {
      const key = JSON.stringify([user, kind, id]), old = rows.get(key);
      if ((old?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
      const row = { id, kind, payload: structuredClone(payload), revision: expectedRevision + 1, deletedAt: null };
      rows.set(key, row); return structuredClone(row);
    },
    async get(user, kind, id) { const row = rows.get(JSON.stringify([user, kind, id])); return row ? structuredClone(row) : null; },
  };
  const artifacts = {
    upload: async (_user, kind, bytes) => { calls.push(["upload", kind, bytes.length > 0]); return { resourceId: "upload:one" }; },
    import: async (_user, input) => { calls.push(["import", input.resourceId]); return { description: "Imported description", instructions: "Imported instructions", resources: [], invocation: { userInvocable: true, modelInvocable: true }, metadata: {}, whenToUse: null }; },
    prepare: async (_user, input) => ({ nativeName: input.nativeName, digest: input.digest }),
    removeUpload: async (_user, resourceId) => { calls.push(["removeUpload", resourceId]); },
  };
  const service = new SkillLibraryService(null, { documents, artifacts, platformCatalogue: createPlatformSkillCatalogue({ rootDir }) });
  return { service, calls, rows };
}

test("copying a platform skill makes the account's own skill with its origin remembered, once per request", async () => {
  const root = await tempRoot();
  await skill(root, "runtime/skills/curated-scientific/survival-analysis", "---\nname: survival-analysis\ndescription: x\n---\n\nBody text.\n", { "scripts/run.py": "print(1)\n" });
  const { service, calls } = copyFixture(root);
  const user = { id: "copier" };
  const copied = await service.duplicatePlatform(user, "curated:survival-analysis", { title: "我的生存分析", idempotencyKey: "copy-1" });
  assert.equal(copied.payload.title, "我的生存分析");
  assert.equal(copied.payload.package.source.kind, "builtin-copy");
  assert.equal(copied.payload.package.source.package, "survival-analysis");
  assert.deepEqual(calls.map((call) => call[0]), ["upload", "import", "removeUpload"], "the raw upload does not outlive the copy");
  const retried = await service.duplicatePlatform(user, "curated:survival-analysis", { title: "我的生存分析", idempotencyKey: "copy-1" });
  assert.equal(retried.id, copied.id, "the same request is the same copy");
  await assert.rejects(service.duplicatePlatform(user, "curated:survival-analysis", { title: "另一个名字", idempotencyKey: "copy-1" }), { status: 409 });
  await assert.rejects(service.duplicatePlatform(user, "community:dsh-ppt", { title: "x", idempotencyKey: "copy-2" }), { code: "skill_platform_not_copyable" });
  await assert.rejects(service.duplicatePlatform(user, "curated:survival-analysis", { title: " ", idempotencyKey: "copy-3" }), { status: 400 });
});

test("the routes answer an account only, with the id as one segment", async (t) => {
  const user = { id: "reader" }, calls = [];
  const service = {
    listPlatform: async (actor) => { calls.push(["list", actor.id]); return { groups: [], items: [] }; },
    readPlatform: async (actor, id) => { calls.push(["read", id]); if (id === "gone:none") throw new HttpError(404, "skill_platform_not_found", "no"); return { id }; },
    duplicatePlatform: async (actor, id, body) => { calls.push(["copy", id, body.title]); return { id: "skill:new" }; },
  };
  const store = {
    ensureSessionUser: async (req) => { if (req.headers.authorization !== "ok") throw new HttpError(401, "unauthorized", "No session"); return { user }; },
    assertCsrf: async (req) => { if (req.method !== "GET" && req.headers["x-csrf-token"] !== "csrf") throw new HttpError(403, "csrf_invalid", "No CSRF"); },
  };
  const handler = createSkillLibraryRoutes({ store, service, maxJsonBytes: 65536 });
  const server = createServer((req, res) => { void handler(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }).catch((error) => sendError(res, error)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { authorization: "ok", "x-csrf-token": "csrf" };
  assert.equal((await fetch(`${base}/api/skills/platform`)).status, 401);
  assert.equal((await fetch(`${base}/api/skills/platform`, { headers })).status, 200);
  const read = await fetch(`${base}/api/skills/platform/${"core:stats-integrity"}`, { headers });
  assert.deepEqual((await read.json()).data, { id: "core:stats-integrity" });
  assert.equal((await fetch(`${base}/api/skills/platform/${"gone:none"}`, { headers })).status, 404);
  const copy = await fetch(`${base}/api/skills/platform/${"core:stats-integrity"}/copy`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "副本", idempotencyKey: "k" }) });
  assert.equal(copy.status, 201);
  assert.deepEqual(calls, [["list", "reader"], ["read", "core:stats-integrity"], ["read", "gone:none"], ["copy", "core:stats-integrity", "副本"]]);
});
