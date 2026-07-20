import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemosClient } from "../src/memosClient.mjs";
import { createWebApiApp } from "../src/server.mjs";

function fakeMemosService() {
  const memos = new Map();
  const requests = [];
  let nextId = 1;
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
      return Response.json({ memos: [...memos.values()] });
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

  return { fetchImpl, requests };
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
