import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemosClient } from "../src/memosClient.mjs";
import { createWebApiApp } from "../src/server.mjs";

function fakeMemosService() {
  const memos = new Map();
  const records = new Map();
  const requests = [];
  let nextId = 1;
  let nextRecordId = 1;
  const tagsFor = (content) => [...String(content).matchAll(/(?:^|\s)#([a-zA-Z0-9_\u3400-\u9fff-]+)/g)].map((match) => match[1]);
  const now = () => new Date().toISOString();

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = String(init.method ?? "GET").toUpperCase();
    const authorization = init.headers?.Authorization ?? init.headers?.authorization;
    requests.push({ url: url.toString(), method, authorization });
    assert.equal(authorization, "Bearer memos_pat_test");

    if (url.pathname === "/api/v1/auth/me" && method === "GET") {
      return Response.json({ user: { name: "users/evimed", username: "evimed" } });
    }
    if (url.pathname === "/api/v1/memos" && method === "GET") {
      const state = url.searchParams.get("state");
      return Response.json({ memos: [...memos.values()].filter((memo) => !state || memo.state === state) });
    }
    if (url.pathname === "/api/v1/memos" && method === "POST") {
      const body = JSON.parse(String(init.body));
      const id = `memo_${nextId++}`;
      const memo = {
        ...body,
        name: `memos/${id}`,
        tags: tagsFor(body.content),
        pinned: false,
        createTime: now(),
        updateTime: now(),
      };
      memos.set(id, memo);
      return Response.json(memo);
    }
    if (url.pathname === "/api/v1/memoryRecords" && method === "GET") {
      const namespace = url.searchParams.get("namespace");
      const statuses = new Set(url.searchParams.getAll("statuses"));
      const kinds = new Set(url.searchParams.getAll("kinds"));
      const scopes = new Set(url.searchParams.getAll("scopes"));
      const scopeId = url.searchParams.get("scopeId");
      const query = String(url.searchParams.get("query") ?? "").toLowerCase();
      const memoryRecords = [...records.values()].filter((record) =>
        record.namespace === namespace
        && (statuses.size === 0 || statuses.has(record.status))
        && (kinds.size === 0 || kinds.has(record.kind))
        && (scopes.size === 0 || scopes.has(record.scope))
        && (!scopeId || record.scopeId === scopeId)
        && (!query || `${record.key} ${record.summary} ${record.value}`.toLowerCase().includes(query))
      );
      return Response.json({ memoryRecords });
    }
    if (url.pathname === "/api/v1/memoryRecords:upsert" && method === "POST") {
      const body = JSON.parse(String(init.body));
      const input = body.memoryRecord;
      const existing = [...records.values()].find((record) =>
        record.namespace === input.namespace
        && record.scope === input.scope
        && record.scopeId === input.scopeId
        && record.kind === input.kind
        && record.key === input.key
      );
      if (existing && body.expectedVersion > 0 && body.expectedVersion !== existing.version) {
        return Response.json({ message: "version conflict" }, { status: 409 });
      }
      const evidence = body.evidence
        ? [...(existing?.evidence ?? []), { ...body.evidence, fingerprint: `proof_${existing?.evidence?.length ?? 0}` }]
        : [...(existing?.evidence ?? [])];
      const id = existing?.name?.slice("memoryRecords/".length) ?? `record_${nextRecordId++}`;
      const changed = existing && (existing.value !== input.value || existing.summary !== input.summary || existing.status !== input.status);
      const record = {
        ...existing,
        ...input,
        name: `memoryRecords/${id}`,
        evidence,
        evidenceCount: evidence.length,
        revisions: changed ? [...(existing.revisions ?? []), {
          version: existing.version,
          value: existing.value,
          summary: existing.summary,
          status: existing.status,
          changedTime: now(),
          reason: body.reason ?? "",
        }] : (existing?.revisions ?? []),
        version: existing ? existing.version + 1 : 1,
        createTime: existing?.createTime ?? now(),
        updateTime: now(),
      };
      records.set(id, record);
      return Response.json(record);
    }
    if (url.pathname === "/api/v1/memoryRecords:purge" && method === "POST") {
      const body = JSON.parse(String(init.body));
      let deletedCount = 0;
      for (const [id, record] of records) {
        if (record.namespace === body.namespace) {
          records.delete(id);
          deletedCount += 1;
        }
      }
      return Response.json({ deletedCount });
    }
    const memoryMatch = url.pathname.match(/^\/api\/v1\/memoryRecords\/([^/]+)$/);
    if (memoryMatch) {
      const id = decodeURIComponent(memoryMatch[1]);
      const record = records.get(id);
      if (!record) return Response.json({ message: "not found" }, { status: 404 });
      if (method === "GET") return Response.json(record);
      if (method === "DELETE") {
        records.delete(id);
        return new Response(null, { status: 200 });
      }
    }
    const match = url.pathname.match(/^\/api\/v1\/memos\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const memo = memos.get(id);
      if (!memo) return Response.json({ message: "not found" }, { status: 404 });
      if (method === "GET") return Response.json(memo);
      if (method === "PATCH") {
        const body = JSON.parse(String(init.body));
        const updated = {
          ...memo,
          ...body,
          tags: body.content == null ? memo.tags : tagsFor(body.content),
          updateTime: now(),
        };
        memos.set(id, updated);
        return Response.json(updated);
      }
      if (method === "DELETE") {
        memos.delete(id);
        return new Response(null, { status: 200 });
      }
    }
    return Response.json({ message: "unexpected fake route" }, { status: 500 });
  }

  return { fetchImpl, requests, records };
}

function clientConfig() {
  return {
    memosUrl: "http://memos.internal",
    memosAccessToken: "memos_pat_test",
    memosRequestTimeoutMs: 1_000,
    memosContextLimit: 8,
    memosContextMaxChars: 20_000,
  };
}

test("Memos adapter keeps internal tenancy tags private and enforces ownership", async () => {
  const fake = fakeMemosService();
  const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
  assert.deepEqual(await client.status(), {
    configured: true,
    connected: true,
    code: null,
    account: "evimed",
    structured: true,
  });

  const alpha = await client.create("alpha", "#利妥昔单抗\n重点核对老年人感染风险。 #药物安全");
  const beta = await client.create("beta", "另一个用户的私有记录");
  assert.doesNotMatch(alpha.content, /evimed-user-/);
  assert.deepEqual(alpha.tags, ["利妥昔单抗", "药物安全"]);
  assert.equal((await client.list("alpha")).length, 1);
  assert.equal((await client.list("beta"))[0].id, beta.id);
  await assert.rejects(
    () => client.update("alpha", beta.id, { pinned: true }),
    (error) => error?.status === 404 && error?.code === "memory_not_found",
  );
  const relevant = await client.relevant("alpha", "利妥昔单抗抗衰老是否安全");
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0].id, alpha.id);
  assert.ok(fake.requests.every((request) => request.authorization === "Bearer memos_pat_test"));
});

test("Memos adapter exports and purges every memory surface without crossing user namespaces", async () => {
  const fake = fakeMemosService();
  const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
  const alphaMemo = await client.create("alpha", "alpha manual memory");
  await client.update("alpha", alphaMemo.id, { state: "archived" });
  await client.create("beta", "beta manual memory");
  await client.upsertRecord("alpha", {
    scope: "user",
    kind: "profile",
    key: "profile.role",
    value: "Clinical researcher",
    summary: "Works on clinical research.",
    origin: "explicit",
    status: "active",
    confidence: 1,
    importance: 0.8,
    sensitive: false,
  });
  await client.upsertRecord("beta", {
    scope: "user",
    kind: "profile",
    key: "profile.role",
    value: "Another user",
    summary: "Another user profile.",
    origin: "explicit",
    status: "active",
    confidence: 1,
    importance: 0.8,
    sensitive: false,
  });

  const exported = await client.exportUserMemory("alpha");
  assert.equal(exported.records.length, 1);
  assert.equal(exported.manualMemos.length, 1);
  assert.equal(exported.manualMemos[0].state, "archived");

  assert.deepEqual(await client.purgeUserMemory("alpha"), { structured: 1, manual: 1 });
  assert.equal((await client.exportUserMemory("alpha")).records.length, 0);
  assert.equal((await client.exportUserMemory("beta")).records.length, 1);
  assert.equal((await client.list("beta")).length, 1);
});

test("EviMed memory API supports the complete native dashboard lifecycle", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-memory-api-"));
  const fake = fakeMemosService();
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: true,
    ...clientConfig(),
    memosFetch: fake.fetchImpl,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    let response = await fetch(`${base}/api/memory/status`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.connected, true);

    response = await fetch(`${base}/api/memory/memos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "长期研究偏好：优先核对系统综述。 #循证" }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()).data;
    assert.equal(created.content, "长期研究偏好：优先核对系统综述。 #循证");
    assert.deepEqual(created.tags, ["循证"]);

    response = await fetch(`${base}/api/memory/memos`);
    assert.equal((await response.json()).data.length, 1);

    response = await fetch(`${base}/api/memory/memos/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.pinned, true);

    response = await fetch(`${base}/api/memory/memos/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "archived" }),
    });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/memory/memos?state=archived`);
    const archived = (await response.json()).data;
    assert.equal(archived.length, 1);
    assert.equal(archived[0].state, "archived");

    response = await fetch(`${base}/api/memory/memos/${created.id}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/memory/memos?state=archived`);
    assert.deepEqual((await response.json()).data, []);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("structured memory API exposes profile groups and user-confirmed pending inferences", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-structured-memory-api-"));
  const fake = fakeMemosService();
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: true,
    ...clientConfig(),
    memosFetch: fake.fetchImpl,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const me = (await (await fetch(`${base}/api/me`)).json()).data;
    const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
    const pending = await client.upsertRecord(me.user.id, {
      scope: "user",
      kind: "preference",
      key: "response.evidence_depth",
      value: "Prefer primary evidence and explicit uncertainty.",
      summary: "Primary evidence first; uncertainty must remain visible.",
      origin: "inferred",
      status: "pending",
      confidence: 0.7,
      importance: 0.9,
      sensitive: false,
    }, {
      sourceType: "conversation_message",
      sourceRef: "sessions/s1/messages/m1",
      quote: "优先给原始证据，并明确保留不确定性。",
      observedAt: new Date().toISOString(),
      weight: 1,
    });

    let response = await fetch(`${base}/api/memory/profile`);
    assert.equal(response.status, 200);
    let profile = (await response.json()).data;
    assert.equal(profile.pendingCount, 1);
    assert.equal(profile.groups.preference[0].id, pending.id);

    response = await fetch(`${base}/api/memory/records/${pending.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: pending.version, status: "active" }),
    });
    assert.equal(response.status, 200);
    const confirmed = (await response.json()).data;
    assert.equal(confirmed.status, "active");
    assert.equal(confirmed.origin, "explicit");
    assert.equal(confirmed.confidence, 1);

    response = await fetch(`${base}/api/memory/records?status=active&kind=preference`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 1);

    response = await fetch(`${base}/api/memory/records/${pending.id}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    profile = (await (await fetch(`${base}/api/memory/profile`)).json()).data;
    assert.equal(profile.records.length, 0);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("memory status reports missing configuration without pretending to be connected", async () => {
  const client = new MemosClient({ memosUrl: "", memosAccessToken: "" });
  assert.deepEqual(await client.status(), {
    configured: false,
    connected: false,
    code: "memory_url_missing",
  });
  await assert.rejects(
    () => client.create("alpha", "content"),
    (error) => error?.status === 503 && error?.code === "memory_url_missing",
  );
});
