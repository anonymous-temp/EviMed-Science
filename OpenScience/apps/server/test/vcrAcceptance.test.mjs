// The module's own acceptance matrix, as a test.
//
// The plan lists 38 scenarios (§12). Each is owned by a work package and
// asserted in that package's own suite — but a matrix kept in a document is a
// matrix that goes stale the first time a test is renamed, and a scenario
// nobody asserts reads exactly like one that passes. So this walks the tests
// and the eval packs, maps every scenario to the test titles that name it, and
// fails on a scenario nothing names.
//
// "Names" means the title: the string passed to `test(` / `it(` / `describe(`
// (or the AC list a `vcr_case(` declares). A comment that mentions AC-25 is not
// a test of AC-25 — the first version of this file counted comments, and a
// scenario whose only mention was "(AC-25)" beside a helper read as covered.
// A test title still only *says* what it asserts; the matrix cannot check that
// the body does, which is what review is for.
//
// It is also the home of the two scenarios that are about the module as a
// whole rather than about one package: the T0 journey (AC-02, asserted end to
// end in the engine's own E09 case and here against the vocabulary that makes
// it possible) and the real briefs (AC-24).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VCR_CAPABILITIES, VCR_DATA_TIERS, VCR_POPULATION_KINDS, VCR_ROUTE_MIN_TIER } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const engineRoot = path.resolve(repoRoot, "..", "项目代码", "vcr-engine");

/**
 * The titles of the tests a JS or TS source declares: the first string of every
 * `test(`, `it(` and `describe(` call (with `.skip`, `.only` and the like), read
 * from a real token stream so that a call inside a comment, a string or a
 * regular expression is not one. A title built from a template keeps its literal
 * parts; an interpolated part is a NUL, so `${id}` can never spell an AC.
 * @param {string} source
 * @returns {string[]}
 */
export function testTitles(source) {
  /** @type {{ type: "str" | "id" | "p", value: string }[]} */
  const tokens = [];
  const n = source.length;
  const regexFollows = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "=>", "+", "return"]);
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i += 1; continue; }
    if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let value = "";
      i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") { i += 1; }
        else if (c === "`" && source[i] === "$" && source[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) { if (source[i] === "{") depth += 1; else if (source[i] === "}") depth -= 1; i += 1; }
          value += "\u0000";
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ type: "str", value });
      continue;
    }
    if (c === "/") {
      const previous = tokens.at(-1);
      if (!previous || (previous.type !== "str" && regexFollows.has(previous.value))) {
        i += 1;
        let inClass = false;
        while (i < n && (source[i] !== "/" || inClass)) {
          if (source[i] === "\\") i += 1;
          else if (source[i] === "[") inClass = true;
          else if (source[i] === "]") inClass = false;
          i += 1;
        }
        i += 1;
        tokens.push({ type: "p", value: "regex" });
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(source[j])) j += 1;
      tokens.push({ type: "id", value: source.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ type: "p", value: c });
    i += 1;
  }
  /** @type {string[]} */
  const titles = [];
  for (let k = 0; k < tokens.length; k += 1) {
    if (tokens[k].type !== "id" || !["test", "it", "describe"].includes(tokens[k].value)) continue;
    let at = k + 1;
    while (tokens[at]?.value === "." && tokens[at + 1]?.type === "id") at += 2;
    if (tokens[at]?.value !== "(") continue;
    at += 1;
    let title = "";
    while (tokens[at]?.type === "str") {
      title += tokens[at].value;
      at += 1;
      if (tokens[at]?.value === "+" && tokens[at + 1]?.type === "str") at += 1;
      else break;
    }
    if (title) titles.push(title);
  }
  return titles;
}

/**
 * The scenario ids the engine's numeric cases declare: `vcr_case(id, c("AC-04",
 * ...), function() ...)`. A line whose `vcr_case(` sits after a `#` is a comment.
 * @param {string} source
 * @returns {string[]}
 */
export function caseAcceptanceIds(source) {
  /** @type {string[]} */
  const ids = [];
  for (const line of source.split("\n")) {
    const at = line.indexOf("vcr_case(");
    if (at < 0 || line.slice(0, at).includes("#")) continue;
    ids.push(...[...line.slice(at).matchAll(/\bAC-\d{2}\b/g)].map((match) => match[0]));
  }
  return ids;
}

/** Every AC id named by a test title (or an R case's declared list), and where. */
async function acceptanceIndex() {
  /** @type {Map<string, string[]>} */
  const named = new Map();
  /** @param {string} file @param {string[]} ids */
  const add = (file, ids) => { for (const id of ids) named.set(id, [...(named.get(id) ?? []), file]); };
  /** @param {string} file @param {string} source */
  const scanTitles = (file, source) => {
    for (const title of testTitles(source)) add(file, [...title.matchAll(/\b(AC-\d{2})\b/g)].map((match) => match[1]));
  };
  const testDir = path.join(repoRoot, "apps/server/test");
  for (const entry of await readdir(testDir)) {
    if (!entry.startsWith("vcr") || !entry.endsWith(".test.mjs")) continue;
    scanTitles(`apps/server/test/${entry}`, await readFile(path.join(testDir, entry), "utf8"));
  }
  const webDir = path.join(repoRoot, "apps/web/src");
  const walk = async (/** @type {string} */ dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.test\.tsx?$/.test(entry.name) && /vcr|virtual-research/i.test(full)) {
        scanTitles(path.relative(repoRoot, full), await readFile(full, "utf8"));
      }
    }
  };
  await walk(webDir);
  for (const entry of await readdir(path.join(engineRoot, "tests/numeric")).catch(() => [])) {
    if (!entry.endsWith(".R")) continue;
    add(`vcr-engine/tests/numeric/${entry}`, caseAcceptanceIds(await readFile(path.join(engineRoot, "tests/numeric", entry), "utf8")));
  }
  return named;
}

test("the scan reads titles: a scenario named only in a comment, a string or a regex is not named", () => {
  const source = [
    '// test("AC-01 in a line comment", () => {});',
    '/* it("AC-02 in a block comment", () => {}); */',
    '// AC-03 is described here but no test title says so',
    'const shown = "test(\\"AC-04 inside a string\\")";',
    'const pattern = /test\\("AC-05 in a regex"/;',
    'test("AC-06 a real one", () => {});',
    'test.skip("AC-07 skipped is still declared", () => {});',
    "it(`AC-08 template ${AC_09} title`, () => {});",
    'describe("AC-10 " + "split across two strings", () => { it("nested", () => {}); });',
    'test(title, () => {});',
    'function test2() { return "AC-11 no call"; }',
  ].join("\n");
  const ids = testTitles(source).flatMap((title) => [...title.matchAll(/\bAC-\d{2}\b/g)].map((match) => match[0]));
  assert.deepEqual(ids, ["AC-06", "AC-07", "AC-08", "AC-10"]);
  assert.deepEqual(testTitles('test("a", () => { test("nested", () => {}); });'), ["a", "nested"]);
  // The R side: the list a case declares, not a mention beside it.
  assert.deepEqual(caseAcceptanceIds([
    '# vcr_case("N01", c("AC-01"), function() {',
    'vcr_case("N02", c("AC-02", "AC-03"), function() {',
    '  # AC-04 is checked below',
    'vcr_case("N03", "AC-05", function() {',
  ].join("\n")), ["AC-02", "AC-03", "AC-05"]);
});

test("every one of the plan's 38 acceptance scenarios is named by a test title somewhere", async () => {
  const named = await acceptanceIndex();
  // The walk has to prove it walked: a glob that stopped matching would find
  // nothing unnamed and pass forever.
  assert.ok(named.size >= 30, `only ${named.size} scenarios found — the scan read nothing`);
  const files = new Set([...named.values()].flat());
  assert.ok([...files].some((file) => file.startsWith("apps/server/test/")), "no server test title was read");
  assert.ok([...files].some((file) => file.startsWith("vcr-engine/")), "no engine case was read");
  const missing = [];
  for (let n = 1; n <= 38; n += 1) {
    const id = `AC-${String(n).padStart(2, "0")}`;
    if (!named.has(id)) missing.push(id);
  }
  assert.deepEqual(missing, [],
    "a scenario nothing asserts reads exactly like one that passes; put its id in the title of the test that asserts it, or say in the plan why it cannot be a test");
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

test("AC-35 the timed T0 run and the other release-time checks are written down where release-time acceptance is recorded", async () => {
  // The acceptance ledger has one row per capability and no AC rows, so the timed
  // run cannot live there. What can be tested is that the place it does live is
  // not empty and names each check a deployed stack has to make.
  const checklist = await readFile(path.join(repoRoot, "docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md"), "utf8");
  const start = checklist.indexOf("## 虚拟临床研究：只有部署后才能做的检查");
  assert.ok(start >= 0, "the release checklist has no section for the module's release-time checks");
  const rest = checklist.slice(start + 3);
  const section = rest.slice(0, rest.indexOf("\n## ") < 0 ? undefined : rest.indexOf("\n## "));
  for (const [what, needle] of [
    ["the timed T0 run", "AC-35"],
    ["the engine image build and its lock check", "package lock verified"],
    ["the data plane's permissions", "/data-plane"],
    ["the jobs volume's permissions", "/jobs"],
    ["the live run of each capability, recorded in the ledger", "acceptance-ledger"],
    ["the migration on a production copy", "migrate-check.mjs"],
    ["the new .env keys reaching the web container", "OPEN_SCIENCE_VCR_ENGINE_TOKEN_HOST_FILE"],
  ]) assert.ok(section.includes(needle), `the checklist section does not name ${what} (${needle})`);
  // And the five capability rows it sends the live runs to exist.
  const ledger = JSON.parse(await readFile(path.join(repoRoot, "evals/acceptance-ledger.json"), "utf8"));
  const rows = new Map(ledger.capabilities.map((/** @type {any} */ row) => [row.id, row]));
  for (const id of VCR_CAPABILITIES) assert.ok(rows.get(id)?.realDelivery, `the ledger has no realDelivery to record ${id}'s live run in`);
});
