// The module's own acceptance matrix, as a test.
//
// The plan lists 38 scenarios (§12). Each is owned by a work package and
// asserted in that package's own suite — but a matrix kept in a document is a
// matrix that goes stale the first time a test is renamed, and a scenario
// nobody asserts reads exactly like one that passes. So this walks the tests
// and the eval packs, maps every scenario to the test titles that name it, and
// fails on a scenario nothing names. It is also the home of the two scenarios
// that are about the module as a whole rather than about one package: the T0
// journey (AC-02, asserted end to end in the engine's own E09 case and here
// against the vocabulary that makes it possible) and the real briefs (AC-24).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VCR_CAPABILITIES, VCR_DATA_TIERS, VCR_POPULATION_KINDS, VCR_ROUTE_MIN_TIER } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const engineRoot = path.resolve(repoRoot, "..", "项目代码", "vcr-engine");

/** Every AC id named by a test title, and where. */
async function acceptanceIndex() {
  /** @type {Map<string, string[]>} */
  const named = new Map();
  /** @param {string} file @param {string} text */
  const scan = (file, text) => {
    for (const [, id] of text.matchAll(/\b(AC-\d{2})\b/g)) {
      named.set(id, [...(named.get(id) ?? []), file]);
    }
  };
  const testDir = path.join(repoRoot, "apps/server/test");
  for (const entry of await readdir(testDir)) {
    if (!entry.startsWith("vcr") || !entry.endsWith(".test.mjs")) continue;
    scan(`apps/server/test/${entry}`, await readFile(path.join(testDir, entry), "utf8"));
  }
  const webDir = path.join(repoRoot, "apps/web/src");
  const walk = async (/** @type {string} */ dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(tsx?|ts)$/.test(entry.name) && /vcr|virtual-research/i.test(full)) {
        scan(path.relative(repoRoot, full), await readFile(full, "utf8"));
      }
    }
  };
  await walk(webDir);
  for (const entry of await readdir(path.join(engineRoot, "tests/numeric")).catch(() => [])) {
    if (!entry.endsWith(".R")) continue;
    scan(`vcr-engine/tests/numeric/${entry}`, await readFile(path.join(engineRoot, "tests/numeric", entry), "utf8"));
  }
  return named;
}

test("every one of the plan's 38 acceptance scenarios is named by a test somewhere", async () => {
  const named = await acceptanceIndex();
  // The walk has to prove it walked: a glob that stopped matching would find
  // nothing unnamed and pass forever.
  assert.ok(named.size >= 30, `only ${named.size} scenarios found — the scan read nothing`);
  const missing = [];
  for (let n = 1; n <= 38; n += 1) {
    const id = `AC-${String(n).padStart(2, "0")}`;
    if (!named.has(id)) missing.push(id);
  }
  assert.deepEqual(missing, [],
    "a scenario nothing asserts reads exactly like one that passes; add a test that names it, or say in the plan why it cannot be one");
});

test("AC-24 every capability ships at least three real briefs, and one of them is the accrual backtest", async () => {
  /** @type {Record<string, any[]>} */
  const packs = {};
  for (const id of VCR_CAPABILITIES) {
    const raw = await readFile(path.join(repoRoot, "evals", id, "briefs.json"), "utf8")
      .catch(() => assert.fail(`${id} ships no evals/${id}/briefs.json`));
    const parsed = JSON.parse(raw);
    const briefs = Array.isArray(parsed) ? parsed : parsed.briefs ?? [];
    assert.ok(briefs.length >= 3, `${id} has ${briefs.length} briefs; the rule is three real ones`);
    for (const brief of briefs) {
      const text = JSON.stringify(brief);
      assert.ok(text.length > 200, `${id} has a brief too short to be a real request`);
      // A brief is a researcher's request, not a fixture: it names a disease, a
      // drug, an endpoint or a design, and it is not the word "example".
      assert.ok(!/lorem|placeholder|TODO|示例任务/i.test(text), `${id} ships a placeholder brief`);
    }
    packs[id] = briefs;
  }
  // The one the plan names specifically: a backtest of accrual against a
  // partner's historical funnel (AC-37's measurement, asked for as a brief).
  const matching = JSON.stringify(packs["vcr-matching"]);
  assert.ok(/入组|accrual|漏斗|funnel/i.test(matching),
    "no vcr-matching brief asks for the accrual work the plan names in AC-24");
  assert.ok(/回测|backtest|覆盖率|coverage/i.test(matching),
    "no vcr-matching brief asks for the backtest half of it");
});

test("AC-02 the T0 tier is a complete journey in the vocabulary, not a degraded one", () => {
  // The engine's E09 case runs the chain end to end (a declared parametric
  // population → virtual patients → a reference trial, with realPatients 0).
  // What belongs here is the rule that makes it possible: at T0 — public
  // material only — a population kind, a comparator route and a trial design
  // all exist, so no step of the seven has to be skipped for want of data.
  assert.equal(VCR_DATA_TIERS[0], "T0");
  assert.ok(VCR_POPULATION_KINDS.includes("scenario"), "a declared parametric population is a first-class population");
  assert.ok(VCR_POPULATION_KINDS.includes("literature"), "a population from published baselines is too");
  const atT0 = Object.entries(VCR_ROUTE_MIN_TIER).filter(([, tier]) => tier === "T0").map(([route]) => route);
  assert.ok(atT0.includes("literature_control"),
    "the literature control is the route that makes T0 a whole journey rather than a demo (plan §5.3)");
  assert.ok(atT0.length >= 2, "more than one comparator route is reachable without patient data");
});

test("AC-02 the engine ships the case that runs the T0 chain, and it asserts no real patients", async () => {
  const caseFile = await readFile(path.join(engineRoot, "tests/numeric/E09_t0_chain.R"), "utf8")
    .catch(() => assert.fail("the engine has no E09 T0-chain case"));
  assert.match(caseFile, /population\.scenario/, "the case starts from a declared population");
  assert.match(caseFile, /design\.simulate/, "the case ends at a simulated trial");
  assert.match(caseFile, /realPatients/, "the case asserts what the four counts say about a study with no patients");
});
