// The knowledge base's four reads of 2026-10-12, through the real server composition and over HTTP: what rests on a document,
// the Obsidian vault, the files the conversations delivered, and the composition of the library. What the unit tests cannot
// say: that the composition hands each route the stores it reads (the change service built further down than the routes, the
// run ledger and the real capability registry), and that every one of them is the account's own and the project's own.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const sha = (text) => createHash("sha256").update(text).digest("hex");
const hex = (character, length = 64) => character.repeat(length);

test("through the server: dependents, the vault, the delivered files and the composition are the account's own and the project's own", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60_000,
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-kb-p0-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, sourceIngestionEnabled: false });
  const users = [];
  let listening = false;
  try {
    const login = async (name) => {
      const username = `${name}${randomUUID().slice(0, 8)}`;
      const user = await app.store.createUser(username, "test-only-source-password", "Knowledge base P0 fixture");
      users.push(user);
      const project = await app.store.defaultProject(await app.store.userById(user.id));
      return { user, project, username };
    };
    const owner = await login("kbowner");
    const stranger = await login("kbstranger");
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    const base = `http://127.0.0.1:${address.port}`;
    const session = async ({ username, project }) => {
      const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "test-only-source-password" }) });
      const auth = await response.json();
      return { "content-type": "application/json", cookie: response.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken, "x-open-science-project": project.id };
    };
    const ownerHeaders = await session(owner);
    const strangerHeaders = await session(stranger);
    const documents = app.sourceService.documents;
    const projectId = owner.project.id;

    // Three documents that say what they are, one note the researcher wrote, and one compiled page.
    let counter = 0;
    const add = async (name, patch, understanding = null) => {
      counter += 1;
      const bytes = `${name}:${counter}`;
      const { source } = await app.sourceService.register(owner.user.id, { projectId, connector: { type: "upload", id: "library" }, path: `knowledge-base/${name}`,
        sha256: sha(bytes), size: bytes.length, mimeType: "application/octet-stream", mtime: "2026-10-01T00:00:00.000Z" });
      const understandingId = `understanding:${source.id}:g1`;
      if (understanding) {
        await documents.put(owner.user.id, "knowledge", understandingId, { recordType: "source-understanding", sourceId: source.id, generation: source.payload.generation ?? 1,
          output: { schemaVersion: 1, sourceId: source.id, generation: source.payload.generation ?? 1, ...understanding }, units: [] }, { expectedRevision: 0, projectId });
      }
      return { source: await documents.put(owner.user.id, "source", source.id, { ...source.payload, status: "complete",
        ...(understanding ? { currentUnderstandingId: understandingId } : {}), ...patch }, { expectedRevision: source.revision, projectId }), bytes };
    };
    const trial = await add("trial.pdf", { docType: "paper-rct", metadata: { title: "Rivaroxaban versus warfarin", authors: ["Patel MR"], publicationDate: "2011-09-08", doi: "10.1056/NEJMoa1009638", keywords: ["atrial fibrillation"] } },
      { summary: "利伐沙班不劣于华法林。", claims: [{ id: "c1", statement: "主要终点不劣于华法林。", evidence: [{ quote: "non-inferior to warfarin" }] }] });
    await add("guideline.pdf", { docType: "review-guideline", metadata: { title: "房颤抗凝指南", publicationDate: "2023", keywords: ["Atrial Fibrillation"] } }, { summary: "指南。", claims: [] });
    await add("review.pdf", { docType: "review-guideline", metadata: { title: "综述", publicationDate: "2021", keywords: ["atrial fibrillation"] } }, { summary: "综述。", claims: [] });
    await mkdir(path.join(owner.project.baseDir, "knowledge-base/notes"), { recursive: true });
    await writeFile(path.join(owner.project.baseDir, "knowledge-base/notes/meeting-1a2b.md"), "# 组会记录\n\n确定 C1–C3 分开合并。\n");
    await add("notes/meeting-1a2b.md", { docType: "note-memo", title: "组会记录" });
    await mkdir(path.join(owner.project.baseDir, "knowledge-base/wiki"), { recursive: true });
    await writeFile(path.join(owner.project.baseDir, "knowledge-base/wiki/doac.md"), "---\ntitle: \"直接口服抗凝药\"\n---\n# 直接口服抗凝药\n");
    await add("wiki/doac.md", { docType: "document" });

    // What rests on the first: a memory that names it, a result that read its bytes (and one of a stranger's that did not).
    const memory = await app.researchMemory.upsertRecord(owner.user.id, { scope: "project", scopeId: projectId, kind: "project_fact", key: "project.population",
      value: "纳入 18 岁以上非瓣膜性房颤患者", summary: "纳入 18 岁以上非瓣膜性房颤患者", origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false },
    null, { sourceLinks: [{ type: "knowledge_source", id: trial.source.id }] });
    const versionId = `rv_${hex("3")}`;
    await documents.put(owner.user.id, "result-version", versionId, { recordType: "result-version", versionId, artifactId: `ra_${hex("2")}`, projectId, digest: hex("5"), size: 10,
      path: "deliverables/clinical-evidence-synthesis/clinical-evidence-report.md", mimeType: "text/markdown", capturedAt: "2026-10-10T08:00:00Z", producer: { kind: "tool", runId: "run_report" },
      inputs: [{ kind: "data", id: "knowledge-base/trial.pdf", digest: sha(trial.bytes), availability: "captured" }], machineValues: [], findings: [], bindingSources: [], coverage: { gaps: [] } },
    { expectedRevision: 0, projectId });
    // The ledger: one finished conversation that delivered a package, one that a machine started.
    const aRun = (id, extra = {}) => ({ id, status: "succeeded", effectiveAgentId: "clinical-evidence-synthesis", title: "房颤抗凝综述", finishedAt: "2026-10-10T08:00:00Z",
      deliverables: [{ id: "clinical-evidence-synthesis", capability: "clinical-evidence-synthesis" }],
      artifacts: ["deliverables/clinical-evidence-synthesis/clinical-evidence-report.md", "deliverables/clinical-evidence-synthesis/clinical-evidence-matrix.json"],
      unverifiedArtifacts: ["deliverables/clinical-evidence-synthesis/revision-notes.md"], ...extra });
    const originalList = app.agentRuns.list.bind(app.agentRuns);
    app.agentRuns.list = async (project) => (project.userId === owner.user.id ? [aRun("run_report"), aRun("run_machine", { automated: true })] : originalList(project));

    // 1. Dependents.
    const found = await (await fetch(`${base}/api/sources/${trial.source.id}/dependents`, { headers: ownerHeaders })).json();
    assert.deepEqual(found.data.memories.map((item) => [item.recordId, item.text, item.scope]), [[memory.id, "纳入 18 岁以上非瓣膜性房颤患者", "project"]]);
    assert.deepEqual(found.data.results.map((item) => [item.versionId, item.runId, item.title]), [[versionId, "run_report", "房颤抗凝综述"]]);
    assert.deepEqual(found.data.methods, []);
    const none = await (await fetch(`${base}/api/sources/${(await app.sourceService.list(owner.user.id, { projectId, limit: 100 })).items.find((item) => item.payload.paths[0] === "knowledge-base/guideline.pdf").id}/dependents`, { headers: ownerHeaders })).json();
    assert.deepEqual(none.data, { memories: [], methods: [], results: [], pages: [] });
    assert.equal((await fetch(`${base}/api/sources/${trial.source.id}/dependents`, { headers: strangerHeaders })).status, 404, "another account's document is not found, however it is asked for");
    assert.equal((await fetch(`${base}/api/sources/${trial.source.id}/dependents`)).status, 401);

    // 2. The vault: a note per document, the researcher's own text, the page as it is, links that land.
    const vault = await fetch(`${base}/api/sources/export/vault?projectId=${encodeURIComponent(projectId)}`, { headers: ownerHeaders });
    assert.equal(vault.status, 200);
    assert.equal(vault.headers.get("content-type"), "application/zip");
    const files = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await vault.arrayBuffer()))).map(([name, bytes]) => [name, strFromU8(bytes)]));
    const root = `${owner.project.name}/`;
    assert.deepEqual(Object.keys(files).map((name) => name.slice(root.length)).sort(), ["index.md", "sources/Rivaroxaban versus warfarin.md", "sources/房颤抗凝指南.md",
      "sources/综述.md", "sources/组会记录.md", "wiki/doac.md"].sort());
    const note = files[`${root}sources/Rivaroxaban versus warfarin.md`];
    assert.match(note, /^---\ntitle: "Rivaroxaban versus warfarin"\nauthors: \["Patel MR"\]\nyear: 2011\ndoi: "10\.1056\/NEJMoa1009638"\n/);
    assert.match(note, /1\. 主要终点不劣于华法林。\n   > non-inferior to warfarin\n/);
    assert.match(files[`${root}sources/组会记录.md`], /# 组会记录\n\n确定 C1–C3 分开合并。\n/);
    assert.equal(files[`${root}wiki/doac.md`], "---\ntitle: \"直接口服抗凝药\"\n---\n# 直接口服抗凝药\n");
    for (const [name, text] of Object.entries(files)) for (const [, target] of text.matchAll(/\[\[([^\]|]+)\|/g)) assert.ok(`${root}${target}.md` in files, `${name} → ${target}`);
    // A project's id is the account's own (every account has a "default"): the stranger asking for it is asking for theirs.
    assert.equal(stranger.project.id, projectId);
    const theirs = await fetch(`${base}/api/sources/export/vault?projectId=${encodeURIComponent(projectId)}`, { headers: strangerHeaders });
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await theirs.arrayBuffer()))), [`${stranger.project.name}/index.md`], "an empty library, none of the owner's");
    assert.equal((await fetch(`${base}/api/sources/export/vault?projectId=nobody-has-this`, { headers: strangerHeaders })).status, 404);

    // 3. The delivered files: the researcher's finished conversation, one line, not the machine's.
    const outputs = await (await fetch(`${base}/api/sources/outputs?projectId=${encodeURIComponent(projectId)}`, { headers: ownerHeaders })).json();
    assert.deepEqual(outputs.data.items, [{ runId: "run_report", title: "房颤抗凝综述", path: "deliverables/clinical-evidence-synthesis/clinical-evidence-report.md", at: "2026-10-10T08:00:00.000Z" }]);
    assert.deepEqual((await (await fetch(`${base}/api/sources/outputs?projectId=${encodeURIComponent(projectId)}`, { headers: strangerHeaders })).json()).data.items, []);
    assert.equal((await fetch(`${base}/api/sources/outputs?projectId=nobody-has-this`, { headers: ownerHeaders })).status, 404);

    // 4. The composition: the three documents that say a year and a keyword, in any case; not the note, not the page.
    const composition = await (await fetch(`${base}/api/sources/composition?projectId=${encodeURIComponent(projectId)}`, { headers: ownerHeaders })).json();
    assert.deepEqual(composition.data, { total: 4, dated: 3, keyworded: 3,
      years: [{ year: 2023, count: 1 }, { year: 2021, count: 1 }, { year: 2011, count: 1 }], keywords: [{ keyword: "atrial fibrillation", count: 3 }] });
    assert.equal((await (await fetch(`${base}/api/sources/composition?projectId=${encodeURIComponent(projectId)}`, { headers: strangerHeaders })).json()).data.total, 0);
    assert.equal((await fetch(`${base}/api/sources/composition?projectId=nobody-has-this`, { headers: ownerHeaders })).status, 404);
  } finally {
    for (const user of users) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    if (listening) await app.close();
    else await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
