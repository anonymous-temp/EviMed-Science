// The prediction registry over real PostgreSQL and the evolution ledger (evidence-flywheel plan §5.2, F25): a filing is a tenant's immutable row.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { EvolutionLedger } from "../src/evolutionLedger.mjs";
import { createPredictionRegistry } from "../src/predictionRegistry.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "A disposable localhost test database is required" };
const operator = `prediction_${randomUUID()}`, alice = `prediction_${randomUUID()}`, bob = `prediction_${randomUUID()}`;
const refused = (code) => (error) => error?.code === code;

let database, documents, service, clock;
const config = { predictionRegistryEnabled: true, operatorUsers: [operator] };
const makeRegistry = () => createPredictionRegistry({ config, ledger: service, now: () => clock });

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Operator','development'),($2,'Alice','development'),($3,'Bob','development')", [operator, alice, bob]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576),($2,'vcr-study','Study',1048576),($3,'vcr-study','Study',1048576)", [operator, alice, bob]);
  documents = new ProductDocuments(database);
  service = new EvolutionLedger({ documents, ownerId: operator, now: () => clock });
});
after(async () => { if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[operator, alice, bob]]); await database.close(); } });

let sequence = 0;
const filing = (over = {}) => ({ source: "vcr", studyId: `study-${++sequence}`, projectId: "vcr-study", accountId: alice, registryId: `NCT0000${String(sequence).padStart(4, "0")}`, endpoint: "Overall survival",
  estimate: 0.78, interval: [0.65, 0.93], probability: 0.7, methodId: "design.analytic", engineJobId: `job-${sequence}`, filedAt: "2026-10-06T07:59:00.000Z", ...over });

test("a registration is the filing account's row: stamped, hashed, found again when retried, a new row when revised, and never overwritten", options, async () => {
  clock = new Date("2026-10-06T08:00:00.000Z");
  const registry = makeRegistry();
  const input = filing();
  const first = await registry.register(input);
  assert.deepEqual([first.status, first.existing, first.recordedAt], ["waiting-publication", false, "2026-10-06T08:00:00.000Z"]);
  assert.match(first.payloadHash, /^[a-f0-9]{64}$/);
  const again = await registry.register(input);
  assert.deepEqual([again.id, again.existing], [first.id, true], "the same filing is the same row");
  const revised = await registry.register({ ...input, estimate: 0.8, interval: [0.7, 0.9], filedAt: "2026-10-06T07:59:30.000Z" });
  assert.notEqual(revised.id, first.id, "the same trial, endpoint and source, filed again, is another row");
  assert.equal((await documents.history(alice, "knowledge", first.id)).length, 1, "nothing ever rewrote the first");
  assert.equal(await service.get(first.id, operator), null, "it is the account's, not the operator's, in the ledger");
  assert.equal((await service.get(first.id, alice)).payload.status, "waiting-publication");
  assert.equal((await service.list("prospective", operator)).some((row) => row.id === first.id), false, "the module's own prospective list does not see it");
  const second = await registry.register({ source: "vcr", studyId: "study-2", projectId: "vcr-study", accountId: bob, registryId: "NCT09999999", endpoint: "PFS", probability: 0.4, filedAt: "2026-10-06T07:00:00.000Z" });
  assert.equal(second.status, "waiting-publication");
  assert.equal((await service.get(second.id, bob)).payload.source, "vcr");
  await assert.rejects(() => registry.register(filing({ estimate: undefined, probability: undefined })), refused("prediction_invalid"));
  await assert.rejects(() => registry.register(filing({ projectId: "no-such-project" })));
});



