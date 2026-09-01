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
      )
        // Order and truncate the way the Go store does — importance, then
        // confidence, then recency, capped at pageSize. Without this the fake
        // hands back every record and no test can observe a record being
        // crowded off the page, which is the failure that matters here.
        .sort((left, right) =>
          right.importance - left.importance
          || right.confidence - left.confidence
          || String(right.updateTime).localeCompare(String(left.updateTime)))
        .slice(0, Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize")) || 100)));
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

  return { fetchImpl, requests, memos, records };
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

test("run summaries are recalled only when they match the question", async () => {
  const fake = fakeMemosService();
  const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
  const projectId = "project-recall";
  const record = (key, question) => client.upsertRecord("alpha", {
    scope: "project",
    scopeId: projectId,
    kind: "run_summary",
    key,
    value: JSON.stringify({ runId: key, question, answer: `关于${question}的长篇回答` }),
    summary: `Conversation about: ${question}`,
    origin: "system",
    status: "active",
    // A finished run is stored with full confidence, and a failed one is stored
    // as more important than a successful one. Those two numbers alone put the
    // relevance score above zero, which is what used to make every summary
    // unconditionally recallable.
    confidence: 1,
    importance: 0.7,
    sensitive: false,
  });
  await record("run.metformin", "二甲双胍的作用机制是什么");
  await record("run.rituximab", "利妥昔单抗的感染风险");
  await client.upsertRecord("alpha", {
    scope: "user",
    scopeId: null,
    kind: "preference",
    key: "pref.language",
    value: "回答请用中文",
    summary: "回答请用中文",
    origin: "explicit",
    status: "active",
    confidence: 1,
    importance: 0.6,
    sensitive: false,
  });

  const greeting = await client.relevant("alpha", "hello", { projectId });
  assert.deepEqual(greeting.map((memo) => memo.kind), ["preference"]);

  const onTopic = await client.relevant("alpha", "二甲双胍还有哪些副作用", { projectId });
  assert.deepEqual(
    onTopic.map((memo) => memo.kind).sort(),
    ["preference", "run_summary"],
    "a question that names the drug should still reach the earlier run",
  );
});

test("the long-term profile survives a store full of run summaries", async () => {
  const fake = fakeMemosService();
  const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
  const projectId = "project-crowding";
  // One record per run, and a failed run outranks a preference on importance,
  // so a single ordered page eventually contains nothing but episodes.
  for (let index = 0; index < 120; index += 1) {
    await client.upsertRecord("alpha", {
      scope: "project", scopeId: projectId, kind: "run_summary", key: `run.${index}`,
      value: JSON.stringify({ runId: `run-${index}`, question: `问题 ${index}`, answer: `回答 ${index}` }),
      summary: `Conversation about: 问题 ${index}`, origin: "system", status: "active",
      confidence: 1, importance: 0.7, sensitive: false,
    });
  }
  await client.upsertRecord("alpha", {
    scope: "user", scopeId: null, kind: "profile", key: "profile.role",
    value: "临床药师，主要做药物评价", summary: "临床药师，主要做药物评价",
    origin: "explicit", status: "active", confidence: 1, importance: 0.6, sensitive: false,
  });

  const recalled = await client.relevant("alpha", "hello", { projectId });
  assert.ok(
    recalled.some((memo) => memo.kind === "profile"),
    "the profile must stay reachable however many runs have accumulated",
  );
});

test("a recalled run summary carries the exchange, not its internal record", async () => {
  const fake = fakeMemosService();
  const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
  const projectId = "project-projection";
  await client.upsertRecord("alpha", {
    scope: "project", scopeId: projectId, kind: "run_summary", key: "run.metformin",
    value: JSON.stringify({
      runId: "run_abc", sessionId: "ses_abc", model: "deepseek/deepseek-v4-pro",
      errorCode: "specialist_citation_invalid", durationMs: 23794,
      question: "二甲双胍的作用机制是什么", answer: "核心是抑制肝脏糖异生。",
    }),
    summary: "Conversation about: 二甲双胍的作用机制是什么",
    origin: "system", status: "active", confidence: 1, importance: 0.7, sensitive: false,
  });

  const [recalled] = await client.relevant("alpha", "二甲双胍还有哪些副作用", { projectId });
  assert.ok(recalled, "the matching run summary should be recalled");
  assert.match(recalled.content, /二甲双胍的作用机制是什么/);
  assert.match(recalled.content, /抑制肝脏糖异生/);
  for (const internal of ["run_abc", "ses_abc", "specialist_citation_invalid", "23794"]) {
    assert.ok(!recalled.content.includes(internal), `${internal} must not reach the prompt`);
  }
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

test("Memos adapter removes project-scoped records and legacy run memos without deleting personal memory", async () => {
  const fake = fakeMemosService();
  const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
  await client.create("alpha", "personal note with - Project: study-one");
  await client.create("alpha", "# EviMed agent run\n- Project: study-one\n#evimed-agent-run");
  await client.create("alpha", "# EviMed agent run\n- Project: study-two\n#evimed-agent-run");
  for (const [scope, scopeId, key] of [
    ["project", "study-one", "run.one"],
    ["project", "study-two", "run.two"],
    ["user", "", "profile.role"],
  ]) {
    await client.upsertRecord("alpha", {
      scope,
      scopeId,
      kind: scope === "user" ? "profile" : "run_summary",
      key,
      value: key,
      summary: key,
      origin: "system",
      status: "active",
      confidence: 1,
      importance: 0.5,
      sensitive: false,
    });
  }

  assert.deepEqual(await client.deleteProjectMemory("alpha", "study-one"), { structured: 1, manual: 1 });
  const exported = await client.exportUserMemory("alpha");
  assert.deepEqual(exported.records.map((record) => record.key).sort(), ["profile.role", "run.two"]);
  assert.equal(exported.manualMemos.length, 2);
  assert.ok(exported.manualMemos.some((memo) => memo.content === "personal note with - Project: study-one"));
  assert.ok(exported.manualMemos.some((memo) => memo.content.includes("- Project: study-two")));
});

test("deleting a SaaS project also deletes its project-scoped memory", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-project-memory-delete-"));
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
    const projectId = "project-memory-delete";
    let response = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, name: "Project memory deletion" }),
    });
    assert.equal(response.status, 200);
    const client = new MemosClient(clientConfig(), { fetchImpl: fake.fetchImpl });
    await client.upsertRecord(me.user.id, {
      scope: "project",
      scopeId: projectId,
      kind: "run_summary",
      key: "run.project-delete",
      value: "project run",
      summary: "project run",
      origin: "system",
      status: "active",
      confidence: 1,
      importance: 0.5,
      sensitive: false,
    });
    await client.create(me.user.id, `# EviMed agent run\n- Project: ${projectId}\n#evimed-agent-run`);

    response = await fetch(`${base}/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: projectId }),
    });
    assert.equal(response.status, 200);
    const exported = await client.exportUserMemory(me.user.id);
    assert.equal(exported.records.length, 0);
    assert.equal(exported.manualMemos.length, 0);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
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

// The memory service's own bounds, applied before the request rather than
// learned from a rejection.
//
// 2026-09-01 on the acceptance stack: every run's memory write came back
// `memory_upstream_error`, and because evidence rides along with the record in
// one upsert, a single over-long conversation quote lost the run summary and
// the extracted preference together. The service caps a quote at 4000
// characters (记忆模块 memory_service.go, validateMemoryEvidenceInput) and this
// client sent it unbounded — a contract that existed on one side of the
// boundary and was discovered on the other by a 400.
test("evidence is trimmed to what the memory service accepts, and never sent empty", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ name: "memoryRecords/abc", namespace: "n", scope: "MEMORY_SCOPE_USER" }),
    };
  };
  const client = new MemosClient(clientConfig(), { fetchImpl });
  const record = {
    scope: "user", kind: "preference", key: "k", value: "v", summary: "s",
    origin: "explicit", status: "active", confidence: 0.9, importance: 0.5,
  };

  // What matters here is the request, which is captured before the client
  // parses the reply; the stub reply is deliberately minimal, so the parse is
  // allowed to fail after the fact.
  const send = async (evidence) => {
    try {
      await client.upsertRecord("user-1", record, evidence);
    } catch { /* the assertion is on what went out */ }
  };

  await send({
    sourceType: "conversation_message",
    sourceRef: "sessions/s/messages/1",
    quote: "q".repeat(5_000),
  });
  assert.ok(
    Buffer.byteLength(sent.at(-1).evidence.quote, "utf8") <= 4_000,
    "a quote past the bound is trimmed, not left to be refused",
  );

  // Bytes, not characters. The service is Go and counts `len(s)`; this client is
  // JavaScript. On English fixtures the two agree, and on the Chinese
  // conversations this product actually holds they differ threefold — so the
  // first fix for this trimmed to 4000 characters, looked right, and changed
  // nothing.
  await send({
    sourceType: "conversation_message",
    sourceRef: "sessions/s/messages/3",
    quote: "证据引语。".repeat(2_000),
  });
  const chinese = sent.at(-1).evidence.quote;
  assert.ok(Buffer.byteLength(chinese, "utf8") <= 4_000, "a multi-byte quote must be bounded in bytes");
  assert.ok(chinese.length > 0 && chinese.length < 2_000, "and still carry a usable excerpt");
  assert.equal(chinese, [...chinese].join(""), "the cut must land on a character boundary");

  // A required field that is empty is not evidence, and attaching it fails the
  // whole record. Better an unevidenced record than no record at all.
  await send({
    sourceType: "conversation_message",
    sourceRef: "sessions/s/messages/2",
    quote: "   ",
  });
  assert.equal(sent.at(-1).evidence, undefined, "empty evidence is omitted rather than sent and refused");
  assert.ok(sent.at(-1).memoryRecord, "and the record itself is still written");
});
