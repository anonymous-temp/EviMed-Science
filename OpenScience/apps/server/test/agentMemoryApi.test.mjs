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
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";
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

/** @param {string} path @param {any} [body] @param {string} [token] @param {string} [method] @param {Record<string, string>} [extra] */
function request(path, body = undefined, token = "evk_good", method = body === undefined ? "GET" : "POST", extra = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    url: path,
    method,
    headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json", ...extra },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const apiKeys = {
    async resolve(token) {
      if (token !== "evk_good") throw new HttpError(401, "agent_key_invalid", "The API key is not valid.");
      return {
        userId: "u1", keyId: "agk_1", projectId: overrides.boundProject ?? null,
        scopes: overrides.scopes ?? [...AGENT_KEY_SCOPES], subjects: overrides.subjects ?? false,
      };
    },
    async subjectAccount(ownerId, subject) { calls.push(["subjectAccount", ownerId, subject]); return { userId: `subj_${subject}`, created: true }; },
    async findSubjectAccount(ownerId, subject) {
      calls.push(["findSubjectAccount", ownerId, subject]);
      return (overrides.knownSubjects ?? []).includes(subject) ? `subj_${subject}` : null;
    },
  };
  const store = {
    async userById(id) { return { id, accountCreatedAt: "2026-01-01T00:00:00.000Z" }; },
    async requireProject(user, id) { calls.push(["requireProject", id, user.id]); return { id, userId: user.id }; },
  };
  const capsules = {
    async recall(userId, input) { calls.push(["recall", userId, input]); return { items: [] }; },
    // What recall's methods are chosen from: the capsules in force, and one
    // capsule's entries.
    async active() { return { record: null, items: [] }; },
    async entries() { return { items: [], nextCursor: null }; },
    async get(userId, id) {
      const found = (overrides.capsules ?? []).find((capsule) => capsule.userId === userId && capsule.id === id);
      if (!found) throw new HttpError(404, "capsule_not_found", "The capsule is unavailable.");
      return { id, payload: { title: found.title } };
    },
    async note(userId, projectId, input) { calls.push(["note", userId, projectId, input]); return { id: "entry_1", ...input }; },
  };
  const researchMemory = {
    async listRecords(userId, input) { calls.push(["listRecords", userId, input]); return []; },
  };
  const memoryIntelligence = {
    async recordRun(project, run, messages, options) {
      calls.push(["recordRun", project.id, run.sessionId, messages, options]);
      return { proposed: 2, extracted: 1, activated: 0, pending: 1, rejected: 1 };
    },
  };
  const routes = createAgentMemoryRoutes({
    config: { ...config, ...overrides.config }, apiKeys, store, researchMemory, capsules,
    memoryIntelligence: overrides.memoryIntelligence ?? memoryIntelligence, memorySubstrate: overrides.memorySubstrate ?? null,
  });
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
  assert.equal(note[3].review, true, "a third party's note waits for the owner; the platform's own take effect");
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
  // Held for the owner, by the one argument that says so: the extractor is the
  // platform's own, and without it what it writes takes effect.
  assert.deepEqual(recorded[4], { holdForOwner: true });
});

test("what an episode yields waits for the account owner, and a memory already in force is never changed by one", async () => {
  // The real extractor, a store double and a model double: the property is the
  // records written, not the arguments passed. Until 2026-09-27 this surface
  // promised `pending` while the extractor it called activated everything.
  const records = new Map();
  let nextId = 1;
  const store = {
    async listRecords() { return [...records.values()]; },
    async upsertRecord(_userId, input, evidence) {
      const key = [input.scope, input.scopeId ?? "", input.kind, input.key].join("|");
      const existing = records.get(key);
      const record = {
        ...existing, ...input, id: existing?.id ?? `record_${nextId++}`, version: (existing?.version ?? 0) + 1,
        evidence: [...(existing?.evidence ?? []), ...(evidence ? [evidence] : [])], revisions: existing?.revisions ?? [],
      };
      records.set(key, record);
      return record;
    },
  };
  await store.upsertRecord("u1", {
    scope: "user", scopeId: "", kind: "preference", key: "preference.output_language",
    value: "回答请用中文", summary: "中文回答", origin: "explicit", status: "active", confidence: 1, importance: 0.8, sensitive: false,
  });
  const fetchImpl = async (_url, init) => {
    const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
    const user = sources.find((source) => source.role === "user");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [
      { scope: "user", kind: "preference", key: "preference.herb_count", value: "药味控制在 12 味以内", summary: "药味不超过 12 味",
        origin: "explicit", importance: 0.7, sensitive: false, sourceRef: user.sourceRef, evidenceQuote: user.text },
      { scope: "user", kind: "preference", key: "preference.output_language", value: "回答请用英文", summary: "英文回答",
        origin: "explicit", importance: 0.7, sensitive: false, sourceRef: user.sourceRef, evidenceQuote: user.text },
    ] }) } }] });
  };
  const memoryIntelligence = new MemoryIntelligence({
    deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-pro", memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 1_000,
  }, store, { fetchImpl });
  const { routes } = fixture({ memoryIntelligence });
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/episodes`, {
    projectId: "p9", sessionId: "s1", messages: [{ role: "user", text: "我开方一般控制在 12 味以内，回答请用英文。" }],
  }), res);

  const byKey = (key) => [...records.values()].find((record) => record.key === key);
  assert.equal(byKey("preference.herb_count").status, "pending", "a proposal, not a memory in force");
  assert.equal(byKey("preference.herb_count").lastConfirmedAt, null, "and nobody has confirmed it");
  assert.equal(byKey("preference.output_language").value, "回答请用中文", "the owner's memory in force is not rewritten");
  assert.equal(byKey("preference.output_language").status, "active");
  const summaries = [...records.values()].filter((record) => record.kind === "run_summary");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, "pending", "the episode's own summary is held too: every record an episode writes is pending");
  const data = res.captured.body.data;
  assert.equal(data.activated, 0);
  assert.equal(data.pending, 1);
  const described = agentMemoryOpenApi({ basePath: AGENT_MEMORY_PATH, rateLimitPerMinute: 120 });
  assert.match(described.info.description, /stays `pending`/, "and the description says what the code does");
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

test("an integration key speaks for the doctor it names, and every read and write is that doctor's alone", async () => {
  const { routes, calls } = fixture({ subjects: true, knownSubjects: ["doc-7"] });
  const as = (subject) => ({ "x-subject": subject });
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "太子参" }, "evk_good", "POST", as("doc-7")), response());
  await routes(request(`${AGENT_MEMORY_PATH}/records`, undefined, "evk_good", "GET", as("doc-7")), response());
  await routes(request(`${AGENT_MEMORY_PATH}/note`, { factKind: "preference", content: "药味不超过 12 味" }, "evk_good", "POST", as("doc-7")), response());
  await routes(request(`${AGENT_MEMORY_PATH}/episodes`, { messages: [{ role: "user", text: "我一般开 12 味以内。" }] }, "evk_good", "POST", as("doc-7")), response());
  assert.equal(calls.find((entry) => entry[0] === "recall")[1], "subj_doc-7");
  assert.equal(calls.find((entry) => entry[0] === "listRecords")[1], "subj_doc-7");
  const note = calls.find((entry) => entry[0] === "note");
  assert.deepEqual([note[1], note[2]], ["subj_doc-7", "default"], "a subject's note lands in its one project");
  assert.equal(calls.find((entry) => entry[0] === "recordRun")[1], "default", "and so does an episode that names none");
  // Only writes make an account; the reads found the one that exists.
  assert.deepEqual(calls.filter((entry) => entry[0] === "subjectAccount").map((entry) => entry[1]), ["u1", "u1"]);
  assert.ok(!calls.some((entry) => ["recall", "listRecords", "note", "recordRun"].includes(entry[0]) && entry[1] === "u1"),
    "nothing reached the institution's own account");
});

test("without X-Subject an integration key is its institution, and a read for a doctor never seen creates nothing", async () => {
  const { routes, calls } = fixture({ subjects: true });
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }), response());
  assert.equal(calls.find((entry) => entry[0] === "recall")[1], "u1", "absent, the key's own account: the institution level");
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }, "evk_good", "POST", { "x-subject": "doc-new" }), res);
  assert.deepEqual(res.captured.body.data.items, [], "an empty account, answered as one");
  assert.ok(!calls.some((entry) => entry[0] === "subjectAccount"), "a read creates no account");
  const records = response();
  await routes(request(`${AGENT_MEMORY_PATH}/records`, undefined, "evk_good", "GET", { "x-subject": "doc-new" }), records);
  assert.deepEqual(records.captured.body.data, []);
});

test("only an integration key may name a subject, a subject is a plain identifier, and a subject has one project", async () => {
  const plain = fixture();
  await assert.rejects(
    () => plain.routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }, "evk_good", "POST", { "x-subject": "doc-7" }), response()),
    (error) => error.status === 400 && error.code === "agent_key_subject_unsupported",
  );
  assert.ok(!plain.calls.some((entry) => entry[0] === "recall"), "refused before any memory was read");
  const integration = fixture({ subjects: true, knownSubjects: ["doc-7"] });
  for (const bad of ["", " ", "张医生", "a b", "x".repeat(129)]) {
    await assert.rejects(
      () => integration.routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }, "evk_good", "POST", { "x-subject": bad }), response()),
      (error) => error.status === 400 && error.code === "agent_subject_invalid",
      `refused: ${JSON.stringify(bad)}`,
    );
  }
  await assert.rejects(
    () => integration.routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x", projectId: "ward-3" }, "evk_good", "POST", { "x-subject": "doc-7" }), response()),
    (error) => error.status === 400 && error.code === "agent_subject_project_unsupported",
  );
  const root = response();
  await integration.routes(request(`${AGENT_MEMORY_PATH}/`, undefined, "evk_good", "GET", { "x-subject": "doc-7" }), root);
  assert.equal(root.captured.body.data.subjects, true);
  assert.equal(root.captured.body.data.speaksFor, "subject");
});

test("recall names at most eight capsules, each once, and returns methods unless asked not to", async () => {
  const { routes, calls } = fixture({ capsules: [{ userId: "u1", id: "cap_school", title: "经方思路" }] });
  for (const capsuleIds of [[], "cap_school", ["a", "a"], Array.from({ length: 9 }, (_, index) => `c${index}`), [""]]) {
    await assert.rejects(
      () => routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x", capsuleIds }), response()),
      (error) => error.status === 400 && error.code === "agent_memory_payload_invalid",
      JSON.stringify(capsuleIds),
    );
  }
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x", methods: "some" }), response()),
    (error) => error.status === 400 && error.code === "agent_memory_payload_invalid",
  );
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x", capsuleIds: ["cap_school"] }), res);
  assert.deepEqual(res.captured.body.data.capsules, [{ id: "cap_school", title: "经方思路", owner: "self" }]);
  assert.deepEqual(res.captured.body.data.methods, []);
  const recalled = calls.find((entry) => entry[0] === "recall");
  assert.deepEqual(recalled[2].selection, [{ capsuleId: "cap_school", mode: "named" }], "the named capsule, not the ones in force");
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x", capsuleIds: ["cap_elsewhere"] }), response()),
    (error) => error.status === 404 && error.code === "capsule_not_found",
  );
});

test("a limit the capsule half cannot serve is served, not refused", async () => {
  const { routes, calls } = fixture();
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "x", limit: 45 }), response());
  assert.equal(calls.find((entry) => entry[0] === "recall")[2].limit, 30, "the capsule store's own ceiling");
});

test("each request schema in the description is exactly the fields its route accepts", async () => {
  const { AGENT_MEMORY_REQUEST_FIELDS } = await import("../src/agentMemoryRoutes.mjs");
  const schemas = agentMemoryOpenApi({ basePath: AGENT_MEMORY_PATH, rateLimitPerMinute: 120 }).components.schemas;
  const described = { recall: "RecallRequest", note: "NoteRequest", episodes: "EpisodeRequest" };
  assert.deepEqual(Object.keys(described).sort(), Object.keys(AGENT_MEMORY_REQUEST_FIELDS).sort(), "every body the routes read is described");
  for (const [operation, schema] of Object.entries(described)) {
    assert.deepEqual(Object.keys(schemas[schema].properties).sort(), [...AGENT_MEMORY_REQUEST_FIELDS[operation]].sort(), operation);
    assert.equal(schemas[schema].additionalProperties, false, `${operation}: an unknown field is refused, and the description says so`);
  }
});

test("the description names the subject header on every operation, with the pattern the route enforces", async () => {
  const { AGENT_SUBJECT_PATTERN } = await import("../src/agentApiKeys.mjs");
  const document = agentMemoryOpenApi({ basePath: AGENT_MEMORY_PATH, rateLimitPerMinute: 120 });
  assert.equal(document.components.parameters.Subject.name, "X-Subject");
  assert.equal(document.components.parameters.Subject.schema.pattern, AGENT_SUBJECT_PATTERN.source);
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      assert.ok(operation.parameters.some((parameter) => parameter.$ref === "#/components/parameters/Subject"), `${method} ${path}`);
      assert.match(operation.responses[400].description, /agent_key_subject_unsupported/, `${method} ${path}`);
    }
  }
});
