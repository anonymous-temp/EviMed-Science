// The recording of the platform's evidence feed that the knowledge-source plugin's tests replay (flywheel F09).
//
// The plugin reads this feed like any other publisher's, and its adapter tests replay recorded answers. The other
// publishers' answers were recorded off the wire; this one has no upstream but this code, so the recording is made by
// the producer itself: the real `createEvidenceFeed` over a seeded database, written exactly as the route writes it.
// It is deterministic (requested ids, fixed times), so `evidenceFeed.integration.test.mjs` regenerates it and holds
// the plugin's copy equal to what the feed builds today — a change to the feed's shape fails there until the plugin's
// recording is made again:
//
//   OPEN_SCIENCE_TEST_POSTGRES_URL=postgresql://… node apps/server/test/helpers/evidenceFeedFixture.mjs --write
//
// Hidden knowledge: the seed is three cards that cover what the plugin must read — an interpretation of a trial (it
// names the trial's registry number and DOI), a recalculation (first-hand, about a published study) and a
// researcher's original research — and nothing else in the feed, so that the fixture stays small enough to read. (The
// researcher's three standing cards sit in a zone that is not open to the internet, which is what gives their author the
// standing the feed asks of a researcher.)

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneDatabase } from "../../src/controlPlaneDatabase.mjs";
import { createEvidenceFeed } from "../../src/evidenceFeed.mjs";
import { EvidenceZoneService } from "../../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./geoTestDatabase.mjs";

export const FEED_FIXTURE_PUBLIC_URL = "https://www.evimed.test";
export const FEED_FIXTURE_NOW = "2026-10-05T08:00:00.000Z";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Where the plugin keeps its copy of the recording. */
export const PLUGIN_FIXTURE_DIR = path.resolve(HERE, "../../../../../项目代码/knowledge-plugin/tests/fixtures/json-api/evimed-evidence");

const TEXT = "In this randomized trial, 7 of 100 adults on the drug had a stroke and 12 of 100 on usual care did.";
const sources = (url, title) => [{ title, url, excerpt: TEXT, documentText: `${TEXT} A passage that is never sent.`, coverage: "full-text" }];
const card = (requestId, title, answer, extra) => ({
  requestId, title, subtype: "academic", summary: answer, body: answer, state: "published", limitations: "单项研究。", provenance: "p",
  content: { question: title, answer }, ...extra,
});
const TIMES = {
  brief: "2026-10-03T02:00:00.000Z",
  recalculation: "2026-10-04T05:30:00.000Z",
  research: "2026-10-04T09:15:00.000Z",
};

/**
 * Seed three cards into a database and build the feed's first page, byte for byte as the route writes it.
 * @param {any} database a migrated frontier database with the three accounts below
 */
export async function recordEvidenceFeed(database) {
  const zones = new EvidenceZoneService({ database, platformPublisherUserId: "publisher" });
  const publisher = { id: "publisher" };
  const alice = { id: "alice" };
  const official = (await zones.saveEditorial(publisher, { requestId: "feed-fixture-official", title: "房颤抗凝", description: "房颤患者的抗凝证据", background: "平台维护", kind: "official" }, null, null, false, "programme")).zone;
  await zones.saveEditorial(publisher, { expectedRevision: official.revision, state: "published" }, official.id, null, false, "programme");
  const brief = (await zones.saveEditorial(publisher, card("feed-fixture-brief", "阿哌沙班在房颤患者中预防卒中", "随机对照试验显示，阿哌沙班使卒中事件少于对照。", {
    originality: "brief", lineage: { verifiedStudy: { doi: "10.1056/NEJMoa1107039", registryId: "NCT00412984" } },
    sources: sources("https://doi.org/10.1056/NEJMoa1107039", "Apixaban versus warfarin in patients with atrial fibrillation"),
  }), official.id, null, true, "programme")).evidence;
  const recalculation = (await zones.saveEditorial(publisher, card("feed-fixture-recalc", "对一项房颤 Meta 分析的复算", "复算与原文报告的合并效应一致，差值落在容差内。", {
    originality: "recalculation", lineage: { verifiedStudy: { doi: "10.1000/meta.2026.1" } },
    // First-hand work in the platform's voice stands on a calculation (the card contract); the feed's items carry no claims.
    claims: [{ claimId: "CALC-1", claimType: "calculated", claim: "复算得到的合并效应值为 0.82。", calculation: { engine: "evolution_recalculation", method: "meta-pool@abc", receiptId: "evolution-recalculation-receipt-0123456789abcdef0123456789abcdef", inputs: [{ identifier: "doi:10.1000/meta.2026.1" }], valuePath: "recalculated.value", machineValue: 0.82, format: "f2" } }],
    sources: sources("https://doi.org/10.1000/meta.2026.1", "A meta-analysis of anticoagulants in atrial fibrillation"),
  }), official.id, null, true, "programme")).evidence;
  const { zone } = await zones.save(alice, { requestId: "feed-fixture-user", title: "我的真实世界研究", description: "d", background: "b" });
  const live = (await zones.save(alice, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  const open = (await zones.setVisibility(alice, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  // A researcher's card is in the feed only when it was published from a research result and its author is established:
  // three published cards with a quotation the platform verified each, here in a zone that is not open to the internet.
  const standing = (await zones.save(alice, { requestId: "feed-fixture-standing", title: "已核验的卡片", description: "d", background: "b" })).zone;
  await zones.save(alice, { expectedRevision: standing.revision, state: "published" }, standing.id);
  for (const name of ["a", "b", "c"]) {
    await zones.saveEditorial(alice, card(`feed-fixture-standing-${name}`, `已核验的卡片 ${name}`, "试验中卒中事件少于对照。", {
      sources: sources("https://example.org/registry/af-stroke", "Stroke registry"),
      claims: [{ claimId: "CLM-1", claimType: "direct", claim: "卒中事件少于对照。", sourceIndexes: [1], supportQuote: "7 of 100 adults on the drug had a stroke" }],
    }), standing.id, null, true, "result");
  }
  const research = (await zones.saveEditorial(alice, card("feed-fixture-research", "单中心房颤患者的抗凝出血事件", "单中心 1,200 例患者中，抗凝相关出血低于预期。", {
    originality: "original_research", sources: sources("https://example.org/registry/af-bleeding", "Single-centre AF anticoagulation registry"),
    lineage: { resultVersionId: `rv_${"7".repeat(64)}` },
  }), open.id, null, true, "result")).evidence;
  for (const [id, at] of [[brief.id, TIMES.brief], [recalculation.id, TIMES.recalculation], [research.id, TIMES.research]]) {
    await database.query("UPDATE evimed_frontier.evidence_cards SET created_at=$2, updated_at=$2 WHERE id=$1", [id, at]);
    await database.query("UPDATE evimed_frontier.evidence_card_revisions SET recorded_at=$2 WHERE card_id=$1", [id, at]);
  }
  const feed = createEvidenceFeed({ database, config: { publicUrl: FEED_FIXTURE_PUBLIC_URL }, now: () => new Date(FEED_FIXTURE_NOW) });
  const { page, etag } = await feed.page();
  return { body: JSON.stringify({ version: page.version, generatedAt: page.generatedAt, items: page.items, next: page.next }), etag, page };
}

/**
 * The plugin's replay metadata for the recording: the source row it is read as, and the one exchange. The page's ETag is
 * not kept: it names the zones' content version, which counts every write the database ever saw and so is not
 * something a deterministic recording can hold.
 * @param {{ body: string }} recording
 */
export function pluginProvenance({ body }) {
  const bytes = Buffer.from(body, "utf8");
  const url = `${FEED_FIXTURE_PUBLIC_URL}/evidence/feed.json`;
  return {
    case: "json-api/evimed-evidence",
    recorded_by: "OpenScience/apps/server/test/helpers/evidenceFeedFixture.mjs (the platform's own feed code over a seeded test database; no upstream exists but that code)",
    user_agent: "EviMedBot/1.0 (+https://www.evimed.com; knowledge-source monitor)",
    recorded_at: FEED_FIXTURE_NOW,
    note: "Deterministic: regenerated by apps/server/test/evidenceFeed.integration.test.mjs and held equal, so a change to the feed's shape fails there until this is recorded again.",
    source: {
      id: "evimed-evidence", name: "EviMed 证据中心（平台出品的证据卡）", homepage: "https://www.evimed.com/evidence/", lane: "evidence", source_type: "evidence-body",
      access: "json-api", egress: "direct", authority: 3, safety_feed: false, owner_entity: "EviMed 证据中心", launch_tier: "P0", language: "zh", region: "CN",
      poll_floor_s: 3600, poll_ceiling_s: 21600, platform_produced: true,
      config: { family: "evimed-evidence", url_env: "EVIMED_EVIDENCE_FEED_URL", max_pages: 5, url, allowed_hosts: ["www.evimed.test"] },
    },
    state: { last_ok_at: null, cursor: {} },
    now: FEED_FIXTURE_NOW,
    request_budget: 5,
    parse_notes: [],
    errors: [],
    exchanges: [{
      method: "GET", url, api: true, conditional: true, request_body: null, request_headers: null, status: 200, final_url: url,
      headers: { "content-type": "application/json; charset=utf-8" },
      fetched_at: FEED_FIXTURE_NOW, file: "01.json", gzip: false, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error("OPEN_SCIENCE_TEST_POSTGRES_URL is required");
  const isolated = await createGeoTestDatabase(databaseUrl, "feedfixture");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  try {
    await migrateFrontier(database, { dimension: 1024 });
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('publisher','Platform publisher','development')");
    const recording = await recordEvidenceFeed(database);
    if (process.argv.includes("--write")) {
      await mkdir(PLUGIN_FIXTURE_DIR, { recursive: true });
      await writeFile(path.join(PLUGIN_FIXTURE_DIR, "01.json"), recording.body, "utf8");
      await writeFile(path.join(PLUGIN_FIXTURE_DIR, "provenance.json"), `${JSON.stringify(pluginProvenance(recording), null, 1)}\n`, "utf8");
      process.stdout.write(`wrote ${PLUGIN_FIXTURE_DIR}\n`);
    } else process.stdout.write(`${recording.body}\n`);
  } finally {
    await database.close();
    await isolated.drop();
  }
}
