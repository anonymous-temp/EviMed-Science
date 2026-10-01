// The page contract, proven on real rows (contract 2026-09-29 §5).
//
// A study is seeded through the real stores (`vcrViewsSeed.mjs`), read through
// the real `VcrService`, and what the browser would be sent is compared, byte
// for byte after ids are numbered, with the JSON files under
// `test/fixtures/vcr-views/`. The web tests render the real components from the
// same files through the real readers with only the network mocked — so the
// server cannot change a page without the fixture changing, and the fixture
// cannot change without the browser being shown what it will now receive.
//
// A page shape changes on purpose with
//
//   VCR_VIEWS_WRITE_FIXTURES=1 node --test test/vcrViews.integration.test.mjs
//
// and the diff of the fixtures is the review.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

import { VCR_TABS } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { FIXTURE_DIR } from "./vcrViewsFixtures.mjs";
import { SEED_NOW, seedEv201 } from "./vcrViewsSeed.mjs";

const WRITE = process.env.VCR_VIEWS_WRITE_FIXTURES === "1";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const config = { vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 7_200,
  vcrMaxConcurrentJobs: 2, vcrLeaseMs: 900_000, vcrDataPlaneDir: "" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {VcrService} */
let service;
/** @type {any} */
let seeded;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrviews_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  const store = new VcrStore({ database });
  await store.ready();
  const matchStore = new VcrMatchStore({ database });
  const evidenceStore = new VcrEvidenceStore({ database });
  const jobs = new VcrJobs({ store, config });
  seeded = await seedEv201({ store, matchStore, evidenceStore });
  service = new VcrService({ store, config, jobs, matchStore, evidenceStore, now: () => SEED_NOW });
  number(seeded.study.id);
  number(seeded.empty.id);
});

after(async () => {
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

/**
 * The ids generated in this run, numbered by first appearance across EVERY
 * fixture written in one run, so `std_1` is the same study in the home list, on
 * its page and in each tab — the web tests address the fixtures by those ids.
 * The two studies are pinned first, so the numbering does not depend on which
 * page happens to be written first.
 */
const numbered = new Map();
const counters = new Map();

/** @param {string} id */
function number(id) {
  if (!numbered.has(id)) {
    const prefix = id.slice(0, id.indexOf("_"));
    counters.set(prefix, (counters.get(prefix) ?? 0) + 1);
    numbered.set(id, `${prefix}_${counters.get(prefix)}`);
  }
  return numbered.get(id);
}

/**
 * A fixture's text: generated ids replaced by their run-independent numbers,
 * hashes masked. Fixed ids (`job_seed_1`) are left as they are.
 * @param {unknown} value
 */
function normalize(value) {
  const text = JSON.stringify(value, null, 2)
    .replace(/\b(std|def|prt|crt|pre|evd|asm|pop|pts|cmp|scn|grd|mdl|mth|exe|res|fct|mas|jdg|rev|fup|rvw|dec|exp)_[0-9a-f]{22}\b/g, (match) => number(match))
    .replace(/"hash": "[0-9a-f]{12}"/g, '"hash": "HASH"');
  return `${text}\n`;
}

/** @param {string} name @param {unknown} value */
function check(name, value) {
  const path = join(FIXTURE_DIR, name);
  const text = normalize(value);
  if (WRITE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  assert.equal(text, readFileSync(path, "utf8"), `${name} differs from what the service now sends; regenerate with VCR_VIEWS_WRITE_FIXTURES=1 and read the diff`);
}

test("the home list is exactly the browser's VcrHome", options, async () => {
  const home = await service.listStudies({ id: seeded.owner });
  assert.equal(home.studies.length, 2);
  const row = home.studies.find((/** @type {any} */ entry) => entry.id === seeded.study.id);
  assert.equal(row.tier, "T0", "tier, not dataTier");
  assert.equal(typeof row.updatedAt, "string");
  assert.ok(row.conclusion?.text, "a conclusion sentence rendered from a result");
  assert.ok(row.attention.length > 0);
  check("ev201/home.json", home);
  assert.ok(Array.isArray(home.todos) && home.todos.length > 0, "a lead may contact patients, so 招募待办 is there");
  const reviewer = await service.listStudies({ id: "u_stat" });
  assert.equal(reviewer.todos, undefined, "a statistical reviewer has no recruiting role, so the column is absent");
  assert.equal(reviewer.studies.length, 1, "a member sees the study they belong to and nothing else");
});

test("the study page and its overview carry what the browser reads", options, async () => {
  const study = await service.studyView({ id: seeded.owner }, seeded.study.id);
  assert.equal(study.tier, "T0");
  assert.ok(study.overview.metrics.length > 0 && study.overview.designs.length === 4 && study.overview.deliverables.length === 2);
  assert.deepEqual(study.abilities.includes("run"), true);
  assert.equal(study.jobs.some((/** @type {any} */ job) => job.state === "awaiting_budget"), true);
  assert.ok(study.budget.awaitingBudget >= 1);
  check("ev201/study.json", study);
  const fresh = await service.studyView({ id: seeded.owner }, seeded.empty.id);
  assert.equal(fresh.overview.designs.length, 0);
  check("empty/study.json", fresh);
});

test("every one of the six data tabs answers the shape its component reads", options, async () => {
  for (const tab of VCR_TABS.filter((entry) => entry !== "overview")) {
    check(`ev201/${tab}.json`, await service.tab({ id: seeded.owner }, seeded.study.id, tab));
    check(`empty/${tab}.json`, await service.tab({ id: seeded.owner }, seeded.empty.id, tab));
  }
});

test("the matching tab answers each view and the candidate it is asked for", options, async () => {
  const asked = await service.tab({ id: seeded.owner }, seeded.study.id, "matching", new URLSearchParams("view=matching&candidate=P-0201"));
  assert.equal(asked.selected.candidate.id, "P-0201");
  check("ev201/matching-p0201.json", asked);
  // The one person whose referral is waiting on a coordinator's confirmation.
  const waiting = await service.tab({ id: seeded.owner }, seeded.study.id, "matching", new URLSearchParams("candidate=P-0192"));
  assert.equal(waiting.selected.canContact, true);
  assert.ok(waiting.selected.referralId, "the contact confirms a referral, not a candidate key");
  check("ev201/matching-p0192.json", waiting);
  for (const view of ["referral", "sites", "followup"]) {
    const answer = await service.tab({ id: seeded.owner }, seeded.study.id, "matching", new URLSearchParams(`view=${view}`));
    assert.equal(answer.view, view);
    check(`ev201/matching-${view}.json`, answer);
  }
});

test("the model library, the precedents and a package read", options, async () => {
  check("ev201/models.json", await service.modelLibrary({ id: seeded.owner }));
  const precedents = await service.precedents({ id: seeded.owner }, new URLSearchParams("q=CTR"));
  assert.equal(precedents.available, true);
  assert.equal(precedents.precedents.length, 1);
  check("ev201/precedents.json", precedents);
  const unavailable = await new VcrService({ store: service.store, config, now: () => SEED_NOW }).precedents({ id: seeded.owner }, {});
  assert.equal(unavailable.available, false);
  assert.ok(unavailable.message, "the sentence saying the library is not there");
  check("ev201/precedents-unavailable.json", unavailable);
  check("ev201/export.json", await service.exportView({ id: seeded.owner }, seeded.study.id, seeded.packageId));
});
