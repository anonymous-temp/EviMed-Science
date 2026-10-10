// 2026-10-10 review M-14: two reads of research memory looked at a fixed window of the account's records instead of at what the
// question needed.
//   - `relevant()` (the term-matching arm: every question about an earlier time, and every recall while the index is out) read the
//     100 most important durable records and the 100 most important of any kind, whoever's they were, and only then dropped what
//     the project, the time or the question ruled out. An account with more than that lost the rest, silently, however well they
//     matched.
//   - Extraction compared what the model proposed with the 100 most important records of the whole account, so a memory beyond
//     them was "new": a replacement could not find what it replaced, and a restated fact was written as a duplicate.
// Both against a real database, with the account holding more than the window.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 120_000 };

const alpha = `window_alpha_${randomUUID()}`;
const beta = `window_beta_${randomUUID()}`;
const FILLERS = 110;
/** @type {any} */ let database;
/** @type {any} */ let store;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,'Window owner','development' FROM unnest($1::text[]) AS id", [[alpha, beta]]);
  await migrateProductStore(database);
  await migrateNotifications(database);
  await migrateUsageLedger(database);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
  // More than a window of the two kinds that used to fill it, every one of them more important than anything the tests look for:
  // the researcher's own standing preferences, and another project's facts.
  for (let index = 0; index < FILLERS; index += 1) {
    await store.upsertRecord(alpha, record({ kind: "preference", key: `pref.filler_${index}`, value: `filler preference ${index}`, summary: `filler ${index}`, importance: 0.9 }));
    await store.upsertRecord(alpha, record({ scope: "project", scopeId: "prj_other", kind: "project_fact", key: `project.filler_${index}`, value: `another project's fact ${index}`, summary: `other ${index}`, importance: 0.95 }));
  }
});
after(async () => {
  if (!database) return;
  await store.purgeRecords(alpha);
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[alpha, beta]]);
  await database.close();
});

/** @param {Record<string, any>} overrides */
function record(overrides = {}) {
  return {
    scope: "user", scopeId: "", kind: "preference", key: "pref.x", value: "x", summary: "x", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false, ...overrides,
  };
}
const idsOf = (/** @type {{ id: string }[]} */ memos) => memos.map((memo) => memo.id.replace(/^record:/, ""));

test("a standing preference that matches the question is recalled however many more important ones the account holds", options, async () => {
  const target = await store.upsertRecord(alpha, record({ key: "pref.zeta", value: "zetazeta protocol: always preregister the analysis", summary: "zetazeta protocol", importance: 0.05 }));
  const recalled = await store.relevant(alpha, "what is the zetazeta protocol", { projectId: "prj_a" });
  assert.equal(recalled[0]?.id, `record:${target.id}`, "the memory that answers the question leads, though 110 others outrank it on importance");
  // Without a question that names it, the long-term picture is what it always was: the most important, within the budget.
  const greeting = await store.relevant(alpha, "hello", { projectId: "prj_a" });
  assert.ok(greeting.length > 0 && greeting.length <= 8);
  assert.ok(greeting.every((memo) => memo.kind === "preference" && memo.content.startsWith("filler")));
});

test("a project's fact is recalled when the question names it, whatever other projects' facts are more important", options, async () => {
  const target = await store.upsertRecord(alpha, record({ scope: "project", scopeId: "prj_a", kind: "project_fact", key: "project.kappa", value: "kappakappa dose is 5 mg", summary: "kappakappa dose", importance: 0.05 }));
  const recalled = await store.relevant(alpha, "the kappakappa dose", { projectId: "prj_a" });
  assert.deepEqual(idsOf(recalled).includes(target.id), true, "found by the question's own words");
  assert.ok(recalled.every((memo) => !memo.content.startsWith("another project")), "and another project's facts stay in their project");
});

test("a question about an earlier time reaches the version that held then, past the first hundred records", options, async () => {
  const held = await store.upsertRecord(alpha, record({ key: "pref.omega", value: "omegaomega: report to two decimals", summary: "omegaomega rule", importance: 0.05,
    validFrom: "2025-01-01T00:00:00Z", invalidSince: "2026-01-01T00:00:00Z" }));
  const then = await store.relevant(alpha, "omegaomega", { projectId: "prj_a", asOf: Date.parse("2025-06-15T00:00:00Z"), now: Date.parse("2026-10-10T00:00:00Z") });
  assert.ok(idsOf(then).includes(held.id), "it held in June 2025");
  const now = await store.relevant(alpha, "omegaomega", { projectId: "prj_a", now: Date.parse("2026-10-10T00:00:00Z") });
  assert.ok(!idsOf(now).includes(held.id), "and does not hold today");
});

// ------------------------------------------------------------------ extraction

function run(id = "run_window") {
  return { id, sessionId: "session_window", mode: "open-domain", agentId: null, agentVersion: null, effectiveAgentId: "clinical-evidence-synthesis",
    effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "research", model: "deepseek/deepseek-v4-pro", status: "succeeded", errorCode: null, artifacts: [],
    startedAt: "2026-10-10T01:00:00.000Z", finishedAt: "2026-10-10T01:01:00.000Z", durationMs: 60_000 };
}
const message = (/** @type {string} */ id, /** @type {string} */ text) => ({ info: { id, role: "user" }, parts: [{ type: "text", text }] });
const extractionConfig = { deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro", memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 5_000 };
/** The model, answering with candidates built from the sources it was shown; every request body is kept. */
function proposing(/** @type {(sources: any[]) => any[]} */ candidates) {
  /** @type {any[]} */ const requests = [];
  const fetchImpl = async (/** @type {any} */ _input, /** @type {any} */ init) => {
    const payload = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    requests.push(payload);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: candidates(payload.sources) }) } }] });
  };
  return { fetchImpl, requests };
}

test("extraction is shown the older memories the conversation is about, and finds the one a new fact replaces", options, async () => {
  const projectId = "prj_extract";
  const older = await store.upsertRecord(alpha, record({ scope: "project", scopeId: projectId, kind: "project_fact", key: "project.cohort_size",
    value: "队列 400 人", summary: "队列规模 400 人", importance: 0.05 }));
  const { fetchImpl, requests } = proposing((sources) => [{
    scope: "project", kind: "project_fact", key: "project.cohort_size_current", value: "队列 500 人", summary: "队列规模 500 人", origin: "explicit",
    importance: 0.6, sensitive: false, sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text, supersedes: "project.cohort_size",
  }]);
  const result = await new MemoryIntelligence(extractionConfig, store, { fetchImpl })
    .recordRun({ id: projectId, userId: alpha }, run(), [message("m1", "队列扩大了，现在是 500 人")]);

  const shown = requests[0].existingMemories.map((/** @type {any} */ item) => item.key);
  assert.ok(shown.includes("project.cohort_size"), `the extractor was shown the older memory the conversation is about: ${shown.slice(0, 5).join(", ")}`);
  assert.deepEqual(result.rejectionReasons.filter((reason) => /supersedes/.test(reason)), [], "and the memory it replaces is found");
  assert.equal(result.written[0]?.supersedes, older.id);
  assert.equal((await store.getRecord(alpha, older.id)).status, "superseded", "it stops being used instead of standing beside the new one");
});

test("a fact stated again is another observation of the memory that holds it, however old and unimportant that memory is", options, async () => {
  const projectId = "prj_again";
  const older = await store.upsertRecord(alpha, record({ scope: "project", scopeId: projectId, kind: "project_fact", key: "project.endpoint",
    value: "主要终点：总生存期", summary: "主要终点", importance: 0.05 }));
  const { fetchImpl } = proposing((sources) => [{
    scope: "project", kind: "project_fact", key: "project.endpoint", value: "主要终点：无进展生存期", summary: "主要终点", origin: "explicit",
    importance: 0.6, sensitive: false, sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text,
  }]);
  const result = await new MemoryIntelligence(extractionConfig, store, { fetchImpl })
    .recordRun({ id: projectId, userId: alpha }, run("run_again"), [message("m1", "主要终点改成无进展生存期")]);
  assert.equal(result.written[0]?.change, "updated", "an update of what was stored, not a new memory");
  assert.equal(result.written[0]?.id, older.id);
  const kept = (await store.listAllRecords(alpha, { kinds: ["project_fact"] })).filter((item) => item.key === "project.endpoint");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].version, older.version + 1);
});
