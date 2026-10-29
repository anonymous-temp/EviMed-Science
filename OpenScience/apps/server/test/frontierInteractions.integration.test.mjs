// What the reader's page reports and what each list served, in the real hosted app over HTTP against a real PostgreSQL
// (ct-track 2026-10-24): every list answer's listId and slots and its serve record; the events route — a session, the CSRF
// token in the header or (a closing page's beacon) in a text/plain body, at most 50 events in 64 KiB, idempotent on the
// client's id, drops by reason, a foreign list kept as none, the per-reader minute; onboarding's prefs and the flag; the
// operators' reading figures behind the scrape token.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { insertSource, memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem } from "./helpers/frontierComposeFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const accounts = { reader: `track${suffix}`, other: `other${suffix}`, busy: `busy${suffix}` };
const PASSWORD = "test-only-frontier-password";
const TOKEN = "test-only-metrics-token";
/** @type {any} */ let context = null;
/** @type {any} */ let isolated = null;
const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
let serial = 0;
/** A client event id, as the page makes one. */
const eventId = () => `evt_${suffix}_${String(serial += 1).padStart(6, "0")}`;
const SESSION = `ses_${suffix}`;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "ftrack");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-track-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: TOKEN,
    frontierEnabled: true, frontierAudience: "all", frontierEventsPerMinute: 60,
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")], entries: [] }).fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} } });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, { cookie: string, csrf: string }>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { cookie: String(login.headers.get("set-cookie")).split(";")[0], csrf: body.data.csrfToken };
  }
  const database = app.store.database;
  await insertSource(database, "nejm", { authority: 5 });
  await insertSource(database, "fda", { name: "FDA", lane: "regulatory", source_type: "regulator", authority: 5, owner_entity: "us-fda" });
  const items = {
    picked: await insertComposedItem(database, { sourceId: "nejm", selected: true, title: "Selected trial", scoreTotal: 90, specialties: ["cardiology"],
      visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) }),
    plain: await insertComposedItem(database, { sourceId: "nejm", title: "Plain trial", scoreTotal: 50, visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) }),
    alert: await insertComposedItem(database, { sourceId: "fda", lane: "safety", sourceType: "regulator", safetyAlert: true, selected: true, title: "Recall",
      visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) }),
  };
  context = { app, base, sessions, database, dataDir, items };
});

after(async () => {
  if (context) {
    await context.database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [Object.values(accounts)]);
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  await isolated?.drop();
});

/** @param {string} role @param {Record<string, string>} [extra] */
const headers = (role, extra = {}) => ({ "content-type": "application/json", cookie: context.sessions[role].cookie, "x-open-science-csrf": context.sessions[role].csrf, ...extra });
/** @param {string} role @param {any} events @param {{ beacon?: boolean, csrf?: string | null }} [options] */
async function send(role, events, { beacon = false, csrf } = {}) {
  if (!beacon) return fetch(`${context.base}/api/frontier/events`, { method: "POST", headers: headers(role), body: JSON.stringify({ events }) });
  // What navigator.sendBeacon sends: a text/plain string, the cookie, no custom header — the token in the body.
  const body = { events, ...(csrf === null ? {} : { csrf: csrf ?? context.sessions[role].csrf }) };
  return fetch(`${context.base}/api/frontier/events`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", cookie: context.sessions[role].cookie },
    body: JSON.stringify(body) });
}
const event = (overrides) => ({ id: eventId(), session: SESSION, at: Date.now() - 500, ...overrides });

test("a list answer carries its listId and each entry its slot, and the serve record keeps what was served, in order", options, async () => {
  const { base, database, items } = context;
  const selected = (await (await fetch(`${base}/api/frontier/items?view=selected`, { headers: headers("reader") })).json()).data;
  assert.match(selected.listId, /^[0-9a-f-]{36}$/);
  assert.ok(selected.items.length >= 2 && selected.items.every((item) => item.slot === "editorial"), "精选 is the editor's pick");
  const all = (await (await fetch(`${base}/api/frontier/items?view=all`, { headers: headers("reader") })).json()).data;
  assert.ok(all.items.every((item) => item.slot === null), "a chronological list has no slot");
  assert.notEqual(all.listId, selected.listId);
  const safety = (await (await fetch(`${base}/api/frontier/items?view=all&safety=1&window=3d&limit=50`, { headers: headers("reader") })).json()).data;
  assert.deepEqual(safety.items.map((item) => [item.id, item.slot]), [[items.alert.publicId, "must-see"]]);
  const serve = (await database.query("SELECT user_id, surface, policy, editorial, entries FROM evimed_frontier.list_serves WHERE list_id = $1", [selected.listId])).rows[0];
  assert.deepEqual([serve.user_id, serve.surface, serve.policy], [accounts.reader, "feed", "feed:selected:timeline"]);
  assert.match(serve.editorial, /threshold:64$/, "the default line (c3-select 2026-10-25: 64, was 82)");
  assert.deepEqual(serve.entries.map((entry) => entry.item), selected.items.map((item) => item.id), "in the order served");
  assert.equal(serve.entries[0].slot, "editorial");
  const kinds = (await database.query("SELECT surface, policy FROM evimed_frontier.list_serves WHERE list_id = ANY($1::uuid[]) ORDER BY surface", [[all.listId, safety.listId]])).rows;
  assert.deepEqual(kinds.map((row) => [row.surface, row.policy]), [["feed", "feed:all:timeline"], ["safety", "safety:time"]]);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.exposure_snapshots")).rows[0].n, 0, "no exposure snapshot is issued any more");
});

test("events: an impression and an open join their list, idempotent on the client's id; what is not the vocabulary is dropped by reason", options, async () => {
  const { base, database, items } = context;
  const list = (await (await fetch(`${base}/api/frontier/items?view=selected`, { headers: headers("reader") })).json()).data;
  const impression = event({ type: "impression", surface: "feed", item: items.picked.publicId, list: list.listId, slot: "editorial", position: 1, value: 1_200, device: "wide" });
  const open = event({ type: "open", surface: "feed", item: items.picked.publicId, list: list.listId, slot: "editorial", position: 1, view: `view_${suffix}_1` });
  const first = await send("reader", [impression, open,
    event({ type: "scroll", surface: "feed" }),
    event({ type: "open", surface: "feed", item: "zzzzzzzzzzzzzzzz" }),
    { ...impression }]);
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).data, { accepted: 2, duplicates: 1, dropped: { "unknown-type": 1, "unknown-item": 1 } });
  const again = await send("reader", [impression, open]);
  assert.deepEqual((await again.json()).data, { accepted: 0, duplicates: 2, dropped: {} }, "a batch retried after a lost answer inserts nothing twice");
  const rows = (await database.query(`SELECT type, surface, list_id::text AS list_id, slot, position, value, genre, device, view_id FROM evimed_frontier.interactions
    WHERE user_id = $1 ORDER BY id`, [accounts.reader])).rows;
  assert.deepEqual(rows.map((row) => [row.type, row.list_id === list.listId, row.slot, row.position, row.genre, row.device]),
    [["impression", true, "editorial", 1, "paper", "wide"], ["open", true, "editorial", 1, "paper", null]], "the item's genre at the time is written with it");
  assert.equal(rows[1].view_id, `view_${suffix}_1`);
  // Another reader's list id joins nothing: the event is kept, its list is none.
  const foreign = await send("other", [event({ type: "open", surface: "feed", item: items.plain.publicId, list: list.listId, slot: "editorial", position: 0 })]);
  assert.deepEqual((await foreign.json()).data.accepted, 1);
  const kept = (await database.query("SELECT list_id, slot FROM evimed_frontier.interactions WHERE user_id = $1", [accounts.other])).rows;
  assert.deepEqual(kept, [{ list_id: null, slot: null }]);
});

test("events: a beacon's text/plain body with its token is the same request; without the token, or with another, it is refused", options, async () => {
  const { database, items } = context;
  const view = `view_${suffix}_beacon`;
  const beacon = await send("reader", [event({ type: "dwell", surface: "reader", item: items.picked.publicId, view, value: 42_000 }),
    event({ type: "reach-end", surface: "reader", item: items.picked.publicId, view })], { beacon: true });
  assert.equal(beacon.status, 200);
  assert.equal((await beacon.json()).data.accepted, 2);
  assert.equal((await database.query("SELECT sum(value)::integer AS dwell FROM evimed_frontier.interactions WHERE view_id = $1", [view])).rows[0].dwell, 42_000);
  assert.equal((await send("reader", [event({ type: "reach-end", surface: "reader", item: items.picked.publicId, view })], { beacon: true, csrf: null })).status, 403);
  assert.equal((await send("reader", [event({ type: "reach-end", surface: "reader", item: items.picked.publicId, view })], { beacon: true, csrf: context.sessions.other.csrf })).status, 403);
  const anonymous = await fetch(`${context.base}/api/frontier/events`, { method: "POST", headers: { "content-type": "text/plain" },
    body: JSON.stringify({ events: [event({ type: "filter-change", surface: "feed", detail: "view" })], csrf: "guess" }) });
  assert.equal(anonymous.status, 401);
});

test("events: at most 50 in 64 KiB, no field but the events and the token, and a reader's minute is bounded", options, async () => {
  const many = Array.from({ length: 51 }, () => event({ type: "filter-change", surface: "feed", detail: "view" }));
  const tooMany = await send("reader", many);
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).code, "frontier_events_invalid");
  const huge = await fetch(`${context.base}/api/frontier/events`, { method: "POST", headers: headers("reader"),
    body: JSON.stringify({ events: [event({ type: "filter-change", surface: "feed", detail: "view" })], pad: "x".repeat(70_000) }) });
  assert.equal(huge.status, 413);
  const extra = await fetch(`${context.base}/api/frontier/events`, { method: "POST", headers: headers("reader"),
    body: JSON.stringify({ events: [event({ type: "filter-change", surface: "feed", detail: "view" })], url: "https://example.org/?q=private" }) });
  assert.equal(extra.status, 400);
  // The busy reader's minute is 60 events (frontierEventsPerMinute): the second batch of 50 would pass it.
  assert.equal((await send("busy", Array.from({ length: 50 }, () => event({ type: "filter-change", surface: "feed", detail: "tag" })))).status, 200);
  const limited = await send("busy", Array.from({ length: 20 }, () => event({ type: "filter-change", surface: "feed", detail: "tag" })));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "frontier_events_rate_limited");
  assert.equal((await context.database.query("SELECT count(*)::integer AS n FROM evimed_frontier.interactions WHERE user_id = $1", [accounts.busy])).rows[0].n, 50,
    "nothing of a refused batch is kept");
});

test("onboarding: prefs read empty, a wrong answer is refused, an answer is kept and drops the cached ranking; 与我相关 serves its list with slots", options, async () => {
  const { base, database } = context;
  const empty = (await (await fetch(`${base}/api/frontier/prefs`, { headers: headers("other") })).json()).data;
  assert.deepEqual(empty, { role: null, specialties: [], interests: [], onboardedAt: null, skippedAt: null, interestTags: [] });
  const put = (body) => fetch(`${base}/api/frontier/prefs`, { method: "PUT", headers: headers("other"), body: JSON.stringify(body) });
  for (const [body, why] of [[{ role: "astronaut" }, "a role outside the roles"], [{ specialties: ["cardiology", "oncology", "neurology", "dermatology"] }, "four specialties"],
    [{ specialties: ["not-a-specialty"] }, "an unknown specialty"], [{ done: true }, "finishing with no specialty"], [{ interests: ["no-such-tag"] }, "an interest that is no tag"],
    [{ done: true, skipped: true, specialties: ["cardiology"] }, "finished and skipped at once"], [{ favourite: "x" }, "a field it does not name"]]) {
    const refused = await put(body);
    assert.equal(refused.status, 400, why);
  }
  const saved = (await (await put({ role: "pharmacist", specialties: ["cardiology", "surgery-anesthesia"], interests: ["drug:empagliflozin"], done: true })).json()).data;
  assert.equal(saved.role, "pharmacist");
  assert.deepEqual(saved.specialties, ["cardiology", "general-surgery"], "a retired specialty is kept as its successor");
  assert.deepEqual(saved.interests, ["drug:empagliflozin"]);
  assert.ok(saved.onboardedAt && saved.skippedAt === null);
  const row = (await database.query("SELECT role, specialties, onboarded_at FROM evimed_frontier.user_prefs WHERE user_id = $1", [accounts.other])).rows[0];
  assert.equal(row.role, "pharmacist");
  // The deployment has no model, so the block is off here — the prefs are kept all the same (frontierProfiles.integration has the ranking).
  const forYou = (await (await fetch(`${base}/api/frontier/for-you`, { headers: headers("other") })).json()).data;
  assert.equal(forYou.state, "off");
});

test("the operators' reading figures: behind the token, a window of days, click-through by slot and position, dwell and return", options, async () => {
  const { base } = context;
  assert.equal((await fetch(`${base}/api/ops/frontier-reading`)).status, 401);
  const answer = await fetch(`${base}/api/ops/frontier-reading?days=3`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(answer.status, 200);
  const { data } = await answer.json();
  assert.equal(data.days.length, 3);
  assert.deepEqual(data.partsMissing, []);
  const today = data.days[0];
  assert.ok(today.activity.impressions >= 1 && today.activity.opens >= 1);
  assert.deepEqual(data.clickThrough.slot.find((row) => row.key === "editorial"), { key: "editorial", impressions: 1, opens: 1, ctr: 1 });
  assert.deepEqual(data.clickThrough.position.map((row) => row.key), ["1"]);
  assert.ok(data.dwell.views >= 1 && data.dwell.reachedEnd >= 1, "the beacon's view reached the end");
  assert.equal(today.return.d1, null, "today's readers cannot have come back tomorrow yet");
  for (const days of ["0", "171", "x"]) assert.equal((await fetch(`${base}/api/ops/frontier-reading?days=${days}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 400, days);
  const scrape = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
  assert.match(scrape, /^open_science_frontier_reading_snapshot 1$/m);
  assert.match(scrape, /^open_science_frontier_events_total\{outcome="accepted"\} \d+$/m);
  assert.match(scrape, /^open_science_frontier_events_total\{outcome="unknown-type"\} [1-9]\d*$/m);
  assert.match(scrape, /^open_science_frontier_reading_impressions_7d_by_slot\{slot="editorial"\} 1$/m);
  for (const line of scrape.split("\n").filter((entry) => entry.startsWith("open_science_frontier_reading_") || entry.startsWith("open_science_frontier_events_"))) {
    assert.doesNotMatch(line, /user|account|track|session/, line);
  }
});

test("a hide carries its reason over HTTP, and the operator reads the sources readers called low in quality or promotional — never a reader (c2-hide)", options, async () => {
  const { base, database } = context;
  await insertSource(database, "flagsrc", { name: "Flagged Source", source_type: "media" });
  const flagged = [];
  for (let index = 0; index < 3; index += 1) {
    flagged.push(await insertComposedItem(database, { sourceId: "flagsrc", selected: true, title: `Flagged ${index}`, scoreTotal: 60, visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) }));
  }
  const hide = (role, item, body) => fetch(`${base}/api/frontier/items/${item.publicId}/hide`, { method: "POST", headers: headers(role), body: JSON.stringify(body) });
  // The card hides at once with no body, then says why a moment later; the reason lands on the hide that stands.
  assert.equal((await hide("reader", flagged[0], {})).status, 200);
  const stored = async (role, item) => (await database.query("SELECT hidden_reason FROM evimed_frontier.user_state WHERE user_id = $1 AND item_id = $2",
    [accounts[role], item.id])).rows[0]?.hidden_reason;
  assert.equal(await stored("reader", flagged[0]), null);
  const answer = await hide("reader", flagged[0], { reason: "low-quality" });
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).data, { state: { starred: false, hidden: true, read: false } }, "the answer is the state, as it was");
  assert.equal(await stored("reader", flagged[0]), "low-quality");
  const refused = await hide("reader", flagged[1], { reason: "boring" });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "frontier_payload_invalid");
  assert.equal(await stored("reader", flagged[1]), undefined, "a refused hide hid nothing");
  assert.equal((await hide("reader", flagged[1], { reason: "promotional" })).status, 200);
  assert.equal((await hide("other", flagged[0], { reason: "promotional" })).status, 200);
  assert.equal((await hide("other", flagged[2], { reason: "source" })).status, 200);
  assert.equal((await hide("busy", flagged[2], { reason: "already-seen" })).status, 200);
  const ops = (await (await fetch(`${base}/api/ops/frontier-reading?days=3`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).data;
  assert.deepEqual(ops.partsMissing, []);
  assert.deepEqual(ops.flaggedSources, { days: 30, sources: [{ source: "flagsrc", name: "Flagged Source", lowQuality: 1, promotional: 2, readers: 2 }] },
    "per source, over thirty days: the two reasons that are about the source, and how many readers said so; the other reasons are not counted");
  // Undone, the reason goes with the hide and out of the count.
  assert.equal((await fetch(`${base}/api/frontier/items/${flagged[0].publicId}/unhide`, { method: "POST", headers: headers("reader"), body: "{}" })).status, 200);
  assert.equal(await stored("reader", flagged[0]), null);
  const after = (await (await fetch(`${base}/api/ops/frontier-reading?days=3`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).data;
  assert.deepEqual(after.flaggedSources.sources.map((row) => [row.lowQuality, row.promotional, row.readers]), [[0, 2, 2]]);
  // A reader's own pages say nothing of reasons: not in an item, a list, nor the state the action returned.
  const list = await (await fetch(`${base}/api/frontier/items?view=all&limit=50`, { headers: headers("other") })).text();
  assert.doesNotMatch(list, /hidden_?[rR]eason|low-quality|promotional|flagged/);
});
