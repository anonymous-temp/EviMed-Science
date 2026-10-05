// The shared entity vocabulary against a real PostgreSQL (plan §4.2, B3): the
// frontier pipeline stores the keys it always did while sharing the
// vocabulary's glossary, `frontierItemsMatching` finds published items by
// identifier before entity and never an unpublished one, and an autopilot
// agenda, a GEO project and a VCR study are tagged when written, again when
// edited, and once when they were made before the vocabulary could tag —
// each row read and written through its own account.
//
// Its own database (test/helpers/geoTestDatabase.mjs): it creates tables the
// other suites share and counts rows across them.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { AutopilotService } from "../src/autopilotService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createEntityVocabulary, frontierItemsMatching } from "../src/entityVocabulary.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const DIMENSION = 16;

/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {any} */
let database;
const alice = `ent_${randomUUID()}`;
const bob = `ent_${randomUUID()}`;

const GLOSSARY = [
  ["drug", "semaglutide", "司美格鲁肽"], ["drug", "metformin", "二甲双胍"], ["trial", "SELECT", "SELECT"],
  ["disease", "heart failure", "心力衰竭"], ["disease", "Alzheimer's disease", "阿尔茨海默病"], ["org", "FDA", "美国食品药品监督管理局"],
];

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "entityvocab");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Alice','development'),($2,'Bob','development')", [alice, bob]);
  await database.query(`INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes)
    VALUES($1,'one','One',1048576),($1,'two','Two',1048576),($2,'one','Theirs',1048576)`, [alice, bob]);
  await migrateUsageLedger(database);
  await migrateFrontier(database, { dimension: DIMENSION });
  for (const [kind, en, zh] of GLOSSARY) {
    await database.query("INSERT INTO evimed_frontier.glossary (kind, term_en, term_zh, keep_original, origin) VALUES ($1,$2,$3,$4,'hand')", [kind, en, zh, en === zh]);
  }
});

after(async () => {
  await database?.close();
  await isolated?.drop();
});

/** A vocabulary over this database. @param {Record<string, any>} [overrides] */
const vocabulary = (overrides = {}) => createEntityVocabulary({ database, enabled: true, ...overrides });

/**
 * Record what the code asks this database and the account ids of every row it reads back.
 * @param {any} db @returns {{ accounts: Set<string>, statements: Array<{ sql: string, values: unknown[] }> }}
 */
function spyOnDatabase(db) {
  /** @type {Set<string>} */
  const accounts = new Set();
  /** @type {Array<{ sql: string, values: unknown[] }>} */
  const statements = [];
  const note = (/** @type {any} */ sql, /** @type {any} */ values, /** @type {any} */ result) => {
    statements.push({ sql: String(sql), values: values ?? [] });
    for (const row of result?.rows ?? []) if (typeof row.user_id === "string") accounts.add(row.user_id);
    return result;
  };
  const query = db.query.bind(db);
  db.query = async (/** @type {any} */ sql, /** @type {any} */ values) => note(sql, values, await query(sql, values));
  const transaction = db.transaction.bind(db);
  db.transaction = (/** @type {(client: any) => Promise<any>} */ operation) => transaction((/** @type {any} */ client) => operation(new Proxy(client, {
    get(target, property) {
      if (property === "query") return async (/** @type {any} */ sql, /** @type {any} */ values) => note(sql, values, await target.query(sql, values));
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  })));
  return { accounts, statements };
}

// --- the frontier: what it stores is what it always stored -----------------------------------

test("the pipeline stores the keys it always did while sharing the vocabulary's glossary", options, async () => {
  const operator = `ent_op_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Frontier operator','development')", [operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
  await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
    VALUES ('j-nejm','NEJM','evidence','journal','crossref-issn','api',5,false,'MMS','P0','US')`);
  const entities = { drugs: ["司美格鲁肽", "Tirzepatide"], trials: ["SELECT"], orgs: ["美国食品药品监督管理局"], diseases: ["心力衰竭"] };
  const editor = {
    owner: { userId: operator, projectId: "evimed-frontier" }, available: true, provider: { balanceSpent: false },
    async screen(/** @type {any[]} */ batch) {
      return { verdicts: new Map(batch.map((input) => [input.key, { medical: true, news: true, lane: input.allowedLanes[0], specialties: ["cardiology"], language: "en", digest: false }])), errors: new Map(), calls: 1 };
    },
    async edit(/** @type {any} */ item) {
      const modelInput = buildModelInput(item);
      return { modelInput, modelInputSha256: sha256(modelInput), attempts: 1, issues: [], numbers: null, error: null, model: "deepseek-flash", editorVersion: FRONTIER_EDITOR_VERSION,
        verification: "passed", output: { titleZh: "中文标题", summaryZh: "导读。", reasonZh: "值得一看。", lane: item.allowedLanes[0], specialties: ["cardiology"],
          evidenceType: "observational", entities, scores: { impact: 20, novelty: 10, relevance: 10 }, flags: [] } };
    },
  };
  const plugin = { async text(/** @type {string} */ entryId) { return { entry_id: entryId, revision: 1, status: "unavailable", abstract: null, body_excerpt: null, enrichment: {} }; } };
  const embedder = { configured: true, modelKey: `fake@${DIMENSION}`, dimension: DIMENSION, async embedDocuments(/** @type {string[]} */ texts) { return texts.map(() => Array.from({ length: DIMENSION }, () => 1)); } };
  const clock = new Date("2026-09-22T12:00:00Z");
  const run = async (/** @type {string} */ doi, /** @type {any} */ glossary, /** @type {string} */ title) => {
    const pipeline = new FrontierPipeline({ database, editor, plugin, embedder, now: () => clock, workerId: `test-${randomUUID()}`, glossary,
      config: { kbEmbeddingDimension: DIMENSION, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 10, frontierSelectThreshold: 70 } });
    const canonical = `https://example.org/${doi}`;
    await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url, doi, pmid, registry_ids,
        title_raw, summary_raw, facts, lang, published_at, date_precision, first_seen_at, content_sha256, backfill, defects, state)
      VALUES ($1,$2,1,'j-nejm',$3,$4,$4,$5,NULL,'{}',$8,NULL,'{}'::jsonb,'en',$6,'instant',$6,$7,false,'{}','received')`,
    [`j-nejm:${doi}`, Math.floor(Math.random() * 1e9), `doi:${doi}`, canonical, doi, new Date("2026-09-21T21:00:00Z"), createHash("sha256").update(doi).digest("hex"), title]);
    await pipeline.processBatch();
    return (await database.query("SELECT entity_keys, state FROM evimed_frontier.items WHERE doi = $1", [doi])).rows[0];
  };

  // What the pipeline stored before this module existed: its own glossary, read from the table.
  const shared = vocabulary();
  const stored = await run("10.1000/shared", shared.glossaryStore, "Semaglutide in heart failure");
  assert.equal(stored.state, "published");
  assert.deepEqual(stored.entity_keys, ["drug:semaglutide", "drug:tirzepatide", "trial:select", "org:fda", "disease:heart failure"],
    "a known name keys by its canonical English name, an unknown one as itself");
  assert.deepEqual(stored.entity_keys, await shared.keysForEntities(entities), "the vocabulary computes the same keys from the same names");
  // The pipeline did not need the glossary table to be non-empty to key: with none it keys each name as itself, and still does.
  await database.query("TRUNCATE evimed_frontier.glossary");
  const bare = vocabulary();
  const unseeded = await run("10.1000/unseeded", bare.glossaryStore, "A registry of amyloid cardiomyopathy in older adults");
  assert.deepEqual(unseeded.entity_keys, ["drug:司美格鲁肽", "drug:tirzepatide", "trial:select", "org:美国食品药品监督管理局", "disease:心力衰竭"]);
  assert.deepEqual(await bare.keysForText({ texts: ["司美格鲁肽"] }), [], "while the vocabulary itself tags nothing from an empty glossary");
  for (const [kind, en, zh] of GLOSSARY) {
    await database.query("INSERT INTO evimed_frontier.glossary (kind, term_en, term_zh, keep_original, origin) VALUES ($1,$2,$3,$4,'hand')", [kind, en, zh, en === zh]);
  }
});

// --- the lookup: identifier before entity, published only -------------------------------------

test("frontierItemsMatching: identifier matches first, then entity matches by shared keys; nothing unpublished, withdrawn or from a disabled source", options, async () => {
  await database.query("TRUNCATE evimed_frontier.item_keys, evimed_frontier.items RESTART IDENTITY CASCADE");
  await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region, enabled)
    VALUES ('s-off','Off source','evidence','journal','rss','direct',3,false,'Off','P0','US',false)
    ON CONFLICT (id) DO NOTHING`);
  await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
    VALUES ('s-on','On source','evidence','journal','rss','direct',3,false,'On','P0','US') ON CONFLICT (id) DO NOTHING`);
  /** @param {string} name @param {Record<string, any>} values */
  const insert = async (name, values) => {
    const row = {
      state: "published", source: "s-on", doi: null, pmid: null, registry: [], entities: [], days: 1, keys: [], ...values,
    };
    const timeline = new Date(Date.parse("2026-09-30T00:00:00Z") - row.days * 86_400_000);
    const result = await database.query(`INSERT INTO evimed_frontier.items (public_id, primary_source_id, canonical_url, identity_key, doi, pmid, registry_ids, title_raw,
        lang, lane, source_type, entity_keys, state, published_at, first_seen_at, timeline_at, visible_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'en','evidence','journal',$9,$10,$11,$11,$11,$11) RETURNING id`,
    [`${name}${"x".repeat(12)}`.slice(0, 16).toLowerCase().replace(/[^a-z0-9]/g, "x"), row.source, `https://example.org/${name}`, `url:${createHash("sha256").update(name).digest("hex")}`,
      row.doi, row.pmid, row.registry, `Title ${name}`, row.entities, row.state, timeline]);
    for (const key of row.keys) await database.query("INSERT INTO evimed_frontier.item_keys (key, item_id) VALUES ($1,$2)", [key, result.rows[0].id]);
    return name;
  };
  await insert("doimatch", { doi: "10.1000/a", keys: ["doi:10.1000/a"], entities: ["drug:semaglutide"], days: 3 });
  await insert("pmidmatch", { pmid: "42", keys: ["pmid:42"], days: 2 });
  await insert("registered", { registry: ["NCT01234567"], days: 5 });           // a second milestone of the trial: no item_keys row of its own
  await insert("entityone", { entities: ["drug:semaglutide"], days: 1 });
  await insert("entitytwo", { entities: ["drug:semaglutide", "disease:heart failure"], days: 4 });
  await insert("entityold", { entities: ["drug:semaglutide"], days: 40 });
  await insert("unpublished", { state: "scored", doi: "10.1000/unpub", keys: ["doi:10.1000/unpub"], entities: ["drug:semaglutide"] });
  await insert("withdrawn", { state: "withdrawn", doi: "10.1000/withdrawn", keys: ["doi:10.1000/withdrawn"], entities: ["drug:semaglutide"] });
  await insert("disabled", { source: "s-off", entities: ["drug:semaglutide"], registry: ["NCT01234567"] });
  await insert("elsewhere", { entities: ["drug:metformin"] });

  const names = async (/** @type {any} */ query) => (await frontierItemsMatching(database, query)).map((match) => [match.titleRaw.slice(6), match.matchedBy]);
  const asked = { entityKeys: ["drug:semaglutide", "disease:heart failure"], identifierKeys: ["doi:10.1000/a", "doi:10.1000/unpub", "doi:10.1000/withdrawn", "pmid:42", "reg:NCT01234567"] };
  assert.deepEqual(await names(asked), [
    ["pmidmatch", "identifier"], ["doimatch", "identifier"], ["registered", "identifier"],
    ["entitytwo", "entity"], ["entityone", "entity"], ["entityold", "entity"],
  ], "identifier matches first (newest first), then entity matches (most shared keys first); the unpublished, withdrawn and disabled-source items are not there");
  const full = await frontierItemsMatching(database, asked);
  assert.deepEqual(full.map((match) => [match.matchedIdentifierKeys, match.matchedEntityKeys]), [
    [["pmid:42"], []], [["doi:10.1000/a"], ["drug:semaglutide"]], [["reg:NCT01234567"], []],
    [[], ["disease:heart failure", "drug:semaglutide"]], [[], ["drug:semaglutide"]], [[], ["drug:semaglutide"]],
  ], "each match says which of the keys asked about named it");
  assert.equal(full[0].publicId.length >= 12, true);
  assert.deepEqual([full[1].doi, full[1].pmid, full[2].registryIds], ["10.1000/a", null, ["NCT01234567"]]);
  // The window, the bound, and the keys may come in one list of either kind.
  assert.deepEqual(await names({ ...asked, since: new Date("2026-09-25T12:00:00Z") }), [
    ["pmidmatch", "identifier"], ["doimatch", "identifier"], ["entitytwo", "entity"], ["entityone", "entity"]]);
  assert.deepEqual(await names({ ...asked, limit: 2 }), [["pmidmatch", "identifier"], ["doimatch", "identifier"]]);
  assert.deepEqual(await names({ ...asked, limit: 4 }), [["pmidmatch", "identifier"], ["doimatch", "identifier"], ["registered", "identifier"], ["entitytwo", "entity"]]);
  assert.deepEqual(await names({ entityKeys: [...asked.entityKeys, ...asked.identifierKeys] }), await names(asked));
  assert.deepEqual(await names({ entityKeys: ["drug:tirzepatide"], identifierKeys: ["doi:10.9999/none"] }), []);
  assert.deepEqual(await names({}), []);
  assert.deepEqual(await names({ entityKeys: ["not a key"] }), []);
  await assert.rejects(frontierItemsMatching(database, { entityKeys: ["drug:semaglutide"], since: "yesterday-ish" }), TypeError);
  // The vocabulary's own method is the same lookup, and the off vocabulary's is empty.
  assert.deepEqual((await vocabulary().frontierItemsMatching({ identifierKeys: ["pmid:42"] })).map((match) => match.matchedBy), ["identifier"]);
  assert.deepEqual(await createEntityVocabulary({ database, enabled: false }).frontierItemsMatching({ identifierKeys: ["pmid:42"] }), []);
});

// --- autopilot agendas -------------------------------------------------------------------------

const agendaInput = { title: "Question", topics: ["research"], taskTypes: ["evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: "UTC" };

test("an agenda is tagged when it is made and again when its title or prompt is edited, not when something else is", options, async () => {
  const documents = new ProductDocuments(database);
  const service = new AutopilotService({ documents, jobs: new ProductJobs(database), entityVocabulary: vocabulary() });
  const made = await service.create(alice, { ...agendaInput, projectId: "one", title: "Semaglutide in heart failure", topics: ["semaglutide", "heart failure NCT01234567"], prompt: "Watch the SELECT trial and PMID: 37952131" });
  assert.deepEqual(made.payload.entityKeys, ["disease:heart failure", "drug:semaglutide", "trial:select", "pmid:37952131", "reg:NCT01234567"]);
  assert.deepEqual(service.projectAgenda(made).payload.entityKeys, made.payload.entityKeys, "the existing view carries them");
  const budget = await service.update(alice, made.id, { expectedRevision: made.revision, dailyBudgetCny: 30 });
  assert.deepEqual(budget.payload.entityKeys, made.payload.entityKeys, "an unrelated edit leaves them");
  const retitled = await service.update(alice, made.id, { expectedRevision: budget.revision, title: "Metformin in Alzheimer's disease" });
  assert.deepEqual(retitled.payload.entityKeys, ["disease:alzheimer's disease", "disease:heart failure", "drug:metformin", "drug:semaglutide", "trial:select", "pmid:37952131", "reg:NCT01234567"],
    "the topics and the prompt still name what they named");
  const reprompted = await service.update(alice, made.id, { expectedRevision: retitled.revision, prompt: "Only metformin" });
  assert.deepEqual(reprompted.payload.entityKeys, ["disease:alzheimer's disease", "disease:heart failure", "drug:metformin", "drug:semaglutide", "reg:NCT01234567"]);
  const stored = await documents.get(alice, "agenda", made.id);
  assert.deepEqual(stored.payload.entityKeys, reprompted.payload.entityKeys, "and what is stored is what the edit returned");
});

test("agendas made before the vocabulary could tag are tagged once; another account's agendas are neither read nor written", options, async () => {
  const documents = new ProductDocuments(database);
  const jobs = new ProductJobs(database);
  const legacy = new AutopilotService({ documents, jobs });
  const mine = await legacy.create(alice, { ...agendaInput, projectId: "two", title: "Metformin and the SELECT trial" });
  const mineArchived = await legacy.create(alice, { ...agendaInput, projectId: "two", title: "Archived semaglutide question" });
  await legacy.archive(alice, mineArchived.id, { expectedRevision: mineArchived.revision });
  const theirs = await legacy.create(bob, { ...agendaInput, projectId: "one", title: "Semaglutide for Bob" });
  assert.equal("entityKeys" in mine.payload, false, "no vocabulary, no keys");
  assert.deepEqual(legacy.projectAgenda(mine).payload.entityKeys, [], "and the view says none");
  const before = await documents.get(bob, "agenda", theirs.id);

  const service = new AutopilotService({ documents, jobs, entityVocabulary: vocabulary() });
  const spy = spyOnDatabase(database);
  const pass = await service.backfillEntityKeys(database, { userId: alice, limit: 100 });
  assert.ok(pass.tagged >= 1);
  assert.deepEqual([...spy.accounts].filter((id) => id.startsWith("ent_")), [alice], "the pass read one account's rows and no other's");
  assert.deepEqual((await documents.get(alice, "agenda", mine.id)).payload.entityKeys, ["drug:metformin", "trial:select"]);
  assert.equal("entityKeys" in (await documents.get(alice, "agenda", mineArchived.id)).payload, false, "an archived agenda is left alone");
  const untouched = await documents.get(bob, "agenda", theirs.id);
  assert.deepEqual([untouched.revision, "entityKeys" in untouched.payload], [before.revision, false], "the other account's agenda is as it was");

  // Once: a second pass tags nothing, and only the keys were added to the payload.
  const tagged = await documents.get(alice, "agenda", mine.id);
  assert.equal((await service.backfillEntityKeys(database, { userId: alice })).tagged, 0);
  assert.equal((await documents.get(alice, "agenda", mine.id)).revision, tagged.revision);
  const { entityKeys, ...rest } = tagged.payload;
  assert.deepEqual(rest, mine.payload, "nothing else of the agenda moved");
  assert.deepEqual(entityKeys, ["drug:metformin", "trial:select"]);
  // The pass with no account named reaches Bob's, through Bob's own document.
  await service.backfillEntityKeys(database, { limit: 100 });
  assert.deepEqual((await documents.get(bob, "agenda", theirs.id)).payload.entityKeys, ["drug:semaglutide"]);
});

test("an agenda made while the glossary is empty carries no keys, and is tagged when the glossary arrives", options, async () => {
  const documents = new ProductDocuments(database);
  const rows = (await database.query("SELECT kind, term_en, term_zh, keep_original, origin FROM evimed_frontier.glossary")).rows;
  await database.query("TRUNCATE evimed_frontier.glossary");
  const vocab = vocabulary();
  const service = new AutopilotService({ documents, jobs: new ProductJobs(database), entityVocabulary: vocab });
  const made = await service.create(alice, { ...agendaInput, projectId: "one", title: "Late semaglutide question" });
  assert.equal("entityKeys" in made.payload, false, "an empty [] must not stand for a glossary that was not there");
  for (const row of rows) {
    await database.query("INSERT INTO evimed_frontier.glossary (kind, term_en, term_zh, keep_original, origin) VALUES ($1,$2,$3,$4,$5)", [row.kind, row.term_en, row.term_zh, row.keep_original, row.origin]);
  }
  vocab.registerBackfill("autopilot", ({ limit }) => service.backfillEntityKeys(database, { limit }));
  assert.equal((await vocab.refresh()).entries, rows.length);
  await vocab.backfill();
  assert.deepEqual((await documents.get(alice, "agenda", made.id)).payload.entityKeys, ["drug:semaglutide"]);
});

// --- GEO projects --------------------------------------------------------------------------------

test("a GEO project is tagged from its product at creation and when the product changes; older projects once, each account's own", options, async () => {
  const store = new GeoStore({ database, entityVocabulary: vocabulary() });
  const project = await store.createProject({ userId: alice, projectId: `geo-${randomUUID().slice(0, 8)}`, engines: ["deepseek"], coverageDays: 90,
    product: { brandName: "Wegovy", genericName: "semaglutide", indication: "Heart failure with obesity" } });
  assert.deepEqual(project.entityKeys, ["disease:heart failure", "drug:semaglutide"]);
  const tier = await store.updateProject(alice, project.id, { coverageDays: 60 });
  assert.deepEqual(tier?.entityKeys, project.entityKeys, "a setting that is not the product leaves the keys");
  const changed = await store.updateProject(alice, project.id, { product: { brandName: "Glucophage", genericName: "二甲双胍", indication: "type 2 diabetes" } });
  assert.deepEqual(changed?.entityKeys, ["drug:metformin"]);
  assert.deepEqual((await store.getProject(alice, project.id))?.entityKeys, ["drug:metformin"]);
  assert.deepEqual((await store.listProjects(alice)).find((row) => row.id === project.id)?.entityKeys, ["drug:metformin"]);
  const cleared = await new GeoStore({ database }).updateProject(alice, project.id, { product: { brandName: "Glucophage", genericName: "二甲双胍 XR" } });
  assert.deepEqual(cleared?.entityKeys, [], "a product changed where the vocabulary cannot tag has no keys until it can");
  assert.equal((await database.query("SELECT entity_keys FROM evimed_geo.projects WHERE id = $1", [project.id])).rows[0].entity_keys, null);

  const legacy = new GeoStore({ database });
  const mine = await legacy.createProject({ userId: alice, projectId: `geo-${randomUUID().slice(0, 8)}`, engines: ["deepseek"], coverageDays: 90, product: { genericName: "Alzheimer's disease drug semaglutide" } });
  const theirs = await legacy.createProject({ userId: bob, projectId: `geo-${randomUUID().slice(0, 8)}`, engines: ["deepseek"], coverageDays: 90, product: { genericName: "semaglutide" } });
  const raw = async (/** @type {string} */ id) => (await database.query("SELECT entity_keys, updated_at FROM evimed_geo.projects WHERE id = $1", [id])).rows[0];
  assert.deepEqual([(await raw(mine.id)).entity_keys, (await raw(theirs.id)).entity_keys], [null, null]);
  const bobBefore = await raw(theirs.id);
  const spy = spyOnDatabase(database);
  const pass = await store.backfillEntityKeys({ userId: alice, limit: 100 });
  assert.ok(pass.tagged >= 2, "this account's project, and the one the clearing left");
  assert.deepEqual([...spy.accounts].filter((id) => id.startsWith("ent_")), [alice], "the pass read one account's projects and no other's");
  assert.deepEqual((await raw(mine.id)).entity_keys, ["disease:alzheimer's disease", "drug:semaglutide"]);
  assert.deepEqual(await raw(theirs.id), bobBefore, "the other account's project is as it was");
  assert.equal((await store.backfillEntityKeys({ userId: alice })).tagged, 0, "once");
  await store.backfillEntityKeys({});
  assert.deepEqual((await raw(theirs.id)).entity_keys, ["drug:semaglutide"]);
});

// --- VCR studies ---------------------------------------------------------------------------------

test("a VCR study is tagged from its name, question and definition, again on each edit; older studies once, each account's own", options, async () => {
  const store = new VcrStore({ database, entityVocabulary: vocabulary() });
  const study = await store.createStudy({ userId: alice, projectId: `vcr-${randomUUID().slice(0, 8)}`, name: "Semaglutide external control", question: "Does it help in NCT01234567?" });
  assert.deepEqual(study.entityKeys, ["drug:semaglutide", "reg:NCT01234567"]);
  const renamed = await store.updateStudy(study.id, { question: "Does metformin help instead?" }, alice);
  assert.deepEqual(renamed?.entityKeys, ["drug:metformin", "drug:semaglutide"], "the name still names its drug, the question names another");
  const stepped = await store.setStep(study.id, "definition", { status: "done" });
  assert.deepEqual(stepped?.entityKeys, ["drug:metformin", "drug:semaglutide"], "a step is not an edit");
  const budgeted = await store.updateStudy(study.id, { dataTier: "T0" }, alice);
  assert.deepEqual(budgeted?.entityKeys, ["drug:metformin", "drug:semaglutide"]);
  await store.saveDefinition({ studyId: study.id, userId: alice, pico: { population: "Adults with heart failure and obesity", conditions: ["Alzheimer's disease"], interventions: [{ name: "semaglutide" }], comparator: "placebo" } });
  assert.deepEqual((await store.studyById(study.id))?.entityKeys, ["disease:alzheimer's disease", "disease:heart failure", "drug:metformin", "drug:semaglutide"],
    "a new definition names the disease and the treatment");
  assert.deepEqual((await store.getStudy(alice, study.id))?.entityKeys, (await store.studyById(study.id))?.entityKeys);
  const retitled = await store.updateStudy(study.id, { name: "A study about nothing in the glossary", question: "Is it so?" }, alice);
  assert.deepEqual(retitled?.entityKeys, ["disease:alzheimer's disease", "disease:heart failure", "drug:semaglutide"], "the definition's PICO still counts");

  const legacy = new VcrStore({ database });
  const mine = await legacy.createStudy({ userId: alice, projectId: `vcr-${randomUUID().slice(0, 8)}`, name: "Old study of metformin", question: "" });
  const theirs = await legacy.createStudy({ userId: bob, projectId: `vcr-${randomUUID().slice(0, 8)}`, name: "Bob's study of semaglutide", question: "" });
  assert.deepEqual([mine.entityKeys, theirs.entityKeys], [[], []]);
  const raw = async (/** @type {string} */ id) => (await database.query("SELECT entity_keys, updated_at FROM evimed_vcr.studies WHERE id = $1", [id])).rows[0];
  const bobBefore = await raw(theirs.id);
  const spy = spyOnDatabase(database);
  const pass = await store.backfillEntityKeys({ userId: alice, limit: 100 });
  assert.equal(pass.tagged, 1);
  const selection = spy.statements.find((statement) => /FROM evimed_vcr\.studies/.test(statement.sql) && /entity_keys IS NULL/.test(statement.sql) && /SELECT/.test(statement.sql));
  assert.equal(selection?.values[0], alice, "the pass asked for one account's studies");
  assert.ok(![...spy.accounts].includes(bob), "and read none of the other's");
  assert.deepEqual((await raw(mine.id)).entity_keys, ["drug:metformin"]);
  assert.deepEqual(await raw(theirs.id), bobBefore, "the other account's study is as it was");
  assert.equal((await store.backfillEntityKeys({ userId: alice })).tagged, 0, "once");
  await store.backfillEntityKeys({});
  assert.deepEqual((await raw(theirs.id)).entity_keys, ["drug:semaglutide"]);
});

test("the migrations run on a database that already holds these tables, twice in a row", options, async () => {
  const { migrateGeo } = await import("../src/geoPersistence.mjs");
  const { migrateVcr } = await import("../src/vcrPersistence.mjs");
  await migrateFrontier(database, { dimension: DIMENSION });
  await migrateFrontier(database, { dimension: DIMENSION });
  await new GeoStore({ database }).ready();
  await migrateGeo(database);
  await new VcrStore({ database }).ready();
  await migrateVcr(database);
  const columns = (await database.query(`SELECT table_schema, column_name, data_type, is_nullable FROM information_schema.columns
    WHERE column_name = 'entity_keys' AND table_schema IN ('evimed_geo', 'evimed_vcr') ORDER BY 1`)).rows;
  assert.deepEqual(columns.map((row) => [row.table_schema, row.data_type, row.is_nullable]), [["evimed_geo", "ARRAY", "YES"], ["evimed_vcr", "ARRAY", "YES"]]);
  const index = (await database.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'frontier_items_registry_ids_idx'")).rows[0];
  assert.match(index.indexdef, /gin \(registry_ids\)/);
});
