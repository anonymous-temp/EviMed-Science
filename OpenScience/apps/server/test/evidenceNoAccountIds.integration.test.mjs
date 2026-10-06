// No account id leaves through a public or cross-account response (flywheel review 2026-10-06). The id of a local account is its login
// name, so it must never be an address, a field or a word in anything another person can read. The real hosted app, composed as a
// deployment composes it, against a real PostgreSQL: every public page and API document with no session, the feed and the sitemap, and
// the in-app routes another signed-in account reads (links, author page, community column, zone and card views, topic requests).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { authorHandlesFor } from "../src/evidenceAuthorHandles.mjs";
import { createEvidenceChangeLog } from "../src/evidenceChangeLog.mjs";
import { migrateEvidenceOrigins } from "../src/evidenceOrigins.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-no-account-ids";
const PUBLIC_URL = "https://www.evimed.test";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
/** Login names that are nothing like the display names, so a leak cannot hide as a name. */
const accounts = {
  owner: { id: "login-owner-7q4x", name: "李明" },
  second: { id: "login-second-3k9z", name: "张伟" },
  reader: { id: "login-reader-8m2w", name: "王芳" },
};
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
const KEYS = ["disease:atrial-fibrillation", "drug:apixaban"];
const SIMULATIONS = [{ id: "sim-1", title: "Simulated trial", summary: "A model run.", createdAt: "2026-10-03T00:00:00Z", numbers: [{ label: "Hazard ratio", value: 0.8, valueSource: "predicted" }] }];
/** @type {any} */ let context = null;
/** @type {any} */ let isolated = null;

const card = (/** @type {string} */ title, /** @type {Record<string, any>} */ extra = {}) => ({
  title, subtype: "academic", summary: `${title} 摘要。`, body: "正文", state: "published", limitations: "单项试验", provenance: "p", entityKeys: KEYS,
  sources: [{ title: "试验", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" }],
  content: { question: "能预防卒中吗？", answer: "卒中更少。", population: "成人" },
  claims: [{ claimId: "CLM-001", claimType: "direct", claim: "阿哌沙班组卒中更少。", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" }],
  ...extra,
});

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "noids");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-no-account-ids-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres",
    requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    frontierEnabled: true, frontierAudience: "all", evidencePublicWebEnabled: true, evidencePublicIndexable: true, evidenceCommunityCardsEnabled: true,
    publicUrl: PUBLIC_URL, evidencePublicRatePerMinute: 10_000,
    evidenceSimulations: { list: async () => ({ items: SIMULATIONS, next: null }), get: async (/** @type {string} */ id) => SIMULATIONS.find((entry) => entry.id === id) ?? null },
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")] }).fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  for (const account of Object.values(accounts)) await app.store.createUser(account.id, PASSWORD, account.name);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.tick();
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, account] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: account.id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
});
after(async () => {
  if (!context) return;
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
  await isolated?.drop();
});

/** A public document as an anonymous browser gets it. @param {string} pathname */
const anonymous = async (pathname) => {
  const response = await fetch(`${context.base}${pathname}`, { headers: { "user-agent": BROWSER } });
  return { status: response.status, body: await response.text() };
};
/** An in-app route as one signed-in account reads it. @param {string} role @param {string} pathname */
const signedIn = async (role, pathname) => {
  const response = await fetch(`${context.base}${pathname}`, { headers: context.sessions[role] });
  return { status: response.status, body: await response.text() };
};

test("no account id appears in any public page, API document, feed or sitemap, or in what another signed-in account reads", options, async () => {
  const { app } = context;
  const zones = app.frontier.evidenceZones;
  const owner = { id: accounts.owner.id };
  const second = { id: accounts.second.id };
  const publisher = { id: PLATFORM_PUBLISHER_USER_ID };
  const userZone = async (/** @type {{ id: string }} */ user, /** @type {string} */ title) => {
    const { zone } = await zones.save(user, { title, description: "d", background: "b" });
    const live = (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
    return (await zones.setVisibility(user, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  };
  // The official zone whose community column lists the researchers' cards on the same subject.
  const made = (await zones.saveEditorial(publisher, { title: "房颤抗凝", description: "d", background: "b", kind: "official" }, null, null, false, "programme")).zone;
  const official = (await zones.saveEditorial(publisher, { expectedRevision: made.revision, state: "published" }, made.id, null, false, "programme")).zone;
  const officialCard = (await zones.saveEditorial(publisher, card("官方卡片"), official.id, null, true, "programme")).evidence;
  // An established researcher (three ✓ cards), one of whose cards has been edited since it was written: the receipt names the last editor.
  const zone = await userZone(owner, "李明的专区");
  const cards = [];
  for (const name of ["一", "二", "三"]) cards.push((await zones.saveEditorial(owner, card(`李明的卡片${name}`), zone.id, null, true, "result")).evidence);
  const reviewed = (await zones.saveEditorial(owner, card("李明的修订卡", { editorial: { author: { kind: "human", name: "李明" }, status: "review-pending" } }), zone.id, null, true, "result")).evidence;
  const edited = (await zones.save(owner, { expectedRevision: reviewed.revision, body: "修订后的正文" }, zone.id, reviewed.id)).evidence;
  assert.equal(edited.editorial.lastEditor.userId, accounts.owner.id, "the owner's own view still carries the receipt as stored");
  // Another researcher's card that began from the owner's, a review and a run started from the owner's card: the cross-account links.
  const zoneTwo = await userZone(second, "张伟的专区");
  const follower = (await zones.saveEditorial(second, card("张伟的后续研究", { lineage: { originCardId: cards[0].id } }), zoneTwo.id, null, true, "result")).evidence;
  await zones.act({ id: accounts.reader.id }, zone.id, "follow", { expectedRevision: zone.revision });
  await zones.act({ id: accounts.reader.id }, zone.id, "review", { score: 4, text: "清楚", expectedRevision: cards[0].revision }, cards[0].id);
  await migrateEvidenceOrigins(app.store.database);
  await app.store.database.query("INSERT INTO evimed_frontier.evidence_card_runs(user_id,project_id,run_id,card_id) VALUES($1,'p','r1',$2)", [accounts.reader.id, cards[0].id]);
  await createEvidenceChangeLog({ database: app.store.database }).append({ zoneId: zone.id, cardId: cards[0].id, category: "searched_no_change", trigger: "scheduled_check", facts: {} });
  const handles = await authorHandlesFor(app.store.database, [accounts.owner.id, accounts.second.id, PLATFORM_PUBLISHER_USER_ID]);
  const ownerHandle = /** @type {string} */ (handles.get(accounts.owner.id));
  const publisherHandle = /** @type {string} */ (handles.get(PLATFORM_PUBLISHER_USER_ID));
  const secondHandle = /** @type {string} */ (handles.get(accounts.second.id));
  const filed = await fetch(`${context.base}/api/frontier/evidence/topic-requests`, { method: "POST", headers: context.sessions.reader, body: JSON.stringify({ title: "房颤患者的抗凝选择" }) });
  assert.equal(filed.status, 200);

  const forbidden = [accounts.owner.id, accounts.second.id, accounts.reader.id, PLATFORM_PUBLISHER_USER_ID];
  /** @type {string[]} */
  const leaks = [];
  /** @param {string} label @param {{ status: number, body: string }} answer @param {string[]} [allowed] ids this reader may see (their own) */
  const clean = (label, answer, allowed = []) => {
    assert.ok(answer.status === 200 || answer.status === 410, `${label} answered ${answer.status}`);
    for (const id of forbidden) if (!allowed.includes(id) && answer.body.includes(id)) leaks.push(`${label} carries the account id ${id}`);
  };

  const publicDocuments = [
    "/evidence/", "/evidence/about", "/evidence/metrics", "/evidence/simulations", "/evidence/simulations/sim-1", "/evidence/requests", "/evidence/sitemap.xml",
    "/evidence/feed.json", "/evidence/feed.xml",
    `/evidence/z/${official.id}`, `/evidence/z/${zone.id}`, `/evidence/z/${zone.id}/changes`, `/evidence/z/${zoneTwo.id}`,
    `/evidence/c/${officialCard.id}`, `/evidence/c/${cards[0].id}`, `/evidence/c/${cards[0].id}?view=public`, `/evidence/c/${edited.id}`, `/evidence/c/${follower.id}`,
    `/evidence/a/${ownerHandle}`, `/evidence/a/${publisherHandle}`, `/evidence/a/${secondHandle}`,
    "/evidence/api/v1/zones", `/evidence/api/v1/zones/${zone.id}`, `/evidence/api/v1/zones/${zone.id}/cards`, `/evidence/api/v1/zones/${zone.id}/changes`,
    `/evidence/api/v1/cards/${cards[0].id}`, `/evidence/api/v1/cards/${edited.id}?view=public`, `/evidence/api/v1/cards/${officialCard.id}`, `/evidence/api/v1/metrics`,
    `/evidence/api/v1/authors/${ownerHandle}`, `/evidence/api/v1/authors/${publisherHandle}`,
  ];
  for (const pathname of publicDocuments) clean(pathname, await anonymous(pathname));
  // The sitemap lists the established author's pages: their addresses are handles.
  const sitemap = (await anonymous("/evidence/sitemap.xml")).body;
  assert.ok(sitemap.includes(`/evidence/a/${ownerHandle}`) && sitemap.includes(`/evidence/c/${cards[0].id}`), "the established author is in the sitemap, by handle");

  const inApp = [
    `/api/frontier/evidence/${cards[0].id}/links`, `/api/frontier/evidence/${follower.id}/links`, `/api/frontier/authors/${ownerHandle}`, `/api/frontier/authors/${publisherHandle}`,
    `/api/frontier/zones/${official.id}/community`, "/api/frontier/zones", "/api/frontier/evidence", `/api/frontier/zones/${zone.id}`,
    `/api/frontier/zones/${zone.id}/evidence`, `/api/frontier/zones/${zone.id}/evidence/${cards[0].id}`, `/api/frontier/zones/${zone.id}/evidence/${edited.id}`,
    "/api/frontier/evidence/topic-requests",
  ];
  for (const pathname of inApp) clean(`in-app ${pathname}`, await signedIn("reader", pathname), [accounts.reader.id]);
  assert.deepEqual(leaks, []);

  // The author is the handle everywhere, and an account id is not an address.
  assert.match(ownerHandle, /^au_[a-f0-9]{16}$/);
  assert.equal((await anonymous(`/evidence/a/${accounts.owner.id}`)).status, 404);
  assert.equal((await anonymous(`/evidence/api/v1/authors/${accounts.owner.id}`)).status, 404);
  assert.equal((await signedIn("reader", `/api/frontier/authors/${accounts.owner.id}`)).status, 404);
  const column = JSON.parse((await signedIn("reader", `/api/frontier/zones/${official.id}/community`)).body).data;
  assert.ok(column.items.length > 0 && column.items.every((/** @type {any} */ item) => /^au_[a-f0-9]{16}$/.test(item.author.id)), "the community column signs a card with the handle");
  assert.equal(JSON.parse((await anonymous(`/evidence/api/v1/cards/${cards[0].id}`)).body).data.card.creator.id, ownerHandle);
  // The owner's own reading of the card keeps the receipt as stored; a stranger's does not carry the account in it.
  const asOwner = JSON.parse((await signedIn("owner", `/api/frontier/zones/${zone.id}/evidence/${edited.id}`)).body).data.evidence;
  assert.equal(asOwner.editorial.lastEditor.userId, accounts.owner.id);
  const asReader = JSON.parse((await signedIn("reader", `/api/frontier/zones/${zone.id}/evidence/${edited.id}`)).body).data.evidence;
  assert.deepEqual(Object.keys(asReader.editorial.lastEditor).sort(), ["editedAt", "name"]);
  assert.equal(asReader.editorial.lastEditor.name, accounts.owner.name);
});
