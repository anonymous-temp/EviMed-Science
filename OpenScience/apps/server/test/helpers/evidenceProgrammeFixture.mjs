// The evidence programme over real PostgreSQL, with doubles only where a provider or a runtime would be: the model, the result
// store's reads, and the entity glossary (a closed list of terms, so a test says which entity a phrase is about). Everything the
// programme writes — decisions, agendas, episodes, zones, cards — goes through the real services.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { AutopilotPlanner } from "../../src/autopilotNextAction.mjs";
import { AutopilotService } from "../../src/autopilotService.mjs";
import { frontierItemsMatching } from "../../src/entityVocabulary.mjs";
import { createEvidenceBudget } from "../../src/evidenceBudget.mjs";
import { createEvidenceProgramme } from "../../src/evidenceProgramme.mjs";
import { EvidenceZoneService } from "../../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../../src/frontierPersistence.mjs";
import { EVIDENCE_PROJECT_ID, ensureEvidenceProject } from "../../src/internalProjects.mjs";
import { ProductDocuments, ProductJobs } from "../../src/productStore.mjs";
import { createStore } from "../../src/store.mjs";
import { UsageLedger } from "../../src/usageLedger.mjs";
import { createGeoTestDatabase } from "./geoTestDatabase.mjs";
import { insertItem, insertSource } from "./frontierFixtures.mjs";

export { EVIDENCE_PROJECT_ID, PLATFORM_PUBLISHER_USER_ID, insertItem, insertSource };

/** The glossary of a test: a term a text mentions (case-insensitive substring) and the entity key it is. */
export const TEST_GLOSSARY = Object.freeze({
  "atrial fibrillation": "disease:atrial fibrillation", 房颤: "disease:atrial fibrillation", apixaban: "drug:apixaban", rivaroxaban: "drug:rivaroxaban",
  warfarin: "drug:warfarin", "non-small cell lung cancer": "disease:non-small cell lung cancer", 非小细胞肺癌: "disease:non-small cell lung cancer",
  osimertinib: "drug:osimertinib", "breast cancer": "disease:breast cancer", 乳腺癌: "disease:breast cancer", "type 2 diabetes": "disease:type 2 diabetes",
  "2 型糖尿病": "disease:type 2 diabetes", semaglutide: "drug:semaglutide", "chronic kidney disease": "disease:chronic kidney disease", 慢性肾病: "disease:chronic kidney disease",
});

/** @param {Record<string, string>} [glossary] */
export function glossaryVocabulary(database, glossary = TEST_GLOSSARY) {
  /** @param {string[]} texts */
  const keysIn = (texts) => [...new Set(Object.entries(glossary).filter(([term]) => texts.some((text) => String(text).toLowerCase().includes(term.toLowerCase()))).map(([, key]) => key))].sort();
  return {
    enabled: true,
    tag: async ({ texts = [] } = {}) => keysIn(texts),
    keysForText: async ({ texts = [] } = {}) => keysIn(texts),
    frontierItemsMatching: (query) => frontierItemsMatching(database, query),
  };
}

/** What a model of the test answers: a JSON message in the provider's shape. @param {unknown} content */
export const modelAnswer = (content) => ({ choices: [{ finish_reason: "stop", message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });

/**
 * @param {{ url: string, label: string, config?: Record<string, any>, callModel?: (deps: any, call: any) => Promise<any>,
 *   plannerCall?: (deps: any, call: any) => Promise<any>, staleOfficialCards?: any, observedErrors?: any }} options
 */
export async function programmeFixture({ url, label, config: over = {}, callModel, plannerCall, staleOfficialCards = null, observedErrors = null }) {
  const isolated = await createGeoTestDatabase(url, label);
  const dataDir = await mkdtemp(join(tmpdir(), `evidence-programme-${label}-`));
  const store = createStore({ stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000, dataDir, maxProjectBytes: 1_048_576 });
  const database = store.database;
  await migrateFrontier(database, { dimension: 1024 });
  const operatorId = `operator-${randomUUID().slice(0, 8)}`;
  const researcherId = `researcher-${randomUUID().slice(0, 8)}`;
  for (const id of [operatorId, researcherId]) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [id]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [id]);
  }
  await ensureEvidenceProject(store);
  const clock = { at: new Date("2026-10-05T01:00:00.000Z") };
  const now = () => new Date(clock.at);
  const config = {
    evidenceProgrammeEnabled: true, evidenceProgrammeDailyBudgetCny: 30, evidenceProgrammeMaxConcurrency: 1, evidenceProgrammeEpisodeBudgetCny: 10,
    evidenceProgrammeMinDemandUsers: 5, evidenceProgrammeOriginalPerWeek: 2, evidenceProgrammeStaleCardDays: 30, frontierTimeZone: "Asia/Shanghai",
    frontierSelectThreshold: 82, deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", deepseekModel: "deepseek-flash", autopilotPlannerEnabled: true,
    operatorUsers: [operatorId], userDailySpendLimit: 0, userWeeklySpendLimit: 0, ...over,
  };
  const documents = new ProductDocuments(database);
  const jobs = new ProductJobs(database);
  const ledger = new UsageLedger(database);
  const vocabulary = glossaryVocabulary(database);
  const zones = new EvidenceZoneService({ database, entityKeysFor: ({ texts }) => vocabulary.keysForText({ texts }), platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID });
  await zones.ready();
  /** @type {{ call: any }[]} */
  const plannerCalls = [];
  const planner = new AutopilotPlanner(config, { usageLedger: ledger, callModel: async (deps, call) => {
    plannerCalls.push({ call });
    if (plannerCall) return plannerCall(deps, call);
    const context = JSON.parse(call.body.messages[1].content);
    return modelAnswer({ action: "run", taskType: context.taskTypes.find((type) => type.state === "available").id, focus: "核对新的随机对照试验", reason: "上次综合之后有新证据" });
  } });
  const autopilot = new AutopilotService({ documents, jobs, usage: ledger, planner, entityVocabulary: vocabulary, now });
  /** @type {Map<string, any>} result versions of a run, set by a test */
  const resultsByRun = new Map();
  /** @type {Map<string, { bytes: Buffer, digest: string, capturedAt: string }>} preserved source bytes by version id */
  const rawByVersion = new Map();
  const results = {
    list: async (_userId, { runId }) => ({ items: resultsByRun.get(runId) ?? [], nextCursor: null }),
    raw: async (_userId, _projectId, versionId) => {
      const held = rawByVersion.get(versionId);
      if (!held) throw Object.assign(new Error("not here"), { code: "result_snapshot_unavailable" });
      return { version: { digest: held.digest, capturedAt: held.capturedAt }, bytes: held.bytes };
    },
  };
  const budget = createEvidenceBudget({ usageLedger: ledger, config, now });
  /** @type {{ calls: any[] }} */
  const decisions = { calls: [] };
  const programme = createEvidenceProgramme({
    config, database, documents, jobs, autopilot, zones, budget, entityVocabulary: vocabulary, results, usageLedger: ledger,
    ensureProject: () => ensureEvidenceProject(store), staleOfficialCards, observedErrors, now,
    callModel: async (deps, call) => { decisions.calls.push(call); if (!callModel) throw Object.assign(new Error("no model"), { code: "model_gateway_unavailable" }); return callModel(deps, call); },
  });
  autopilot.programme = programme;
  const publisherUser = { id: PLATFORM_PUBLISHER_USER_ID, name: "EviMed 证据中心" };

  /** One model call booked and settled at `cost` under `purpose`, in the publisher's evidence project, at `at`. */
  async function spend(cost, { purpose = "evidence", userId = PLATFORM_PUBLISHER_USER_ID, projectId = EVIDENCE_PROJECT_ID, at = now(), runId = null } = {}) {
    const id = randomUUID();
    const reserved = await ledger.reserveModel({
      id, userId, projectId, purpose, model: "deepseek-v4-flash", priceVersion: "evimed-reference-2026-09-05", currency: "CNY", runId,
      requestFingerprint: createHash("sha256").update(id).digest("hex"), estimatedCost: Math.max(cost, 0.01), dailyLimit: 0, weeklyLimit: 0, now: at,
    });
    await ledger.settleModel(userId, reserved.id, { usage: { cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 5 }, actualCost: cost, priced: true });
  }

  /** A reader whose 「与你相关」 profile carries `phrases` (`{ text, source }`); the row is the only trace of them. */
  async function reader(phrases) {
    const id = `reader-${randomUUID().slice(0, 12)}`;
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [id]);
    await database.query("INSERT INTO evimed_frontier.user_profiles(user_id, specialties, phrases) VALUES($1, '{}', $2::jsonb)", [id, JSON.stringify(phrases)]);
    return id;
  }

  /** A published feed item carrying `entityKeys`. @param {Record<string, any>} over */
  async function feedItem(over = {}) {
    await insertSource(database, "nejm");
    const { entityKeys = [], score = 90, ...rest } = over;
    const item = await insertItem(database, { sourceId: "nejm", timelineAt: clock.at.toISOString(), ...rest });
    await database.query("UPDATE evimed_frontier.items SET entity_keys=$2, score_total=$3 WHERE id=$1", [item.id, entityKeys, score]);
    return item;
  }

  /** An official zone (published, the publisher's unless told otherwise) with the given title. */
  async function importedZone(title, { owner = PLATFORM_PUBLISHER_USER_ID, kind = "official" } = {}) {
    const id = `ez_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await database.query("INSERT INTO evimed_frontier.evidence_zones(id, user_id, title, description, background, state, kind) VALUES($1,$2,$3,'','', 'published', $4)", [id, owner, title, kind]);
    return id;
  }

  async function close() {
    await store.close();
    await isolated.drop();
    await rm(dataDir, { recursive: true, force: true });
  }

  return { databaseUrl: isolated.url, store, database, documents, jobs, ledger, vocabulary, zones, autopilot, planner, plannerCalls, budget, programme, results, resultsByRun, rawByVersion,
    config, clock, now, spend, reader, feedItem, importedZone, publisherUser, operatorId, researcherId, decisions, close };
}

/** The sha-256 of a string. @param {string} value */
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
