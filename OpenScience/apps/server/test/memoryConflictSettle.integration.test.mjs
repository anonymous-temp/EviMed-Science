import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

/**
 * A memory disagreement, seen and settled on the memory page (F1): the list the
 * page reads carries each record's interval, open disagreements and changed
 * sources; one route settles a disagreement for the researcher, as the
 * researcher's decision; and nothing of another account is reachable by it.
 * Real routes, real store, real database.
 */
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

async function signIn(base, username, password) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  const auth = await login.json();
  return {
    "content-type": "application/json",
    cookie: login.headers.get("set-cookie").split(";")[0],
    "x-open-science-csrf": auth.data.csrfToken,
  };
}

/** The real app, two accounts, and each one's signed-in headers. */
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "evimed-memory-settle-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
  });
  const password = "test-only-memory-password";
  const make = async (label) => {
    const username = `${label}${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    return { user: await app.store.createUser(username, password, "Memory fixture"), username };
  };
  const mine = await make("settle");
  const theirs = await make("other");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[mine.user.id, theirs.user.id]]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    app, base, user: mine.user, other: theirs.user,
    headers: await signIn(base, mine.username, password),
    otherHeaders: await signIn(base, theirs.username, password),
  };
}

const fact = (overrides = {}) => ({
  scope: "project", scopeId: "prj_a", kind: "project_fact", key: "project.dose.rivaroxaban",
  value: "rivaroxaban dose is 20 mg once daily", summary: "rivaroxaban dose is 20 mg once daily",
  origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false, ...overrides,
});
const proof = { sourceType: "conversation_message", sourceRef: "sessions/ses_1/messages/1", quote: "stated in the conversation", weight: 1 };
const SOURCE = `src_${"a".repeat(32)}`;

const get = async (base, headers, route) => (await (await fetch(`${base}${route}`, { headers })).json()).data;
const post = (base, headers, route, body) => fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
const profileOf = async (base, headers) => get(base, headers, "/api/memory/profile");

test("the page's list carries the interval, the open disagreement with the other statement, and a changed source", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const memory = app.researchMemory;
  const plain = await memory.upsertRecord(user.id, fact({ key: "project.plain", value: "a plain statement", summary: "a plain statement" }), proof);
  const a = await memory.upsertRecord(user.id, fact({ key: "project.dose.a", value: "dose a is 20 mg", summary: "dose a is 20 mg" }), proof,
    { sourceLinks: [{ type: "knowledge_source", id: SOURCE, version: "sha256:v1" }] });
  const b = await memory.upsertRecord(user.id, fact({ key: "project.dose.b", value: "dose b is 15 mg", summary: "dose b is 15 mg", origin: "inferred", confidence: 0.6 }), proof);
  const later = await memory.upsertRecord(user.id, fact({ key: "project.later", value: "starts next year", summary: "starts next year", validFrom: "2099-01-01T00:00:00.000Z" }), proof);
  await memory.markConflict(user.id, a.id, b.id, { reason: "the two doses disagree" });
  await memory.markSourceLinks(user.id, { type: "knowledge_source", id: SOURCE }, { state: "retracted", reason: "retraction notice" });

  const profile = await profileOf(base, headers);
  const byId = Object.fromEntries(profile.records.map((record) => [record.id, record]));
  assert.equal(byId[plain.id].relations, undefined, "a record with nothing to say carries no relations");
  assert.deepEqual(byId[a.id].relations.caveats, ["conflict", "source_retracted"]);
  assert.deepEqual(byId[a.id].relations.conflicts.map((side) => [side.id, side.text, side.status]), [[b.id, "dose b is 15 mg", "active"]]);
  assert.deepEqual(byId[a.id].relations.sources, [{ type: "knowledge_source", id: SOURCE, state: "retracted" }]);
  assert.deepEqual(byId[b.id].relations.conflicts.map((side) => [side.id, side.text]), [[a.id, "dose a is 20 mg"]], "each side sees the other");
  assert.deepEqual(byId[b.id].relations.caveats, ["conflict"]);
  assert.deepEqual(byId[later.id].relations.caveats, ["not_yet_valid"]);
  assert.equal(byId[later.id].relations.validity.from, "2099-01-01T00:00:00Z");
  assert.equal(profile.groups.project_fact.find((record) => record.id === a.id).relations.caveats.length, 2, "the grouped view says the same");

  // The same labels on the list and the search the page also reads.
  const listed = await get(base, headers, "/api/memory/records?kind=project_fact");
  assert.deepEqual(listed.find((record) => record.id === b.id).relations.caveats, ["conflict"]);
  const found = await get(base, headers, `/api/memory/search?q=${encodeURIComponent("dose")}`);
  assert.deepEqual(found.items.find((record) => record.id === a.id).relations.caveats, ["conflict", "source_retracted"]);

  // A check that could not answer is not a finding.
  await memory.markSourceLinks(user.id, { type: "knowledge_source", id: SOURCE }, { state: "unknown", reason: "lookup timed out" });
  const after = await profileOf(base, headers);
  assert.deepEqual(after.records.find((record) => record.id === a.id).relations.caveats, ["conflict"]);
});

test("settling a disagreement replaces the other, keeps it as history, and is the researcher's own decision", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const memory = app.researchMemory;
  const a = await memory.upsertRecord(user.id, fact({ key: "project.dose.a", value: "dose a is 20 mg", summary: "dose a is 20 mg" }), proof);
  const b = await memory.upsertRecord(user.id, fact({ key: "project.dose.b", value: "dose b is 15 mg", summary: "dose b is 15 mg", origin: "inferred", confidence: 0.6 }), proof);
  await memory.markConflict(user.id, a.id, b.id);

  // The inference is the side the researcher chooses: it becomes theirs.
  const settled = await post(base, headers, "/api/memory/conflicts/resolve", { keepId: b.id, otherId: a.id });
  assert.equal(settled.status, 200);
  const { data } = await settled.json();
  assert.equal(data.kept.id, b.id);
  assert.equal(data.kept.status, "active");
  assert.equal(data.kept.origin, "explicit", "a model's inference does not stay one once the researcher chose it");
  assert.equal(data.kept.confidence, 1);
  assert.ok(data.kept.lastConfirmedAt);
  assert.equal(data.kept.provenance.basis, "confirmed");
  assert.equal(data.kept.revisions.at(-1).by, "user");
  assert.match(data.kept.revisions.at(-1).reason, /^user confirmed/);
  assert.equal(data.superseded.id, a.id);
  assert.equal(data.superseded.status, "superseded");
  assert.equal(data.superseded.supersededBy, b.id);
  assert.equal(data.superseded.revisions.at(-1).by, "user", "the replacement is recorded as the researcher's act, not a model's");

  // History stays: the replaced statement is still there, with its value, and no longer a party.
  const profile = await profileOf(base, headers);
  const byId = Object.fromEntries(profile.records.map((record) => [record.id, record]));
  assert.equal(byId[a.id].value, "dose a is 20 mg");
  assert.equal(byId[a.id].status, "superseded");
  assert.deepEqual(byId[a.id].relations.conflicts, [], "a settled disagreement is no longer labelled on either side");
  assert.ok(byId[a.id].relations.validity.until, "the replaced statement says when it stopped holding");
  assert.equal(byId[b.id].relations, undefined);

  // Settling twice, or settling something that is not in conflict, says so by name.
  const again = await post(base, headers, "/api/memory/conflicts/resolve", { keepId: b.id, otherId: a.id });
  assert.equal(again.status, 404);
  assert.equal((await again.json()).code, "memory_conflict_not_found");

  // The one click that takes any memory change back puts the disagreement back.
  const undone = await post(base, headers, `/api/memory/records/${a.id}/undo`, { expectedVersion: data.superseded.version });
  assert.equal(undone.status, 200);
  const reopened = await profileOf(base, headers);
  assert.deepEqual(reopened.records.find((record) => record.id === a.id).relations.caveats, ["conflict"]);
  assert.deepEqual(reopened.records.find((record) => record.id === b.id).relations.caveats, ["conflict"]);
});

test("only a person settles a disagreement, only on their own memories, and only memories in force", options, async (t) => {
  const { app, base, headers, otherHeaders, user, other } = await fixture(t);
  const memory = app.researchMemory;
  const a = await memory.upsertRecord(user.id, fact({ key: "project.dose.a", value: "dose a" }), proof);
  const b = await memory.upsertRecord(user.id, fact({ key: "project.dose.b", value: "dose b" }), proof);
  const pending = await memory.upsertRecord(user.id, fact({ key: "project.dose.c", value: "dose c", status: "pending", origin: "inferred", confidence: 0.6 }), proof);
  const strangers = await memory.upsertRecord(other.id, fact({ key: "project.dose.s", value: "someone else's dose" }), proof);
  await memory.markConflict(user.id, a.id, b.id);
  await memory.markConflict(user.id, a.id, pending.id);

  // Not signed in: refused before anything is read.
  const anonymous = await fetch(`${base}/api/memory/conflicts/resolve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keepId: a.id, otherId: b.id }),
  });
  assert.ok([401, 403].includes(anonymous.status), `an anonymous settle answered ${anonymous.status}`);

  // Another account's record is not found, from either side, and nothing of it moves.
  for (const [keepId, otherId] of [[a.id, strangers.id], [strangers.id, a.id]]) {
    const refused = await post(base, headers, "/api/memory/conflicts/resolve", { keepId, otherId });
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).code, "memory_not_found");
  }
  const theirsBefore = await memory.getRecord(other.id, strangers.id);
  const foreign = await post(base, otherHeaders, "/api/memory/conflicts/resolve", { keepId: a.id, otherId: b.id });
  assert.equal(foreign.status, 404, "the other account cannot settle this account's disagreement");
  assert.equal((await memory.getRecord(user.id, b.id)).status, "active");
  assert.equal((await memory.getRecord(other.id, strangers.id)).version, theirsBefore.version);

  // A memory still waiting for confirmation cannot be settled against one in force.
  const waiting = await post(base, headers, "/api/memory/conflicts/resolve", { keepId: a.id, otherId: pending.id });
  assert.equal(waiting.status, 409);
  assert.equal((await waiting.json()).code, "memory_conflict_invalid");

  // The body is exactly two ids.
  assert.equal((await post(base, headers, "/api/memory/conflicts/resolve", { keepId: a.id })).status, 400);
  assert.equal((await post(base, headers, "/api/memory/conflicts/resolve", { keepId: a.id, otherId: b.id, by: "extraction" })).status, 400);
  assert.equal((await post(base, headers, "/api/memory/conflicts/resolve", { keepId: a.id, otherId: a.id })).status, 400);
  assert.equal((await memory.getRecord(user.id, b.id)).status, "active", "no refused call changed anything");

  // The route is a researcher's act: a platform step keeps `by: "system"` and does not confirm.
  const system = await memory.resolveConflict(user.id, a.id, b.id, { by: "system", reason: "platform step" });
  assert.equal(system.kept.revisions.length, 0, "a settle that is not the researcher's leaves the kept statement's history alone");
  assert.equal(system.kept.provenance.basis, "stated");
});
