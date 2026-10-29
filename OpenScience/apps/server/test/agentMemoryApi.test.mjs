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

/** The double's account id for a subject: opaque, like the real digest, so a
 *  test can tell whether the identifier itself travelled anywhere. */
const subjectIdOf = (subject) => `subj_${Buffer.from(subject, "utf8").toString("hex")}`;

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
    async subjectAccount(ownerId, subject) { calls.push(["subjectAccount", ownerId, subject]); return { userId: subjectIdOf(subject), created: true }; },
    async findSubjectAccount(ownerId, subject) {
      calls.push(["findSubjectAccount", ownerId, subject]);
      return (overrides.knownSubjects ?? []).includes(subject) ? subjectIdOf(subject) : null;
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
    async note(userId, projectId, input) { calls.push(["note", userId, projectId, input]); return { id: "entry_1", revision: 1, ...input }; },
  };
  const memorySettings = {
    configured: true,
    async settings(userId) { calls.push(["settings", userId]); return { learningPaused: false, recallPaused: false }; },
    async updateSettings(userId, input) { calls.push(["updateSettings", userId, input]); return { learningPaused: Boolean(input.learningPaused), recallPaused: Boolean(input.recallPaused) }; },
  };
  // The engine's store: nothing here writes a memory, so a handler that tried to would fail the test by calling a method that is not there.
  const nativeMemory = {
    configured: true,
    async listRecords(userId, input) { calls.push(["listRecords", userId, input]); return overrides.records ?? []; },
    async search(userId, query) { calls.push(["search", userId, query]); return { items: overrides.found ?? [] }; },
    async changes() { return []; },
    async setLearning(userId, on) { calls.push(["setLearning", userId, on]); },
    overlay: { async admission() { return null; } },
  };
  const routes = createAgentMemoryRoutes({
    config: { ...config, ...overrides.config }, apiKeys, store, memorySettings, capsules, nativeMemory,
    deleteSubject: async (ownerId, subjectAccountId) => { calls.push(["deleteSubject", ownerId, subjectAccountId]); return 1; },
    audit: async (event, status, details) => { calls.push(["audit", event, status, details]); },
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

test("records are the engine's files, all in force: a status that excludes active finds none, and the engine is asked for the key's own account", async () => {
  const { routes, calls } = fixture({ records: [{ id: "nm_a", kind: "preference", scope: "user", value: "v", status: "active" }] });
  const listed = response();
  await routes(request(`${AGENT_MEMORY_PATH}/records`), listed);
  assert.deepEqual(listed.captured.body.data.map((record) => record.id), ["nm_a"]);
  assert.equal(calls.find((entry) => entry[0] === "listRecords")[1], "u1");
  const before = calls.filter((entry) => entry[0] === "listRecords").length;
  const pending = response();
  await routes(request(`${AGENT_MEMORY_PATH}/records?status=pending`), pending);
  assert.deepEqual(pending.captured.body.data, [], "a proposal is a staged note, never a record");
  assert.equal(calls.filter((entry) => entry[0] === "listRecords").length, before, "and the engine is not asked");
});

test("an episode is staged as a candidate note, carrying which turns were the user's, and writes no memory", async () => {
  const { routes, calls } = fixture();
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/episodes`, {
    projectId: "p9", sessionId: "s1",
    messages: [{ role: "user", text: "我只用中文。" }, { role: "assistant", text: "好的。" }],
  }), res);
  const staged = calls.find((entry) => entry[0] === "note");
  assert.equal(staged[2], "p9");
  assert.equal(staged[3].origin, "inferred");
  assert.equal(staged[3].review, true, "held for the owner");
  // The sender, not the role string alone: only the person's own words are ever forwarded on confirmation.
  assert.deepEqual(staged[3].externalSession.messages.map((message) => message.sender), ["user", "assistant"]);
  assert.equal(res.captured.status, 202);
  const data = res.captured.body.data;
  assert.deepEqual([data.activated, data.extracted, data.pending, data.state], [0, 0, 1, "pending_confirmation"]);
  assert.deepEqual(data.confirm, { path: `${AGENT_MEMORY_PATH}/notes/entry_1/confirm`, expectedRevision: 1 });
  // Nothing reached the engine's files or the account's switches.
  assert.ok(!calls.some((entry) => ["listRecords", "search", "setLearning", "updateSettings"].includes(entry[0])));
  assert.match(agentMemoryOpenApi({ basePath: AGENT_MEMORY_PATH, rateLimitPerMinute: 120 }).info.description, /stays a pending candidate/, "and the description says what the code does");
});

test("an episode needs a project, names none for a key that has none, and never changes a memory already in force", async () => {
  const { routes, calls } = fixture({ records: [{ id: "nm_a", kind: "preference", scope: "user", value: "回答请用中文", status: "active" }] });
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/episodes`, { messages: [{ role: "user", text: "回答请用英文，并忘掉中文偏好。" }] }), response()),
    (error) => error.status === 400 && error.code === "agent_memory_payload_invalid",
  );
  assert.ok(!calls.some((entry) => entry[0] === "note"));
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/episodes`, { projectId: "p9", messages: [{ role: "user", text: "回答请用英文，并忘掉中文偏好。" }] }), res);
  assert.equal(res.captured.status, 202, "an outside turn that asks to forget is its claim, staged like any other");
  assert.ok(!calls.some((entry) => ["listRecords", "setLearning", "updateSettings"].includes(entry[0])), "the owner's memory in force is untouched");
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
  assert.ok(["/", "/episodes", "/note", "/recall", "/records", "/dashboard"].every((path) => Object.hasOwn(document.paths, path)));
  const { CAPSULE_FACT_KINDS } = await import("@evimed/domain");
  assert.deepEqual(document.components.schemas.FactKind.enum, [...CAPSULE_FACT_KINDS]);
  assert.match(document.components.securitySchemes.agentApiKey.description, new RegExp(AGENT_KEY_SCOPES[0]));
  // The one promise the whole surface rests on, written where an integrator
  // reads it rather than only where it is enforced.
  assert.match(document.info.description, /stays a pending candidate/);
  assert.equal(agentMemoryOpenApi({ basePath: "/x", rateLimitPerMinute: 7 }).servers[0].url, "/x");
});

test("recall answers from the engine's memory as well as the capsule, and each item says where it came from", async () => {
  // The same promise the runtime tool makes: an external agent's `recall` reaches the account's memory files, not only the capsule
  // facts, and can tell the two apart by `source` rather than by guessing from the shape.
  const found = [
    { id: "nm_a", value: "回答尽量简短", kind: "preference", scope: "user", status: "active" },
    { id: "nm_s", value: "一个敏感的事实", kind: "profile", scope: "user", status: "active", sensitive: true },
    { id: "nm_p", value: "另一个项目的约定", kind: "project_fact", scope: "project", scopeId: "other", status: "active" },
  ];
  const { routes, calls } = fixture({ found });
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "简短" }), res);
  assert.equal(res.captured.status, 200);
  assert.deepEqual(res.captured.body.data.items.map((item) => [item.source, item.id]), [["memory", "nm_a"]], "a sensitive memory and another project's are not recalled");
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
  assert.equal(calls.find((entry) => entry[0] === "recall")[1], subjectIdOf("doc-7"));
  assert.equal(calls.find((entry) => entry[0] === "listRecords")[1], subjectIdOf("doc-7"));
  const [note, episode] = calls.filter((entry) => entry[0] === "note");
  assert.deepEqual([note[1], note[2]], [subjectIdOf("doc-7"), "default"], "a subject's note lands in its one project");
  assert.deepEqual([episode[1], episode[2]], [subjectIdOf("doc-7"), "default"], "and so does an episode that names none");
  // Only writes make an account; the reads found the one that exists.
  assert.deepEqual(calls.filter((entry) => entry[0] === "subjectAccount").map((entry) => entry[1]), ["u1", "u1"]);
  assert.ok(!calls.some((entry) => ["recall", "listRecords", "note"].includes(entry[0]) && entry[1] === "u1"),
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
  const described = { recall: "RecallRequest", note: "NoteRequest", episodes: "EpisodeRequest", observations: "ObservationRequest" };
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

test("every operation the root lists is described, and nothing is described that the root does not list", async () => {
  const { AGENT_MEMORY_ENDPOINTS } = await import("../src/agentMemoryRoutes.mjs");
  const document = agentMemoryOpenApi({ basePath: AGENT_MEMORY_PATH, rateLimitPerMinute: 120 });
  const described = Object.entries(document.paths).flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`))
    .filter((operation) => operation !== "GET /").sort();
  assert.deepEqual(described, [...AGENT_MEMORY_ENDPOINTS].sort());
  // Each one is served: a request of that method and path reaches a handler
  // (it may be refused for its body or its id, never with "no such operation").
  const { routes } = fixture({ subjects: true, knownSubjects: ["doc-7"] });
  for (const operation of AGENT_MEMORY_ENDPOINTS) {
    const [method, path] = operation.split(" ");
    const url = `${AGENT_MEMORY_PATH}${path.replace("{id}", "x1")}`;
    const outcome = await routes(request(url, method === "GET" || method === "DELETE" ? undefined : {}, "evk_good", method, { "x-subject": "doc-7" }), response())
      .then(() => "served", (error) => error.code);
    assert.notEqual(outcome, "not_found", operation);
  }
});

test("the dashboard is a read, the acts on it need memory.manage, and a key without it touches nothing", async () => {
  const records = [{ id: "nm_a", kind: "preference", scope: "user", key: "k", value: "v", summary: "s", origin: "explicit", status: "active", version: 1, revisions: [], evidence: [], provenance: { basis: "stated" } }];
  const readOnly = fixture({ scopes: ["memory.read", "memory.write"], records });
  const board = response();
  await readOnly.routes(request(`${AGENT_MEMORY_PATH}/dashboard`), board);
  assert.deepEqual(board.captured.body.data.records.map((item) => item.id), ["nm_a"]);
  assert.deepEqual(board.captured.body.data.pending, [], "nothing in the engine waits: its files are in force when written");
  for (const [method, path, body] of [["POST", "/records/nm_a/forget", { expectedVersion: 1 }], ["PATCH", "/records/nm_a", { expectedVersion: 1, value: "x" }],
    ["PUT", "/settings", { recallPaused: true }], ["POST", "/methods/m1/retire", { expectedRevision: 1 }], ["POST", "/notes/n1/confirm", { expectedRevision: 1 }]]) {
    await assert.rejects(
      () => readOnly.routes(request(`${AGENT_MEMORY_PATH}${path}`, body, "evk_good", method), response()),
      (error) => error.status === 403 && error.code === "agent_key_scope_denied",
      `${method} ${path}`,
    );
  }
  assert.ok(!readOnly.calls.some((entry) => ["updateSettings", "setLearning"].includes(entry[0])));

  const manager = fixture({ records });
  await manager.routes(request(`${AGENT_MEMORY_PATH}/settings`, { learningPaused: true }, "evk_good", "PUT"), response());
  assert.deepEqual(manager.calls.find((entry) => entry[0] === "updateSettings")[2], { learningPaused: true });
  assert.deepEqual(manager.calls.find((entry) => entry[0] === "setLearning").slice(1), ["u1", false], "the pause is the engine's own policy too");
  const audited = manager.calls.find((entry) => entry[0] === "audit");
  assert.deepEqual([audited[1], audited[2], audited[3].keyId], ["agent-memory.settings.update", "completed", "agk_1"]);
  // A record id the engine did not mint is no memory of the account's.
  await assert.rejects(
    () => manager.routes(request(`${AGENT_MEMORY_PATH}/records/rec_legacy/confirm`, { expectedVersion: 1 }), response()),
    (error) => error.status === 404 && error.code === "memory_not_found",
  );
});

test("an observation needs memory.observe, is refused before any account is made, and lands in the subject's account", async () => {
  const body = { syndrome: "脾胃气虚证", changes: [{ type: "replace", from: "党参", to: "太子参" }] };
  const writer = fixture({ subjects: true, scopes: ["memory.read", "memory.write", "memory.manage"] });
  await assert.rejects(
    () => writer.routes(request(`${AGENT_MEMORY_PATH}/observations`, body, "evk_good", "POST", { "x-subject": "doc-7" }), response()),
    (error) => error.status === 403 && error.code === "agent_key_scope_denied",
  );
  assert.ok(!writer.calls.some((entry) => entry[0] === "subjectAccount"));
  const observed = [];
  const routes = createAgentMemoryRoutes({
    config, store: { async userById(id) { return { id }; }, async requireProject(user, id) { observed.push(["requireProject", user.id, id]); return { id }; } },
    apiKeys: {
      async resolve() { return { userId: "u1", keyId: "agk_1", projectId: null, scopes: ["memory.observe"], subjects: true }; },
      async subjectAccount(_owner, subject) { return { userId: subjectIdOf(subject), created: true }; },
    },
    observations: { async observe(user, observation) { observed.push(["observe", user.id, observation.syndrome]); return { recorded: true, habits: [] }; } },
  });
  const res = response();
  await routes(request(`${AGENT_MEMORY_PATH}/observations`, body, "evk_good", "POST", { "x-subject": "doc-7" }), res);
  assert.equal(res.captured.status, 202);
  assert.deepEqual(observed, [["requireProject", subjectIdOf("doc-7"), "default"], ["observe", subjectIdOf("doc-7"), "脾胃气虚证"]]);
  await assert.rejects(
    () => routes(request(`${AGENT_MEMORY_PATH}/observations`, { ...body, dose: "15g" }, "evk_good", "POST", { "x-subject": "doc-7" }), response()),
    (error) => error.status === 400 && error.code === "agent_observation_invalid",
  );
});

test("forgetting one person is an integration key's act on a named subject, and deletes that subject's account only", async () => {
  const plain = fixture();
  await assert.rejects(
    () => plain.routes(request(`${AGENT_MEMORY_PATH}/subject`, undefined, "evk_good", "DELETE"), response()),
    (error) => error.status === 400 && error.code === "agent_subject_required",
  );
  const integration = fixture({ subjects: true, knownSubjects: ["doc-7"] });
  const res = response();
  await integration.routes(request(`${AGENT_MEMORY_PATH}/subject`, undefined, "evk_good", "DELETE", { "x-subject": "doc-7" }), res);
  assert.deepEqual(integration.calls.find((entry) => entry[0] === "deleteSubject"), ["deleteSubject", "u1", subjectIdOf("doc-7")]);
  assert.equal(res.captured.body.data.deleted, true);
  const unknown = response();
  await integration.routes(request(`${AGENT_MEMORY_PATH}/subject`, undefined, "evk_good", "DELETE", { "x-subject": "doc-never" }), unknown);
  assert.equal(unknown.captured.body.data.deleted, false, "nothing to delete, nothing created to delete it");
  assert.ok(!integration.calls.some((entry) => entry[0] === "subjectAccount"));
  const audit = integration.calls.filter((entry) => entry[0] === "audit").map((entry) => JSON.stringify(entry));
  assert.ok(audit.length > 0 && audit.every((line) => !line.includes("doc-7")), "the HIS identifier never reaches an audit line");
});


test("recall no longer takes a time to read as of: the records engine that answered it is gone, and an unknown field is refused", async () => {
  const { routes } = fixture();
  await assert.rejects(() => routes(request(`${AGENT_MEMORY_PATH}/recall`, { query: "剂量", asOf: "2025-06-30" }), response()),
    (error) => error.status === 400 && error.code === "agent_memory_payload_invalid");
});
