import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrl, signedIn, ingestCorpus } from "./helpers/knowledgeBaseApp.mjs";

const durable = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 30_000 };

test("personal intake and snapshots preserve ownership, independent retention, revisions and explicit unshare", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const headers = { ...ctx.headers }; delete headers["x-open-science-project"];
  const api = async (route, method = "GET", body) => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  const first = await api("/api/library/uploads", "POST", { filename: "first.txt", data: "original A" });
  assert.equal(first.status, 201); assert.equal(first.data.source.projectId, "evimed-library"); assert.equal(first.data.duplicate, false);
  assert.equal(first.data.job, undefined);
  for (const extra of [{ projectId: ctx.project.id }, { userId: "forged" }, { path: "../bad" }]) {
    assert.equal((await api("/api/library/uploads", "POST", { filename: "valid.txt", data: "a", ...extra })).status, 400);
  }
  assert.equal((await api("/api/library/uploads", "POST", { filename: "../bad", data: "a" })).status, 400);
  const note = await api("/api/library/notes", "POST", { title: "Draft", body: "version A" });
  assert.equal(note.status, 201);
  const noteId = note.data.source.id;
  const getNote = await api(`/api/sources/${noteId}`);
  const copy = await api(`/api/library/${noteId}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: getNote.data.revision });
  assert.equal(copy.status, 201);
  const storedCopy = await ctx.app.sourceService.get(ctx.user.id, copy.data.source.id);
  assert.equal(storedCopy.payload.copiedFrom.sourceId, noteId);
  const repeated = await api(`/api/library/${noteId}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: getNote.data.revision });
  assert.equal(repeated.data.source.id, copy.data.source.id); assert.equal(repeated.data.duplicate, true);
  assert.equal((await api(`/api/library/${noteId}/projects`, "POST", { projectId: "evimed-library", expectedRevision: getNote.data.revision })).status, 400);
  assert.equal((await api(`/api/library/${noteId}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: 999 })).status, 409);
  await api("/api/library", "POST", { sourceId: copy.data.source.id });
  const edited = await api(`/api/sources/${noteId}/note`, "PUT", { title: "Draft", body: "version B" });
  assert.equal(edited.status, 200);
  let library = await api("/api/library");
  assert.equal(library.data.items.length, 3, "explicit project copy retains A alongside personal B");
  await api(`/api/library/${edited.data.source.id}`, "DELETE");
  const again = await api(`/api/sources/${edited.data.source.id}/note`, "PUT", { title: "Draft", body: "version C" });
  assert.equal(again.status, 200);
  library = await api("/api/library"); assert.equal(library.data.items.length, 2, "explicit unshare survives edit");
  const current = await api(`/api/sources/${first.data.source.id}`);
  assert.equal((await api(`/api/sources/${first.data.source.id}`, "DELETE", { expectedRevision: current.data.revision })).status, 200);
  library = await api("/api/library"); assert.equal(library.data.items.length, 1);
  assert.equal((await api("/api/sources?scope=all")).data.counts.all, 2);
});

test("a full personal library rolls source and job registration back and permits a clean retry", durable, async t => {
  const ctx = await signedIn({ libraryMaxItems: 1 }); t.after(ctx.close);
  const headers = { ...ctx.headers }; delete headers["x-open-science-project"];
  const upload = async filename => {
    const response = await fetch(`${ctx.base}/api/library/uploads`, { method: "POST", headers, body: JSON.stringify({ filename, data: filename }) });
    return { status: response.status, ...(await response.json()) };
  };
  const first = await upload("one.txt"); assert.equal(first.status, 201);
  const second = await upload("two.txt"); assert.equal(second.status, 409);
  const page = await ctx.app.sourceService.list(ctx.user.id, { all: true }); assert.equal(page.counts.all, 1);
  const jobs = await ctx.app.store.database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest'", [ctx.user.id]);
  assert.equal(jobs.rows[0].n, 1);
  const removed = await fetch(`${ctx.base}/api/library/${first.data.source.id}`, { method: "DELETE", headers }); assert.equal(removed.status, 200);
  assert.equal((await upload("two.txt")).status, 201);
});


test("all body search uses owned indexed sources without sharing them to other projects", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const [source] = await ingestCorpus(ctx, { names: ["房颤抗凝指南.pdf"] });
  const response = await fetch(`${ctx.base}/api/sources?scope=all&q=${encodeURIComponent("达比加群")}`, { headers: ctx.headers });
  const result = (await response.json()).data;
  assert.equal(response.status, 200); assert.deepEqual(result.items.map(item => item.id), [source.id]);
  assert.ok(result.passages[source.id][0].snippet.includes("达比加群"));
  const shared = await ctx.app.kbIndex.passages({ userId: ctx.user.id, projectId: null, shared: true, q: "达比加群" });
  assert.equal(shared, null);
  const other = await ctx.app.kbIndex.passages({ userId: ctx.user.id, projectId: "missing-project", shared: false, q: "达比加群" });
  assert.equal(other, null);
});

test("A-B-A creates a separately frozen copy and never changes its earlier snapshot provenance", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const api = async (route, method, body) => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers: ctx.headers, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return (await response.json()).data;
  };
  const original = await api("/api/library/notes", "POST", { title: "Stable", body: "A" });
  const first = await api(`/api/library/${original.source.id}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: original.source.revision });
  const b = await api(`/api/sources/${original.source.id}/note`, "PUT", { title: "Stable", body: "B" });
  const a = await api(`/api/sources/${b.source.id}/note`, "PUT", { title: "Stable", body: "A" });
  assert.equal(a.source.id, original.source.id);
  const stale = await fetch(`${ctx.base}/api/library/${a.source.id}/projects`, { method: "POST", headers: ctx.headers,
    body: JSON.stringify({ projectId: ctx.project.id, expectedRevision: original.source.revision }) });
  assert.equal(stale.status, 409, "a stale click must not copy revived A");
  const second = await api(`/api/library/${a.source.id}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: a.source.revision });
  assert.notEqual(second.source.id, first.source.id);
  const previous = await ctx.app.sourceService.get(ctx.user.id, first.source.id);
  assert.equal(previous.payload.copiedFrom.revision, original.source.revision);
  assert.equal(second.source.payload.copiedFrom.revision, a.source.revision);
});

test("a copy chosen on a row the platform's reading has moved on since is still current, and copying that version again finds one snapshot", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const api = async (route, method, body) => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers: ctx.headers, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return (await response.json()).data;
  };
  const note = await api("/api/library/notes", "POST", { title: "Reading", body: "stays the same" });
  const chosen = note.source.revision;
  // What background reading does to a fresh upload: records move the revision and leave the bytes and the version alone.
  const stored = await ctx.app.sourceService.get(ctx.user.id, note.source.id);
  const moved = await ctx.app.sourceService.documents.put(ctx.user.id, "source", stored.id, { ...stored.payload, updatedAt: new Date().toISOString() },
    { expectedRevision: stored.revision, projectId: stored.projectId });
  assert.ok(moved.revision > chosen, "the record moved on");
  const first = await api(`/api/library/${note.source.id}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: chosen });
  const again = await api(`/api/library/${note.source.id}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: moved.revision });
  assert.equal(again.source.id, first.source.id); assert.equal(again.duplicate, true);
  const stale = await fetch(`${ctx.base}/api/library/${note.source.id}/projects`, { method: "POST", headers: ctx.headers,
    body: JSON.stringify({ projectId: ctx.project.id, expectedRevision: moved.revision + 50 }) });
  assert.equal(stale.status, 409);
});

test("personal links use the public reader without a project and preserve an explicit unshare on refetch", durable, async t => {
  let version = "A"; let paidToolCalls = 0;
  const ctx = await signedIn({ deepseekToolsFetch: async () => { paidToolCalls += 1; throw new Error("Personal intake must not call paid web tools."); }, webReadHostIntervalMs: 0, webReadTransport: async ({ url }) => url.pathname === "/robots.txt"
    ? { status: 404, headers: {}, body: Buffer.alloc(0) }
    : { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(`<html><head><title>Public page</title></head><body><main><p>${version} ${"Public preserved content ".repeat(40)}</p></main></body></html>`) } });
  t.after(ctx.close);
  const headers = { ...ctx.headers }; delete headers["x-open-science-project"];
  const response = await fetch(`${ctx.base}/api/library/links`, { method: "POST", headers, body: JSON.stringify({ url: "https://www.nmpa.gov.cn/page" }) });
  assert.equal(response.status, 201); const first = (await response.json()).data;
  assert.equal(first.source.personal, true);
  await fetch(`${ctx.base}/api/library/${first.source.id}`, { method: "DELETE", headers }); version = "B";
  const refetch = await fetch(`${ctx.base}/api/sources/${first.source.id}/refetch`, { method: "POST", headers, body: "{}" });
  assert.equal(refetch.status, 200); const b = (await refetch.json()).data; assert.equal(b.changed, true);
  const inventory = await fetch(`${ctx.base}/api/library`, { headers }); assert.equal((await inventory.json()).data.items.length, 0);
  version = "C";
  const secondRefetch = await fetch(`${ctx.base}/api/sources/${b.source.id}/refetch`, { method: "POST", headers, body: "{}" });
  assert.equal(secondRefetch.status, 200); const c = (await secondRefetch.json()).data;
  const stillUnshared = await fetch(`${ctx.base}/api/library`, { headers }); assert.equal((await stillUnshared.json()).data.items.length, 0);
  const shared = await fetch(`${ctx.base}/api/library`, { method: "POST", headers, body: JSON.stringify({ sourceId: c.source.id }) }); assert.equal(shared.status, 201);
  version = "D";
  const finalRefetch = await fetch(`${ctx.base}/api/sources/${c.source.id}/refetch`, { method: "POST", headers, body: "{}" }); assert.equal(finalRefetch.status, 200);
  const renewed = await fetch(`${ctx.base}/api/library`, { headers }); assert.equal((await renewed.json()).data.items.length, 2);
  assert.equal(paidToolCalls, 0);
});


test("replacing one filename preserves personal retention while another current filename has the same bytes", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const upload = async (filename, data) => {
    const response = await fetch(`${ctx.base}/api/library/uploads`, { method: "POST", headers: ctx.headers, body: JSON.stringify({ filename, data }) });
    assert.equal(response.status, 201); return (await response.json()).data;
  };
  const first = await upload("first.txt", "A"); const second = await upload("second.txt", "A");
  assert.equal(first.source.id, second.source.id);
  await upload("first.txt", "B");
  const response = await fetch(`${ctx.base}/api/library`, { headers: ctx.headers });
  assert.equal((await response.json()).data.items.length, 2);
  const a = await ctx.app.sourceService.get(ctx.user.id, first.source.id); assert.equal(a.payload.publication.current, true);
  await upload("second.txt", "C");
  const updated = await fetch(`${ctx.base}/api/library`, { headers: ctx.headers });
  assert.equal((await updated.json()).data.items.length, 2, "only after its last current filename is replaced does A leave");
});

test("legacy membership without retention metadata remains explicitly retained on personal replacement", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const upload = async data => {
    const response = await fetch(`${ctx.base}/api/library/uploads`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ filename: "legacy.txt", data }) }); assert.equal(response.status, 201);
  };
  await upload("A");
  await ctx.app.store.database.query("UPDATE evimed_product.documents SET payload=payload-'explicitRetention'-'personalSourceIds' WHERE user_id=$1 AND kind='preferences' AND payload->>'recordType'='library-item'", [ctx.user.id]);
  await upload("B");
  const response = await fetch(`${ctx.base}/api/library`, { headers: ctx.headers });
  assert.equal((await response.json()).data.items.length, 2);
  const shared = await fetch(`${ctx.base}/api/sources?scope=shared`, { headers: ctx.headers });
  const retained = (await shared.json()).data.items;
  assert.equal(retained.length, 2);
  assert.ok(retained.some(source => source.payload.publication.current === false), "explicit retained historical A remains read-only");
});

test("an explicit unshare remains effective beyond the first hundred historical source rows", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const upload = async data => {
    const response = await fetch(`${ctx.base}/api/library/uploads`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ filename: "history.txt", data }) }); assert.equal(response.status, 201); return (await response.json()).data;
  };
  const first = await upload("A");
  await fetch(`${ctx.base}/api/library/${first.source.id}`, { method: "DELETE", headers: ctx.headers });
  // Fill the source-history pages without running parsers or fabricating shared memberships.
  await ctx.app.store.database.query(`INSERT INTO evimed_product.documents(user_id,project_id,kind,id,payload)
    SELECT user_id,project_id,kind,'src_'||md5('history-row-'||n),
      jsonb_set(jsonb_set(jsonb_set(payload,'{publication}','{"current":false,"bindings":{}}'::jsonb),'{familyId}',to_jsonb('fam_'||md5(n::text))),'{fingerprint,sha256}',to_jsonb(md5(n::text)||md5(n::text)))
    FROM evimed_product.documents CROSS JOIN generate_series(1,105) n WHERE user_id=$1 AND kind='source' AND id=$2`, [ctx.user.id, first.source.id]);
  await upload("B");
  const response = await fetch(`${ctx.base}/api/library`, { headers: ctx.headers });
  assert.equal((await response.json()).data.items.length, 0);
});


test("opposite project copies and concurrent edits settle without a lock cycle", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  await ctx.app.store.createProject(await ctx.app.store.userById(ctx.user.id), "second", "Second");
  const request = async (route, method, body) => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers: ctx.headers, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  const one = await request("/api/sources/notes", "POST", { projectId: ctx.project.id, title: "One", body: "original one" });
  const two = await request("/api/sources/notes", "POST", { projectId: "second", title: "Two", body: "original two" });
  const results = await Promise.all([
    request(`/api/library/${one.data.source.id}/projects`, "POST", { projectId: "second", expectedRevision: one.data.source.revision }),
    request(`/api/library/${two.data.source.id}/projects`, "POST", { projectId: ctx.project.id, expectedRevision: two.data.source.revision }),
    request(`/api/sources/${one.data.source.id}/note`, "PUT", { title: "One", body: "edited one" }),
    request(`/api/sources/${two.data.source.id}/note`, "PUT", { title: "Two", body: "edited two" }),
  ]);
  assert.ok(results.slice(0, 2).every(result => [201, 409].includes(result.status)), JSON.stringify(results));
  assert.ok(results.slice(2).every(result => result.status === 200), JSON.stringify(results));
  for (const result of results.slice(0, 2)) if (result.status === 201) assert.equal(result.data.source.payload.copiedFrom.revision, 1);
});


test("personal note intent follows the latest unshare and later reshare across consecutive edits", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const request = async (route, method, body) => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers: ctx.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, await response.clone().text()); return (await response.json()).data;
  };
  const a = await request("/api/library/notes", "POST", { title: "Intent", body: "A" });
  await request(`/api/library/${a.source.id}`, "DELETE");
  const b = await request(`/api/sources/${a.source.id}/note`, "PUT", { title: "Intent", body: "B" });
  const c = await request(`/api/sources/${b.source.id}/note`, "PUT", { title: "Intent", body: "C" });
  const before = await fetch(`${ctx.base}/api/library`, { headers: ctx.headers }); assert.equal((await before.json()).data.items.length, 0);
  await request("/api/library", "POST", { sourceId: c.source.id });
  const d = await request(`/api/sources/${c.source.id}/note`, "PUT", { title: "Intent", body: "D" });
  const after = await fetch(`${ctx.base}/api/library`, { headers: ctx.headers });
  const items = (await after.json()).data.items; assert.equal(items.length, 2, "explicit C remains retained and current D follows renewed sharing intent");
  assert.ok(items.some(item => item.sourceId === d.source.id));
});

test("source-bound originals read personal files without opening generic internal project access", durable, async t => {
  const ctx = await signedIn(); t.after(ctx.close);
  const headers = { ...ctx.headers }; delete headers["x-open-science-project"];
  const bytes = Buffer.from("%PDF-1.4\nPersonal original\n%%EOF\n");
  const uploaded = await fetch(`${ctx.base}/api/library/uploads`, { method: "POST", headers,
    body: JSON.stringify({ filename: "original.pdf", data: bytes.toString("base64"), encoding: "base64" }) });
  assert.equal(uploaded.status, 201); const source = (await uploaded.json()).data.source;
  const route = `${ctx.base}/api/sources/${source.id}/file`;
  const read = await fetch(`${route}?mode=read`, { headers }); assert.equal(read.status, 200);
  const original = (await read.json()).data;
  assert.equal(original.path, source.payload.paths[0]); assert.equal(original.mime, "application/pdf"); assert.equal(original.encoding, "base64");
  assert.equal(original.size, bytes.length); assert.deepEqual(Buffer.from(original.data, "base64"), bytes);
  const preview = await fetch(`${route}?mode=preview`, { headers }); assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff"); assert.equal(preview.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.ok(preview.headers.get("content-security-policy")); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
  const download = await fetch(`${route}?mode=download`, { headers }); assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment;/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  for (const query of ["root=workspace", "path=secrets.txt", "projectId=other", "mode=preview&root=base", "mode=unknown"]) {
    assert.equal((await fetch(`${route}?${query}`, { headers })).status, 400);
  }
  const internalHeaders = { ...headers, "x-open-science-project": "evimed-library" };
  const generic = await fetch(`${ctx.base}/api/commands/read_artifact`, { method: "POST", headers: internalHeaders,
    body: JSON.stringify({ root: "base", path: source.payload.paths[0] }) }); assert.equal(generic.status, 404);
  const start = await fetch(`${ctx.base}/api/commands/start_runtime`, { method: "POST", headers: internalHeaders, body: "{}" }); assert.equal(start.status, 404);
  for (const genericRoute of [`/api/files/preview/${encodeURIComponent(source.payload.paths[0])}?root=base`, "/api/runtime"]) {
    assert.equal((await fetch(`${ctx.base}${genericRoute}`, { headers: internalHeaders })).status, 404);
  }
  const office = await readFile(new URL("./fixtures/materials/supplement.xlsx", import.meta.url));
  const officeUpload = await fetch(`${ctx.base}/api/library/uploads`, { method: "POST", headers,
    body: JSON.stringify({ filename: "supplement.xlsx", data: office.toString("base64"), encoding: "base64" }) });
  assert.equal(officeUpload.status, 201); const officeSource = (await officeUpload.json()).data.source;
  for (const mode of ["read", "preview", "download"]) {
    const opened = await fetch(`${ctx.base}/api/sources/${officeSource.id}/file?mode=${mode}`, { headers }); assert.equal(opened.status, 200);
    if (mode === "read") {
      const file = (await opened.json()).data; assert.equal(file.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      assert.deepEqual(Buffer.from(file.data, "base64"), office);
    } else assert.deepEqual(Buffer.from(await opened.arrayBuffer()), office);
  }
  const other = await signedIn();
  try {
    // The other authenticated account reaches the same server with its own session cookie.
    const foreign = await fetch(`${ctx.base}/api/sources/${source.id}/file?mode=download`, { headers: other.headers });
    assert.equal(foreign.status, 404);
  } finally { await other.close(); }
});
