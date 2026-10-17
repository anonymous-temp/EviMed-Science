// scripts/ops/ui-walk.mjs: what it is built from and how it decides (R19, plan §3 S9; audit D §4 S2, S3, S8).
//
//  - the page table and the baseline are the editable sources, the walk carries a copy (it is the one file the release switch mounts), and
//    the copy is the sources;
//  - every page of the router has a template, and every page of the table is a page of the router;
//  - nothing the walk saw is only reported: a finding fails unless the baseline accepts it, with an owner and a day;
//  - every function the walk hands to the browser stands on its own text (18.1's `ReferenceError: drawerMarks is not defined`), and every
//    step names what it is for.
//
// The control flow of the walk against a stand-in browser is `uiWalk.test.mjs`; the composition checks are `uiWalkComposition.test.mjs`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as walk from "../../../scripts/ops/ui-walk.mjs";
import { ALL_ERROR_CODES, errorCodeAudience, errorCodeMessage } from "../../../packages/domain/src/errorCodes.mjs";
import { BASELINE, BEGIN, embeddedBlock, END, operatorSentences, PAGE_TEMPLATES, WALK } from "../../../scripts/ops/embed-walk-tables.mjs";

const {
  applyBaseline, asFinding, baselineDelta, baselineProblems, COVERAGE_RULES, finding, STEP_TARGETS, UNACCEPTABLE_RULES, viewOfSentence, walkSetting, WALK_PROFILES,
} = walk;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

test("the tables the walk carries are the page table and the baseline, byte for byte", async () => {
  const text = await readFile(WALK, "utf8");
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(start > 0 && end > start, "the walk has its embedded-tables block between the markers");
  const sources = embeddedBlock(await readJson(PAGE_TEMPLATES), await readJson(BASELINE), operatorSentences());
  assert.equal(text.slice(start, end + END.length), sources, "run node scripts/ops/embed-walk-tables.mjs");
  assert.deepEqual(walk.PAGE_TEMPLATES, await readJson(PAGE_TEMPLATES));
  assert.deepEqual(walk.WALK_BASELINE, await readJson(BASELINE));
  assert.deepEqual(walk.OPERATOR_SENTENCES, operatorSentences());
});

test("the page table names six templates, each view one of them, and a budget row that exists", async () => {
  const table = await readJson(PAGE_TEMPLATES);
  const templates = Object.keys(table.templates);
  assert.deepEqual(templates.filter((name) => /^T\d$/.test(name)), ["T1", "T2", "T3", "T4", "T5", "T6"]);
  const seen = new Set();
  for (const view of table.views) {
    assert.ok(!seen.has(view.view), `${view.view} is listed once`);
    seen.add(view.view);
    assert.ok(templates.includes(view.template), `${view.view} is built on a template that exists (${view.template})`);
    if (view.budget !== undefined) assert.ok(Object.hasOwn(table.budgets, view.budget), `${view.view} names budget ${view.budget}`);
    if (view.budgetOverride !== undefined) assert.ok(typeof view.budgetNote === "string" && view.budgetNote.length > 20, `${view.view}: a budget past its row says why`);
    assert.ok(view.route || view.discovered || view.module, `${view.view} says where it is found`);
    assert.ok(view.family, `${view.view} belongs to a route family`);
    assert.equal(view.provisional, undefined, `${view.view}: the provisional list ended in R19; a debt is a baseline entry with an owner and a day`);
  }
  // A module page's tabs are its template's: the step rail is on every one of them.
  for (const view of table.views.filter((entry) => entry.module)) assert.equal(table.templates[view.template].stepRail, "every-tab", view.view);
  assert.ok(seen.size > 55, `${seen.size} views: the table did not read`);
});

test("every page the router serves has a template in the page table, and every page of the table is one the router serves", async () => {
  const table = await readJson(PAGE_TEMPLATES);
  const router = await readFile(path.join(repoRoot, "apps/web/src/app/router.tsx"), "utf8");
  const app = router.slice(router.indexOf('path: "/app"'), router.indexOf('{ path: "*", element: <NotFound /> }'));
  // The routes that draw a page (a Navigate is a redirect); a nested route's path is relative to its parent's.
  const served = [...new Set([...app.matchAll(/path: "([^"]+)"[^}]*?element: (?:<(\w+)|null)/g)]
    .filter(([, , element]) => element !== "Navigate")
    .map(([, address]) => address))].filter((address) => address !== "/app");
  assert.ok(served.length >= 20 && ["frontier", "account", "autopilot/:taskId?", ":tab", "answers/:snapshotId"].every((address) => served.includes(address)), `read ${served.length} routes from the router: ${served.join(", ")}`);
  const patterns = [...table.views.map((view) => view.pattern), ...table.unwalked.map((entry) => entry.pattern)];
  const covers = (pattern, address) => pattern === `/app/${address}` || pattern.endsWith(`/${address}`);
  const withoutTemplate = served.filter((address) => !patterns.some((pattern) => covers(pattern, address)));
  assert.deepEqual(withoutTemplate, [], `the router serves ${withoutTemplate.join(", ")} and the page table gives it no template: add a view, or an \`unwalked\` row with the reason`);
  const notServed = patterns.filter((pattern) => pattern !== "/app/*" && !served.some((address) => covers(pattern, address)));
  assert.deepEqual(notServed, [], `the page table names ${notServed.join(", ")}, which the router no longer serves`);
  assert.ok(patterns.includes("/app/*"), "the not-found page has a row");
  for (const entry of table.unwalked) {
    assert.ok(table.templates[entry.template], `${entry.pattern}: its template exists`);
    assert.ok(entry.why.length > 30, `${entry.pattern}: an unwalked page says why`);
  }
});

test("the walk's own lists are read from the page table and nowhere else", () => {
  const { ROUTES, GEO_TABS, VCR_TABS_WALK, ROW_CLICK_PAGES, SECTION_SHAPES_BY_PAGE, BUDGET_BY_PAGE } = walk;
  assert.equal(ROUTES.length, walk.PAGE_TEMPLATES.views.filter((view) => view.route).length);
  assert.deepEqual(GEO_TABS.map(([, segment]) => segment), ["", "/visibility", "/accuracy", "/questions", "/sources", "/actions", "/plan", "/evidence"]);
  assert.equal(VCR_TABS_WALK.length, 7);
  for (const name of [...ROW_CLICK_PAGES, ...Object.keys(SECTION_SHAPES_BY_PAGE), ...Object.keys(BUDGET_BY_PAGE)]) {
    assert.ok(walk.PAGE_TEMPLATES.views.some((view) => view.view === name), `${name} is a view of the table`);
  }
  // A page's budget is its row's, widened by its own override.
  assert.deepEqual(BUDGET_BY_PAGE["frontier-zones"], { controls: 9, colors: 8, borders: 4 });
  assert.deepEqual(BUDGET_BY_PAGE["frontier-daily"], { controls: 10, colors: 8 });
  assert.deepEqual(BUDGET_BY_PAGE["geo-overview"], { controls: 10, colors: 7, borders: 6 });
  assert.equal(walk.PROVISIONAL_PAGES, undefined, "the provisional list is gone");
});

/** A baseline of the entries given, each with the owner and the day the file asks for. */
const baseline = (...entries) => ({ entries: entries.map((entry) => ({ owner: "guards", until: "2026-12-31", why: "measured on the first walk of R19", ...entry })) });
const today = "2026-10-17";

test("a baseline is valid when each entry names its view, its finding, an owner, a reason and a day", () => {
  assert.deepEqual(baselineProblems(baseline({ view: "files@desktop", rule: "type-pairs", max: 6 }, { view: "*", contains: "not walked — " })), []);
  assert.deepEqual(baselineProblems({}), ["the baseline has no `entries` list"]);
  const problem = (entry) => baselineProblems({ entries: [entry] });
  assert.equal(problem({ view: "files@desktop", rule: "type-pairs", owner: "", until: "2026-12-31", why: "x" }).length, 1, "no owner");
  assert.equal(problem({ view: "files@desktop", rule: "type-pairs", owner: "a", until: "someday", why: "x" }).length, 1, "no day");
  assert.equal(problem({ view: "files@desktop", rule: "type-pairs", owner: "a", until: "2026-12-31", why: "" }).length, 1, "no reason");
  assert.equal(problem({ view: "files desktop", rule: "type-pairs", owner: "a", until: "2026-12-31", why: "x" }).length, 1, "a view is one word: name@desktop, name@phone, name@*, *, or what a finding says");
  assert.equal(problem({ view: "*", owner: "a", until: "2026-12-31", why: "x" }).length, 1, "neither a rule nor a sentence");
  assert.equal(problem({ view: "*", rule: "axe", contains: "x", owner: "a", until: "2026-12-31", why: "x" }).length, 1, "both a rule and a sentence");
  assert.equal(problem({ view: "*", contains: "x", max: 3, owner: "a", until: "2026-12-31", why: "x" }).length, 1, "a number goes with a rule");
  assert.equal(problem({ view: "*", rule: "step-failed", owner: "a", until: "2026-12-31", why: "x" }).length, 1, "a step that did not run is never a debt");
  assert.equal(problem({ view: "*", rule: "type-pairs", profiles: ["staging"], owner: "a", until: "2026-12-31", why: "x" }).length, 1, "a profile the walk has");
  // A coverage gap is the owner walk's: a fixture walk has data and accepts no gap.
  assert.equal(problem({ view: "*", rule: "not-observable", owner: "a", until: "2026-12-31", why: "x" }).length, 1);
  assert.deepEqual(problem({ view: "*", rule: "not-observable", profiles: ["owner"], owner: "a", until: "2026-12-31", why: "x" }), []);
  assert.deepEqual([...COVERAGE_RULES].sort(), ["not-observable", "not-walked"]);
  assert.deepEqual([...UNACCEPTABLE_RULES], ["step-failed"]);
  assert.deepEqual(WALK_PROFILES, ["owner", "fixture"]);
});

test("a sentence carries its view and a rule by the walk's own markers; a measure carries them itself", () => {
  assert.equal(viewOfSentence("files@desktop: 5 font-size × weight pairs"), "files@desktop");
  assert.equal(viewOfSentence("vcr-*@2: not walked — the account has one study"), "vcr-*@2");
  assert.equal(viewOfSentence("no colon in this one"), "*");
  assert.deepEqual(asFinding("files@desktop: not observable: no row"), { rule: "not-observable", view: "files@desktop", text: "files@desktop: not observable: no row" });
  assert.equal(asFinding("geo-answer: not walked — the first project lists no wrong sentence").rule, "not-walked");
  assert.equal(asFinding("inbox@desktop: the page does not show the choice it was given").rule, "notice");
  const measured = finding("type-pairs", "files@desktop", "files@desktop: 5 pairs", 5);
  assert.equal(asFinding(measured), measured);
});

test("the baseline accepts a finding by its rule up to a number, or by a literal part of its sentence, for the views and walks it names", () => {
  const pairs = (view, count) => finding("type-pairs", view, `${view}: ${count} font-size × weight pairs`, count);
  const decide = (findings, entries, extra = {}) => applyBaseline(findings, baseline(...entries), { profile: "owner", today, ...extra });

  const held = decide([pairs("files@desktop", 6), pairs("memory@desktop", 5)], [{ view: "files@desktop", rule: "type-pairs", max: 6 }, { view: "memory@*", rule: "type-pairs", max: 8 }]);
  assert.equal(held.accepted.length, 2);
  assert.deepEqual(held.unaccepted, []);
  // One more pair than the entry holds is a finding nobody accepted: a page can only get better.
  const worse = decide([pairs("files@desktop", 7)], [{ view: "files@desktop", rule: "type-pairs", max: 6 }]);
  assert.deepEqual(worse.unaccepted.map((entry) => [entry.finding.view, entry.why]), [["files@desktop", "no baseline entry accepts it"]]);
  // The view must be the entry's: a name@* covers both widths, a name@desktop only the desktop, * every view.
  assert.equal(decide([pairs("files@phone", 5)], [{ view: "files@desktop", rule: "type-pairs", max: 9 }]).unaccepted.length, 1);
  assert.equal(decide([pairs("files@phone", 5)], [{ view: "files@*", rule: "type-pairs", max: 9 }]).unaccepted.length, 0);
  assert.equal(decide([pairs("files@phone", 5)], [{ view: "*", rule: "type-pairs", max: 9 }]).unaccepted.length, 0);
  assert.equal(decide([pairs("filesx@phone", 5)], [{ view: "files@*", rule: "type-pairs", max: 9 }]).unaccepted.length, 1, "files@* is not every view that starts with files");
  // A sentence is matched by a literal part of it (and a plain string notice is a sentence).
  const by = decide(["inbox@desktop: the page does not show the choice it was given", "inbox@desktop: something else"], [{ view: "inbox@desktop", contains: "does not show the choice" }]);
  assert.deepEqual([by.accepted.length, by.unaccepted.length], [1, 1]);
  // The day: an entry past it accepts nothing, and the finding says whose entry ran out.
  const late = decide([pairs("files@desktop", 5)], [{ view: "files@desktop", rule: "type-pairs", max: 6, until: "2026-10-16" }]);
  assert.deepEqual(late.unaccepted.map((entry) => entry.why), ["the baseline entry of guards expired on 2026-10-16"]);
  assert.equal(late.expired.length, 1);
  assert.equal(decide([pairs("files@desktop", 5)], [{ view: "files@desktop", rule: "type-pairs", max: 6, until: "2026-10-17" }]).accepted.length, 1, "the day itself still counts");
  // The walk it is for: the owner walk's debts are not the fixture walk's.
  const owner = { view: "*", rule: "type-pairs", max: 9, profiles: ["owner"] };
  assert.equal(decide([pairs("files@desktop", 5)], [owner]).accepted.length, 1);
  assert.equal(decide([pairs("files@desktop", 5)], [owner], { profile: "fixture" }).unaccepted.length, 1);
});

test("a coverage gap is accepted by the owner walk and never by a fixture walk; a step that did not run is accepted by nobody", () => {
  const gap = "frontier@desktop: not observable: no list on the page has a first row that opens";
  const entry = { view: "frontier@desktop", rule: "not-observable", profiles: ["owner"] };
  assert.equal(applyBaseline([gap], baseline(entry), { profile: "owner", today }).accepted.length, 1);
  const fixture = applyBaseline([gap], baseline(entry), { profile: "fixture", today });
  assert.deepEqual(fixture.unaccepted.map((item) => item.why), ["a fixture walk accepts no coverage gap"]);
  // Even a `contains` entry that names the sentence, or one that names no walk, cannot give a fixture walk a gap.
  assert.equal(applyBaseline([gap], baseline({ view: "*", contains: "not observable" }), { profile: "fixture", today }).unaccepted.length, 1);
  assert.equal(applyBaseline([finding("not-walked", "geo-answer", "geo-answer: not walked — no wrong sentence")], baseline({ view: "*", contains: "not walked" }), { profile: "fixture", today }).unaccepted.length, 1);
  const broken = finding("step-failed", "memory-map-drawer", "memory-map-drawer: the step could not run");
  assert.deepEqual(applyBaseline([broken], baseline({ view: "*", contains: "the step could not run" }), { profile: "owner", today }).unaccepted.map((item) => item.why), ["a step that did not run is never accepted"]);
});

test("the delta says what the baseline accepted, what it did not, which entries can go and which can be lowered", () => {
  const pairs = (view, count) => finding("type-pairs", view, `${view}: ${count} pairs`, count);
  const entries = baseline(
    { view: "files@desktop", rule: "type-pairs", max: 8 }, { view: "memory@desktop", rule: "type-pairs", max: 6 },
    { view: "gone@desktop", rule: "type-pairs", max: 6 }, { view: "old@desktop", rule: "type-pairs", max: 6, until: "2026-01-01" },
  );
  const decided = applyBaseline([pairs("files@desktop", 5), pairs("memory@desktop", 6), pairs("inbox@desktop", 5)], entries, { profile: "owner", today });
  assert.deepEqual([decided.accepted.length, decided.unaccepted.length, decided.unused.map((entry) => entry.view), decided.expired.map((entry) => entry.view)], [2, 1, ["gone@desktop"], ["old@desktop"]]);
  assert.deepEqual(decided.lowerable.map(({ entry, measured }) => [entry.view, entry.max, measured]), [["files@desktop", 8, 5]]);
  const lines = baselineDelta(decided, "owner");
  assert.equal(lines[0], "baseline (owner walk): 2 finding(s) accepted by 2 entry(ies), 1 not accepted");
  assert.ok(lines.includes("  accepted 1 × files@desktop type-pairs ≤ 8 (guards, until 2026-12-31)"));
  assert.ok(lines.includes("  EXPIRED old@desktop type-pairs ≤ 6 (guards, until 2026-01-01)"));
  assert.ok(lines.includes("  no longer needed, delete: gone@desktop type-pairs ≤ 6 (guards, until 2026-12-31)"));
  assert.ok(lines.includes("  can be lowered to 5: files@desktop type-pairs ≤ 8 (guards, until 2026-12-31)"));
});

test("the walk's setting is the owner walk by default, rejects what it does not know, and reads a baseline from a file or none", async () => {
  const set = await walkSetting({});
  assert.deepEqual([set.profile, set.baselineSource, set.problems], ["owner", "embedded", []]);
  assert.match(set.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(set.baseline, walk.WALK_BASELINE);
  assert.equal((await walkSetting({ OPEN_SCIENCE_WALK_PROFILE: "fixture", OPEN_SCIENCE_WALK_TODAY: "2026-10-17" })).today, "2026-10-17");
  assert.match((await walkSetting({ OPEN_SCIENCE_WALK_PROFILE: "staging" })).problems[0], /OPEN_SCIENCE_WALK_PROFILE is owner or fixture, not staging/);
  assert.match((await walkSetting({ OPEN_SCIENCE_WALK_TODAY: "yesterday" })).problems[0], /OPEN_SCIENCE_WALK_TODAY is a date/);
  const none = await walkSetting({ OPEN_SCIENCE_WALK_BASELINE: "none" });
  assert.deepEqual([none.baselineSource, none.baseline.entries], ["none", []]);
  const missing = await walkSetting({ OPEN_SCIENCE_WALK_BASELINE: "/nowhere/baseline.json" });
  assert.match(missing.problems[0], /^the baseline \/nowhere\/baseline\.json cannot be read/);
});

test("the baseline the walk ships is a valid file whose entries all have an owner, a reason and a day that has not passed", async () => {
  const shipped = await readJson(BASELINE);
  assert.deepEqual(baselineProblems(shipped), []);
  assert.ok(Array.isArray(shipped.about) && shipped.about.length >= 2, "the file says what it is for");
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of shipped.entries) assert.ok(entry.until >= today, `${entry.view} ${entry.rule ?? entry.contains}: the day ${entry.until} has passed; renew it with a reason, or fix the page`);
});

test("every step the walk records names what it is for, and every named target is a step the walk records", async () => {
  const source = await readFile(WALK, "utf8");
  const recorded = [...source.matchAll(/recordStep\(report, failures, notices, ([^,]+), /g)].map((match) => match[1].trim());
  assert.ok(recorded.length >= 8, `${recorded.length} recordStep calls were found`);
  const names = new Set(recorded.filter((name) => name.startsWith('"')).map((name) => name.slice(1, -1)));
  // A step per view is named by the view (`evidence-matrix@desktop`); its target is looked up without it.
  names.add("evidence-matrix");
  assert.ok(recorded.some((name) => !name.startsWith('"')), "the per-view step was found");
  for (const name of names) assert.ok(Object.hasOwn(STEP_TARGETS, name), `step ${name} has no entry in STEP_TARGETS`);
  for (const name of Object.keys(STEP_TARGETS)) assert.ok(names.has(name), `STEP_TARGETS names ${name} and no step is recorded under it`);
  for (const target of Object.values(STEP_TARGETS)) assert.ok(target.length > 20, target);
});

test("every function the walk hands to the browser stands on its own text", async () => {
  // Playwright sends `fn.toString()` to the page, so a name the function takes from this module is a ReferenceError there while it works
  // in a test that calls it here: 18.1's memory-map step threw `drawerMarks is not defined` for a release and the walk stayed green. ESLint's
  // `no-undef` is the check: the text of each function is linted alone, with the browser's and the language's globals.
  const require = createRequire(import.meta.url);
  const { Linter } = require("eslint");
  const source = await readFile(WALK, "utf8");
  const named = [...new Set([...source.matchAll(/\.(?:evaluate|waitForFunction)\(\s*([A-Za-z_]\w*)/g)].map((match) => match[1]))];
  assert.ok(named.length >= 25, `${named.length} in-page functions were found: ${named.join(", ")}`);
  const linter = new Linter();
  const problems = [];
  for (const name of named) {
    // `page.evaluate(source)` puts axe-core's text into the page: a string, not a function.
    if (name === "source") continue;
    const fn = walk[name];
    if (typeof fn !== "function") { problems.push(`${name} is handed to the browser and is not exported, so no test can stand it on its own`); continue; }
    const messages = linter.verify(`const probe = ${fn.toString()};\nprobe;`, {
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
      env: { browser: true, es2023: true },
      globals: { axe: "readonly" },
      rules: { "no-undef": "error" },
    });
    for (const message of messages) problems.push(`${name}: ${message.message}`);
  }
  assert.deepEqual(problems, []);
  // The check can fail: a function that reaches for a helper of the module is seen.
  const messages = linter.verify("const probe = function probe() { return helper(document.title); };\nprobe;", { parserOptions: { ecmaVersion: 2023 }, env: { browser: true, es2023: true }, rules: { "no-undef": "error" } });
  assert.deepEqual(messages.map((message) => message.message), ["'helper' is not defined."]);
});

test("a page view is photographed whole when it is up to three windows tall, and in slices of a window and a half when it is taller", () => {
  const { capturePlan, CAPTURE_MAX_SLICES } = walk;
  const shape = (scrollHeight, over = {}) => ({ viewportHeight: 945, clientHeight: 945, scrollHeight, ...over });
  assert.deepEqual(capturePlan(shape(945)), { kind: "single" });
  assert.deepEqual(capturePlan(shape(949)), { kind: "single" }, "four pixels over is the rounding of a scroll height");
  assert.deepEqual(capturePlan(shape(2200)), { kind: "stretch", height: 2200 });
  assert.deepEqual(capturePlan(shape(2835)), { kind: "stretch", height: 2835 }, "three windows is still one picture");
  // The app's own bar above the scroll area (a phone's) stays in the picture: the window is the page and what stands over it.
  assert.deepEqual(capturePlan(shape(2000, { viewportHeight: 844, clientHeight: 796 })), { kind: "stretch", height: 2048 });
  assert.deepEqual(capturePlan(shape(2836)), { kind: "slices", tops: [0, 1418, 1891], truncated: false });
  assert.deepEqual(capturePlan(shape(9450)).tops, [0, 1418, 2836, 4254, 5672, 7090, 8505], "the last slice is the page's end");
  const many = capturePlan(shape(47250));
  assert.deepEqual([many.tops.length, many.truncated, many.tops.at(-1)], [CAPTURE_MAX_SLICES, true, 7 * 1418]);
});

/** What the nightly candidate check writes (schema 1, the shape its header documents), cut to what the walk reads. */
const CANDIDATE_CHECK = {
  schemaVersion: 1, checkedAt: "2026-10-17T03:10:00Z", pin: { dsh: "0.1.7-rc.2", publishedAt: "2026-09-18T00:00:00Z", cordis: "4.0.4" }, distTags: { latest: "0.1.7-rc.2", alpha: "0.2.1-alpha.2" },
  candidates: [
    { version: "0.2.1-alpha.2", tags: ["alpha"], lagDays: 9.9, ageDays: 3.1, verdict: "blocked", reasons: ["cordis 4.0.5-alpha.1 differs from the manifest", "2 unclassified wire methods", "the LoopX plugin's peer range excludes it", "6 dsh-client-* peers unsatisfied"] },
    { version: "0.1.7-rc.2", tags: ["latest"], lagDays: 0, ageDays: 29, verdict: "same-as-pin", reasons: [] },
  ],
  pins: [{ id: "dsh-cite", kind: "npm", pinned: "0.3.5", latest: "0.4.2", behind: true, lagDays: 6.5 }, { id: "loopx-cli", pinned: "1.3.1", latest: "1.4.0", behind: true, lagDays: 5.4 }, { id: "openlist", pinned: "4.2.6", latest: "4.2.6", behind: false, lagDays: 0 }],
  unknown: ["the GitHub rate limit stopped the OpenViking poll"],
};

test("the walk tells the candidate check in its report and its output when one is named, and never fails on it or on its absence (R19 S8)", async () => {
  const { candidateCheckSummary, readCandidateCheck } = walk;
  const told = candidateCheckSummary(CANDIDATE_CHECK);
  assert.deepEqual(told.lines, [
    "candidate check (2026-10-17T03:10:00Z): the kernel is pinned at 0.1.7-rc.2; 2 candidate(s)",
    "  0.2.1-alpha.2 (alpha): blocked, 9.9 days after the pin — cordis 4.0.5-alpha.1 differs from the manifest; 2 unclassified wire methods; the LoopX plugin's peer range excludes it",
    "  0.1.7-rc.2 (latest): same-as-pin, 0 days after the pin",
    "  2 other pin(s) behind upstream: dsh-cite 0.3.5 → 0.4.2 (6.5 days), loopx-cli 1.3.1 → 1.4.0 (5.4 days)",
    "  could not be learned: the GitHub rate limit stopped the OpenViking poll",
  ]);
  assert.deepEqual(told.summary.pinsBehind.map((pin) => pin.id), ["dsh-cite", "loopx-cli"]);
  assert.equal(told.summary.candidates[0].reasons.length, 4, "the report keeps the reasons, the output the first three");
  // Another schema, a file that is not JSON, and no file at all are each said (or not) without throwing.
  assert.match(candidateCheckSummary({ schemaVersion: 2 }).lines[0], /not a candidate-check\.json of schema 1/);
  assert.deepEqual(await readCandidateCheck(undefined), { summary: null, lines: [] });
  assert.deepEqual(await readCandidateCheck("/nowhere/candidate-check.json"), { summary: null, lines: [] }, "the nightly job's file is not on every host");
  assert.match((await readCandidateCheck("/x", async () => "not json")).lines[0], /^candidate check: \/x is not JSON/);
  assert.equal((await readCandidateCheck("/x", async () => JSON.stringify(CANDIDATE_CHECK))).summary.pin, "0.1.7-rc.2");
});

test("the operator's sentences are the domain's, for the codes written for the operator and for no one else", () => {
  // A `run` sentence is the subject of its run's own card and inbox line and a `person` sentence is written for the reader: neither is in
  // the table, and the table says nothing a page of a researcher may say.
  const table = new Set(walk.OPERATOR_SENTENCES);
  const said = (audience) => [...ALL_ERROR_CODES].filter((code) => errorCodeAudience(code) === audience).map((code) => errorCodeMessage(code)).filter((sentence) => sentence?.length >= 12);
  assert.deepEqual(said("person").filter((sentence) => table.has(sentence)), []);
  assert.deepEqual(said("run").filter((sentence) => table.has(sentence)), []);
  assert.deepEqual([...table].sort(), [...new Set(said("operator"))].sort());
  assert.ok(table.size > 100, `${table.size} sentences: the domain's operator codes did not read`);
});

