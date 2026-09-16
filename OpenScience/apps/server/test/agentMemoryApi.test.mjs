/**
 * The memory API an agent that is not ours calls, and the credential it holds.
 *
 * What these cases are about is not the verbs — recall, note and records
 * already existed and are tested where they live. It is the three properties
 * that are true only because the caller is external: the key is a hash the
 * store cannot give back, the scope is the key's and not the request's, and
 * nothing an outside agent sends becomes an active memory.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_KEY_SCOPES } from "../src/agentApiKeys.mjs";
import { createAgentMemoryRoutes, AGENT_MEMORY_PATH } from "../src/agentMemoryRoutes.mjs";
import { agentMemoryOpenApi } from "../src/agentMemoryOpenApi.mjs";
import { HttpError } from "../src/security.mjs";

const config = { agentMemoryApiEnabled: true, maxJsonBytes: 1_048_576 };

/** A response double that records what the handler wrote. */
function response() {
  const captured = { status: 0, body: null, headers: {} };
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers ?? {}; },
    end(payload) { captured.body = payload ? JSON.parse(String(payload)) : null; },
    setHeader() {},
  };
}

/** @param {string} path @param {any} [body] @param {string} [token] @param {string} [method] */
function request(path, body = undefined, token = "evk_good", method = body === undefined ? "GET" : "POST") {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    url: path,
    method,
    headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const apiKeys = {
    async resolve(token) {
      if (token !== "evk_good") throw new HttpError(401, "agent_key_invalid", "The API key is not valid.");
      return { userId: "u1", keyId: "agk_1", projectId: overrides.boundProject ?? null, scopes: overrides.scopes ?? [...AGENT_KEY_SCOPES] };
    },
  };
  const store = {
    async userById() { return { id: "u1", accountCreatedAt: "2026-01-01T00:00:00.000Z" }; },
    async requireProject(_user, id) { calls.push(["requireProject", id]); return { id, userId: "u1" }; },
  };
  const capsules = {
    async recall(userId, input) { calls.push(["recall", userId, input]); return { items: [] }; },
    async note(userId, projectId, input) { calls.push(["note", userId, projectId, input]); return { id: "entry_1", ...input }; },
  };
  const researchMemory = {
    async listRecords(userId, input) { calls.push(["listRecords", userId, input]); return []; },
  };
  const memoryIntelligence = {
    async recordRun(project, run, messages) {
      calls.push(["recordRun", project.id, run.sessionId, messages]);
      return { proposed: 2, extracted: 1, activated: 0, pending: 1, rejected: 1 };
    },
  };
  const routes = createAgentMemoryRoutes({ config: { ...config, ...overrides.config }, apiKeys, store, researchMemory, capsules, memoryIntelligence, memorySubstrate: overrides.memorySubstrate ?? null });
  return { routes, calls };
}

test("the API is off unless a deployment turns it on, and says so rather than 404", async () => {
  const { routes } = fixture({ config: { agentMemoryApiEnabled: false } });
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }), response()),
    (error) => error.status === 503 && error.code === "agent_memory_disabled",
  );
});

test("a note is always inferred and always pending, and there is no field that says otherwise", async () => {
  const { routes, calls } = fixture();
  const res = response();
  // `origin` is not in the allowed field list, so a caller asserting its user
  // said this outright is refused rather than believed.
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/note`, { factKind: "preference", content: "用中文", origin: "explicit" }), response()),
    (error) => error.code === "agent_memory_payload_invalid",
  );
  assert.equal(await routes(request(`${AGENT_MEMORY_PATH}/note`, { factKind: "preference", content: "用中文" }), res), true);
  const note = calls.find((entry) => entry[0] === "note");
  assert.equal(note[3].origin, "inferred");
  assert.equal(res.captured.body.data.reviewRequired, true);
});

test("a key bound to a project cannot reach another one, and cannot reach the account by omitting it", async () => {
  const { routes, calls } = fixture({ boundProject: "p1" });
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x", projectId: "p2" }), response()),
    (error) => error.status === 403 && error.code === "agent_key_project_denied",
  );
  // Omitting it falls back to the binding rather than to "any project".
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }), response());
  assert.equal(calls.find((entry) => entry[0] === "recall")[2].projectId, "p1");
});

test("a scope the key does not carry is refused before the store is touched", async () => {
  const { routes, calls } = fixture({ scopes: ["memory.read"] });
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/note`, { factKind: "preference", content: "x" }), response()),
    (error) => error.status === 403 && error.code === "agent_key_scope_denied",
  );
  assert.ok(!calls.some((entry) => entry[0] === "note"));
});

test("records default to active, because a pending record is a proposal nobody agreed to", async () => {
  const { routes, calls } = fixture();
  await routes(request(`${AGENT_MEMORY_PATH}/records`), response());
  assert.deepEqual(calls.find((entry) => entry[0] === "listRecords")[2].statuses, ["active"]);
  await routes(request(`${AGENT_MEMORY_PATH}/records?status=pending`), response());
  assert.deepEqual(calls.filter((entry) => entry[0] === "listRecords").at(-1)[2].statuses, ["pending"]);
});

test("an episode goes through the platform's own extractor, carrying which turns were the user's", async () => {
  const { routes, calls } = fixture();
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/episodes`, {
    projectId: "p9", sessionId: "s1",
    messages: [{ role: "user", text: "我只用中文。" }, { role: "assistant", text: "好的。" }],
  }), res);
  const recorded = calls.find((entry) => entry[0] === "recordRun");
  assert.equal(recorded[1], "p9");
  // The sender, not the role string alone: origin is decided from who said it,
  // and machine text arriving as the user's words is the failure that matters.
  assert.deepEqual(recorded[3].map((message) => message.sender), ["user", "assistant"]);
  assert.equal(res.captured.status, 202);
  assert.equal(res.captured.body.data.activated, 0);
});

test("an unknown key is refused with one code, and nothing distinguishes it from a revoked one", async () => {
  const { routes } = fixture();
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }, "evk_wrong"), response()),
    (error) => error.status === 401 && error.code === "agent_key_invalid",
  );
});

test("the description is built from the vocabularies the handlers validate against", async () => {
  const { routes } = fixture();
  const res = response();
  assert.equal(await routes(request(`${AGENT_MEMORY_PATH}/openapi.json`, undefined, ""), res), true);
  const document = res.captured.body;
  assert.equal(document.openapi, "3.1.0");
  // Reachable without a key: the schema is not a secret, and an integrator
  // reads it before they have one.
  assert.deepEqual(Object.keys(document.paths).sort(), ["/", "/episodes", "/note", "/recall", "/records"]);
  const { CAPSULE_FACT_KINDS } = await import("@evimed/domain");
  assert.deepEqual(document.components.schemas.FactKind.enum, [...CAPSULE_FACT_KINDS]);
  assert.match(document.components.securitySchemes.agentApiKey.description, new RegExp(AGENT_KEY_SCOPES[0]));
  // The one promise the whole surface rests on, written where an integrator
  // reads it rather than only where it is enforced.
  assert.match(document.info.description, /stays `pending`/);
  assert.equal(agentMemoryOpenApi({ basePath: "/x", rateLimitPerMinute: 7 }).servers[0].url, "/x");
});

test("recall answers from the records as well as the capsule, and each item says where it came from", async () => {
  // The same promise the runtime tool makes: an external agent's `recall`
  // reaches the account's structured memory, not only the capsule facts, and
  // can tell the two apart by `source` rather than by guessing from the shape.
  const memorySubstrate = {
    async recall() { return [{ id: "record:r1", content: "回答尽量简短", kind: "preference", scope: "user", memoryType: "structured" }]; },
  };
  const { routes, calls } = fixture({ memorySubstrate });
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "简短" }), res);
  assert.equal(res.captured.status, 200);
  assert.deepEqual(res.captured.body.data.items.map((item) => [item.source, item.id]), [["memory", "record:r1"]]);
  assert.deepEqual(res.captured.body.data.sources, { memory: 1, capsule: 0 });
  assert.equal(res.captured.body.data.contextOnly, true);
  assert.equal(calls.find((entry) => entry[0] === "recall")[2].scope, "capsule", "the capsule half is asked for the capsule only");
});
