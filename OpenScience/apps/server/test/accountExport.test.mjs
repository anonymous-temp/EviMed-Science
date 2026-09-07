import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REFERENCE_PRICE_LIST, priceUsage } from "@evimed/domain";
import {
  UNEXPORTED_ACCOUNT_TABLES,
  accountExportTables,
  exportPluginDocumentRow,
  exportedPriceLists,
  projectPluginDocumentIds,
  withAccountExportSnapshot,
} from "../src/accountExport.mjs";
import { PLUGIN_ID, PLUGIN_REGISTRY, PLUGIN_SUPPORT_SNAPSHOT, pluginEntry, pluginRegistryFrom, projectPluginId } from "../src/pluginService.mjs";

// Offline coverage for the parts of the account export that need no database:
// the price lists an archive has to carry, or the customer's copy of their
// spending points at versions only this repository can resolve; the plugin
// documents it may carry; and which tables it reads at all.
// `accountExport.integration.test.mjs` covers the PostgreSQL half.

const current = REFERENCE_PRICE_LIST.version;

test("the export carries one price list per version its usage rows name", () => {
  const lists = exportedPriceLists([
    { priceVersion: current }, { priceVersion: current }, { priceVersion: "evimed-reference-1999-01-01" }, {},
  ]);
  assert.deepEqual(Object.keys(lists).sort(), ["evimed-reference-1999-01-01", current].sort());
  assert.deepEqual(lists[current], REFERENCE_PRICE_LIST);
  assert.equal(lists[current].effectiveFrom, REFERENCE_PRICE_LIST.effectiveFrom);
  // A version this deployment can no longer resolve is stated as null rather
  // than dropped: a missing key reads as "no price list existed", and null is
  // the true statement — the row names one this platform no longer holds.
  assert.equal(lists["evimed-reference-1999-01-01"], null);
  assert.deepEqual(Object.keys(exportedPriceLists([])), []);
});

test("a price version named after an Object.prototype member is exported like any other", () => {
  // `priceVersion` comes out of a database column, so these names are reachable.
  // On a plain object literal "toString" tests as already collected and is
  // dropped, and "__proto__" never becomes a key at all — a usage row whose
  // price version the archive silently omits.
  const names = ["toString", "constructor", "__proto__", "hasOwnProperty"];
  const lists = exportedPriceLists([...names, ...names].map((priceVersion) => ({ priceVersion })));
  assert.deepEqual(Object.keys(lists).sort(), [...names].sort());
  for (const name of names) assert.equal(lists[name], null, `${name} was dropped from the export`);
  // And it survives the serialization the archive actually ships as.
  const roundTripped = JSON.parse(JSON.stringify({ priceLists: lists })).priceLists;
  assert.deepEqual(Object.keys(roundTripped).sort(), [...names].sort());
});

/** What this double claims one query's rows weigh. Small on purpose: the budget
 * test below needs the pre-flight sum to stay under the assembled buffer, or it
 * would be measuring the pre-flight refusal instead of the one it names. */
const PREFLIGHT_ROW_BYTES = 32;

/** A database double: enough PostgreSQL shape for the snapshot assembly, no more.
 * @param {any[]} usage */
function fakeDatabase(usage, documents = [], feedbackEvents = []) {
  const database = {
    /** @type {string[]} */ queries: [],
    /** What its pre-flight has reported in total — accumulated as it answers,
     * so adding a query cannot quietly turn the budget assertion into one that
     * holds no matter what. */
    preflightBytes: 0,
    /** @param {(client:any) => Promise<any>} operation */
    transaction: (operation) => operation({ query: (/** @type {string} */ text, /** @type {any[]} */ values) => database.query(text, values) }),
    /** @param {string} text @param {any[]} [values] */
    async query(text, values = []) {
      database.queries.push(text);
      if (text.startsWith("SELECT count(*)")) {
        database.preflightBytes += PREFLIGHT_ROW_BYTES;
        return { rows: [{ rows: "1", bytes: String(PREFLIGHT_ROW_BYTES) }], rowCount: 1 };
      }
      if (text.includes("FROM evimed_control.users")) {
        return { rowCount: 1, rows: [{ id: values[0], name: "Owner", accountCreatedAt: "2026-09-06 00:00:00+00", sameGeneration: true, snapshotAt: "2026-09-06T00:00:00.000Z" }] };
      }
      if (text.includes("FROM evimed_usage.model_requests")) return { rows: usage, rowCount: usage.length };
      if (text.includes("FROM evimed_product.feedback_events")) return { rows: feedbackEvents, rowCount: feedbackEvents.length };
      if (text.startsWith("SELECT id,kind")) return { rows: documents, rowCount: documents.length };
      return { rows: [], rowCount: 0 };
    },
  };
  return database;
}


test("an exported account snapshot resolves the price versions of its own usage rows", async () => {
  const database = fakeDatabase([
    { id: "usage-1", priceVersion: current, currency: "CNY", actualCost: "0.25000000" },
    { id: "usage-2", priceVersion: "evimed-reference-1999-01-01", currency: "CNY", actualCost: "0.10000000" },
  ]);
  const user = { id: "user-1", accountCreatedAt: "2026-09-06 00:00:00+00" };
  const state = await withAccountExportSnapshot(database, user, {}, async (snapshot) => JSON.parse(snapshot.data.toString()));
  assert.ok(database.queries.some((text) => text.includes("FROM evimed_usage.model_requests")), "the usage rows were never read");
  assert.equal(state.version, 1);
  assert.equal(state.usage.length, 2);
  for (const row of state.usage) assert.ok(row.priceVersion in state.priceLists, `${row.priceVersion} is unresolvable from the export`);
  assert.deepEqual(state.priceLists[current], JSON.parse(JSON.stringify(REFERENCE_PRICE_LIST)));
  assert.equal(state.priceLists["evimed-reference-1999-01-01"], null);
  // How far "self-contained" actually goes: a reader of this archive can price
  // the rows whose lists it carries, and gets a refusal — not a number — for
  // the row naming a version this deployment no longer holds.
  const metered = { resourceType: "model", model: "deepseek-v4-pro", cacheMiss: 1_000_000, output: 1_000_000, peak: true };
  const resolved = priceUsage(metered, state.priceLists[current]);
  assert.equal(resolved.priced, true);
  assert.ok(resolved.cost > 0);
  assert.deepEqual(priceUsage(metered, state.priceLists["evimed-reference-1999-01-01"]), { cost: 0, priced: false, currency: "" });
});

test("the archive byte budget is what bounds the price lists the state carries", async () => {
  const usage = [{ id: "usage-1", priceVersion: current, currency: "CNY", actualCost: "0.25000000" }];
  const user = { id: "user-1", accountCreatedAt: "2026-09-06 00:00:00+00" };
  const sized = fakeDatabase(usage);
  const full = await withAccountExportSnapshot(sized, user, {}, async (snapshot) => snapshot.data.length);
  const listBytes = JSON.stringify(exportedPriceLists(usage)).length;
  assert.ok(listBytes > 200 && listBytes < full, "the price lists are a real part of the assembled state");
  // The pre-flight count above never sees this key: it counts database rows and
  // their bytes. What refuses an over-budget archive is the measurement of the
  // assembled buffer, which the price lists are inside.
  assert.ok(full - 1 > sized.preflightBytes, "the pre-flight byte count, not the assembled buffer, would be doing the refusing");
  await assert.rejects(
    withAccountExportSnapshot(fakeDatabase(usage), user, {}, async () => "the over-budget archive was handed out", { maxBytes: full - 1 }),
    (/** @type {any} */ error) => error.status === 413 && error.code === "archive_too_large",
  );
  assert.equal(await withAccountExportSnapshot(fakeDatabase(usage), user, {}, async (snapshot) => snapshot.data.length, { maxBytes: full }), full);
});

test("an account with no metered usage exports no price lists", async () => {
  const database = fakeDatabase([]);
  const state = await withAccountExportSnapshot(database, { id: "user-1", accountCreatedAt: "2026-09-06 00:00:00+00" }, {}, async (snapshot) => JSON.parse(snapshot.data.toString()));
  assert.deepEqual(state.priceLists, {});
});

// --- the feedback ledger, and the tables the archive is allowed to miss -----
// `evimed_product.feedback_events` is user-scoped customer data in a table with
// no delete path: what the researcher decided about their own memories and
// deliverables, kept forever. It was added and simply not exported, and nothing
// failed — the completeness guard covers `documents` KINDS, not tables.

test("the archive carries the account's own feedback ledger", async () => {
  const events = [{
    id: "feedback:memory-rejected:0123456789abcdef0123456789abcdef", projectId: "one", runId: null,
    trigger: "memory-rejected", subjectType: "memory-record", subjectId: "record_1",
    detail: { key: "response.evidence_depth", kind: "preference", version: 4, reason: "deleted" },
    occurredAt: "2026-09-06T00:00:00.000Z", recordedAt: "2026-09-06T00:00:01.000Z",
  }];
  const user = { id: "user-1", accountCreatedAt: "2026-09-06 00:00:00+00" };
  const database = fakeDatabase([], [], events);
  const state = await withAccountExportSnapshot(database, user, {}, async (snapshot) => JSON.parse(snapshot.data.toString()));
  assert.ok(database.queries.some((text) => text.includes("FROM evimed_product.feedback_events")), "the feedback ledger was never read");
  assert.deepEqual(state.feedbackEvents, events);
  // Carrying a new key is additive, so the contract version does not move.
  assert.equal(state.version, 1);
  // And an account that decided nothing exports an empty list, not a missing key.
  const empty = await withAccountExportSnapshot(fakeDatabase([]), user, {}, async (snapshot) => JSON.parse(snapshot.data.toString()));
  assert.deepEqual(empty.feedbackEvents, []);
});

/** The migration modules, read as the text they are. */
const migrationSources = ["controlPlaneDatabase.mjs", "productPersistence.mjs", "notificationPersistence.mjs", "usagePersistence.mjs"];

/** Every table the migrations create, mapped to whether it is account-scoped.
 * Read as source text because that is what a migration is here: one template
 * literal per module, with `${schema}` its only substitution. */
function migratedTables() {
  /** @type {Map<string, boolean>} */
  const tables = new Map();
  for (const name of migrationSources) {
    const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8").replaceAll("${schema}", "evimed_control");
    for (const [, table, body] of text.matchAll(/CREATE TABLE IF NOT EXISTS\s+([\w.]+)\s*\(([\s\S]*?)\n\);/g)) {
      tables.set(table, /^\s*user_id\s/m.test(body));
    }
  }
  return tables;
}

test("the exported table list is derived from the queries, joins included", () => {
  assert.deepEqual(accountExportTables([["x", `SELECT 1 FROM evimed_x.one o
    JOIN evimed_x.two t ON (t.user_id)=(o.user_id) WHERE o.user_id=$1`]]), ["evimed_x.one", "evimed_x.two"]);
  // The real list, including the join the revisions query makes.
  const exported = accountExportTables();
  for (const table of ["evimed_control.projects", "evimed_control.research_sessions", "evimed_product.documents",
    "evimed_product.revisions", "evimed_product.feedback_events", "evimed_inbox.notifications",
    "evimed_inbox.preferences", "evimed_usage.model_requests"]) {
    assert.ok(exported.includes(table), `${table} is not read by any export query`);
  }
  assert.equal(exported.length, 8, `the export reads ${exported.join(", ")}`);
});

test("every account-scoped table is either exported or declared unexported with a reason", () => {
  const tables = migratedTables();
  // The scan has to prove it scanned: a regex that matched nothing would make
  // every loop below vacuously true and this guard permanently green.
  assert.ok(tables.size >= 18, `the migration scan found only ${tables.size} tables`);
  for (const anchor of ["evimed_control.users", "evimed_product.documents", "evimed_product.feedback_events", "evimed_usage.model_requests"]) {
    assert.ok(tables.has(anchor), `${anchor} was never seen by the scan`);
  }
  assert.equal(tables.get("evimed_product.documents"), true, "a table with a user_id column is account-scoped");
  assert.equal(tables.get("evimed_product.maintenance_lease"), false, "a table without one is not");

  const exported = accountExportTables();
  const accountScoped = [...tables].filter(([, scoped]) => scoped).map(([table]) => table);
  assert.ok(accountScoped.length >= 13, `only ${accountScoped.length} account-scoped tables were recognized`);
  for (const table of accountScoped) {
    assert.ok(exported.includes(table) || Object.hasOwn(UNEXPORTED_ACCOUNT_TABLES, table),
      `${table} holds account-scoped data and the export neither carries it nor says why it does not`);
  }
  // The declaration is exclusive, and it is about real tables: an entry that
  // named nothing, or named something the export already carries, would let a
  // genuinely missing table hide behind it.
  for (const [table, reason] of Object.entries(UNEXPORTED_ACCOUNT_TABLES)) {
    assert.equal(tables.get(table), true, `${table} is declared unexported but is not an account-scoped table`);
    assert.ok(!exported.includes(table), `${table} is declared unexported and is exported`);
    assert.ok(reason.length > 30, `${table} is left out without a stated reason`);
  }
  // `evimed_control.users` is the account itself and carries no user_id column,
  // so the scan does not ask about it; the snapshot's own locking SELECT is
  // what exports it, as `state.account`.
  assert.equal(tables.get("evimed_control.users"), false);
});

// --- the plugin documents the archive carries -----------------------------
// The archive used to compare every stored plugin document against
// `projectPluginId(row.projectId)` — dsh-cite's id and nothing else — so a
// second registered bundle's configuration would not merely have been missing
// from the customer's own copy of their data: it would have been read as an
// unsupported identity and refused the whole export with a 503.

const twoPlugins = pluginRegistryFrom(
  { communityToolBundles: [...PLUGIN_SUPPORT_SNAPSHOT.communityToolBundles, { name: "dsh-notes", version: "1.0.0", status: "installed" }] },
  new Set([PLUGIN_ID, "dsh-notes"]),
);
/** @param {string} pluginId @param {any} registry */
function pluginRow(pluginId, registry = PLUGIN_REGISTRY, id = `project:one:${pluginId}`) {
  return {
    id, kind: "plugin", projectId: "one", revision: 2,
    payload: { schemaVersion: 1, pluginId, binaryVersion: pluginEntry(pluginId, registry).version, enabled: true, settings: pluginId === PLUGIN_ID ? { timeoutMs: 4000 } : {} },
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z", deletedAt: null,
  };
}

test("the archive names one document per registered plugin, and dsh-cite's is the id it always was", () => {
  assert.ok(PLUGIN_REGISTRY.size >= 1, "an empty registry would make every assertion below vacuous");
  assert.deepEqual(projectPluginDocumentIds("one"), [...PLUGIN_REGISTRY.keys()].map((id) => `project:one:${id}`));
  assert.ok(projectPluginDocumentIds("one").includes(projectPluginId("one")), "dsh-cite's document must still be one of them");
  assert.deepEqual(projectPluginDocumentIds("one", twoPlugins), ["project:one:dsh-cite", "project:one:dsh-notes"]);
});

test("a second registered plugin's configuration is carried, not refused as an unsupported identity", () => {
  const notes = pluginRow("dsh-notes", twoPlugins);
  // The rule that used to run: dsh-cite's id or nothing.
  assert.throws(() => exportPluginDocumentRow(notes), { status: 503, code: "account_export_unsupported_state" });
  assert.deepEqual(exportPluginDocumentRow(notes, twoPlugins), notes, "a registered bundle's document belongs in the customer's archive");
  // And registering a second bundle changes nothing about the first.
  const cite = pluginRow(PLUGIN_ID);
  assert.deepEqual(exportPluginDocumentRow(cite), cite);
  assert.deepEqual(exportPluginDocumentRow(cite, twoPlugins), cite);
});

test("a plugin document whose id and payload name different bundles is refused", () => {
  // With one registered plugin the id comparison implied this; with two it
  // does not, and the export would hand back one bundle's settings under
  // another bundle's name.
  const crossed = { ...pluginRow("dsh-notes", twoPlugins), id: "project:one:dsh-cite" };
  assert.throws(() => exportPluginDocumentRow(crossed, twoPlugins), { status: 503, code: "account_export_unsupported_state" });
  for (const broken of [
    { ...pluginRow(PLUGIN_ID), projectId: null },
    { ...pluginRow(PLUGIN_ID), id: "project:other:dsh-cite" },
    { ...pluginRow(PLUGIN_ID), payload: { ...pluginRow(PLUGIN_ID).payload, token: "private" } },
  ]) assert.throws(() => exportPluginDocumentRow(broken), { status: 503, code: "account_export_unsupported_state" });
});

test("an exported snapshot really routes its plugin documents through that rule", async () => {
  const user = { id: "user-1", accountCreatedAt: "2026-09-06 00:00:00+00" };
  const cite = pluginRow(PLUGIN_ID);
  const state = await withAccountExportSnapshot(fakeDatabase([], [cite]), user, {}, async (snapshot) => JSON.parse(snapshot.data.toString()));
  assert.equal(state.documents.length, 1, "the plugin document was never read");
  assert.deepEqual(state.documents[0], cite);
  // A document the control plane cannot name still refuses the archive rather
  // than shipping an identity nothing in the product wrote.
  await assert.rejects(
    withAccountExportSnapshot(fakeDatabase([], [{ ...cite, id: "project:one:dsh-browse" }]), user, {}, async () => "shipped"),
    { status: 503, code: "account_export_unsupported_state" },
  );
});
