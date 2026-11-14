// ChiCTR's eligibility text (G10): the two labelled sections cut out of a record page as the web reader returns it, the cache that keeps a read for days and a failure for
// hours, and the judging target that carries the words (or none). No database and no network: the reader and the store are doubles. The page text below is invented but has
// the shape of the registry's real template, which a record read through the platform's reader on 2026-11-04 showed to be one table row per field, Chinese label row first.
import assert from "node:assert/strict";
import test from "node:test";
import { segmentCriteria } from "@evimed/domain";
import { judgmentTargets } from "../src/vcrMatchJudge.mjs";
import { chictrEligibilityFrom, createRegistryPageCounters, createRegistryPages, VcrRegistryPageStore } from "../src/vcrRegistryPages.mjs";

const URL_OF = (n) => `https://www.chictr.org.cn/showproj.html?proj=${n}`;
const NAV = "- 网站首页|\n- ChiCTR简介|\n\n检索试验 按国家、省（市）统计\n";
const PAGE_ZH_EN = `${NAV}
示例研究

| 注册号： Registration number： | ChiCTR2000099999 |
| 研究类型： | 干预性研究 |
| 纳入标准： | （1） 年龄18-75岁； （2） 确诊为二型糖尿病。 |
| Inclusion criteria | 1. Aged 18-75; 2. Type 2 diabetes. |
| 排除标准： | （1）妊娠或哺乳期； （2）近三个月内使用过胰岛素。 |
| Exclusion criteria： | 1. Pregnancy or lactation. |
| 研究实施时间： Study execute time： | 从 From 2020-02-10 至 To 2021-06-30 |
`;

test("both sections are taken from the Chinese rows, with the headings the clause splitter reads, and the clauses come out split", () => {
  const found = chictrEligibilityFrom(PAGE_ZH_EN);
  assert.deepEqual(found?.language, { inclusion: "zh", exclusion: "zh" });
  assert.equal(found?.eligibility, "Inclusion Criteria:\n（1） 年龄18-75岁； （2） 确诊为二型糖尿病。\n\nExclusion Criteria:\n（1）妊娠或哺乳期； （2）近三个月内使用过胰岛素。");
  const clauses = segmentCriteria(found?.eligibility);
  assert.deepEqual(clauses.map((clause) => [clause.kind, clause.text]), [["inclusion", "年龄18-75岁；"], ["inclusion", "确诊为二型糖尿病。"], ["exclusion", "妊娠或哺乳期；"], ["exclusion", "近三个月内使用过胰岛素。"]]);
});

test("a section the Chinese row leaves empty is taken from the English row, and a page with only English rows reads", () => {
  const mixed = chictrEligibilityFrom(`| 纳入标准： | （1） 年龄18岁以上。 |\n| Inclusion criteria | 1. Aged 18 or older. |\n| 排除标准： |  |\n| Exclusion criteria： | 1. Pregnancy. 2. Allergy to the drug. |\n`);
  assert.deepEqual(mixed?.language, { inclusion: "zh", exclusion: "en" });
  assert.match(mixed?.eligibility ?? "", /Exclusion Criteria:\n1\. Pregnancy\. 2\. Allergy to the drug\.$/u);
  const english = chictrEligibilityFrom("| Inclusion criteria: | 1. Adults. |\n| Exclusion criteria: | 1. Children. |\n");
  assert.deepEqual(english?.language, { inclusion: "en", exclusion: "en" });
  assert.equal(chictrEligibilityFrom("| 排除标准： | 无 |\n")?.eligibility, "Exclusion Criteria:\n无", "one section alone is what the page has");
});

test("a label cell may hold both languages, and a pipe inside a value does not split it", () => {
  const found = chictrEligibilityFrom("| 纳入标准： Inclusion criteria： | 白细胞 \\| 血小板正常 |\n");
  assert.equal(found?.eligibility, "Inclusion Criteria:\n白细胞 | 血小板正常");
});

test("outside a table the label starts a line and its words follow, up to the other section", () => {
  const found = chictrEligibilityFrom("Inclusion criteria:\n1. Adults\n2. Consent\n\nExclusion criteria: 1. Pregnancy\n2. Infection\n\nGender: both\n");
  assert.equal(found?.eligibility, "Inclusion Criteria:\n1. Adults 2. Consent\n\nExclusion Criteria:\n1. Pregnancy 2. Infection");
});

test("a page with no section, or an empty one, has no eligibility text", () => {
  assert.equal(chictrEligibilityFrom(NAV), null);
  assert.equal(chictrEligibilityFrom(""), null);
  assert.equal(chictrEligibilityFrom(undefined), null);
  assert.equal(chictrEligibilityFrom("| 纳入标准： |  |\n| Exclusion criteria |  |\n"), null);
  assert.equal(chictrEligibilityFrom("| 研究目的： | 比较纳入标准的两种写法 |\n"), null, "a label is the first cell, not a phrase inside a value");
});

/** A cache in memory with the real store's interface. */
function memoryStore() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  const key = ({ registry, registryId }) => `${registry}\u0000${registryId}`;
  return {
    rows,
    async get(input) { return rows.get(key(input)) ?? null; },
    async saveRead({ registry, registryId, url, eligibility, at }) { rows.set(key({ registry, registryId }), { status: "ok", eligibility, url, source: "web_read", reason: null, fetchedAt: at, attemptedAt: at }); },
    async saveFailed({ registry, registryId, url, reason, at }) {
      const held = rows.get(key({ registry, registryId }));
      rows.set(key({ registry, registryId }), held ? { ...held, reason, attemptedAt: at } : { status: "failed", eligibility: "", url, source: "web_read", reason, fetchedAt: null, attemptedAt: at });
    },
  };
}

function setup({ text = PAGE_ZH_EN, config = {}, start = "2026-11-04T10:00:00Z" } = {}) {
  let clock = new Date(start);
  const reader = { calls: [], behaviour: async () => ({ text }), async read(url, options) { this.calls.push({ url, signal: options?.signal }); return this.behaviour(url); } };
  const store = memoryStore();
  const reports = [];
  const counters = createRegistryPageCounters();
  const pages = createRegistryPages({ store, webReader: reader, config: { vcrRegistryPageDays: 7, vcrRegistryPageFailureHours: 6, vcrRegistryPageTimeoutMs: 1_000, ...config }, report: (code) => reports.push(code), counters, now: () => clock });
  return { pages, reader, store, reports, counters, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}
const ask = (pages, id = "ChiCTR2000099999", n = 99999) => pages.eligibilityFor({ registry: "chictr", registryId: id, url: URL_OF(n) });

test("a page is read once and kept: the second ask makes no request and returns the same words and time", async () => {
  const { pages, reader, counters, advance } = setup();
  const first = await ask(pages);
  assert.match(first?.eligibility ?? "", /^Inclusion Criteria:\n（1）/u);
  assert.equal(first?.source, "web_read");
  assert.equal(first?.url, URL_OF(99999));
  advance(60_000);
  const second = await ask(pages);
  assert.deepEqual(second, first);
  assert.equal(reader.calls.length, 1, "the kept words came back without a second read");
  assert.deepEqual([counters.read, counters.fromCache], [1, 1]);
});

test("the same page asked for by many pairs at once is one read", async () => {
  const { pages, reader } = setup();
  reader.behaviour = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { text: PAGE_ZH_EN }; };
  const answers = await Promise.all(Array.from({ length: 50 }, () => ask(pages)));
  assert.equal(reader.calls.length, 1);
  assert.ok(answers.every((answer) => answer?.eligibility === answers[0]?.eligibility));
});

test("a failed read is none, never an error, and is not asked for again until the failure window is over", async () => {
  const { pages, reader, store, counters, advance, reports } = setup();
  reader.behaviour = async () => { throw Object.assign(new Error("needs a browser"), { code: "web_read_needs_browser" }); };
  assert.equal(await ask(pages), null);
  assert.equal(reader.calls.length, 1);
  assert.equal(store.rows.get("chictr\u0000ChiCTR2000099999").reason, "web_read_needs_browser");
  assert.deepEqual(reports, ["registry_page_web_read_needs_browser"]);
  // A job of thousands of pairs asks again and again: nothing is sent.
  for (let pair = 0; pair < 200; pair += 1) assert.equal(await ask(pages), null);
  assert.equal(reader.calls.length, 1, "the failure is remembered");
  assert.equal(counters.remembered, 200);
  // After the window the page is asked for again, and when it answers its words are kept.
  advance(6 * 3_600_000 + 1);
  reader.behaviour = async () => ({ text: PAGE_ZH_EN });
  assert.match((await ask(pages))?.eligibility ?? "", /Inclusion Criteria/u);
  assert.equal(reader.calls.length, 2);
});

test("a page that reads and holds no section is remembered like a failure, and says so", async () => {
  const { pages, reader, store, advance } = setup({ text: NAV });
  assert.equal(await ask(pages), null);
  assert.equal(await ask(pages), null);
  assert.equal(reader.calls.length, 1);
  assert.equal(store.rows.get("chictr\u0000ChiCTR2000099999").reason, "eligibility_not_located");
  advance(7 * 3_600_000);
  assert.equal(await ask(pages), null);
  assert.equal(reader.calls.length, 2, "and is looked at again once the window is over");
});

test("a read that does not finish in time is none: the deadline holds even for a reader that ignores its signal", async () => {
  const { pages, reader, store } = setup({ config: { vcrRegistryPageTimeoutMs: 1_000 } });
  reader.behaviour = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await ask(pages), null);
  assert.ok(Date.now() - started < 3_000);
  assert.equal(store.rows.get("chictr\u0000ChiCTR2000099999").reason, "registry_page_timeout");
});

test("words that were read keep standing when their days are over and the page cannot be read again", async () => {
  const { pages, reader, advance, counters } = setup();
  const first = await ask(pages);
  advance(8 * 24 * 3_600_000);
  reader.behaviour = async () => { throw Object.assign(new Error("down"), { code: "web_read_upstream_error" }); };
  const later = await ask(pages);
  assert.equal(later?.eligibility, first?.eligibility, "the record's hash does not flip to none because a browser was down");
  assert.equal(reader.calls.length, 2);
  assert.equal(counters.keptOld, 1);
  // And the failed attempt is remembered too.
  await ask(pages);
  assert.equal(reader.calls.length, 2);
  // A later success replaces the words.
  advance(7 * 3_600_000);
  reader.behaviour = async () => ({ text: "| 纳入标准： | （1） 新的条件。 |\n" });
  assert.equal((await ask(pages))?.eligibility, "Inclusion Criteria:\n（1） 新的条件。");
});

// Production 2026-11-14: a matching commit re-read its trials inside its transaction. ChiCTR answers this host 405, so each such read failed, and
// the failure was written inside the commit: the row stayed locked until the commit ended (104 writes cancelled waiting on it) and was lost with a
// commit that did not save, so 56 pages were asked 327 times.
test("an ask that reads nothing returns the words that are held and never asks the site or writes", async () => {
  const { pages, reader, store } = setup();
  const quiet = () => pages.eligibilityFor({ registry: "chictr", registryId: "ChiCTR2000099999", url: URL_OF(99999), cachedOnly: true });
  assert.equal(await quiet(), null);
  assert.equal(reader.calls.length, 0);
  assert.equal(store.rows.size, 0);
  const read = await ask(pages);
  assert.deepEqual(await quiet(), read);
  assert.equal(reader.calls.length, 1);
});

test("the page cache writes outside the transaction its caller holds, and reads inside it", async () => {
  let apart = 0;
  /** @type {Array<[string, number]>} */
  const statements = [];
  const database = {
    withoutTransactionClient(/** @type {() => any} */ work) { apart += 1; return work(); },
    transaction: async (/** @type {(client: any) => Promise<any>} */ operation) => operation({ query: async (/** @type {string} */ sql) => { statements.push([String(sql).trim().split(/\s+/u)[0], apart]); return { rows: [] }; } }),
  };
  const store = new VcrRegistryPageStore({ database });
  store.ready = async () => {};
  const at = new Date("2026-11-14T10:00:00Z");
  await store.get({ registry: "chictr", registryId: "ChiCTR2000099999" });
  await store.saveFailed({ registry: "chictr", registryId: "ChiCTR2000099999", url: URL_OF(99999), reason: "web_read_upstream_error", at });
  await store.saveRead({ registry: "chictr", registryId: "ChiCTR2000099999", url: URL_OF(99999), eligibility: "Inclusion Criteria:\nAdults.", at });
  assert.deepEqual(statements.filter(([word]) => word !== "SET"), [["SELECT", 0], ["INSERT", 1], ["INSERT", 2]]);
});

test("only ChiCTR's own pages are read, and only where the switch is on", async () => {
  const { pages, reader } = setup();
  assert.equal(await pages.eligibilityFor({ registry: "clinicaltrials.gov", registryId: "NCT00000001", url: URL_OF(1) }), null);
  assert.equal(await pages.eligibilityFor({ registry: "chictr", registryId: "ChiCTR1", url: "https://internal.example.org/showproj.html?proj=1" }), null);
  assert.equal(await pages.eligibilityFor({ registry: "chictr", registryId: "ChiCTR1", url: "http://www.chictr.org.cn/showproj.html?proj=1" }), null);
  assert.equal(await pages.eligibilityFor({ registry: "chictr", registryId: "ChiCTR1", url: "" }), null);
  assert.equal(reader.calls.length, 0);
  const off = setup({ config: { vcrRegistryPagesEnabled: false } });
  assert.equal(await ask(off.pages), null);
  assert.equal(off.reader.calls.length, 0);
});

test("a store that fails is a pair judged on the listing, not an error", async () => {
  const { pages, store, reports } = setup();
  store.get = async () => { throw Object.assign(new Error("database down"), { code: "ECONNREFUSED" }); };
  assert.equal(await ask(pages), null);
  assert.deepEqual(reports, ["registry_page_ECONNREFUSED"]);
});

// ---- the target a judgment reads

/** An evidence double: the registry's listing of a ChiCTR trial (title, condition, address; no eligibility text). */
const listing = (extra = {}) => ({ async judgmentRecord({ registryId }) {
  return { status: "ok", trial: { registry: "chictr", registryId, title: "示例研究", summary: "", eligibility: "", conditions: ["二型糖尿病"], interventions: [], url: URL_OF(99999), status: "招募中", phase: "II期", recordHash: "a".repeat(64), ...extra } };
} });
const input = { userId: "u1", registry: "chictr", registryId: "ChiCTR2000099999" };

test("a ChiCTR target carries the page's words, their source and time, clauses to judge, and the same hash on every read of the same page", async () => {
  const { pages, reader } = setup();
  const targets = judgmentTargets({ evidence: listing(), matchStore: null, pages });
  const first = await targets.trial(input);
  const second = await targets.trial(input);
  assert.equal(first.eligibilitySource, "web_read");
  assert.equal(first.clauses.length, 4);
  assert.deepEqual(first.summaryOfTarget.eligibilityPage, { url: URL_OF(99999), fetchedAt: "2026-11-04T10:00:00.000Z" });
  assert.equal(first.hash, second.hash);
  assert.equal(reader.calls.length, 1, "the second read of the target made no request");
});

test("a ChiCTR target whose page gave nothing is judged on its listing, with eligibility source none and no refusal; a failure is not retried per pair", async () => {
  const { pages, reader } = setup();
  reader.behaviour = async () => { throw Object.assign(new Error("blocked"), { code: "web_read_upstream_error" }); };
  const targets = judgmentTargets({ evidence: listing(), matchStore: null, pages });
  const reads = await Promise.all(Array.from({ length: 30 }, () => targets.trial(input)));
  assert.ok(reads.every((target) => target.eligibilitySource === "none" && target.clauses.length === 0 && target.title === "示例研究"));
  assert.equal(reader.calls.length, 1);
  assert.equal(new Set(reads.map((target) => target.hash)).size, 1);
  assert.equal(reads[0].summaryOfTarget.eligibilityPage, undefined);
});

test("what the registry's own record says is never replaced by a page, and a pages module that throws changes nothing", async () => {
  const { pages, reader } = setup();
  const ctgov = judgmentTargets({ evidence: listing({ registry: "clinicaltrials.gov", eligibility: "Inclusion Criteria:\n* Age >= 18" }), matchStore: null, pages });
  assert.equal((await ctgov.trial({ ...input, registry: "clinicaltrials.gov" })).eligibilitySource, "registry");
  assert.equal(reader.calls.length, 0);
  const broken = judgmentTargets({ evidence: listing(), matchStore: null, pages: { async eligibilityFor() { throw new Error("boom"); } } });
  assert.equal((await broken.trial(input)).eligibilitySource, "none");
  const without = judgmentTargets({ evidence: listing(), matchStore: null });
  assert.equal((await without.trial(input)).eligibilitySource, "none");
});
