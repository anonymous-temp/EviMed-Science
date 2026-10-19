// scripts/ops/ui-walk.mjs: its budgets name the pages it walks, it walks every
// GEO tab, it starts no runtime, and a font-pair count is a notice. R10 added
// four checks (DESIGN.md 「页面结构」): neither retired module name on any page,
// one primary action in a page header, a page body that stacks no more kinds of
// section than its budget, and a first row of each list that shows something
// when it is clicked.
//
// The walk drives a real browser against a live deployment. Its verdict and
// budget tables are imported directly; its control flow is run against a
// scripted stand-in for playwright-core that records what the walk asked of
// the browser (2026-09-26 fusion audit, F-G2, F-G14 and F-G20).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import {
  AFTER_CLICK_KIND, afterClickFindings, afterClickProbe, BACK_OFFICE, BUDGET_BY_PAGE, budgetKey, cleanupFindings, cleanupNotices, clickNamed, clickRowTitled,
  EXPECTED_REFUSALS, focusProbe, frontierTargets, frontierItemRoute, GEO_TABS, geoAnswerSnapshot, HEADING_ORDER_PAGES, keylessTitles, knowledgeProbe, knowledgeReturnFindings,
  matrixFindings, matrixProbe, matrixRoute, measure, measureStructure, MISSING_RECORDS, ORIGINAL_MIN_WIDTH,
  pageFindings, pageProbe, PAGE_PROBES, pdfFrameReady, pdfPreviewFindings, pdfProbe, pdfSourceTitle, pickVcrStudies, probeFindings,
  readerFindings, readerProbe, readerReady, RETIRED_NAMES, ROUTES, ROW_CLICK_PAGES, rowClickFindings, rowClickShown,
  rowClickVerdict, rowProbe, sameBox, SECTION_SHAPES_BY_PAGE, skillDrawerFindings, skillDrawerProbe, sourceReaderRoute, structureFindings, tabOrderFindings,
  OPERATOR_SENTENCES, addressAct, ADDRESS_CASES, addressOpenFindings, addressProbe, addressStateFindings, addressStateHolds, AXE_RULES_PER_NOTICE, AXE_TAGS, axeLoaded, axeNotices,
  axeRun, axeVersionOf, composerFindings, composerProbe, COMPOSER_BOTTOM_PX, loadAxeSource, scanWithAxe,
  asFinding, CAPTURE_MAX_SLICES, CAPTURE_QUALITY, findingText, STEP_TARGETS,
  handoffFindings, handoffProbe, HANDOFF_FIELDS, knowledgeGraphFindings, KNOWLEDGE_VIEWS, memoryMapFindings, MEMORY_MAP_VIEWS, navigateForWalk, recoverWalkLoad, routeLoadProbe, memoryRowCoverage, dailyRowCoverage, taskPageFindings, taskPaneReady, TYPE_PAIR_NOTICE, unexpectedRefusals, VCR_TABS_WALK,
} from "../../../scripts/ops/ui-walk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The pages the walk finds by an id in a list the deployment answers, so that no static route names them. */
const DISCOVERED_PAGES = ["geo-answer", "frontier-item", "frontier-zone", "frontier-evidence", "frontier-author", "frontier-event", "evidence-matrix", "files-reader"];

/** The address a page of the walk is opened at, with the fake deployment's ids filled in for the pages it discovers. */
function routeOf(name) {
  const fixed = ROUTES.find(([route]) => route === name);
  if (fixed) return fixed[1];
  const geo = GEO_TABS.find(([route]) => route === name);
  if (geo) return `/app/geo/geo_1${geo[1]}`;
  throw new Error(`no address known for ${name}`);
}

/** A page that measures clean, as `measure` would report it. */
function clean(overrides = {}) {
  return {
    title: "知识库 · EviMed", controlKinds: 5, colorKinds: 4, borderKinds: 2, sizeWeightPairs: ["14px/400", "24px/600"],
    pageLefts: [240], rowTitleLefts: [], subtitle: [], backOfficeHits: [], retiredNameHits: [], headerPrimaryActions: [], sectionShapes: ["ul>li"],
    leakHits: [], unnamedControls: [], overflowX: false, smallTargets: 0, decorativeSvgs: 0, ...overrides,
  };
}

test("every page the budget table names is a page the walk visits", () => {
  // The table said `knowledge`; the route is `files`, so the knowledge base
  // kept the reading budget and failed on its ninth control.
  const walked = new Set([...ROUTES.map(([name]) => name), ...GEO_TABS.map(([name]) => name), ...VCR_TABS_WALK.map(([name]) => name), ...DISCOVERED_PAGES]);
  for (const name of Object.keys(BUDGET_BY_PAGE)) assert.ok(walked.has(name), `the budget names ${name}, which no route walks`);
  for (const name of Object.keys(SECTION_SHAPES_BY_PAGE)) assert.ok(walked.has(name), `the section budget names ${name}, which no route walks`);
  for (const name of ROW_CLICK_PAGES) assert.ok(walked.has(name), `the row-click list names ${name}, which no route walks`);
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9 }), []).failures, []);
  assert.equal(pageFindings("files", "desktop", clean({ controlKinds: 11 }), []).failures.length, 1);
});

test("the evidence zones' home keeps four borders and a published daily's lead allows ten controls", () => {
  const zones = (overrides) => pageFindings("frontier-zones", "desktop", clean({ controlKinds: 8, colorKinds: 5, ...overrides }), []).failures;
  assert.deepEqual(zones({ borderKinds: 4 }), []);
  assert.deepEqual(zones({ borderKinds: 5 }), ["frontier-zones@desktop: 5 kinds of border (budget 4)"]);
  // The feed's own pages keep the reading page's three.
  assert.deepEqual(pageFindings("frontier", "desktop", clean({ controlKinds: 8, borderKinds: 4 }), []).failures, ["frontier@desktop: 4 kinds of border (budget 3)"]);
  const daily = (controlKinds) => pageFindings("frontier-daily", "desktop", clean({ controlKinds }), []).failures;
  assert.deepEqual(daily(9), []);
  assert.deepEqual(daily(10), []);
  assert.deepEqual(daily(11), ["frontier-daily@desktop: 11 kinds of control (budget 10)"]);
});

test("every page the router serves at a fixed address is walked, or says why it is not", async () => {
  // The extension centre's two pages and the evidence zones' home shipped
  // without the walk ever opening them (found 2026-10-03): the route list is
  // written by hand and nothing compared it with the router.
  const router = await readFile(path.join(repoRoot, "apps/web/src/app/router.tsx"), "utf8");
  const app = router.slice(router.indexOf('path: "/app"'), router.indexOf('{ path: "*", element: <NotFound /> }'));
  // One route with an optional last parameter serves the fixed page in front of it too: `autopilot/:taskId?` is /app/autopilot (the list)
  // and /app/autopilot/<id> (one task), and R13 made the task page one route with the list. An address with any other parameter, or a
  // splat, is not a fixed page: its pages are found from the deployment's lists (`discoverRoutes`).
  const pages = [...new Set([...app.matchAll(/\{ path: "([^"]+)", element: <(\w+)/g)]
    .filter(([, , element]) => element !== "Navigate")
    .map(([, address]) => address.replace(/\/:\w+\?$/, ""))
    .filter((address) => !address.includes(":") && !address.includes("*"))
    .map((address) => `/app/${address}`))];
  assert.ok(pages.length >= 12 && ["/app/frontier", "/app/account", "/app/autopilot"].every((page) => pages.includes(page)), `read ${pages.length} fixed pages from the router; the scan did not walk`);
  const notWalked = {
    "/app/chat": "the conversation is the kernel's own frame; OPEN_SCIENCE_WALK_CHAT=1 opens it",
    "/app/handoff": "opens only with a hand-off in the address; without one it returns to the conversation",
    "/app/runs": "a redirect to the newest run's conversation, decided at run time",
    "/app/files/open": "a compiled file named by its place: it reads the file and goes to the document's page, which `files-reader` walks",
  };
  const walked = new Set(ROUTES.map(([, address]) => address.split("?")[0]));
  const missing = pages.filter((page) => !walked.has(page) && !Object.hasOwn(notWalked, page));
  assert.deepEqual(missing, [], `the router serves ${missing.join(", ")} and the walk never opens ${missing.length === 1 ? "it" : "them"}: add a ROUTES row, or name the reason here`);
  for (const page of Object.keys(notWalked)) assert.ok(pages.includes(page), `${page} is exempted, and the router no longer serves it; drop the row`);
});

test("the walk covers every tab a study has, and the domain is where the list lives", async () => {
  // The browser derives its tabs from `@evimed/domain`'s VCR_TABS rather than
  // restating them, so this reads the domain and compares the walk to it. A
  // tab added there and not here is a page nobody looks at again.
  const { VCR_TABS } = await import("@evimed/domain");
  const walked = VCR_TABS_WALK.map(([name]) => name.replace(/^vcr-/, ""));
  assert.deepEqual(walked, [...VCR_TABS], "the walk's tab list is the domain's, in the domain's order");
  const browser = await readFile(path.join(repoRoot, "apps/web/src/components/vcr/vcrTabs.ts"), "utf8");
  assert.match(browser, /VCR_TABS/, "the page derives its tabs from the domain; a hand-written list here would drift");
});

test("the walk covers every tab a GEO project has", async () => {
  const tabs = await readFile(path.join(repoRoot, "apps/web/src/components/geo/geoTabs.ts"), "utf8");
  const list = tabs.slice(tabs.indexOf("GEO_TABS"), tabs.indexOf("];", tabs.indexOf("GEO_TABS")));
  const keys = [...list.matchAll(/key: "([a-z]+)"/g)].map((match) => match[1]);
  assert.equal(keys.length, 8, `read the app's GEO tabs (${keys.join(", ")})`);
  assert.deepEqual(GEO_TABS.map(([, segment]) => segment), keys.map((key) => (key === "overview" ? "" : `/${key}`)));
  for (const [name] of GEO_TABS) assert.ok(BUDGET_BY_PAGE[name], `${name} has the GEO budget`);
});

test("a GEO tab may spend the six kinds of border it was measured at, not a seventh", () => {
  assert.deepEqual(pageFindings("geo-overview", "desktop", clean({ borderKinds: 6 }), []).failures, []);
  assert.deepEqual(pageFindings("geo-overview", "desktop", clean({ borderKinds: 7 }), []).failures, ["geo-overview@desktop: 7 kinds of border (budget 6)"]);
  // The knowledge base is a data page but not a GEO page: its borders stay three.
  assert.equal(pageFindings("files", "desktop", clean({ borderKinds: 4 }), []).failures.length, 1);
});

test("more than four font-size × weight pairs is a finding with a number, which only the baseline accepts", () => {
  const pairs = ["12px/400", "13px/400", "14px/400", "14px/500", "24px/600"];
  const verdict = pageFindings("memory", "desktop", clean({ sizeWeightPairs: pairs }), []);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.notices.length, 1);
  assert.equal(asFinding(verdict.notices[0]).rule, "type-pairs");
  assert.equal(asFinding(verdict.notices[0]).value, 5);
  assert.match(findingText(verdict.notices[0]), new RegExp(`memory@desktop: 5 font-size × weight pairs \\(rule ${TYPE_PAIR_NOTICE}\\)`));
  assert.deepEqual(pageFindings("memory", "desktop", clean({ sizeWeightPairs: pairs.slice(0, 4) }), []).notices, []);
  // Measured at the desktop width only, like the rest of the style budget.
  assert.deepEqual(pageFindings("memory", "phone", clean({ sizeWeightPairs: pairs }), []).notices, []);
});

/**
 * A page for `measure` to read without a browser: each control is described
 * by its tag, its box height, its computed style and the height its own CSS
 * declares (`auto` unless it sets one) — the few DOM calls `measure` makes,
 * answered from that description. Returns what `measure` returned.
 */
function measureControls(controls) {
  const base = {
    display: "block", visibility: "visible", opacity: "1", color: "rgb(20, 20, 20)", backgroundColor: "rgba(0, 0, 0, 0)",
    fontSize: "14px", fontWeight: "400", lineHeight: "22px", borderTopLeftRadius: "0px", paddingTop: "0px", paddingBottom: "0px",
    clip: "auto", clipPath: "none",
    ...Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((side) => [
      [`border${side}Width`, "0px"], [`border${side}Style`, "none"], [`border${side}Color`, "rgb(20, 20, 20)"],
    ])),
  };
  const matchesOne = (el, part) => {
    if (part === "body *") return true;
    const attribute = /^\[([\w-]+)(?:='([^']*)')?\]$/.exec(part);
    if (attribute) return attribute[2] === undefined ? attribute[1] in el.attributes : el.attributes[attribute[1]] === attribute[2];
    return el.tag === part;
  };
  const make = ({ tag, text = "", height, width = 120, declaredHeight = "auto", declaredMinHeight = "auto", icon = false, style = {}, statusMark = false, chartMark = false, chartRoot = false }) => {
    const el = {
      tag, text, attributes: {}, tagName: tag.toUpperCase(), id: "", style: { ...base, ...style },
      children: [], childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
      get textContent() { return text; },
      getBoundingClientRect: () => ({ width, height, left: 0 }),
      computedStyleMap: () => ({ get: (property) => ({ toString: () => (property === "height" ? declaredHeight : property === "min-height" ? declaredMinHeight : "auto") }) }),
      matches: (selector) => selector.split(",").some((part) => matchesOne(el, part.trim())),
      querySelector: (selector) => el.children.find((child) => child.matches(selector)) ?? null,
      getAttribute: (name) => el.attributes[name] ?? null,
      closest: (selector) => selector === "[data-status-mark]" ? (statusMark ? el : null)
        : selector === "[data-geo-chart][aria-hidden='true']" ? (chartRoot ? el : chartMark ? {} : null) : null,
    };
    if (icon) el.children.push(make({ tag: "svg", height: 16 }));
    if (icon) el.children[0].attributes["aria-hidden"] = "true";
    return el;
  };
  const elements = controls.map(make).flatMap((el) => [el, ...el.children]);
  const body = { innerText: controls.map((control) => control.text ?? "").join("\n"), contains: () => true };
  const saved = Object.fromEntries(["document", "window", "getComputedStyle", "CSS"].map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, {
    document: {
      body,
      title: "知识库 · EviMed",
      documentElement: { scrollWidth: 1512 },
      querySelector: () => null,
      querySelectorAll: (selector) => elements.filter((el) => el.matches(selector)),
    },
    window: { innerWidth: 1512 },
    getComputedStyle: (el) => el.style,
    CSS: { escape: (value) => value },
  });
  try {
    return measure([[], BACK_OFFICE.map(re => [re.source, re.flags]), RETIRED_NAMES.map(re => [re.source, re.flags])]);
  } finally {
    Object.assign(globalThis, saved);
  }
}

test("the back-office list still catches a ledger count, and lets the evidence card's 引文已核对 n/m through", () => {
  const caught = (text) => BACK_OFFICE.some((re) => re.test(text));
  assert.equal(caught("已核对 41/72"), true);
  assert.equal(caught("核对 37 条"), true);
  assert.equal(caught("引文已核对 1/2"), false);
  assert.equal(caught("解读 · 综合 · 引文已核对 1/2"), false);
});

test("an effective date is the back office as a label, and a news item's own date when it stands in a sentence", () => {
  const caught = (text) => BACK_OFFICE.some((re) => re.test(text));
  assert.equal(caught("第 2 版 · 9月18日起生效"), true);
  assert.equal(caught("9月18日起生效"), true);
  // 前沿动态 on 2026-10-12: a regulation's own date failed the walk.
  assert.equal(caught("新规将于2026年10月20日起生效"), false);
  assert.equal(caught("自10月20日起生效"), false);
});

test("the back-office list is the shapes of the back office's own labels and the runtime's vocabulary, and holds no sentence (R19 S4)", () => {
  // Seventy-four entries went in R19: 55 are phrases `apps/web/src/app/retiredWords.test.ts` bans in the web source with the reason beside each,
  // 19 are sentences no source file has any more. A sentence on a page is now an `orphan-sentence` when it stands alone, a note carries an
  // action or a number by its type, and a sentence the control plane writes for the operator is matched exactly. The list may only get shorter.
  assert.ok(BACK_OFFICE.length <= 19, `${BACK_OFFICE.length} entries: do not add a phrase here; a source's sentence is retiredWords.test.ts's, an operator's is OPERATOR_SENTENCES`);
  const caught = (text) => BACK_OFFICE.some((re) => re.test(text));
  for (const text of ["已交付", "状态：已交付", "未验证", "缓存命中", "12.4 tok/s", "3,200 tokens", "openFDA 药品召回", "处理第 3 代", "统计复核 已复核（昨天）", "临床复核：未复核", "模型推断 4", "你已确认 2",
    "引擎 meta-v2 · 方法 dersimonian-laird · 回执", "Unexpected Application Error", "Failed to fetch dynamically imported module"]) {
    assert.equal(caught(text), true, text);
  }
  // A researcher's own words, and a sentence the list used to carry, are not the list's business.
  for (const text of ["统计复核 · 昨天", "陈统计 修改 · 昨天", "对照组 ORR", "人工临床复核 · 已有修订建议", "一项还未验证的假设需要进一步研究", "修订已交付报告后重系引证与数值", "来源未验证 · 不会带上 1 条", "只分享文字，不含脚本"]) {
    assert.equal(caught(text), false, text);
  }
});

test("a sentence written for the operator, said exactly on a researcher's page, fails it; the operator's own page may say it", () => {
  const sentences = OPERATOR_SENTENCES;
  assert.ok(sentences.length > 100 && sentences.every((sentence) => sentence.length >= 12), `${sentences.length} operator sentences, all of at least twelve characters`);
  const said = sentences[0];
  const page = (text) => inPage(node("body", {}, [node("main", {}, [node("p", { text })])]), () => measure([[], [], [], sentences]));
  assert.deepEqual(page(`前面的话。${said}后面的话。`).operatorSentenceHits, [said.slice(0, 60)]);
  assert.deepEqual(page("一页什么都没有说的文字，更没有说运维的话。").operatorSentenceHits, []);
  const measured = { ...clean(), operatorSentenceHits: [said.slice(0, 60)] };
  assert.deepEqual(pageFindings("inbox", "desktop", measured, []).failures, [`inbox@desktop: a sentence written for the operator is on a person's page: “${said.slice(0, 60)}”`]);
  assert.deepEqual(pageFindings("ops", "desktop", measured, []).failures, [], "the operator's console is where those sentences belong");
});

/** A list row's title: a text button with no height of its own, `lines` lines of 22 px. */
const title = (lines) => ({ tag: "button", text: "一个很长的资料标题".repeat(lines), height: 22 * lines });

test("a text control that wraps is one kind of control, and a control with a height of its own is not", () => {
  // A list row's title is a button with no height of its own: one line is
  // 22 px, two are 44, three are 66 — one kind, as a wrapped inline link is.
  const wrapped = measureControls([title(1), title(2), title(3)]);
  assert.equal(wrapped.controlKinds, 1);
  assert.deepEqual(Object.keys(wrapped.controlLooks), ["text 14px/400 r0px"]);
  assert.equal(wrapped.controlLooks["text 14px/400 r0px"].count, 3);

  // A 44 px button whose CSS sets that height is a control of its own, though
  // 44 is two of its lines; so is a title with an icon in it, and a text
  // control stretched to a height that is not a whole number of its lines.
  const fixed = { tag: "button", text: "开始研究", height: 44, declaredHeight: "44px" };
  const withIcon = { tag: "a", text: "知识库", height: 44, icon: true };
  const stretched = { tag: "button", text: "全部", height: 30 };
  const mixed = measureControls([title(1), title(2), fixed, withIcon, stretched]).controlLooks;
  assert.deepEqual(Object.keys(mixed), ["text 14px/400 r0px", "44h 14px/400 r0px", "30h 14px/400 r0px"]);
  assert.equal(mixed["44h 14px/400 r0px"].count, 2);

  // What surrounds the lines is part of the look: a padded text button is a
  // kind beside the bare title, whether it wraps or not.
  const padded = (lines) => ({ ...title(lines), height: 22 * lines + 8, style: { paddingTop: "4px", paddingBottom: "4px" } });
  const measured = measureControls([title(1), padded(1), padded(2)]);
  assert.equal(measured.controlKinds, 2);
  assert.deepEqual(measured.controlLooks["text+8 14px/400 r0px"], { count: 2, example: "button: 一个很长的资料标题" });
  // An inline link stays what it was.
  assert.equal(measureControls([{ tag: "a", text: "原文", height: 44, style: { display: "inline" } }]).controlLooks["inline 14px/400 r0px"].count, 1);
});

test("a card its text grows past its minimum height is one kind at every height", () => {
  // 科研工具's tools are `min-h-32` cards with an icon: descriptions of three
  // lengths drew 136, 162 and 182 px and read as three kinds (2026-10-06 walk).
  const card = (height) => ({ tag: "button", text: "用“科研工具”开始一次对话", height, icon: true, declaredMinHeight: "128px", style: { borderTopLeftRadius: "12px" } });
  const grown = measureControls([card(136), card(162), card(182)]);
  assert.deepEqual(Object.keys(grown.controlLooks), ["min128+ 14px/400 r12px"]);
  assert.equal(grown.controlLooks["min128+ 14px/400 r12px"].count, 3);
  // At its minimum it is measured as any control is, and a control whose CSS
  // sets its height keeps that height as its kind.
  const atMinimum = measureControls([card(128), { tag: "button", text: "开始研究", height: 44, declaredHeight: "44px" }]);
  assert.deepEqual(Object.keys(atMinimum.controlLooks), ["128h 14px/400 r12px", "44h 14px/400 r0px"]);
});

test("a status ring drawn by code is a mark, not a kind of border", () => {
  // Spec §7.2: 「焦点环和进度轨的状态环不是描边」. A progress-rail step and a
  // next-step dot say so with data-status-mark; three of GEO's eight border
  // kinds were these rings (2026-09-27 walk). A ring without the mark counts.
  const ring = (width, color, mark) => ({
    tag: "span", height: 14, width: 14, statusMark: mark,
    style: Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((side) => [
      [`border${side}Width`, width], [`border${side}Style`, "solid"], [`border${side}Color`, color],
    ])),
  });
  const card = ring("1px", "rgb(228, 232, 236)", false);
  const marked = measureControls([card, ring("2px", "rgb(10, 93, 193)", true), ring("1px", "rgb(133, 142, 151)", true)]);
  assert.equal(marked.borderKinds, 1);
  const unmarked = measureControls([card, ring("2px", "rgb(10, 93, 193)", false)]);
  assert.equal(unmarked.borderKinds, 2);
});

test("a visually hidden control is not a kind of control on the page", () => {
  // The skip link is clipped to a 1 px box until it has focus (`sr-only`);
  // it counted as a kind of control on every page.
  const skip = { tag: "a", text: "跳到主要内容", height: 1, width: 1, style: { clip: "rect(0px, 0px, 0px, 0px)" } };
  const measured = measureControls([skip, title(1)]);
  assert.equal(measured.controlKinds, 1);
  assert.deepEqual(Object.keys(measured.controlLooks), ["text 14px/400 r0px"]);
  // Clipped by a clip path, the same.
  assert.equal(measureControls([{ ...skip, width: 120, height: 22, style: { clipPath: "inset(50%)" } }, title(1)]).controlKinds, 1);
});

/**
 * A small DOM for the structural measures — what a page stacks, what its
 * header holds, and the first row of a list — which read the page's shape, not
 * only its controls. `node(tag, options, children)` builds an element with its
 * parent links; `inPage(root, fn)` installs it as `document` for one call. The
 * selector engine knows what `measure` and `rowProbe` ask: comma lists, a
 * descendant chain, a tag, `.class`, `[attr]`, `[attr='value']`, `*`, and the
 * one `:scope > li [data-row-title]`.
 */
function node(tag, { attrs = {}, text = "", w = 600, h = 24, left = 0, top = 0, style = {}, scrollW = w, scrollH = h, tabIndex = -1, open = false, value = null } = {}, children = []) {
  const el = {
    tag, text, attrs, children, parent: null, tagName: tag.toUpperCase(), clicks: 0, value, rect: { width: w, height: h, left, top },
    clientWidth: w, clientHeight: h, scrollWidth: scrollW, scrollHeight: scrollH, tabIndex, open,
    get previousElementSibling() { return el.parent ? el.parent.children[el.parent.children.indexOf(el) - 1] ?? null : null; },
    style: {
      display: "block", visibility: "visible", opacity: "1", color: "rgb(20, 20, 20)", backgroundColor: "rgba(0, 0, 0, 0)", fontSize: "14px",
      fontWeight: "400", lineHeight: "22px", borderTopLeftRadius: "0px", paddingTop: "0px", paddingBottom: "0px", clip: "auto", clipPath: "none",
      ...Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((side) => [[`border${side}Width`, "0px"], [`border${side}Style`, "none"], [`border${side}Color`, "rgb(20, 20, 20)"]])),
      ...style,
    },
    id: attrs.id ?? "", childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
    get textContent() { return text + children.map((child) => child.textContent).join(""); },
    get parentElement() { return el.parent; },
    classList: { contains: (name) => (attrs.class ?? "").split(/\s+/).includes(name) },
    getAttribute: (name) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ ...el.rect, right: el.rect.left + el.rect.width, bottom: el.rect.top + el.rect.height }),
    computedStyleMap: () => ({ get: () => ({ toString: () => "auto" }) }),
    click() { el.clicks += 1; },
    contains: (other) => { for (let at = other; at; at = at.parent) if (at === el) return true; return false; },
    matches: (selector) => selector.split(",").some((part) => simple(el, part.trim())),
    closest: (selector) => { for (let at = el; at; at = at.parent) if (at.matches(selector)) return at; return null; },
    querySelectorAll: (selector) => queryAll(el, selector),
    querySelector: (selector) => queryAll(el, selector)[0] ?? null,
  };
  for (const child of children) child.parent = el;
  return el;
}

function simple(el, selector) {
  if (selector === "*") return true;
  const tag = /^[a-z][a-z0-9]*/.exec(selector)?.[0];
  if (tag && el.tag !== tag) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(name)) return false;
  for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:='([^']*)')?\]/g)) {
    if (value === undefined ? !(name in el.attrs) : el.attrs[name] !== value) return false;
  }
  return true;
}

function descendants(root) { return root.children.flatMap((child) => [child, ...descendants(child)]); }

function queryAll(root, selector) {
  const found = [];
  for (const part of selector.split(/,(?![^[]*\])/).map((entry) => entry.trim())) {
    if (part.startsWith(":scope > ")) {
      const [first, ...rest] = part.slice(":scope > ".length).split(" ");
      for (const child of root.children.filter((entry) => simple(entry, first))) {
        found.push(...(rest.length ? queryAll(child, rest.join(" ")) : [child]));
      }
      continue;
    }
    const chain = part.split(/\s+/);
    for (const el of descendants(root)) {
      if (!simple(el, chain[chain.length - 1])) continue;
      let at = el.parent;
      let ok = true;
      for (let i = chain.length - 2; i >= 0 && ok; i -= 1) {
        while (at && !simple(at, chain[i])) at = at.parent;
        ok = Boolean(at);
        at = at?.parent;
      }
      if (ok) found.push(el);
    }
  }
  // Document order, as the browser answers.
  const order = descendants(root);
  return [...new Set(found)].sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

/** Run `fn` with `root` (a <body>) installed as the page. */
function inPage(root, fn, { path = "/app/files" } = {}) {
  const saved = Object.fromEntries(["document", "window", "getComputedStyle", "CSS", "location"].map((name) => [name, globalThis[name]]));
  const body = Object.assign(root, { innerText: descendants(root).map((el) => el.text).filter(Boolean).join("\n") });
  Object.assign(globalThis, {
    document: { body, title: "页面 · EviMed", documentElement: { scrollWidth: 1512, scrollHeight: 945 }, activeElement: null, querySelector: (selector) => queryAll(body, selector)[0] ?? null, querySelectorAll: (selector) => queryAll(body, selector) },
    window: { innerWidth: 1512, innerHeight: 945 },
    getComputedStyle: (el) => el.style,
    CSS: { escape: (value) => value },
    location: { pathname: path, search: "" },
  });
  try { return fn(); } finally { Object.assign(globalThis, saved); }
}

const row = (title, extra = {}) => node("li", {}, [node("button", { attrs: { "data-row-title": "" }, text: title, ...extra })]);
const list = (rows, label = "资料") => node("ul", { attrs: { "aria-label": label }, h: 24 * rows.length }, rows.map((title) => row(title)));
const header = (...buttons) => node("header", {}, [node("h1", { text: "知识库" }), node("div", {}, buttons.map(([name, classes]) => node("button", { text: name, attrs: { class: classes } })))]);
const page = (...blocks) => node("body", {}, [node("main", {}, [node("div", {}, blocks)])]);
const shapesOf = (...blocks) => inPage(page(header(), ...blocks), () => measure([[], [], []])).sectionShapes;

test("a page that stacks a list, a table and a chart stacks three kinds of section; repeated groups are one kind", () => {
  const group = (name) => node("section", { h: 80 }, [node("h2", { text: name }), list(["一行"])]);
  const table = node("table", { h: 120 }, [node("thead"), node("tbody")]);
  const chart = node("svg", { w: 480, h: 200 }, [node("g")]);
  assert.deepEqual(shapesOf(list(["一行", "二行"])), ["ul>li"]);
  // The skills page's six groups, a feed's one group per day: one shape however many the data has.
  assert.deepEqual(shapesOf(group("我的技能"), group("科研分析"), group("写作与核查"), group("办公文档")), ["section>h2+ul"]);
  assert.deepEqual(shapesOf(chart, list(["一行"]), table), ["svg>g", "ul>li", "table>thead+tbody"]);
  // What sits inside a section, a dialog, the sidebar or a tab strip is not a section of the page; neither is an icon.
  const inside = node("section", { h: 300 }, [node("h2", { text: "组" }), list(["一行"]), node("svg", { w: 480, h: 200 }, [node("g")])]);
  const dialog = node("div", { attrs: { role: "dialog" } }, [list(["抽屉里的清单"]), table]);
  const sidebar = node("nav", {}, [list(["项目"])]);
  const tabs = node("div", { attrs: { role: "tablist" } }, [node("ul", {}, [node("li")])]);
  const icon = node("svg", { w: 16, h: 16 }, [node("path")]);
  assert.deepEqual(shapesOf(inside, dialog, sidebar, tabs, icon), ["section>h2+ul"]);
});

test("a page over its section budget fails, one inside it does not, and a page with no budget is not held to one", () => {
  const stacked = ["ul>li", "table>thead+tbody", "svg>g"];
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9, sectionShapes: stacked }), []).failures,
    ["files@desktop: the page stacks 3 kinds of section (budget 2): ul>li, table>thead+tbody, svg>g"]);
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9, sectionShapes: stacked.slice(0, 2) }), []).failures, []);
  assert.deepEqual(pageFindings("account", "desktop", clean({ sectionShapes: stacked }), []).failures, []);
  // Measured at the desktop width, like the rest of the style budget.
  assert.deepEqual(pageFindings("files", "phone", clean({ sectionShapes: stacked }), []).failures, []);
  // The pages R10 rebuilt are all held to one, and the study's tabs to three.
  for (const name of ["files", "memory", "frontier", "capabilities", "extensions-skills", "extensions-plugins", "virtual-research", "vcr-overview"]) {
    assert.ok(Number.isInteger(SECTION_SHAPES_BY_PAGE[name]), `${name} has a section budget`);
  }
});

test("a header holds one primary action: two solid accent buttons fail, a primary beside quiet ones does not", () => {
  const measured = (...buttons) => inPage(page(header(...buttons), list(["一行"])), () => measure([[], [], []]));
  const accent = "bg-accent text-accent-fg";
  assert.deepEqual(measured(["添加", accent], ["导出", "bg-surface-2"], ["更多", "bg-transparent"]).headerPrimaryActions, ["添加"]);
  assert.deepEqual(measured().headerPrimaryActions, []);
  const two = measured(["添加", accent], ["新建笔记", accent]);
  assert.deepEqual(two.headerPrimaryActions, ["添加", "新建笔记"]);
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9, headerPrimaryActions: two.headerPrimaryActions }), []).failures,
    ["files@desktop: the page header has 2 primary actions (at most one): 添加 / 新建笔记"]);
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9, headerPrimaryActions: ["添加"] }), []).failures, []);
});

test("neither retired module name may be on a page: in its text, a control's name or the tab title", () => {
  // The renames of 2026-10-07; each name is looked for as a closed word, wherever a reader or a screen reader meets it.
  assert.deepEqual(RETIRED_NAMES.map((re) => re.source), ["循证传播", "虚拟临研"]); // retired-word-ok
  const hits = (...blocks) => inPage(page(header(), ...blocks), () => measure([[], [], RETIRED_NAMES.map((re) => [re.source, re.flags])])).retiredNameHits;
  assert.deepEqual(hits(node("p", { text: "循证 GEO 与虚拟临床研究" })), []);
  assert.deepEqual(hits(node("p", { text: "进入虚拟临研" })), ["虚拟临研"]); // retired-word-ok
  assert.deepEqual(hits(node("button", { attrs: { "aria-label": "打开循证传播" }, text: "" })), ["循证传播"]); // retired-word-ok
  assert.deepEqual(hits(node("input", { attrs: { placeholder: "搜索循证传播" } })), ["循证传播"]); // retired-word-ok
  for (const viewport of ["desktop", "phone"]) {
    assert.deepEqual(pageFindings("geo", viewport, clean({ retiredNameHits: ["循证传播"] }), []).failures, // retired-word-ok
      [`geo@${viewport}: a retired module name on the page: 循证传播`]); // retired-word-ok
  }
});

test("rowProbe finds the first row of each list whose title is a control, clicks it, and reads what is on screen", () => {
  const stat = node("li", {}, [node("span", { attrs: { "data-row-title": "" }, text: "只读的一行" })]);
  const open = page(header(), list(["第一行", "第二行"], "资料"), node("ul", { attrs: { "aria-label": "结果" } }, [stat]), node("div", { attrs: { role: "dialog" }, w: 0, h: 0 }, [list(["抽屉里"], "抽屉")]));
  inPage(open, () => {
    // A list of results whose title is not a control is not a place to go; a dialog's own list is not the page's.
    assert.deepEqual(rowProbe(["targets"]), ["资料"]);
    assert.deepEqual(rowProbe(["state"]), { dialog: false, path: "/app/files", expanded: 0 });
    assert.equal(rowProbe(["click", 0]), true);
    assert.equal(rowProbe(["click", 5]), false);
    assert.equal(rowProbe(["has", "资料"]), true);
    assert.equal(rowProbe(["has", "仍在载入的列表"]), false);
    assert.equal(rowProbe(["click", "资料"]), true);
  });
  assert.equal(descendants(open).find((el) => el.text === "第一行").clicks, 2);
  assert.equal(descendants(open).find((el) => el.text === "第二行").clicks, 0);
  // A list that holds another list finds the inner list's first row as its own: one row, one target. 问题与回答's groups hold their questions.
  const nested = page(header(), node("ul", {}, [node("li", { attrs: { "data-geo-group": "g1" } }, [
    node("button", { attrs: { "aria-expanded": "true" }, text: "第一组" }),
    node("ul", { attrs: { "aria-label": "测量问句" } }, [node("li", {}, [node("a", { attrs: { "data-row-title": "", href: "/answers/1" }, text: "一个问句" })])]),
  ])]));
  inPage(nested, () => assert.deepEqual(rowProbe(["targets"]), ["一个问句"]));
  // 循证 GEO's groups and findings are ordinary list rows that open a drawer since R19 (the walk used to open closed groups first and click the
  // first link of cards): the probe has no way left to reveal rows, and a list of such rows is found like any other.
  const geoRows = page(header(), node("ul", { attrs: { "aria-label": "测量问句分组" } }, [1, 2].map((n) => node("li", { attrs: { "data-geo-group": `g${n}` } }, [node("button", { attrs: { "data-row-title": "", "aria-haspopup": "dialog" }, text: `组${n}` })]))));
  inPage(geoRows, () => {
    assert.deepEqual(rowProbe(["targets"]), ["测量问句分组"]);
    assert.equal(rowProbe(["click", 0]), true);
  });
  // The rows that open where they are: a memory list beside the works, whose rows are links to their documents (记忆胶囊's 项目).
  const works = node("ul", { attrs: { "aria-label": "作品" } }, [node("li", {}, [node("a", { attrs: { "data-row-title": "", href: "/app/files/src_1" }, text: "一份报告" })])]);
  const memoryTab = page(header(), works, list(["本项目为系统评价"], "项目的记忆"));
  inPage(memoryTab, () => {
    assert.deepEqual(rowProbe(["targets"]), ["作品", "项目的记忆"]);
    assert.deepEqual(rowProbe(["inPlace"]), ["项目的记忆"]);
    assert.equal(rowProbe(["click", "项目的记忆"]), true);
  });
  assert.equal(descendants(memoryTab).find((el) => el.text === "本项目为系统评价").clicks, 1);
  assert.equal(descendants(memoryTab).find((el) => el.text === "一份报告").clicks, 0);
  // A row that opens in place says so in aria-expanded.
  const expanding = page(header(), node("ul", {}, [node("li", {}, [node("button", { attrs: { "data-row-title": "", "aria-expanded": "true" }, text: "已展开" })])]));
  assert.equal(inPage(expanding, () => rowProbe(["state"])).expanded, 1);
  // A dialog on screen is read as one.
  const withDialog = page(header(), node("div", { attrs: { role: "dialog" } }, [node("p", { text: "详情" })]));
  assert.equal(inPage(withDialog, () => rowProbe(["state"])).dialog, true);
});

test("a row click shows something when it opens a drawer, goes to a page, opens a tab or opens the row; nothing else", () => {
  const closed = { dialog: false, path: "/app/files", expanded: 0 };
  assert.equal(rowClickShown(closed, { ...closed, dialog: true }, 0), true);
  assert.equal(rowClickShown(closed, { ...closed, path: "/app/files/src_1" }, 0), true);
  assert.equal(rowClickShown(closed, closed, 1), true);
  assert.equal(rowClickShown(closed, { ...closed, expanded: 1 }, 0), true);
  assert.equal(rowClickShown(closed, closed, 0), false);
  // A dialog that was already open and still is has not been opened by the click.
  assert.equal(rowClickShown({ ...closed, dialog: true }, { ...closed, dialog: true }, 0), false);
  assert.deepEqual(rowClickFindings("files", [{ label: "资料", shown: true }, { label: "笔记", shown: false }]),
    ["files@desktop: clicking the first row of the list “笔记” showed nothing — no drawer, no page, no opened row"]);
});

test("a page's first-row clicks come to failures on every page; a page with nothing to click says so as a coverage gap", () => {
  const rows = [{ label: "资料", shown: true }, { label: "笔记", shown: false }];
  const nothing = (name, label) => `${name}@desktop: clicking the first row of the list “${label}” showed nothing — no drawer, no page, no opened row`;
  // R13 made the click a notice on six pages until a walk had reported them; R19 ended that (no class of finding is only reported).
  for (const name of ["files", "inbox", "geo-questions", "geo-accuracy", "account", "geo", "frontier-zones"]) {
    assert.deepEqual(rowClickVerdict(name, rows), { failures: [nothing(name, "笔记")], notices: [] }, name);
  }
  assert.deepEqual(rowClickVerdict("geo-questions", [{ label: "测量问句", shown: true }]), { failures: [], notices: [] });
  const empty = (name) => `${name}@desktop: not observable: no list on the page has a first row that opens (an empty list, a page without rows, or an account with none), so no click was made`;
  assert.deepEqual(rowClickVerdict("memory-map", []), { failures: [], notices: [empty("memory-map")] });
  assert.equal(asFinding(empty("geo-accuracy")).rule, "not-observable");
  // A click that shows nothing is the same failure whichever way a page is spelled.
  assert.deepEqual(rowClickVerdict("geo-sources", rows).failures, [nothing("geo-sources", "笔记")]);
});

test("the page's blocks are the title, what stands over it and the body that follows the header — not the first block that is not the header", () => {
  // A page with a way back has a block before its header (PageShell's `back`). The walk used to take that block for the body, so
  // the way back was all it measured of the seven tabs of a study: its box began 10 px outside the column and the tabs were never read.
  const column = (back, ...body) => node("body", {}, [node("main", {}, [node("div", {}, [
    node("div", { left: 296 }, [back]),
    node("header", { left: 296 }, [node("h1", { text: "研究", left: 296 })]),
    node("div", { left: 296 }, body),
  ])])]);
  const lefts = (back, ...body) => inPage(column(back, ...body), () => measure([[], [], []])).pageLefts;
  assert.deepEqual(lefts(node("a", { text: "返回", left: 296 }), node("div", { left: 296 }), node("p", { text: "一句话", left: 296 })), [296]);
  // The back link that sticks out of the column is one left edge too many…
  assert.deepEqual(lefts(node("a", { text: "返回", left: 286 }), node("div", { left: 296 })), [296, 286]);
  // …and so is a block of the body, which is measured now.
  assert.deepEqual(lefts(node("a", { text: "返回", left: 296 }), node("div", { left: 296 }), node("div", { left: 306 })), [296, 306]);
  // A page with no way back is measured as before: the title and the body's blocks.
  assert.deepEqual(inPage(page(header(), node("p", { text: "正文", left: 0 })), () => measure([[], [], []])).pageLefts, [0]);
});

test("a row whose title is a link to an outside address in a new tab declares what it opens; a button or a relative link does not", () => {
  const link = (attrs) => node("li", {}, [node("a", { attrs: { "data-row-title": "", ...attrs }, text: "一条新闻" })]);
  const lists = page(
    header(),
    node("ul", { attrs: { "aria-label": "外链" } }, [link({ href: "https://www.fda.gov/x", target: "_blank" })]),
    node("ul", { attrs: { "aria-label": "站内" } }, [link({ href: "/app/frontier/e1" })]),
    node("ul", { attrs: { "aria-label": "按钮" } }, [row("一行")]),
    node("ul", { attrs: { "aria-label": "相对" } }, [link({ href: "x.html", target: "_blank" })]),
  );
  inPage(lists, () => {
    assert.deepEqual(rowProbe(["targets"]), ["外链", "站内", "按钮", "相对"]);
    assert.deepEqual([0, 1, 2, 3].map((index) => rowProbe(["external", index])), [true, false, false, false]);
    // Asking is not clicking.
    assert.equal(descendants(lists).find((el) => el.text === "一条新闻").clicks, 0);
  });
  const closed = { dialog: false, path: "/app/frontier", expanded: 0 };
  // The browser reported no popup, and the row is still not silent: its link is a real one.
  assert.equal(rowClickShown(closed, closed, 0, true), true);
  assert.equal(rowClickShown(closed, closed, 0, false), false);
  assert.equal(rowClickShown(closed, closed, 0), false);
});

/**
 * A stand-in for playwright-core: every page load fires the shell's runtime
 * warm-up through the context's routes, and everything the walk did is
 * written to a log the test reads.
 */
const FAKE_PLAYWRIGHT = String.raw`
const fs = require("fs");
const log = (entry) => fs.appendFileSync(process.env.FAKE_PLAYWRIGHT_LOG, JSON.stringify(entry) + "\n");
const json = (status, body) => ({ status: () => status, ok: () => status < 400, json: async () => body });
let loggedIn = false;
// What each probe of the walk reads on a page that is right. FAKE_PROBE=<kind> makes that kind read a page that is wrong.
const BAD = process.env.FAKE_PROBE || "";
function probe(kind, arg, search) {
  const tab = new URLSearchParams(search).get("tab");
  const wrong = BAD === kind;
  switch (kind) {
    case "geoMarketOff": return wrong ? { present: true, top: 4000, viewport: 945 } : { present: true, top: 300, viewport: 945 };
    case "followingEmpty": return wrong ? { adds: 1, chips: 3, noResults: true } : { adds: 1, chips: 0, noResults: false };
    case "eventGroups": return wrong ? { primary: false, other: false, none: false } : { primary: true, other: true, none: false };
    case "firstRowTop": return { top: wrong ? 620 : 276 };
    case "rowWidth": return wrong ? { widths: [96], min: 96 } : { widths: [300], min: 300 };
    case "capabilityCards": return wrong ? { hits: ["可运行"], wraps: 2 } : { hits: [], wraps: 0 };
    case "memoryTabs": {
      const names = { self: "关于你", project: "项目", methods: "做法", growth: "成长" };
      const selected = wrong ? "关于你" : names[tab] || "项目";
      return { tabs: [["关于你", 0], ["项目", 2], ["做法", 3], ["成长", 0]].map(([name, count]) => ({ name, count, selected: name === selected })), headline: { memories: 5, practices: wrong ? 9 : 3 } };
    }
    case "sharedMissing": return wrong ? { title: true, back: true, retry: true } : { title: true, back: true, retry: false };
    case "memoryMap": return wrong ? { views: ["关系"], figures: [{ kind: "relations", named: false }], lists: [], thin: false, empty: false }
      : { views: ["关系", "主题", "维度", "时间", "活跃"], figures: [{ kind: "relations", named: true }], lists: [{ label: "标记", rows: 3 }], thin: false, empty: false };
    case "knowledgeGraph": return wrong ? { figures: [{ kind: "knowledge-wiki", named: false }], lists: [], legend: false, views: ["图谱"], engineAddress: true, empty: false }
      : { figures: [{ kind: "knowledge-wiki", named: true }], lists: [{ label: "页面", rows: 3 }], legend: true, views: ["资料", "知识页", "图谱"], engineAddress: false, empty: false };
    case "inboxSafety": return wrong ? { heading: 2, bell: 5 } : { heading: 2, bell: 2 };
    case "feishuRows": return { rows: wrong ? 2 : search.includes("notifications") ? 1 : 0 };
    case "connectorRows": return { rows: arg.map((title) => ({ title, found: true, optional: !wrong, configured: false, missing: wrong })) };
    case "opsOrder": return wrong ? { health: 40, config: 2, tokens: ["openlist_storage_missing"] } : { health: 0, config: 10, tokens: [] };
    case "notFound": return { said: !wrong };
    case "missingRecord": return wrong ? { dialog: true, said: false, back: false, failedWord: true } : { dialog: true, said: true, back: true, failedWord: false };
    case "readingFolds": return { folds: [{ label: "编写与核查", open: wrong }, { label: "评议与讨论（0）", open: false }], models: wrong ? ["deepseek"] : [] };
    // FAKE_DAILY=error|off|nameless|zoneless: the empty day read as a failure, a feed the account is not offered, an empty day that names no day, a time with no zone.
    case "dailyEmpty": {
      const mode = process.env.FAKE_DAILY || "";
      if (mode === "error") return { alert: "这条动态已不再提供。", retry: true, title: null, description: null, past: false };
      if (mode === "off") return { alert: null, retry: false, title: null, description: null, past: false };
      if (mode === "nameless") return { alert: null, retry: false, title: "今日日报尚未发布", description: "当天没有符合条件的内容时不出刊。", past: false };
      if (mode === "zoneless") return { alert: null, retry: false, title: "1月1日 周三没有日报", description: "日报每天 07:30发布；当天没有符合条件的内容时不出刊。", past: true };
      return { alert: null, retry: false, title: "1月1日 周三没有日报", description: "日报每天 07:30（北京时间）发布；当天没有符合条件的内容时不出刊。", past: true };
    }
    default: return null;
  }
}
// What measureComposition reads on a page that is right: a module page (a GEO project's tabs, a study's) has its band, its rail or its dotted tab
// row, and a tab list; every other page has none of them. FAKE_COMPOSITION=orphans|steps|band|empty|layers: two sentences standing alone on the
// knowledge base, a GEO tab with seven steps, a GEO band that does not hold, an empty state without a way forward on the inbox, two toolbars on the memory page.
function compositionRead(pathname) {
  const mode = process.env.FAKE_COMPOSITION || "";
  const box = (top, height, left, width) => ({ top, bottom: top + height, left: left === undefined ? 296 : left, right: (left === undefined ? 296 : left) + (width === undefined ? 1152 : width), width: width === undefined ? 1152 : width, height });
  // One answer is read inside the module band too (/answers/:id, band "geo" in the page table).
  const geo = /^\/app\/geo\/geo_1(\/(visibility|accuracy|questions|sources|actions|plan|evidence|answers\/[^/]+))?$/.test(pathname);
  const vcr = /^\/app\/virtual-research\/std_/.test(pathname);
  const read = { viewport: { width: 1512, height: 945 }, height: 945, title: { text: "页面", ...box(26, 32) }, chrome: null, stepRail: null, tablists: [], viewGroups: [], toolbars: [],
    controlsAfterContent: [], orphans: [], tags: [], tagLike: [], words: [], primaries: [], zeroCounts: [], outline: { outlines: 0, showMore: 0 }, chartGrids: [], empties: [],
    notes: [], headline: 0, activity: 0, stepStates: [] };
  if (geo || vcr) {
    read.chrome = { ...box(60, 124, 272, 1200), position: "sticky", sticky: true, held: mode === "band" && pathname.endsWith("/plan") ? { scrolled: 400, before: 60, after: -340, scrollerTop: 0 } : null };
    read.tablists = [{ label: "视图", tabs: 8, dots: vcr ? 7 : 0, inChrome: true, inToolbar: false, inSection: false, ...box(100, 40) }];
    if (geo) read.stepRail = { ...box(60, 40), folded: false, count: mode === "steps" && pathname.endsWith("/visibility") ? 7 : 8, inChrome: true, steps: [] };
  }
  if (mode === "orphans" && pathname === "/app/files") read.orphans = [1, 2].map((n) => ({ text: "第" + n + "句话单独站在页面上没有动作", tag: "p", ...box(300 + n * 40, 24) }));
  if (mode === "empty" && pathname === "/app/inbox") read.empties = [{ title: "暂无消息", icon: false, hasTitle: true, action: false, reason: false, ...box(300, 200) }];
  if (mode === "layers" && pathname === "/app/memory") read.toolbars = [1, 2].map((n) => ({ label: "工具条" + n, inChrome: n === 1, inSection: false, ...box(60 + n * 60, 28), controls: {} }));
  return read;
}
let skillProbes = 0;
let cleanupProbes = 0;
let knowledgeStates = 0;
// The composer as the kernel's frame draws it. FAKE_COMPOSER=low|hero|wrap|chips|onechip|stats: a control too near the bottom, the blank conversation,
// a toolbar that wraps on a phone, two chips (one in the dock), one chip in the toolbar, the statistics and the ring visible.
function composerRead(operator, narrow) {
  const mode = process.env.FAKE_COMPOSER || "";
  const chips = mode === "chips" ? { total: 2, bar: 2, hero: 0, inTools: 1, inDock: 1 } : mode === "onechip" ? { total: 1, bar: 1, hero: 0, inTools: 1, inDock: 0 } : { total: 0, bar: 0, hero: 0, inTools: 0, inDock: 0 };
  return { composer: true, hero: mode === "hero", operator, window: { width: narrow ? 390 : 1512, height: narrow ? 844 : 945 }, gapCard: 40, gapLowest: mode === "low" ? 4 : 24,
    rowLines: mode === "wrap" && narrow ? 2 : 1, rowHeight: mode === "wrap" && narrow ? 82 : 42, scrollsSideways: false, chips, stats: { present: 1, visible: mode === "stats" ? 1 : 0 }, ring: mode === "stats" ? 1 : 0 };
}
function context() {
  const routes = [];
  const initScripts = [];
  const fire = async (url) => {
    for (const [pattern, handler] of routes) {
      if (!pattern.test(url)) continue;
      await handler({ abort: async () => log({ start: url, verdict: "aborted" }), continue: async () => log({ start: url, verdict: "allowed" }), fulfill: async () => {} });
    }
  };
  const newPage = async () => {
    let url = "";
    let routeSettled = false;
    let dialogOpen = false;
    const failed = [];
    const consoles = [];
    let loadAttempts = 0;
    const pageRoutes = [];
    let phone = false;
    // The page one sidebar link left, for Back; and how often each list page's address was read (the walk reads it in a fixed order).
    let previousUrl = null;
    const addressCalls = {};
    // Whether axe-core is in the document: a new document does not have it.
    let axeInjected = false;
    // FAKE_CHAT=network-changed: the chat page drops its requests with
    // ERR_NETWORK_CHANGED and shows 打开超时 until 重试 is pressed;
    // FAKE_CHAT=broken: 重试 does not help either.
    const chatMode = process.env.FAKE_CHAT || "";
    let retried = false;
    const chatFailing = () => chatMode && url.endsWith("/app/chat") && !(chatMode === "network-changed" && retried);
    const target = () => new URL(url);
    const locator = (role, name) => ({
      count: async () => (chatFailing() && role === "button" && name === "重试" ? 1 : 0),
      first: () => ({ click: async () => { retried = true; log({ click: name }); } }),
      fill: async (value) => log({ fill: name, value }),
    });
    return {
      keyboard: { press: async (key) => log({ key, at: target().pathname }) },
      mouse: { move: async () => {} },
      on(event, handler) { if (event === "requestfailed") failed.push(handler); if (event === "console") consoles.push(handler); }, off() {},
      async setViewportSize(size) { phone = size.width < 600; log({ viewport: size.width + "x" + size.height }); }, async close() {}, async waitForTimeout() {},
      async screenshot(options) { if (options && options.path) log({ screenshot: options.path.split("/").pop(), type: options.type, quality: options.quality }); },
      async goBack() { log({ goBack: true }); if (previousUrl) { url = previousUrl; previousUrl = null; } },
      async route(pattern, handler) { pageRoutes.push([pattern, handler]); log({ route: String(pattern) }); },
      async unroute() { pageRoutes.length = 0; log({ unroute: true }); },
      async waitForFunction() {
        if (process.env.FAKE_SLOW_ROUTE === "never" && new URL(url).pathname === "/app/account") throw Error("route still loading after 30000ms");
        if (process.env.FAKE_NO_MATRIX && url.endsWith("clinical-evidence-matrix.json")) throw Error("no matrix");
        routeSettled = true;
      },
      url: () => url,
      frames: () => [{
        url: () => "https://evimed.example.org/__evimed/f/x",
        evaluate: async (fn, arg) => {
          if (typeof fn === "function" && fn.name === "composerProbe") return composerRead(Boolean(arg && arg[0] && arg[0].operator), phone);
          return { composer: !chatFailing(), stats: [] };
        },
      }],
      getByRole: (role, { name }) => locator(role, name),
      async goto(target, options) {
        url = target; routeSettled = false; dialogOpen = false; axeInjected = false; log({ goto: target });
        if (process.env.FAKE_ROUTE_LOAD && phone && target.endsWith("/std_a/comparator")) {
          loadAttempts++;
          for (const handler of consoles) handler({ type: () => "error", text: () => "Failed to load resource: net::ERR_NETWORK_CHANGED" });
        }
        const start = new URL("/api/commands/start_runtime", target).href;
        // A page's own route answers before the context's: the walk's cleanup cover answers the start itself.
        const own = pageRoutes.find(([pattern]) => typeof pattern.test === "function" && pattern.test(start));
        if (own) { log({ start, verdict: "fulfilled" }); await own[1]({ fulfill: async () => {} }); }
        else await fire(start);
        if (chatMode && target.endsWith("/app/chat")) for (const handler of failed) handler({ failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }) });
      },
      async evaluate(fn, arg) {
        if (typeof fn === "function" && fn.name === "routeLoadProbe") {
          const bad = process.env.FAKE_ROUTE_LOAD && phone && url.endsWith("/std_a/comparator") && (process.env.FAKE_ROUTE_LOAD === "persistent" || loadAttempts < 2);
          return { failed: Boolean(bad), message: bad ? "研究暂时无法读取。重试" : null };
        }
        if (typeof fn === "function" && fn.name === "measureComposition") return compositionRead(target().pathname);
        // FAKE_SCROLL=stretch|tall|taller: a page two windows tall (photographed whole), nine, and fifty (photographed in slices, and cut off).
        if (typeof fn === "function" && fn.name === "scrollPage") {
          if (arg[0] === "to") { log({ scrollTo: arg[1], at: target().pathname }); return { top: arg[1] }; }
          const mode = process.env.FAKE_SCROLL || "";
          return { viewportHeight: phone ? 844 : 945, clientHeight: phone ? 844 : 945, scrollHeight: mode === "stretch" ? 2200 : mode === "tall" ? 9450 : mode === "taller" ? 47250 : phone ? 844 : 945 };
        }
        // FAKE_THROW=<function name>: that probe throws in the page, as 18.1's memory-map step did (a helper outside the function's own text).
        if (process.env.FAKE_THROW && typeof fn === "function" && fn.name === process.env.FAKE_THROW) throw new ReferenceError(fn.name + "Helper is not defined");
        // axe-core's source is put into the page as a string; the scan is a function. FAKE_AXE=clean|fail: nothing to report, a scan that throws.
        if (typeof fn === "string") {
          if (fn.includes("axe v")) { axeInjected = true; log({ axe: "injected", at: target().pathname }); }
          return undefined;
        }
        if (typeof fn === "function" && fn.name === "axeLoaded") return axeInjected;
        if (typeof fn === "function" && fn.name === "axeRun") {
          const mode = process.env.FAKE_AXE || "";
          if (mode === "fail") throw new Error("axe blew up");
          if (mode === "clean") return { version: "4.12.1", violations: [], incomplete: 0 };
          const shell = { id: "region", impact: "moderate", nodes: 1, target: "aside", help: "Page content should be contained by landmarks" };
          const own = target().pathname === "/app/files" ? [{ id: "color-contrast", impact: "serious", nodes: 4, target: ".text-text-3", help: "Elements must meet minimum color contrast" }] : [];
          return { version: "4.12.1", violations: [shell, ...own], incomplete: 2 };
        }
        if (url.endsWith("/app/chat") && typeof fn === "function" && String(fn).includes("document.body.innerText")) return chatFailing() ? "打开超时，请重试\n重试" : "";
        // FAKE_ROWS=dead: a row that does nothing when clicked; FAKE_ROWS=two: two lists on every page, so the walk loads the page again between clicks.
        if (typeof fn === "function" && fn.name === "rowProbe") {
          const [action] = arg;
          // Every fake row is a button, so the rows that open in place are all of them.
          if (action === "targets" || action === "inPlace") {
            // FAKE_ROWS=none: a page with no row to click, as an account with no data draws.
            return process.env.FAKE_ROWS === "none" ? [] : process.env.FAKE_ROWS === "two" ? ["第一张清单", "第二张清单"] : ["资料清单"];
          }
          if (action === "state") return { dialog: dialogOpen, path: new URL(url).pathname, expanded: 0 };
          // FAKE_ROWS=external: the row's title is a link to an outside address; the browser reports no popup, and the row is not silent.
          if (action === "external") return process.env.FAKE_ROWS === "external";
          dialogOpen = process.env.FAKE_ROWS !== "dead" && process.env.FAKE_ROWS !== "external";
          log({ rowClick: new URL(url).pathname, index: arg[1], search: new URL(url).search });
          // FAKE_ROW_WRITE=1: the row marks itself read on the way (the inbox): a write the walk's guard must refuse, next to a read it must let through.
          if (process.env.FAKE_ROW_WRITE) {
            for (const [, handler] of pageRoutes) {
              handler({ request: () => ({ method: () => "GET", url: () => "https://evimed.example.org/api/inbox" }), abort: async () => log({ aborted: "GET" }), fallback: async () => log({ fellBack: "GET" }) });
              handler({ request: () => ({ method: () => "POST", url: () => "https://evimed.example.org/api/inbox/n1/read" }), abort: async () => log({ aborted: "POST" }), fallback: async () => log({ fellBack: "POST" }) });
              handler({ request: () => ({ method: () => "POST", url: () => "https://evimed.example.org/api/commands/start_runtime" }), abort: async () => log({ aborted: "start_runtime" }), fallback: async () => log({ fellBack: "start_runtime" }) });
            }
          }
          return true;
        }
        if (typeof fn === "function" && fn.name === "measure") {
          return { title: (process.env.FAKE_SLOW_ROUTE && !routeSettled && new URL(url).pathname === "/app/account") || process.env.FAKE_MISSING_TITLE ? "" : "页面 · EviMed", controlKinds: 3, colorKinds: 3, borderKinds: 1, sizeWeightPairs: ["12px/400", "13px/400", "14px/400", "14px/500", "24px/600"],
            pageLefts: [240], rowTitleLefts: [], subtitle: [], backOfficeHits: [], retiredNameHits: process.env.FAKE_RETIRED ? ["循证传播"] : [], headerPrimaryActions: process.env.FAKE_TWO_PRIMARY ? ["新建", "导入"] : ["新建"], sectionShapes: process.env.FAKE_STACKED ? ["ul>li", "table>thead+tbody", "svg>g+g"] : ["ul>li"], leakHits: [], unnamedControls: [], overflowX: false, smallTargets: 0, decorativeSvgs: 0 };
        }
        if (typeof fn === "function" && fn.name === "measureStructure") {
          const bad = process.env.FAKE_STRUCTURE || "";
          return {
            sidebar: { landmarks: bad === "sidebar" ? 2 : 1, holdsDivider: true, chatLink: bad !== "nolink", closed: phone, inert: bad !== "notinert" },
            scrollers: bad === "scroller" ? [{ label: "table", reachable: false, stop: false, named: false }] : [],
            headingJumps: bad === "headings" ? ["h1→h3 “标题”"] : [],
            height: bad === "tall" ? 90000 : 1500, viewport: 945, rows: bad === "rows" ? 99 : 5,
            duplicateTitles: bad === "twins" ? ["波立维"] : [], truncatedCounts: bad === "cutoff" ? 2 : 0,
          };
        }
        if (typeof fn === "function" && fn.name === "focusProbe") return { text: process.env.FAKE_STRUCTURE === "tabs" ? "对话" : "跳到主要内容", inSidebar: process.env.FAKE_STRUCTURE === "tabs" };
        if (typeof fn === "function" && fn.name === "pageProbe") return probe(arg[0], arg[1], target().search);
        if (typeof fn === "function" && fn.name === "afterClickProbe") {
          if (arg[0] === "sourceDrawer") return { dialog: process.env.FAKE_AFTER !== "bad", drawers: process.env.FAKE_AFTER === "bad" ? 0 : 1 };
          // The task page, as the shell draws it with the runtime not started: the frame's container is placed over the pane and holds no iframe.
          // FAKE_AFTER=bad: a time zone shown by its identifier, a box for typing of the page's own, a frame that is not over the pane.
          const pane = { left: 300, top: 120, width: 900, height: 700 };
          const bad = process.env.FAKE_AFTER === "bad";
          return { path: "/app/autopilot/task_1", layout: "split", list: true, main: true, bar: true, marked: 1, pane: "conversation", paneBox: pane, surface: "task",
            holderBox: bad ? { ...pane, top: 300 } : pane, frameBox: null, editors: bad ? 1 : 0, inputsInMain: 0, dialogs: 0, zoneIds: bad ? ["Asia/Shanghai"] : [] };
        }
        if (typeof fn === "function" && fn.name === "clickNamed") {
          const [role, name] = arg;
          log({ clickNamed: name });
          if (name === "关闭" && process.env.FAKE_CLOSE !== "stuck") dialogOpen = false;
          if (name === "保存" && process.env.FAKE_SKILL_WRITE) for (const [, handler] of pageRoutes) handler({ request: () => ({ method: () => "POST", url: () => "https://evimed.example.org/api/personal-skills" }), abort: async () => log({ aborted: "POST" }), continue: async () => {}, fallback: async () => {} });
          if (name === "回到插件列表") url = new URL("/app/extensions/plugins", url).href;
          if (name === "回到技能列表") url = new URL(process.env.FAKE_BACK === "stay" ? "/app/extensions/skills/impeccable-audit-missing" : "/app/extensions/skills", url).href;
          return true;
        }
        if (typeof fn === "function" && fn.name === "clickRowTitled") return true;
        // 记忆地图: a list of marks (FAKE_ROWS=none: an account with none), the drawer the first mark opened and the address that says so;
        // FAKE_CLOSE=stuck: a drawer that stays open when its 关闭 is pressed.
        if (typeof fn === "function" && fn.name === "markRowsProbe") return process.env.FAKE_ROWS === "none" ? 0 : 3;
        if (typeof fn === "function" && fn.name === "clickFirstMarkProbe") { dialogOpen = process.env.FAKE_ROWS !== "dead"; log({ markClick: new URL(url).pathname }); return true; }
        if (typeof fn === "function" && fn.name === "drawerStateProbe") return { dialog: dialogOpen, address: dialogOpen };
        // 知识页's graph: a list of marks that open a file, the file's page and the way back.
        if (typeof fn === "function" && fn.name === "knowledgeMarkRowsProbe") return process.env.FAKE_ROWS === "none" ? 0 : 3;
        if (typeof fn === "function" && fn.name === "firstKnowledgeMarkProbe") { previousUrl = url; url = new URL("/app/files/src_" + "a".repeat(32), url).href; log({ knowledgeMark: new URL(url).pathname }); return 1; }
        if (typeof fn === "function" && fn.name === "knowledgeReaderProbe") return { reader: true, address: true, engineAddress: false, title: true };
        if (typeof fn === "function" && fn.name === "knowledgeGraphBackProbe") return { graph: true, address: true };
        if (typeof fn === "function" && fn.name === "addressAct") {
          log({ act: arg });
          if (arg[0] === "link") { previousUrl = url; url = new URL(arg[1], url).href; }
          return true;
        }
        // The inbox is read after the choice, after Back and after the address is loaded again; the memory page the same three times, then with a
        // row open and after Back. FAKE_ADDRESS=lost: the address does not come back; FAKE_ADDRESS=open: Back leaves the row open.
        if (typeof fn === "function" && fn.name === "addressProbe") {
          const kind = arg[0];
          const n = (addressCalls[kind] = (addressCalls[kind] ?? 0) + 1);
          const lost = process.env.FAKE_ADDRESS === "lost" && n > 1 && n < 4;
          if (kind === "inbox") return { path: "/app/inbox", search: lost ? "" : "?filter=unread", dialog: false, found: true, selected: lost ? "全部" : "未读 3" };
          const search = "?tab=project&q=" + encodeURIComponent("探针");
          if (n === 4) return { path: "/app/memory", search: search + "&open=r1", dialog: true, found: true, selected: "项目 5", query: "探针" };
          if (n === 5) return { path: "/app/memory", search: process.env.FAKE_ADDRESS === "open" ? search + "&open=r1" : search, dialog: process.env.FAKE_ADDRESS === "open", found: true, selected: "项目 5", query: "探针" };
          return { path: "/app/memory", search: lost ? "" : search, dialog: false, found: true, selected: lost ? "关于你" : "项目 5", query: lost ? "" : "探针" };
        }
        // FAKE_HANDOFF=bad: a draft with no link to a source and a field that would send; FAKE_HANDOFF=nobutton: an event page without 深入研究.
        if (typeof fn === "function" && fn.name === "handoffProbe") {
          if (arg[0] === "event") return { path: new URL(url).pathname, title: "某事件", button: process.env.FAKE_HANDOFF !== "nobutton" };
          const bad = process.env.FAKE_HANDOFF === "bad";
          return { path: "/app/chat", intent: { keys: ["draft", "kind", "projectId", "requestId", "sessionId"].concat(bad ? ["send"] : []), kind: "create",
            draft: bad ? "请深入研究" : "请围绕这个事件做一次深入研究。\n\n事件：某事件\n一手来源：\n- 官方：标题（https://example.org/a）", requestId: "req_1" } };
        }
        if (typeof fn === "function" && fn.name === "pdfProbe") return { width: process.env.FAKE_PDF === "narrow" ? 559 : 896, src: "blob:x#view=FitH&navpanes=0" };
        // FAKE_KB=lost: the way back does not find the list as it was left.
        if (typeof fn === "function" && fn.name === "readerProbe") {
          return { path: "/app/files/src_1?q=" + encodeURIComponent("一份指南"), layout: "columns", title: "一份指南", back: { text: "知识库", href: "/app/files?q=" + encodeURIComponent("一份指南") }, dialogs: 0, columns: ["original", "points"], tabs: [], missing: false };
        }
        if (typeof fn === "function" && fn.name === "knowledgeProbe") {
          if (arg[0] === "first") return { title: "一份指南", href: "/app/files/src_1" };
          const lost = process.env.FAKE_KB === "lost";
          return { path: lost && knowledgeStates++ >= 1 ? "/app/files" : "/app/files?q=" + encodeURIComponent("一份指南"), query: "一份指南", rows: 1, listed: true };
        }
        if (typeof fn === "function" && fn.name === "skillDrawerProbe") {
          skillProbes += 1;
          const refused = skillProbes % 2 === 0;
          return { title: true, captions: process.env.FAKE_SKILL === "bare" ? 0 : 2, switchLabel: "保存后在“我的研究”里使用", needName: refused, needHow: refused };
        }
        if (typeof fn === "function" && fn.name === "cleanupProbe") {
          cleanupProbes += 1;
          const bad = process.env.FAKE_CLEANUP === "quota";
          return { cover: "正在清理上一次任务的运行环境，完成后自动继续", quotaButtons: bad ? ["查看额度"] : [], alertButtons: cleanupProbes > 1 ? ["重试", "查看已有成果"] : null };
        }
        if (typeof fn === "function" && fn.name === "matrixProbe") {
          const [action] = arg;
          const bad = process.env.FAKE_MATRIX || "";
          if (action === "ready") return true;
          if (action === "state") return { overflow: bad === "overflow", rows: 3, firstId: "CLM-001", markInView: bad !== "offscreen", headers: [], marks: ["已核对"] };
          if (action === "filtered") return { rows: bad === "search" ? 3 : 1, status: bad === "search" ? "显示 3 / 3 条" : "显示 1 / 3 条" };
          if (action === "open") return true;
          if (action === "dialog") return { open: true, name: "CLM-001" };
          return { open: false, focusInRow: bad !== "focus" };
        }
        if (typeof fn === "function" && String(fn).includes("location.pathname")) return target().pathname;
        return { english: false, sidebar: true, text: "" };
      },
    };
  };
  return {
    async route(pattern, handler) { routes.push([pattern, handler]); },
    // The script every document starts with: the walk gives its page the account's own project each time (a click into a study switched it).
    async addInitScript(script) { initScripts.push(script); log({ initScript: script.name }); },
    newPage,
    request: {
      async post(url) { if (url.endsWith("/api/auth/login")) { loggedIn = true; return json(200, {}); } loggedIn = false; return json(200, {}); },
      async get(url) {
        // FAKE_EMPTY_LISTS: the lists the walk reads its ids from answer nothing, as a module that is off for the account does.
        if (process.env.FAKE_EMPTY_LISTS && /\/api\/(vcr|frontier|agent-runs|sources|connectors)|\/diagnosis$/.test(url)) return json(404, {});
        // FAKE_DISCOVERY=500|refused: a list that the deployment cannot answer, and one the account may not read.
        if (process.env.FAKE_DISCOVERY && url.endsWith("/api/geo/projects")) return process.env.FAKE_DISCOVERY === "500" ? json(500, {}) : json(403, {});
        if (url.endsWith("/api/agents")) return json(200, { data: ["a1", "a2", "a3", "a4", "a5"].map((id) => ({ id: "capability-" + id })) });
        if (url.endsWith("/api/geo/projects")) return json(200, { data: { projects: [{ id: "geo_1" }] } });
        if (url.endsWith("/api/geo/projects/geo_1/diagnosis")) return json(200, { data: { errors: [{ snapshotId: "snap_old", firstSnapshotId: "snap_1" }] } });
        if (url.endsWith("/api/vcr/studies")) return json(200, { data: { studies: [{ id: "std_a", steps: {} }, { id: "std_b", steps: { population: { status: "done" }, trial: { status: "minimal" } } }, { id: "std_c", steps: { population: { status: "done" } } }] } });
        if (url.endsWith("/api/frontier/items?limit=1")) return json(200, { data: { items: [{ id: "item_1" }] } });
        if (url.endsWith("/api/frontier/zones")) return json(200, { data: { items: [{ id: "z_user", kind: "user" }, { id: "z_official", kind: "official" }] } });
        if (url.endsWith("/api/frontier/hot")) return json(200, { data: { events: [{ id: "ev_1" }] } });
        if (url.endsWith("/api/frontier/zones/z_official/evidence")) return json(200, { data: { items: [{ id: "card_1" }] } });
        if (url.endsWith("/api/frontier/evidence/card_1/links")) return json(200, { data: { author: { id: "au_1", name: "平台" } } });
        if (url.endsWith("/api/agent-runs")) return json(200, { data: [{ id: "run_1", deliverables: [{ id: "pkg", capability: "clinical-evidence-synthesis", status: "delivered" }] }] });
        if (url.includes("/api/sources?")) return json(200, { data: { items: [{ id: "src_1", display: { format: "pdf", title: "一份指南" }, payload: { status: "complete" } }] } });
        if (url.endsWith("/api/connectors")) return json(200, { data: [{ title: "Semantic Scholar", keyless: true, source: "none" }, { title: "PubMed", keyless: false, source: "none" }] });
        if (url.endsWith("/api/me")) return loggedIn ? json(200, { data: { csrfToken: "t", operator: process.env.FAKE_OPERATOR === "1" } }) : json(401, {});
        return json(404, {});
      },
    },
  };
}
module.exports = { chromium: { launch: async () => ({ newContext: async () => context(), close: async () => {} }) } };
`;

/** What the walk takes for axe-core's build: a banner and `axe.run`. The fake page never runs it. */
const FAKE_AXE_SOURCE = "/*! axe v4.12.1\n * a stand-in for the test\n */\nwindow.axe = { version: \"4.12.1\" };\nwindow.axe.run = function () {};\n";

async function walk(env = {}, { axe = false, baseline = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-walk-"));
  await mkdir(path.join(dir, "playwright-core"));
  if (axe) await writeFile(path.join(dir, "axe.min.js"), FAKE_AXE_SOURCE);
  await writeFile(path.join(dir, "playwright-core", "index.js"), FAKE_PLAYWRIGHT);
  await writeFile(path.join(dir, "password"), "not-a-real-password\n");
  // The control-flow tests are about what the walk does, not about what its baseline accepts: this one accepts every sentence of a
  // finding, under a made-up owner. The baseline's own tests (`applyBaseline`, the `baseline` describe below) use real entries.
  await writeFile(path.join(dir, "baseline.json"), JSON.stringify(baseline ?? { entries: [{ view: "*", contains: ":", owner: "test", until: "2999-12-31", why: "the walk's control flow is under test, not its baseline" }] }));
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(repoRoot, "scripts/ops/ui-walk.mjs")], {
      env: {
        ...process.env,
        OPEN_SCIENCE_WALK_BASE_URL: "https://evimed.example.org",
        OPEN_SCIENCE_WALK_USER: "cdss-access",
        OPEN_SCIENCE_WALK_PASSWORD_FILE: path.join(dir, "password"),
        OPEN_SCIENCE_PLAYWRIGHT_CORE: path.join(dir, "playwright-core"),
        OPEN_SCIENCE_WALK_OUT: path.join(dir, "out"),
        OPEN_SCIENCE_WALK_CHAT: "",
        OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS: "0",
        OPEN_SCIENCE_WALK_AXE: axe ? path.join(dir, "axe.min.js") : "",
        OPEN_SCIENCE_WALK_BASELINE: path.join(dir, "baseline.json"),
        FAKE_PLAYWRIGHT_LOG: path.join(dir, "log.jsonl"),
        ...env,
      },
      timeout: 60_000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const log = (await readFile(path.join(dir, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  // A walk that died before it wrote its report says why (its stderr), not that a file is missing.
  const report = JSON.parse(await readFile(path.join(dir, "out", "report.json"), "utf8").catch((error) => { throw new Error(`the walk wrote no report (exit ${result.code}): ${result.stderr || result.stdout}`, { cause: error }); }));
  await rm(dir, { recursive: true, force: true });
  return { ...result, log, report };
}

test("the walk refuses every runtime start a page makes, and says how many", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  const starts = log.filter((entry) => entry.start);
  assert.ok(starts.length > 30, `the shell's warm-up fired on every page (${starts.length})`);
  assert.deepEqual([...new Set(starts.map((entry) => entry.verdict))], ["aborted"]);
  assert.equal(report.runtimeStartsRefused, starts.length);
  // All eight tabs of the account's first GEO project were walked.
  const visited = log.filter((entry) => entry.goto).map((entry) => new URL(entry.goto).pathname);
  for (const [, segment] of GEO_TABS) assert.ok(visited.includes(`/app/geo/geo_1${segment}`), `walked /app/geo/geo_1${segment}`);
  // The font pairs are a finding the baseline accepts here: in the report with the entry that accepted it, and the walk passed.
  assert.ok(report.notices.some((notice) => /^frontier@desktop: 5 font-size × weight pairs/.test(notice)));
  const pairs = report.findings.find((entry) => entry.rule === "type-pairs" && entry.view === "frontier@desktop");
  assert.deepEqual([pairs.value, pairs.accepted], [5, { owner: "test", until: "2999-12-31" }]);
  // A data page (the `data` and `geo` budgets) is allowed five (owner, 2026-10-19): the same five pairs are no finding there.
  assert.equal(report.findings.some((entry) => entry.rule === "type-pairs" && (entry.view === "files@desktop" || entry.view === "geo-overview@desktop")), false);
  assert.match(stdout, /baseline \(owner walk\): \d+ finding\(s\) accepted by 1 entry\(ies\), 0 not accepted/);
  assert.deepEqual(report.failures, []);
});

test("a partial walk (OPEN_SCIENCE_WALK_ONLY) reads the views it names at both widths, takes no step that is not a page, and says that it is not a release walk", async () => {
  const { code, stdout, stderr, log, report } = await walk({ OPEN_SCIENCE_WALK_ONLY: "files,geo-visibility" });
  assert.equal(code, 0, stdout + stderr);
  assert.deepEqual(report.only, ["files", "geo-visibility"]);
  assert.deepEqual(Object.keys(report.pages).filter((name) => /@(desktop|phone)$/.test(name)).sort(), ["files@desktop", "files@phone", "geo-visibility@desktop", "geo-visibility@phone"]);
  // The stale-chunk probe and the address-state steps are about the shell and the router, not about these pages.
  assert.equal(log.filter((entry) => entry.goto).some((entry) => /inbox/.test(entry.goto)), false);
  assert.match(stdout, /PARTIAL WALK \(files, geo-visibility\): not a release walk/);
  const unknown = await walk({ OPEN_SCIENCE_WALK_ONLY: "no-such-view" }).catch((error) => error);
  assert.match(String(unknown.message ?? unknown), /the walk wrote no report \(exit 2\)[\s\S]*names no view: no-such-view/);
});

test("a finding the baseline does not accept fails the walk, whatever kind of notice it used to be, and the delta says what", async () => {
  // R19 S4: 115 notices a run blocked nothing and belonged to nobody. With no baseline the same walk fails on every one of them.
  const { code, stdout, report } = await walk({ OPEN_SCIENCE_WALK_BASELINE: "none", FAKE_ROWS: "none" });
  assert.equal(code, 1);
  assert.deepEqual(report.baseline, { ...report.baseline, source: "none", profile: "owner", accepted: 0 });
  assert.ok(report.baseline.unaccepted > 20, `${report.baseline.unaccepted} findings were not accepted`);
  assert.equal(report.failures.length, report.baseline.unaccepted, "the findings are the only failures of a walk whose pages are right");
  assert.match(stdout, /FAIL \(not accepted by the baseline\) frontier@desktop: 5 font-size × weight pairs \(rule 4\).* \[type-pairs; no baseline entry accepts it\]/);
  // A coverage gap and a measure are both there: the account has no row to click on some page, and a page sets its text in five pairs.
  assert.ok(report.findings.some((entry) => entry.rule === "not-observable" && entry.accepted === null));
  assert.ok(report.findings.some((entry) => entry.rule === "type-pairs" && entry.accepted === null));
});

test("a probe that throws in the page fails the walk and says what it did not reach (R19 S3; 18.1's ReferenceError was a notice for a release)", async () => {
  const { code, report, stdout } = await walk({ FAKE_THROW: "markRowsProbe" });
  assert.equal(code, 1, "the walk was green with a probe that did not run");
  const failure = report.failures.find((line) => line.startsWith("memory-map-drawer: the step could not run"));
  assert.match(failure ?? "", /^memory-map-drawer: the step could not run, so the first mark of 记忆地图's list, and the drawer it opens was not reached \(ReferenceError: markRowsProbeHelper is not defined\)$/);
  assert.equal(report.steps["memory-map-drawer"].target, STEP_TARGETS["memory-map-drawer"]);
  assert.match(report.steps["memory-map-drawer"].error, /ReferenceError/);
  assert.match(stdout, /FAIL memory-map-drawer: the step could not run/);
  // No baseline entry can accept it: a step that did not run is the one finding that is never a debt.
  assert.ok(!report.findings.some((entry) => entry.rule === "step-failed"), "it is a failure, not a finding the baseline could be asked about");
  // A step that ran says what it was for.
  const fine = await walk();
  assert.equal(fine.report.steps["memory-map-drawer"].target, STEP_TARGETS["memory-map-drawer"]);
  for (const [name, read] of Object.entries(fine.report.steps)) assert.equal(typeof read.target, "string", `${name} names its target`);
});

test("the walk judges the composition of every page view it reads and hands what it finds to the baseline", async () => {
  const fine = await walk();
  assert.equal(fine.code, 0, fine.stdout + fine.stderr);
  assert.ok(fine.report.pages["geo-plan@desktop"].composition.stepRail.count === 8, "the composition is in the report, page by page");
  assert.deepEqual(fine.report.findings.filter((entry) => ["orphan-sentence", "step-rail", "chrome", "module-steps", "empty-state", "toggle-layers", "template-slot"].includes(entry.rule)), []);
  // A page with two sentences standing alone, a tab with seven steps among eight, a band that does not hold, an empty state with no way
  // forward and a second toolbar are each a finding of their rule, named by their page: strict, they fail the walk.
  const strict = { OPEN_SCIENCE_WALK_BASELINE: "none" };
  const orphans = await walk({ FAKE_COMPOSITION: "orphans", ...strict });
  assert.ok(orphans.report.failures.some((line) => /^files@desktop: \[orphan-sentence\] 2 sentences stand alone.*\[orphan-sentence; no baseline entry accepts it\]$/.test(line)), orphans.report.failures.filter((line) => line.includes("orphan")).join("\n"));
  const steps = await walk({ FAKE_COMPOSITION: "steps", ...strict });
  assert.ok(steps.report.failures.some((line) => line.startsWith("geo@desktop: the steps are not the same on every tab: geo-overview 8, geo-visibility 7")), steps.report.failures.join("\n"));
  const band = await walk({ FAKE_COMPOSITION: "band", ...strict });
  assert.ok(band.report.failures.some((line) => /^geo-plan@desktop: \[chrome\] the band is at -340 px after the page moved 400 px/.test(line)));
  const empty = await walk({ FAKE_COMPOSITION: "empty", ...strict });
  assert.ok(empty.report.failures.some((line) => /^inbox@desktop: \[empty-state\] the empty state “暂无消息” has no a mark and no an action or the reason there is none/.test(line)));
  const layers = await walk({ FAKE_COMPOSITION: "layers", ...strict });
  assert.ok(layers.report.failures.some((line) => /^memory@desktop: \[toggle-layers\] 2 toolbars on the page/.test(line)));
  // A baseline entry holds a page at what it has: the orphans of the knowledge base are accepted up to two, with an owner and a day, and nothing else is.
  const entry = (max) => ({ view: "files@desktop", rule: "orphan-sentence", max, owner: "pagesa", until: "2999-12-31", why: "the knowledge base's two cards before there is a document" });
  const held = await walk({ FAKE_COMPOSITION: "orphans" }, { baseline: { entries: [entry(2)] } });
  const found = (read) => read.report.findings.find((item) => item.rule === "orphan-sentence");
  assert.deepEqual(found(held).accepted, { owner: "pagesa", until: "2999-12-31" });
  assert.equal(held.report.baseline.accepted, 1);
  const worse = await walk({ FAKE_COMPOSITION: "orphans" }, { baseline: { entries: [entry(1)] } });
  assert.equal(found(worse).accepted, null, "a page may not get worse than the baseline holds it at");
  assert.ok(worse.report.baseline.lowerable.length === 0 && worse.report.baseline.unused.length === 1);
});

test("every page view is photographed whole and its make-up written beside the pictures, and the report links them", async () => {
  const { code, log, report } = await walk();
  assert.equal(code, 0);
  const views = Object.keys(report.pages).filter((view) => report.pages[view].composition);
  assert.ok(views.length > 100, `${views.length} page views have a composition`);
  for (const view of views) {
    assert.deepEqual(report.pages[view].files, { screenshots: [`${view}.jpg`], capture: { kind: "single" }, facts: `${view}.json` }, view);
  }
  // Moderate JPEG, and the early first-screen PNG is gone: a page's picture is the page.
  const shots = log.filter((entry) => entry.screenshot?.startsWith("files@desktop"));
  assert.deepEqual(shots, [{ screenshot: "files@desktop.jpg", type: "jpeg", quality: CAPTURE_QUALITY }]);
  assert.ok(!log.some((entry) => /@(desktop|phone)\.png$/.test(entry.screenshot ?? "") && !/^(stale-chunk|chat)@/.test(entry.screenshot)), "no first-screen picture of a page view");
  // A page two windows tall: the window is stretched to the page for the picture, then put back.
  const stretch = await walk({ FAKE_SCROLL: "stretch" });
  assert.deepEqual(stretch.report.pages["files@desktop"].files, { screenshots: ["files@desktop.jpg"], capture: { kind: "stretch" }, facts: "files@desktop.json" });
  const resize = stretch.log.filter((entry) => entry.viewport);
  const at = stretch.log.findIndex((entry) => entry.screenshot === "files@desktop.jpg");
  assert.deepEqual([stretch.log[at - 1], stretch.log[at + 1]], [{ viewport: "1512x2200" }, { viewport: "1512x945" }]);
  assert.ok(resize.length > 4);
  // A page nine windows tall: slices of a window and a half from the top, the scroll area put back at the top.
  const tall = await walk({ FAKE_SCROLL: "tall" });
  assert.deepEqual(tall.report.pages["files@desktop"].files.capture, { kind: "slices", slices: 7, truncated: false });
  assert.deepEqual(tall.report.pages["files@desktop"].files.screenshots, [1, 2, 3, 4, 5, 6, 7].map((n) => `files@desktop.${n}.jpg`));
  const scrolls = tall.log.filter((entry) => entry.scrollTo !== undefined && entry.at === "/app/files");
  assert.deepEqual(scrolls.slice(0, 8).map((entry) => entry.scrollTo), [0, 1418, 2836, 4254, 5672, 7090, 8505, 0]);
  // A page of fifty windows: eight slices and the report says the rest was cut off.
  const taller = await walk({ FAKE_SCROLL: "taller" });
  assert.deepEqual(taller.report.pages["files@desktop"].files.capture, { kind: "slices", slices: CAPTURE_MAX_SLICES, truncated: true });
});

test("a candidate check named for the walk is in its report and its output, as information", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-walk-candidate-"));
  const file = path.join(dir, "candidate-check.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, checkedAt: "2026-10-17T03:10:00Z", pin: { dsh: "0.1.7-rc.2" }, candidates: [{ version: "0.2.1-alpha.2", tags: ["alpha"], lagDays: 9.9, verdict: "blocked", reasons: ["two unclassified wire methods"] }], pins: [], unknown: [] }));
  try {
    const { code, stdout, report } = await walk({ OPEN_SCIENCE_WALK_CANDIDATE_CHECK: file });
    assert.equal(code, 0, "information never fails a walk");
    assert.deepEqual([report.candidateCheck.pin, report.candidateCheck.candidates[0].verdict], ["0.1.7-rc.2", "blocked"]);
    assert.match(stdout, /INFO candidate check \(2026-10-17T03:10:00Z\): the kernel is pinned at 0\.1\.7-rc\.2; 1 candidate\(s\)/);
    assert.match(stdout, /INFO {3}0\.2\.1-alpha\.2 \(alpha\): blocked, 9\.9 days after the pin — two unclassified wire methods/);
    // A file that is not there is the common case: nothing is said.
    const none = await walk({ OPEN_SCIENCE_WALK_CANDIDATE_CHECK: path.join(dir, "absent.json") });
    assert.equal(none.report.candidateCheck, undefined);
    assert.ok(!none.report.info.some((line) => line.startsWith("candidate check")));
    await writeFile(file, "{ broken");
    const broken = await walk({ OPEN_SCIENCE_WALK_CANDIDATE_CHECK: file });
    assert.equal(broken.code, 0);
    assert.match(broken.report.info.find((line) => line.startsWith("candidate check")), /is not JSON, so it was not read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a list the walk finds its pages by that the deployment cannot answer is a failure; one the account may not read is a page it was not offered", async () => {
  // A server error would otherwise drop the project's eight tabs from the walk as a coverage gap that reads like an account with no project.
  const broken = await walk({ FAKE_DISCOVERY: "500" });
  assert.equal(broken.code, 1);
  assert.ok(broken.report.failures.includes("discovery: /api/geo/projects answered 500, so the pages it names were not found"), broken.report.failures.join("\n"));
  const refused = await walk({ FAKE_DISCOVERY: "refused" });
  assert.equal(refused.code, 0, "a refusal is the account's");
  assert.ok(!refused.report.failures.some((line) => line.startsWith("discovery:")));
  assert.ok(!Object.keys(refused.report.pages).some((view) => view.startsWith("geo-overview@")), "no project was found, so no GEO tab was walked");
});

test("every document the walk opens starts in the account's own project, so that a click into a study does not turn the pages after it into that study's", async () => {
  const { log } = await walk();
  const installed = log.findIndex((entry) => entry.initScript === "forgetProjectChoice");
  const firstPage = log.findIndex((entry) => entry.goto);
  assert.ok(installed >= 0 && installed < firstPage, "the script is on the context before the first page is opened");
  assert.equal(log.filter((entry) => entry.initScript).length, 1);
});

test("the chat page, when asked for, is the one page allowed to start the runtime", async () => {
  const { code, stdout, stderr, log } = await walk({ OPEN_SCIENCE_WALK_CHAT: "1" });
  assert.equal(code, 0, stdout + stderr);
  const chatAt = log.findIndex((entry) => entry.goto?.endsWith("/app/chat"));
  assert.ok(chatAt > 0, "the chat page was opened");
  assert.deepEqual([...new Set(log.slice(0, chatAt).filter((entry) => entry.start).map((entry) => entry.verdict))], ["aborted"]);
  // The conversation's own start is let through; the cleanup cover that follows it is answered by the walk itself, and never reaches the runtime.
  assert.deepEqual(log.slice(chatAt).filter((entry) => entry.start).map((entry) => entry.verdict), ["allowed", "fulfilled"]);
});

test("a chat page that fails because the walk's own network changed is retried once, as a reader would, and noted", async () => {
  // 2026-09-28: the walk runs on the host's network; starting the account's
  // runtime adds a Docker interface, Chromium drops the page's requests with
  // ERR_NETWORK_CHANGED, and the page says 打开超时，请重试.
  const { code, stdout, stderr, log, report } = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_CHAT: "network-changed" });
  assert.equal(code, 0, stdout + stderr);
  assert.deepEqual(log.filter((entry) => entry.click).map((entry) => entry.click), ["重试"]);
  assert.ok(report.info.some((line) => /chat@desktop: loaded after one 重试/.test(line)), report.info.join("\n"));
  assert.deepEqual(report.failures, []);
});

test("a chat page that still fails after the one retry fails the walk", async () => {
  const { code, report } = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_CHAT: "broken" });
  assert.equal(code, 1);
  assert.ok(report.failures.some((failure) => /chat@desktop: the conversation frame did not load \(打开超时/.test(failure)), report.failures.join("\n"));
});


test("medical acronyms remain prose while actual internal source labels are still detected", () => {
  const prose = measureControls([{ tag: "p", height: 24, text: "FDA 警告涉及 cGMP、原料药（API）及掺假问题；血压（BP）正常。" }]);
  assert.deepEqual(prose.backOfficeHits, []);
  const internal = measureControls([{ tag: "p", height: 24, text: "检索来源 openFDA 药品召回；缓存命中。" }]);
  assert.equal(internal.backOfficeHits.length, 2);
});

test("「已交付」 as a status label is the back office; inside a sentence of content it is not", () => {
  for (const text of ["已交付 · 有结论未逐字核对", "状态：已交付", "已交付"]) {
    assert.equal(measureControls([{ tag: "p", height: 24, text }]).backOfficeHits.length, 1, text);
  }
  for (const text of ["修订已交付报告后重系引证与数值", "报告已交付给课题组"]) {
    assert.deepEqual(measureControls([{ tag: "p", height: 24, text }]).backOfficeHits, [], text);
  }
});

test("CSS chart marks are drawing strokes while chart frames and ordinary borders still count", () => {
  const stroke = (color, flags) => ({ tag: "span", height: 12, width: 12, ...flags,
    style: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: color } });
  const measured = measureControls([stroke("red", { chartMark: true }), stroke("blue", { chartMark: true }),
    stroke("grey", { chartRoot: true }), stroke("black", {})]);
  assert.equal(measured.borderKinds, 2);
});

test("a slow route is measured after it settles, and an unresolved route or missing title still fails", async () => {
  const ready = await walk({ FAKE_SLOW_ROUTE: "ready" });
  assert.equal(ready.code, 0, ready.stdout + ready.stderr);
  const pending = await walk({ FAKE_SLOW_ROUTE: "never" });
  assert.equal(pending.code, 1);
  assert.ok(pending.report.failures.some(line => line.includes("account@phone: did not load")));
  const missing = await walk({ FAKE_MISSING_TITLE: "1" });
  assert.equal(missing.code, 1);
  assert.ok(missing.report.failures.some(line => line.includes("the page has no title of its own")));
});

test("the walk clicks the first row of each list on the pages R10 rebuilt, at the desktop width only, and reports what it clicked", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  const clicked = new Set(log.filter((entry) => entry.rowClick).map((entry) => entry.rowClick));
  assert.deepEqual([...clicked].sort(), [...ROW_CLICK_PAGES].map((name) => routeOf(name).split("?")[0]).filter((value, index, all) => all.indexOf(value) === index).sort());
  // One click per page view that has a list: the page walked at the desktop width, never the phone's.
  assert.deepEqual(report.pages["files@desktop"].rowClicks, [{ label: "资料清单", shown: true }]);
  assert.equal(report.pages["files@phone"].rowClicks, undefined);
  // 科研工具's cards start a conversation, so the walk does not click them.
  assert.equal(report.pages["capabilities@desktop"].rowClicks, undefined);
});

test("a row that shows nothing when clicked fails the page it is on, on every page that is clicked", async () => {
  const { code, report } = await walk({ FAKE_ROWS: "dead" });
  assert.equal(code, 1);
  const sentence = (name) => `${name}@desktop: clicking the first row of the list “资料清单” showed nothing — no drawer, no page, no opened row`;
  // R13 made six of these pages notices "until a walk has reported how they behave"; R19 S4 made them what the others always were.
  for (const name of ROW_CLICK_PAGES) assert.ok(report.failures.includes(sentence(name)), name);
  assert.ok(report.failures.includes("memory-map@desktop: pressing the first mark opened no drawer"));
  assert.equal(report.failures.length, ROW_CLICK_PAGES.size + 2, report.failures.filter((line) => !line.includes("showed nothing")).join("\n"));
  for (const name of ["frontier-zones", "geo", "geo-accuracy", "geo-questions", "inbox", "geo-sources", "autopilot", "files"]) assert.ok(ROW_CLICK_PAGES.has(name), name);
  // 设置 › 账户 is rows with their own buttons and no list that opens anything (the fixture walk could only report it unobservable).
  assert.equal(ROW_CLICK_PAGES.has("account"), false);
});

test("a row that is a link to an outside address is not a row that shows nothing, even when the browser reports no new tab", async () => {
  const { code, stdout, stderr, report } = await walk({ FAKE_ROWS: "external" });
  assert.equal(code, 0, stdout + stderr);
  assert.deepEqual(report.pages["frontier@desktop"].rowClicks, [{ label: "资料清单", shown: true }]);
});

test("with two lists on a page the walk loads the page again before the second click", async () => {
  const { code, stdout, stderr, log } = await walk({ FAKE_ROWS: "two" });
  assert.equal(code, 0, stdout + stderr);
  // The 知识页 filter's two views are other addresses of the same page: they carry a query, and this is the plain list's.
  const events = log.filter((entry) => (entry.goto && entry.goto.endsWith("/app/files")) || (entry.rowClick === "/app/files" && !entry.search));
  // The page, the first click, the page again, the second click — then the knowledge base's PDF step and its way-back step each open the page
  // once more, and the phone's view is the last.
  assert.deepEqual(events.map((entry) => (entry.rowClick ? `click ${entry.index}` : "goto")), ["goto", "click 第一张清单", "goto", "click 第二张清单", "goto", "goto", "goto"]);
});

test("R13 first-row clicks: 循证 GEO's groups and findings are clicked like any row, the task page and the drawer are read", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  // R19 (GEOB): the groups of 问题与回答 and the findings of 准确与安全 are rows that open a drawer, so nothing is opened or linked first.
  assert.ok(!log.some((entry) => entry.reveal || entry.link), "no page is revealed or linked before its first row is clicked");
  for (const page of ["geo-questions", "geo-accuracy"]) assert.ok(log.some((entry) => entry.rowClick === `/app/geo/geo_1/${page.replace("geo-", "")}`), page);
  // Every R13 page was clicked, and what the first click opened was read where the page has a reading (the source's drawer, the task's page).
  for (const name of ["geo-questions", "geo-accuracy", "inbox", "geo", "frontier-zones"]) assert.deepEqual(report.pages[`${name}@desktop`].rowClicks, [{ label: "资料清单", shown: true }], name);
  assert.deepEqual(report.pages["geo-sources@desktop"].rowClicks[0].after, { dialog: true, drawers: 1 });
  assert.equal(report.pages["autopilot@desktop"].rowClicks[0].after.pane, "conversation");
  // The walk starts no runtime, so the task's frame container is compared and an INFO line says there was no iframe to compare: no walk
  // could fill it, so it is not a coverage gap (a fixture walk accepts none).
  assert.ok(report.info.includes("autopilot@desktop: the frame's container is placed over the pane, and holds no iframe (the walk starts no runtime), so only the container was compared"), report.info.join("\n"));
  assert.equal(report.notices.some((line) => line.includes("holds no iframe")), false);
  // The knowledge base: a PDF opened on its own page, then the way back to a long list with the search it was found by.
  assert.ok(report.steps["files-return"].browserBack && report.steps["files-return"].back);
  assert.deepEqual(log.filter((entry) => entry.fill).map((entry) => [entry.fill, entry.value]).filter(([name]) => name === "搜索资料和内容"), [["搜索资料和内容", "一份指南"]]);
  assert.deepEqual(report.steps["files-return"].reader.back, { text: "知识库", href: "/app/files?q=" + encodeURIComponent("一份指南") });
});

test("a page with no row to click says so as a notice and fails nothing; a row that writes on its way is refused in the browser, and said", async () => {
  const none = await walk({ FAKE_ROWS: "none" });
  assert.equal(none.code, 0, none.stdout + none.stderr);
  for (const name of ROW_CLICK_PAGES) {
    assert.ok(none.report.notices.includes(`${name}@desktop: not observable: no list on the page has a first row that opens (an empty list, a page without rows, or an account with none), so no click was made`), name);
    assert.deepEqual(none.report.pages[`${name}@desktop`].rowClicks, [], name);
  }
  // With no row on the knowledge base there is nothing to open and come back from, and the step is not run.
  assert.equal(none.report.steps?.["files-return"], undefined);

  const writes = await walk({ FAKE_ROW_WRITE: "1" });
  assert.equal(writes.code, 0, writes.stdout + writes.stderr);
  // The inbox's row marks itself read on the way: the POST is refused, the GET and the runtime start (the context's) are handed on.
  assert.ok(writes.report.info.includes("inbox@desktop: clicking the first row tried 1 write(s), refused in the browser: POST /api/inbox/n1/read"), writes.report.info.join("\n"));
  assert.ok(writes.log.some((entry) => entry.aborted === "POST") && writes.log.some((entry) => entry.fellBack === "GET") && writes.log.some((entry) => entry.fellBack === "start_runtime"));
  assert.ok(!writes.log.some((entry) => entry.aborted === "start_runtime" || entry.aborted === "GET"));
  // Every page is clicked behind the guard now (R13 guarded only its six new pages), and what it refused is information, not a finding.
  assert.ok(!writes.report.notices.some((notice) => /clicking the first row tried/.test(notice)));
  // The guard is removed after every page it was put on.
  const routes = writes.log.filter((entry) => entry.route === "**/api/**").length;
  assert.equal(routes, ROW_CLICK_PAGES.size + 1, "one guard per clicked page, and the new-skill drawer's own");
  assert.equal(writes.log.filter((entry) => entry.unroute).length, routes);
});

test("the way back to the knowledge base's list is read, and a list that does not come back as it was left is a notice", async () => {
  const lost = await walk({ FAKE_KB: "lost" });
  assert.equal(lost.code, 0, lost.stdout + lost.stderr);
  const q = "/app/files?q=" + encodeURIComponent("一份指南");
  assert.deepEqual(lost.report.notices.filter((notice) => /^files@desktop: after /.test(notice)), [
    `files@desktop: after 「知识库」 on the document's page the address is /app/files and the list was ${q}`,
    `files@desktop: after the browser's Back the address is /app/files and the list was ${q}`,
  ]);
  // A list that comes back as it was left says nothing.
  const kept = await walk();
  assert.deepEqual(kept.report.notices.filter((notice) => /^files@desktop: (after|the document|the search|the reader|the way back)/.test(notice)), []);
});

test("a retired module name, a second primary action or a stacked page fails the walk, naming the page", async () => {
  const retired = await walk({ FAKE_RETIRED: "1" });
  assert.equal(retired.code, 1);
  for (const view of ["files@desktop", "files@phone", "geo@desktop", "memory@phone"]) {
    assert.ok(retired.report.failures.includes(`${view}: a retired module name on the page: 循证传播`), view); // retired-word-ok
  }
  const two = await walk({ FAKE_TWO_PRIMARY: "1" });
  assert.equal(two.code, 1);
  assert.ok(two.report.failures.includes("files@desktop: the page header has 2 primary actions (at most one): 新建 / 导入"));
  const stacked = await walk({ FAKE_STACKED: "1" });
  assert.equal(stacked.code, 1);
  assert.ok(stacked.report.failures.includes("files@desktop: the page stacks 3 kinds of section (budget 2): ul>li, table>thead+tbody, svg>g+g"));
  // A page with no section budget is not held to one.
  assert.ok(!stacked.report.failures.some((failure) => failure.startsWith("account@")), stacked.report.failures.join("\n"));
});

// ——— R11: the walk of what the two audits of 2026-10-07 found ———

test("a variant page is held to its page's budget, and no page is excused one because nobody has measured it", () => {
  assert.equal(budgetKey("vcr-trial@2"), "vcr-trial");
  assert.equal(budgetKey("vcr-trial"), "vcr-trial");
  // The second study is the same page: the same numbers fail it.
  assert.equal(pageFindings("vcr-trial@2", "desktop", clean({ controlKinds: 11, sectionShapes: ["a", "b", "c"] }), []).failures.length, 1);
  // R19 S2 ended the provisional list (pages whose number past a budget was a notice): a budget breach fails every page, and a page that
  // has to spend more says so in the page table with the measure behind it.
  const breach = pageFindings("frontier-zone", "desktop", clean({ controlKinds: 12, borderKinds: 5, pageLefts: [240, 300] }), []);
  assert.deepEqual(breach.failures, [
    "frontier-zone@desktop: 12 kinds of control (budget 9)", "frontier-zone@desktop: 5 kinds of border (budget 3)",
    "frontier-zone@desktop: the page's blocks start on 2 left edges (240, 300)",
  ]);
  assert.deepEqual(breach.notices, []);
  assert.deepEqual(pageFindings("frontier-zone", "desktop", clean({ leakHits: ["undefined"], retiredNameHits: ["循证传播"] }), []).failures.length, 2); // retired-word-ok
  assert.deepEqual(pageFindings("frontier-zone", "phone", clean({ overflowX: true }), []).failures, ["frontier-zone@phone: the page overflows horizontally at 390 px"]);

  // R13's two rebuilt pages were notices until a walk had reported them; the same numbers fail them now, as they fail every other page.
  assert.deepEqual(pageFindings("autopilot", "desktop", clean({ pageLefts: [248, 240] }), []).failures, ["autopilot@desktop: the page's blocks start on 2 left edges (248, 240)"]);
  assert.deepEqual(pageFindings("autopilot", "phone", clean({ overflowX: true }), []).failures, ["autopilot@phone: the page overflows horizontally at 390 px"]);
  assert.deepEqual(pageFindings("geo-sources", "desktop", clean({ controlKinds: 11 }), []).failures, ["geo-sources@desktop: 11 kinds of control (budget 10)"]);
  assert.deepEqual(pageFindings("geo-overview", "desktop", clean({ controlKinds: 11 }), []).failures, ["geo-overview@desktop: 11 kinds of control (budget 10)"]);
  assert.deepEqual(pageFindings("inbox", "desktop", clean({ pageLefts: [248, 240] }), []).failures, ["inbox@desktop: the page's blocks start on 2 left edges (248, 240)"]);
  assert.deepEqual(pageFindings("geo-sources", "desktop", clean({ leakHits: ["undefined"] }), []).failures.length, 1);
});

/** Every name the walk reports a page under, static or found. */
function walkedNames() {
  return new Set([...ROUTES.map(([name]) => name), ...GEO_TABS.map(([name]) => name), ...VCR_TABS_WALK.map(([name]) => name), ...DISCOVERED_PAGES]);
}

test("the refusals a page is walked to meet are not failures, and any other refusal still is", () => {
  assert.deepEqual(Object.keys(EXPECTED_REFUSALS).sort(), ["extensions-skill-missing", "frontier-daily-empty", "memory-shared-missing"]);
  // A day nobody published answers 404, and the page is walked to say so in words.
  assert.deepEqual(unexpectedRefusals("frontier-daily-empty", ["404 /api/frontier/dailies/2020-01-01", "500 /api/frontier/dailies"]), ["500 /api/frontier/dailies"]);
  assert.deepEqual(unexpectedRefusals("frontier-daily", ["404 /api/frontier/dailies/2026-10-10", "404 /api/frontier/dailies", "404 /api/me", "500 /api/frontier/dailies/2026-10-10"]), ["404 /api/frontier/dailies", "404 /api/me", "500 /api/frontier/dailies/2026-10-10"]);
  assert.deepEqual(unexpectedRefusals("extensions-skill-missing", ["404 /api/skills/impeccable-audit-missing", "500 /api/skills"]), ["500 /api/skills"]);
  assert.deepEqual(unexpectedRefusals("memory-shared-missing", ["404 /api/capsules/shares/x", "410 /api/capsules/shares/x", "403 /api/capsules"]), ["403 /api/capsules"]);
  // A page with no expected refusal keeps all of them, and a refusal that is not the API's was never a refusal of the page.
  assert.deepEqual(unexpectedRefusals("memory", ["404 /api/memory"]), ["404 /api/memory"]);
  assert.deepEqual(pageFindings("extensions-skill-missing", "desktop", clean(), unexpectedRefusals("extensions-skill-missing", ["404 /api/skills/x"])).failures, []);
  assert.equal(pageFindings("extensions-skill-missing", "desktop", clean(), unexpectedRefusals("extensions-skill-missing", ["502 /api/skills/x"])).failures.length, 1);
});

test("navigation resets Chromium's error page after a network change and retries only once", async () => {
  const visited = [];
  let notices = 0;
  const page = { goto: async (url) => { visited.push(url); if (visited.length === 1) throw new Error("page.goto: net::ERR_NETWORK_CHANGED"); return "loaded"; }, waitForTimeout: async () => {} };
  assert.equal(await navigateForWalk(page, "https://example.org/app/files", () => notices++), "loaded");
  assert.deepEqual(visited, ["https://example.org/app/files", "about:blank", "https://example.org/app/files"]);
  assert.equal(notices, 1);
  let attempts = 0;
  page.goto = async (url) => { if (url !== "about:blank") { attempts++; throw new Error("net::ERR_NETWORK_CHANGED"); } };
  await assert.rejects(navigateForWalk(page, "https://example.org/app/files", () => {}), /ERR_NETWORK_CHANGED/);
  assert.equal(attempts, 2);
  page.goto = async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); };
  await assert.rejects(navigateForWalk(page, "https://example.org/app/files", () => { throw new Error("unexpected retry"); }), /ERR_CONNECTION_REFUSED/);
});

test("the studies and ids the walk opens are read from the lists, and a missing id is a page not walked", () => {
  const study = (id, ...done) => ({ id, steps: Object.fromEntries(done.map((status, index) => [`s${index}`, { status }])) });
  // The study that has produced the most is walked, then the first other; ties go to the list's order.
  assert.deepEqual(pickVcrStudies([study("a"), study("b", "done", "minimal", "running"), study("c", "done")]), { primary: "b", second: "a" });
  assert.deepEqual(pickVcrStudies([study("a", "done"), study("b", "done")]), { primary: "a", second: "b" });
  assert.deepEqual(pickVcrStudies([study("only")]), { primary: "only", second: null });
  assert.deepEqual(pickVcrStudies(undefined), { primary: null, second: null });

  assert.equal(geoAnswerSnapshot({ errors: [{ snapshotId: "old", firstSnapshotId: "first" }] }), "first");
  assert.equal(geoAnswerSnapshot({ errors: [{ snapshotId: null }, { snapshotId: "second" }] }), "second");
  assert.equal(geoAnswerSnapshot({ errors: [] }), null);
  assert.equal(geoAnswerSnapshot(null), null);

  const zones = { items: [{ id: "z1", kind: "user" }, { id: "z2", kind: "official" }] };
  assert.deepEqual(frontierTargets({ zones, hot: { events: [{ id: "e1" }] } }), { zoneId: "z1", official: "z2", cardId: null, authorId: null, eventId: "e1" });
  assert.deepEqual(frontierTargets({ cards: { items: [{ id: "c1" }] }, links: { author: { id: "a1" } } }), { zoneId: null, official: null, cardId: "c1", authorId: "a1", eventId: null });
  assert.deepEqual(frontierTargets({}), { zoneId: null, official: null, cardId: null, authorId: null, eventId: null });

  const runs = [
    { id: "run_old", deliverables: [{ id: "x", capability: "drug-evidence", status: "delivered" }] },
    { id: "run_a", deliverables: [{ id: "pkg 1", capability: "clinical-evidence-synthesis", status: "failed" }] },
    { id: "run_b", deliverables: [{ id: "pkg", capability: "clinical-evidence-synthesis", status: "delivered" }] },
  ];
  assert.equal(matrixRoute(runs), "/app/runs/run_b/files/deliverables/pkg/clinical-evidence-matrix.json");
  assert.equal(matrixRoute([runs[0], runs[1]]), null);
  assert.equal(matrixRoute(undefined), null);

  const sources = { items: [{ display: { format: "docx", title: "报告" }, payload: { status: "complete" } }, { display: { format: "pdf", title: " 一份指南 " }, payload: { status: "parsing" } }, { display: { format: "pdf", title: " 另一份指南 " }, payload: { status: "complete" } }] };
  assert.equal(pdfSourceTitle(sources), "另一份指南");
  assert.equal(pdfSourceTitle({ items: [] }), null);

  // A document's own page: the first document read to the end, whatever it is; none, no page.
  const documents = { items: [{ id: "src_a", display: { format: "docx" }, payload: { status: "parsing" } }, { id: "src b/1", display: { format: "docx" }, payload: { status: "complete" } }, { id: "src_c", payload: { status: "complete" } }] };
  assert.equal(sourceReaderRoute(documents), "/app/files/src%20b%2F1");
  assert.equal(sourceReaderRoute({ items: [{ payload: { status: "complete" } }, { id: "", payload: { status: "complete" } }] }), null);
  assert.equal(sourceReaderRoute({ items: [] }), null);
  assert.equal(sourceReaderRoute(undefined), null);

  assert.deepEqual(keylessTitles([{ title: "Semantic Scholar", keyless: true, source: "none" }, { title: "PubMed", keyless: false, source: "none" }, { title: "NCBI", keyless: true, source: "user" }]), ["Semantic Scholar"]);
  assert.deepEqual(keylessTitles(null), []);
});

/** The sidebar a page of the shell has: one landmark named 侧栏, its divider and its link to the conversation. */
const sidebar = (w = 240, attrs = {}) => node("aside", { attrs: { "aria-label": "侧栏", "data-sidebar": "", ...attrs }, w }, [
  node("nav", {}, [node("a", { attrs: { href: "/app/chat" }, text: "对话", tabIndex: 0 })]),
  node("div", { attrs: { role: "separator" }, w: 4 }),
]);

test("the structure measure reads the sidebar landmark, the regions that scroll sideways, the heading levels and the page's height", () => {
  const reachable = node("div", { attrs: { class: "scroller" }, w: 400, scrollW: 900, style: { overflowX: "auto" } }, [node("button", { text: "按钮", tabIndex: 0 })]);
  const stranded = node("div", { attrs: { "aria-label": "矩阵" }, w: 400, scrollW: 900, style: { overflowX: "auto" } }, [node("p", { text: "没有可以按的东西" })]);
  const stop = node("div", { attrs: { tabindex: "0" }, w: 400, scrollW: 900, tabIndex: 0, style: { overflowX: "auto" } });
  const narrowEnough = node("div", { w: 400, scrollW: 400, style: { overflowX: "auto" } });
  const tall = node("div", { w: 600, h: 400, scrollH: 20000, style: { overflowY: "auto" } });
  const body = node("body", {}, [sidebar(), node("main", {}, [
    node("div", {}, [
      node("header", {}, [node("h1", { text: "地图" })]),
      node("h3", { text: "跳过了二级" }), node("h2", { text: "二级" }), node("h4", { text: "又跳了" }),
      reachable, stranded, stop, narrowEnough, tall,
      node("ul", {}, [node("li", {}, [node("button", { attrs: { "data-row-title": "" }, text: "波立维" })]), node("li", {}, [node("button", { attrs: { "data-row-title": "" }, text: "波立维" })])]),
      node("div", {}, [node("p", { text: "样本量" }), node("p", { attrs: { "data-vcr-count": "events" }, text: "12", w: 40, scrollW: 90 })]),
    ]),
  ])]);
  const measured = inPage(body, () => measureStructure());
  assert.deepEqual(measured.sidebar, { landmarks: 1, holdsDivider: true, chatLink: true, closed: false, inert: false });
  // A scroller is reachable when it is a stop or holds one; a focusable one without a name is its own finding.
  assert.deepEqual(measured.scrollers.map(({ label, reachable: ok, stop: own, named }) => [label, ok, own, named]), [
    ["scroller", true, false, false], ["矩阵", false, false, true], ["div", true, true, false],
  ]);
  assert.deepEqual(measured.headingJumps, ["h1→h3 “跳过了二级”", "h2→h4 “又跳了”"]);
  assert.equal(measured.height, 20000);
  assert.equal(measured.viewport, 945);
  assert.equal(measured.rows, 2);
  assert.deepEqual(measured.duplicateTitles, ["波立维"]);
  assert.equal(measured.truncatedCounts, 1);
  // A closed sidebar is 0 wide and says it is inert.
  const closed = inPage(page(header()), () => measureStructure());
  assert.equal(closed.sidebar.landmarks, 0);
  const folded = inPage(node("body", {}, [sidebar(0, { inert: "" }), node("main", {})]), () => measureStructure());
  assert.deepEqual([folded.sidebar.closed, folded.sidebar.inert], [true, true]);
});

test("a sidebar that is missing, doubled or open to the Tab key, a region that is no Tab stop and holds none, and a skipped heading fail; a tall page and many rows are notices", () => {
  const side = { landmarks: 1, holdsDivider: true, chatLink: true, closed: false, inert: false };
  const read = (overrides = {}) => ({ sidebar: side, scrollers: [], headingJumps: [], height: 1800, viewport: 945, rows: 5, duplicateTitles: [], truncatedCounts: 0, ...overrides });
  const findings = (name, viewport, overrides) => structureFindings(name, viewport, read(overrides));
  assert.deepEqual(findings("files", "desktop"), { failures: [], notices: [] });
  assert.deepEqual(structureFindings("files", "desktop", null), { failures: [], notices: [] });

  assert.deepEqual(findings("autopilot", "desktop", { sidebar: { ...side, landmarks: 0 } }).failures, ["autopilot@desktop: 0 sidebar landmarks named 侧栏 (exactly one)"]);
  assert.deepEqual(findings("autopilot", "desktop", { sidebar: { ...side, landmarks: 2 } }).failures, ["autopilot@desktop: 2 sidebar landmarks named 侧栏 (exactly one)"]);
  assert.deepEqual(findings("autopilot", "desktop", { sidebar: { ...side, chatLink: false } }).failures, ["autopilot@desktop: the sidebar has no link to the conversation"]);
  assert.deepEqual(findings("files", "desktop", { sidebar: { ...side, holdsDivider: false } }).failures, ["files@desktop: the sidebar landmark does not hold its divider"]);
  // Inert matters when the sidebar is closed — the phone's state — and only there.
  assert.deepEqual(findings("files", "phone", { sidebar: { ...side, closed: true } }).failures, ["files@phone: the closed sidebar is not inert — its links are still tab stops"]);
  assert.deepEqual(findings("files", "phone", { sidebar: { ...side, closed: true, inert: true } }).failures, []);
  assert.deepEqual(findings("files", "desktop", { sidebar: { ...side, inert: false } }).failures, []);

  const region = (overrides) => ({ label: "证据矩阵", reachable: true, stop: false, named: true, ...overrides });
  assert.deepEqual(findings("report", "desktop", { scrollers: [region(), region({ reachable: false, label: "table" })] }).failures,
    ["report@desktop: 1 region(s) scroll sideways and are no tab stop and hold none: table"]);
  assert.deepEqual(findings("report", "desktop", { scrollers: [region({ stop: true, named: false })] }).failures,
    ["report@desktop: 1 focusable scrolling region(s) without a name: 证据矩阵"]);

  // GEO's overview and the memory page had their heading levels fixed: a skip there fails. Elsewhere it is read, not failed on.
  assert.deepEqual([...HEADING_ORDER_PAGES].sort(), ["geo-overview", "memory"]);
  assert.deepEqual(findings("geo-overview", "desktop", { headingJumps: ["h1→h3 “本周”"] }).failures, ["geo-overview@desktop: heading levels skip: h1→h3 “本周”"]);
  const elsewhere = findings("files", "desktop", { headingJumps: ["h1→h3 “本周”"] });
  assert.deepEqual(elsewhere.failures, []);
  assert.deepEqual(elsewhere.notices, [{ rule: "heading-order", view: "files@desktop", text: "files@desktop: heading levels skip: h1→h3 “本周”", value: 1 }]);

  // A page's height is judged against its template's number of viewports by the composition check (`long-page`), not here; the rows on a
  // first screen depend on the account's data and are a finding with a number, which only the baseline accepts.
  assert.deepEqual(findings("geo-answer", "phone", { height: 69000 }), { failures: [], notices: [] });
  const rows = findings("geo-sources", "desktop", { rows: 41 }).notices;
  assert.deepEqual(rows, [{ rule: "rows-ceiling", view: "geo-sources@desktop", text: "geo-sources@desktop: 41 rows on the first screen of data (ceiling 40)", value: 41 }]);
  assert.deepEqual(findings("geo-sources", "desktop", { rows: 40 }).notices, []);
  assert.deepEqual(findings("geo-sources", "phone", { rows: 90 }).notices, []);
  assert.deepEqual(findings("files", "desktop", { rows: 400 }).notices, []);

  // The project list must tell its projects apart; the cut-off counts are a phone's.
  assert.deepEqual(findings("account-projects", "desktop", { duplicateTitles: ["波立维"] }).failures, ["account-projects@desktop: two projects read alike in the list: 波立维"]);
  assert.deepEqual(findings("files", "desktop", { duplicateTitles: ["波立维"] }).failures, []);
  assert.deepEqual(findings("vcr-overview", "phone", { truncatedCounts: 2 }).failures, ["vcr-overview@phone: 2 count label(s) of the study are cut off at 390 px"]);
  assert.deepEqual(findings("vcr-overview", "desktop", { truncatedCounts: 2 }).failures, []);
});

test("the second Tab stop of a phone is not in the sidebar while it is closed", () => {
  const stops = [{ text: "跳到主要内容", inSidebar: false }, { text: "展开侧边栏", inSidebar: false }];
  assert.deepEqual(tabOrderFindings("files", stops, true), []);
  assert.deepEqual(tabOrderFindings("files", [stops[0], { text: "对话", inSidebar: true }], true), ["files@phone: with the sidebar closed, Tab reaches it: #2 “对话”"]);
  // An open sidebar is meant to be reached.
  assert.deepEqual(tabOrderFindings("files", [stops[0], { text: "对话", inSidebar: true }], false), []);
  const button = node("button", { text: "展开侧边栏", attrs: { "aria-label": "展开侧边栏" } });
  const inside = node("a", { text: "对话" });
  const shell = node("body", {}, [node("aside", { attrs: { "data-sidebar": "" } }, [inside]), node("main", {}, [button])]);
  assert.deepEqual(inPage(shell, () => { globalThis.document.activeElement = button; return focusProbe(); }), { text: "展开侧边栏", inSidebar: false });
  assert.deepEqual(inPage(shell, () => { globalThis.document.activeElement = inside; return focusProbe(); }), { text: "对话", inSidebar: true });
  assert.deepEqual(inPage(shell, () => focusProbe()), { text: "", inSidebar: false });
});

test("clickNamed presses the control of that name inside the scope and nothing else; clickRowTitled opens the row of a document", () => {
  const save = node("button", { text: "保存" });
  const cancel = node("button", { text: "取消" });
  const outside = node("button", { text: "保存" });
  const item = node("div", { attrs: { role: "menuitem" }, text: "创建技能" });
  const drawer = node("div", { attrs: { role: "dialog" } }, [save, cancel]);
  const body = node("body", {}, [outside, item, drawer, node("main", {}, [node("ul", {}, [node("li", {}, [node("button", { attrs: { "data-row-title": "" }, text: "一份指南.pdf" })])])])]);
  inPage(body, () => {
    assert.equal(clickNamed(["button", "保存", "[role='dialog']"]), true);
    assert.equal(clickNamed(["button", "不存在"]), false);
    assert.equal(clickNamed(["menuitem", "创建技能"]), true);
    assert.equal(clickNamed(["button", "保存", "[role='nothing']"]), false);
  });
  assert.deepEqual([save.clicks, outside.clicks, cancel.clicks, item.clicks], [1, 0, 0, 1]);
  const row = descendants(body).find((el) => el.text === "一份指南.pdf");
  assert.equal(inPage(body, () => clickRowTitled(["指南"])), true);
  assert.equal(row.clicks, 1);
  assert.equal(inPage(body, () => clickRowTitled(["没有"])), false);
});

/** A page's `main`, with `blocks` in it, for a probe. */
const read = (blocks, kind, arg, options) => inPage(node("body", {}, [node("main", {}, blocks)]), () => pageProbe([kind, arg]), options);
const tab = (name, count, selected) => node("div", { attrs: { role: "tab", "aria-selected": String(selected) } }, [node("span", { text: name }), ...(count ? [node("span", { text: String(count) })] : [])]);

test("the page probes read what a fix left behind: the empty 关注, the memory tabs, the bell, the Feishu rows", () => {
  // The folded progress rail (`geoRail`) is not read here any more: the rail is the page's band since R19, and the composition check reads it.
  assert.equal(read([node("div", { attrs: { "data-rail-folded": "" } })], "geoRail"), null);
  assert.deepEqual(read([node("p", { attrs: { "data-geo-market-off": "" }, text: "投放要等媒介集市接通" })], "geoMarketOff"), { present: true, top: 0, viewport: 945 });
  assert.deepEqual(read([node("p")], "geoMarketOff"), { present: false });

  assert.deepEqual(read([node("button", { text: "添加关注" }), node("a", { text: "浏览证据专区" })], "followingEmpty"), { adds: 1, chips: 0, noResults: false });
  assert.deepEqual(read([node("button", { text: "添加关注" }), node("button", { attrs: { "aria-pressed": "false" }, text: "药物" }), node("p", { text: "没有结果" })], "followingEmpty"), { adds: 1, chips: 1, noResults: true });
  assert.deepEqual(read([node("p", { text: "暂无一手材料，以下均为转述报道。" })], "eventGroups"), { primary: true, other: false, none: true });

  // The page's tab list is 关于你 · 项目 · 做法 · 地图 since R19; the growth tab and the sentence that counted its practices went into the map.
  const tabs = [tab("关于你", 0, true), tab("项目", 5, false), tab("做法", 15, false), tab("地图", 0, false)];
  assert.deepEqual(read(tabs, "memoryTabs"), {
    tabs: [{ name: "关于你", count: 0, selected: true }, { name: "项目", count: 5, selected: false }, { name: "做法", count: 15, selected: false }, { name: "地图", count: 0, selected: false }],
  });

  assert.deepEqual(read([node("a", { text: "回到记忆胶囊" }), node("h2", { text: "x" })], "sharedMissing"), { title: false, back: true, retry: false });

  const bell = node("button", { attrs: { "aria-label": "收件箱，8 条未读，其中 3 条需要优先查看" } });
  const bare = node("button", { attrs: { "aria-label": "收件箱，8 条未读" } });
  const inbox = (button, count) => inPage(node("body", {}, [node("aside", {}, [button]), node("main", {}, [node("h2", { text: `需要优先查看 · 未读 ${count} 条` })])]), () => pageProbe(["inboxSafety"]));
  assert.deepEqual(inbox(bell, 3), { heading: 3, bell: 3 });
  assert.deepEqual(inbox(bare, 0), { heading: 0, bell: 0 });
  assert.deepEqual(read([node("h2", { text: "收件箱" })], "inboxSafety"), { heading: null, bell: null });

  assert.deepEqual(read([node("div", {}, [node("span", { text: "飞书" })]), node("p", { text: "飞书机器人已绑定" })], "feishuRows"), { rows: 1 });
  assert.deepEqual(read([node("div", {}, [node("div", {}, [node("div", { text: "Semantic Scholar" }), node("div", { text: "有了自己的密钥，访问更稳" })]), node("div", { text: "可选" })])], "connectorRows", ["Semantic Scholar", "PubMed"]), {
    rows: [{ title: "Semantic Scholar", found: true, optional: true, configured: false, missing: false }, { title: "PubMed", found: false, optional: false, configured: false, missing: false }],
  });
  assert.equal(read([node("div", {}, [node("div", { text: "运行状况" }), node("div", { text: "部署配置检查" }), node("p", { text: "openlist_storage_missing" })])], "opsOrder").health, 0);
  assert.deepEqual(read([node("p", { text: "运行状况 部署配置检查 openlist_storage_missing geo_market_unconfigured" })], "opsOrder").tokens, ["openlist_storage_missing", "geo_market_unconfigured"]);
  // Hidden text is not on the page, and a token says the card it stands in (R19.2: a token from a collapsed list was reported as visible).
  assert.deepEqual(read([node("p", { text: "运行状况 部署配置检查" }), node("p", { text: "hidden_detail", style: { display: "none" } })], "opsOrder").tokens, []);
  assert.deepEqual(read([node("section", {}, [node("h2", { text: "操作审计" }), node("p", { text: "standardized_ratio" })])], "opsOrder").tokens, ["standardized_ratio (in 操作审计)"]);
  assert.deepEqual(read([node("p", { text: "页面不存在" })], "notFound"), { said: true });
  const missing = inPage(node("body", {}, [node("main", {}, [node("div", { attrs: { role: "dialog" } }, [node("p", { text: "找不到这个插件，它可能已被移除。" }), node("button", { text: "回到插件列表" })])])]), () => pageProbe(["missingRecord", ["找不到这个插件，它可能已被移除。", "回到插件列表"]]));
  assert.deepEqual(missing, { dialog: true, said: true, back: true, failedWord: false });
  const folds = read([node("details", { open: false }, [node("summary", { text: "编写与核查" })]), node("details", { open: true }, [node("summary", { text: "更新记录" })]), node("details", {}, [node("summary", { text: "别的折叠" })]), node("p", { text: "由 DeepSeek 起草" })], "readingFolds");
  assert.deepEqual(folds, { folds: [{ label: "编写与核查", open: false }, { label: "更新记录", open: true }], models: ["deepseek"] });
  assert.equal(read([], "unknown"), null);
});

test("a page probe is judged on what it exists to guard, and a probe that read nothing is not a finding", () => {
  const one = (name, viewport, kind, result) => probeFindings(name, viewport, kind, result);
  assert.deepEqual(one("geo-actions", "desktop", "geoMarketOff", { present: false }).failures, []);
  assert.deepEqual(one("geo-actions", "desktop", "geoMarketOff", { present: true, top: 300, viewport: 945 }).failures, []);
  assert.deepEqual(one("geo-actions", "desktop", "geoMarketOff", { present: true, top: 2400, viewport: 945 }).failures, ["geo-actions@desktop: the sentence about placing being off is below the first screen (2400 px)"]);

  assert.deepEqual(one("frontier-following", "desktop", "followingEmpty", { adds: 1, chips: 0, noResults: false }).failures, []);
  assert.deepEqual(one("frontier-following", "desktop", "followingEmpty", { adds: 0, chips: 4, noResults: false }).failures, []);
  assert.equal(one("frontier-following", "desktop", "followingEmpty", { adds: 1, chips: 2, noResults: true }).failures.length, 2);
  assert.equal(one("frontier-following", "desktop", "followingEmpty", { adds: 2, chips: 0, noResults: false }).failures.length, 1);
  assert.deepEqual(one("frontier-event", "desktop", "eventGroups", { primary: false, other: false, none: false }).failures.length, 1);
  assert.deepEqual(one("frontier-event", "desktop", "eventGroups", { primary: false, other: false, none: true }).failures, []);

  // The headline's place and the card footers depend on the feed's data: notices.
  assert.deepEqual(one("frontier", "phone", "firstRowTop", { top: 620 }), { failures: [], notices: ["frontier@phone: the first headline starts at 620 px (the aim is 520)"] });
  assert.deepEqual(one("frontier", "phone", "firstRowTop", { top: 276 }).notices, []);
  assert.deepEqual(one("frontier", "phone", "firstRowTop", { top: null }).notices, []);
  assert.deepEqual(one("virtual-research", "phone", "rowWidth", { widths: [120], min: 120 }).failures, ["virtual-research@phone: a study row's title is 120 px wide (at least 160)"]);
  assert.deepEqual(one("virtual-research", "phone", "rowWidth", { widths: [], min: null }).failures, []);
  assert.deepEqual(one("capabilities", "desktop", "capabilityCards", { hits: ["可运行", "已安装"], wraps: 1 }), {
    failures: ["capabilities@desktop: the tool cards still say 可运行, 已安装"], notices: ["capabilities@desktop: 1 card footer(s) take two lines"] });

  const tabs = (selected, counts) => ({ tabs: ["关于你", "项目", "做法", "地图"].map((name, index) => ({ name, count: counts[index], selected: name === selected })) });
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("项目", [0, 5, 15, 0])).failures, ["memory@desktop: the address names 关于你 and the page opens on 项目"]);
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("关于你", [3, 5, 15, 0])).failures, []);
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("关于你", [0, 5, 15, 0])).failures, []);
  assert.deepEqual(one("memory-landing", "desktop", "memoryTabs", tabs("关于你", [0, 5, 15, 0])).failures, ["memory-landing@desktop: the page opens on an empty 关于你 while 项目 holds 5 and 做法 15"]);
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("关于你", [0, 0, 0, 0])).failures, []);
  assert.deepEqual(one("memory-project", "desktop", "memoryTabs", tabs("做法", [0, 5, 15, 0])).failures, ["memory-project@desktop: the address names 项目 and the page opens on 做法"]);
  assert.deepEqual(one("memory-methods", "desktop", "memoryTabs", tabs("做法", [0, 5, 15, 0])).failures, []);

  assert.deepEqual(one("memory-shared-missing", "desktop", "sharedMissing", { title: true, back: true, retry: false }).failures, []);
  assert.equal(one("memory-shared-missing", "desktop", "sharedMissing", { title: false, back: false, retry: true }).failures.length, 3);
  assert.deepEqual(one("inbox", "desktop", "inboxSafety", { heading: 3, bell: 3 }).failures, []);
  assert.deepEqual(one("inbox", "desktop", "inboxSafety", { heading: 3, bell: 1 }).failures, ["inbox@desktop: the safety heading counts 3 unread and the bell 1"]);
  assert.deepEqual(one("inbox", "desktop", "inboxSafety", { heading: null, bell: 4 }).failures, []);

  assert.deepEqual(one("account", "desktop", "feishuRows", { rows: 1 }).failures, ["account@desktop: the account section still has a 飞书 row (it is bound under 通知)"]);
  assert.deepEqual(one("account-notifications", "desktop", "feishuRows", { rows: 1 }).failures, []);
  assert.deepEqual(one("account-notifications", "desktop", "feishuRows", { rows: 2 }).failures, ["account-notifications@desktop: 2 飞书 rows under 通知 (one)"]);
  assert.deepEqual(one("account-connectors", "desktop", "connectorRows", { rows: [{ title: "NCBI", found: true, optional: true, configured: false, missing: false }] }).failures, []);
  assert.deepEqual(one("account-connectors", "desktop", "connectorRows", { rows: [{ title: "NCBI", found: true, optional: false, configured: false, missing: true }] }).failures, ["account-connectors@desktop: NCBI needs no key and reads 未配置"]);
  assert.deepEqual(one("account-connectors", "desktop", "connectorRows", { rows: [{ title: "NCBI", found: false }] }).notices, ["account-connectors@desktop: the row of NCBI was not found"]);
  assert.deepEqual(one("ops", "desktop", "opsOrder", { health: 0, config: 80, tokens: [] }), { failures: [], notices: [] });
  assert.deepEqual(one("ops", "desktop", "opsOrder", { health: 120, config: 10, tokens: ["a_b"] }), {
    failures: ["ops@desktop: 部署配置检查 comes before 运行状况"], notices: ["ops@desktop: identifiers in the visible text: a_b"] });
  assert.deepEqual(one("ops", "desktop", "opsOrder", { health: -1, config: 10, tokens: [] }).failures, []);
  assert.deepEqual(one("not-found", "phone", "notFound", { said: false }).failures, ["not-found@phone: an address that is not a page does not say 页面不存在"]);
  assert.deepEqual(one("extensions-plugin-missing", "desktop", "missingRecord", { dialog: true, said: true, back: true, failedWord: false }).failures, []);
  assert.deepEqual(one("extensions-plugin-missing", "desktop", "missingRecord", { dialog: true, said: false, back: false, failedWord: true }).failures, [
    "extensions-plugin-missing@desktop: the missing record's drawer does not say “找不到这个插件，它可能已被移除。”", "extensions-plugin-missing@desktop: 「操作未完成」 on a record that is not there"]);
  assert.deepEqual(one("extensions-skill-missing", "desktop", "missingRecord", { dialog: true, said: true, back: false, failedWord: false }).failures, ["extensions-skill-missing@desktop: the missing record's drawer has no button 回到技能列表"]);
  assert.deepEqual(one("frontier-evidence", "desktop", "readingFolds", { folds: [{ label: "编写与核查", open: false }], models: [] }), { failures: [], notices: [] });
  assert.deepEqual(one("frontier-evidence", "desktop", "readingFolds", { folds: [{ label: "评议与讨论（2）", open: true }], models: ["qwen"] }), {
    failures: ["frontier-evidence@desktop: the fold 评议与讨论（2） is open at first sight"],
    notices: ["frontier-evidence@desktop: the card has no 编写与核查 fold", "frontier-evidence@desktop: a model name on the reading page: qwen"] });
  assert.deepEqual(Object.keys(MISSING_RECORDS), ["extensions-plugin-missing", "extensions-skill-missing"]);
  for (const [name, list] of Object.entries(PAGE_PROBES)) for (const [kind, viewports] of list) {
    assert.ok(viewports.every((viewport) => ["desktop", "phone"].includes(viewport)), `${name}: ${kind}`);
    assert.ok(walkedNames().has(name), `${name} has a probe and no route walks it`);
  }
});

test("what a first row opened to is read while it is open: a source's drawer, a task's own page", () => {
  assert.deepEqual(AFTER_CLICK_KIND, { "geo-sources": "sourceDrawer", autopilot: "taskPage" });
  // R13 (E-15): a source opens a drawer holding data-geo-source-drawer, and no longer its conditions in the row.
  const drawer = node("div", { attrs: { role: "dialog" } }, [node("div", { attrs: { "data-geo-source-drawer": "example.org" } }, [node("p", { text: "正在读取引用它的回答" })])]);
  assert.deepEqual(inPage(page(header(), drawer), () => afterClickProbe(["sourceDrawer"])), { dialog: true, drawers: 1 });
  assert.deepEqual(inPage(page(header()), () => afterClickProbe(["sourceDrawer"])), { dialog: false, drawers: 0 });
  // A dialog of another kind is not the source's drawer; the old in-row detail on the page is not one either.
  assert.deepEqual(inPage(page(header(), node("div", { attrs: { role: "dialog" } }, [node("p", { text: "别的" })]), node("span", { attrs: { "data-geo-source-detail": "" } })), () => afterClickProbe(["sourceDrawer"])), { dialog: true, drawers: 0 });
  assert.deepEqual(afterClickFindings("geo-sources", "sourceDrawer", { dialog: true, drawers: 1 }), { failures: [], notices: [] });
  assert.deepEqual(afterClickFindings("geo-sources", "sourceDrawer", { dialog: false, drawers: 0 }).failures,
    ["geo-sources@desktop: clicking the first source opened no drawer (a dialog holding data-geo-source-drawer)"]);
  assert.deepEqual(afterClickFindings("geo-sources", "sourceDrawer", null), { failures: [], notices: [] });
  assert.deepEqual(afterClickFindings("geo-sources", "unknown", { drawers: 0 }), { failures: [], notices: [] });
});

/** The task page as the shell draws it: the list beside the task, the task bar, and a pane the kernel's frame is placed over. */
function taskPage({ pane = "conversation", frame = true, holder = true, extra = [], barText = "每周一、周五 07:30 · 中国标准时间 · 下次 10月12日 07:30", dialog = false, layout = "split", marked = true, surface = "task" } = {}) {
  const paneBox = { w: 900, h: 700, left: 300 };
  return node("body", {}, [
    node("div", { attrs: { "data-session-surface": surface } }, holder ? [node("div", { attrs: { "data-task-frame": "" }, ...paneBox }, frame ? [node("iframe", { attrs: { title: "对话" }, ...paneBox })] : [])] : []),
    node("main", {}, [node("div", { attrs: { "data-autopilot-layout": layout } }, [
      node("section", { attrs: { "data-task-list": "" } }, [
        node("input", { attrs: { type: "search", "aria-label": "搜索任务" } }),
        node("ul", {}, [node("li", {}, [node("a", { attrs: { "data-row-title": "", "data-task-id": "task_1", ...(marked ? { "aria-current": "page" } : {}) }, text: "每周文献" })])]),
      ]),
      node("section", { attrs: { "data-task-main": "" } }, [
        node("header", { attrs: { "data-task-bar": "" } }, [node("h2", { text: "每周文献" }), node("p", { text: barText })]),
        ...(pane ? [node("div", { attrs: { role: "region", "data-task-pane": pane }, ...paneBox })] : []),
        ...extra,
      ]),
      ...(dialog ? [node("div", { attrs: { role: "dialog" } })] : []),
    ])]),
  ]);
}

test("the task page is read for its hooks, its pane, the frame over it and what the page does not draw; every verdict is a notice, bar the time-zone identifier", () => {
  const read = (root, path = "/app/autopilot/task_1") => inPage(root, () => afterClickProbe(["taskPage"]), { path });
  const good = read(taskPage());
  assert.deepEqual(good, {
    path: "/app/autopilot/task_1", layout: "split", list: true, main: true, bar: true, marked: 1, pane: "conversation", surface: "task",
    paneBox: { left: 300, top: 0, width: 900, height: 700 }, holderBox: { left: 300, top: 0, width: 900, height: 700 }, frameBox: { left: 300, top: 0, width: 900, height: 700 },
    editors: 0, inputsInMain: 0, dialogs: 0, zoneIds: [],
  });
  // With the runtime up the iframe is compared; the same rectangle passes in silence.
  assert.deepEqual(taskPageFindings("autopilot", good), { failures: [], notices: [], info: [] });

  // The walk starts no runtime: the container is over the pane and holds no iframe, and the notice says what was and was not compared.
  const bare = read(taskPage({ frame: false }));
  assert.equal(bare.frameBox, null);
  assert.deepEqual(taskPageFindings("autopilot", bare), { failures: [], notices: [], info: ["autopilot@desktop: the frame's container is placed over the pane, and holds no iframe (the walk starts no runtime), so only the container was compared"] });

  // A frame that is not over the pane, a text box of the page's own, a dialog, an unmarked row, a missing surface: each its own notice.
  const off = { ...good, frameBox: { ...good.frameBox, top: 40 } };
  assert.deepEqual(taskPageFindings("autopilot", off).notices, ["autopilot@desktop: the kernel frame is 900×700 at 300,40 and the pane 900×700 at 300,0 (the same rectangle)"]);
  assert.deepEqual(taskPageFindings("autopilot", { ...good, holderBox: { ...good.holderBox, width: 880 }, frameBox: null }).notices,
    ["autopilot@desktop: the kernel frame's container is 880×700 at 300,0 and the pane 900×700 at 300,0 (the same rectangle)"]);
  assert.equal(sameBox(good.paneBox, { ...good.paneBox, left: good.paneBox.left + 2 }), true);
  assert.equal(sameBox(good.paneBox, { ...good.paneBox, left: good.paneBox.left + 3 }), false);
  assert.equal(sameBox(null, good.paneBox), false);
  const typed = read(taskPage({ extra: [node("textarea", { attrs: { "aria-label": "补充" } })], dialog: true, marked: false, surface: "hidden" }));
  assert.deepEqual([typed.editors, typed.dialogs, typed.marked], [1, 1, 0]);
  assert.deepEqual(taskPageFindings("autopilot", typed).notices, [
    "autopilot@desktop: 0 row(s) of the list are marked as the open task (aria-current=page; one)",
    "autopilot@desktop: the task page draws 1 text box(es) of its own; the conversation's input is the kernel's, inside the frame",
    "autopilot@desktop: 1 dialog(s) open on the task page right after the task opened (the conversation is not in a dialog)",
    "autopilot@desktop: the conversation surface reads hidden while the task's conversation is on (task)",
  ]);
  // The list's own search is not a text box of the page's main area, and the sidebar's search is the shell's.
  assert.equal(read(taskPage({ extra: [node("input", { attrs: { type: "checkbox" } })] })).inputsInMain, 0);
  assert.equal(read(taskPage({ extra: [node("input", { attrs: { type: "search" } })] })).inputsInMain, 1);

  // A pane that is not the conversation has no frame placed over it: said, not judged. A page with no pane yet is not observable either.
  assert.deepEqual(taskPageFindings("autopilot", read(taskPage({ pane: "never-run", holder: false }))).notices,
    ["autopilot@desktop: not observable: the first task's pane reads never-run, so no conversation frame is placed over it"]);
  assert.deepEqual(taskPageFindings("autopilot", read(taskPage({ pane: null, holder: false }))).notices,
    ["autopilot@desktop: not observable: the task's pane (data-task-pane) had not rendered, so the conversation's place was not read"]);
  assert.deepEqual(taskPageFindings("autopilot", read(taskPage({ holder: false }))).notices,
    ["autopilot@desktop: not observable: the pane reads conversation and no frame container (data-task-frame) is placed over it"]);
  // The single column (the list is the page, or the task is): no list beside the task to mark, no list required.
  assert.deepEqual(taskPageFindings("autopilot", read(taskPage({ layout: "single", marked: false, frame: false, holder: false, pane: "waiting" }))).notices,
    ["autopilot@desktop: not observable: the first task's pane reads waiting, so no conversation frame is placed over it"]);
  // A click that did not go to a task's page reads nothing of it.
  assert.deepEqual(taskPageFindings("autopilot", { ...good, path: "/app/autopilot" }).notices,
    ["autopilot@desktop: not observable: the first row did not go to a task's own page (the address is /app/autopilot), so the task page was not read"]);
  assert.deepEqual(taskPageFindings("autopilot", null), { failures: [], notices: [], info: [] });
  assert.deepEqual(afterClickFindings("autopilot", "taskPage", good), { failures: [], notices: [], info: [] });
  assert.deepEqual(afterClickFindings("autopilot", "taskPage", null), { failures: [], notices: [] });

  // The one failure is carried over from the drawer: a time zone is named, never shown by its identifier.
  const named = read(taskPage({ barText: "每天 07:00 · Asia/Shanghai · 下次 10月12日 07:00" }));
  assert.deepEqual(named.zoneIds, ["Asia/Shanghai"]);
  assert.deepEqual(taskPageFindings("autopilot", named).failures, ["autopilot@desktop: the task bar names a time zone by its identifier: Asia/Shanghai"]);
  // The pane's wait is the pane being on the page.
  assert.equal(inPage(taskPage(), () => taskPaneReady()), true);
  assert.equal(inPage(taskPage({ pane: null }), () => taskPaneReady()), false);
});

test("a PDF's original is wide on the document's page and fit to the width; a column that is too narrow or a viewer without the fragment fails", () => {
  assert.equal(ORIGINAL_MIN_WIDTH, 560);
  assert.deepEqual(pdfPreviewFindings({ width: 896, src: "blob:x#view=FitH&navpanes=0" }), []);
  assert.deepEqual(pdfPreviewFindings({ width: 560, src: "blob:x#view=FitH&navpanes=0" }), []);
  assert.deepEqual(pdfPreviewFindings({ width: 559, src: "blob:x#view=FitH&navpanes=0" }), ["files@desktop: the original of a PDF is 559 px wide on its page (at least 560)"]);
  assert.deepEqual(pdfPreviewFindings({ width: 896, src: "blob:x" }), ["files@desktop: the PDF is not opened fit to width without the thumbnail column"]);
  // A page asked for first: the fragment still ends with the two open-parameters.
  assert.deepEqual(pdfPreviewFindings({ width: 896, src: "blob:x#page=7&view=FitH&navpanes=0" }), []);
  assert.deepEqual(pdfPreviewFindings({ width: 896, src: null }), []);
  assert.deepEqual(pdfPreviewFindings(null), []);
  const column = (...children) => node("body", {}, [node("main", {}, [node("section", { attrs: { "data-reader-column": "original" }, w: 896 }, children)])]);
  const viewer = node("iframe", { attrs: { title: "PDF 预览", src: "blob:x#view=FitH&navpanes=0" } });
  assert.deepEqual(inPage(column(viewer), () => pdfProbe()), { width: 896, src: "blob:x#view=FitH&navpanes=0" });
  // The column is there and the viewer is not (the file is still being fetched, or the original is not a PDF).
  assert.deepEqual(inPage(column(node("iframe", { attrs: { title: "HTML 预览" } })), () => pdfProbe()), { width: 896, src: null });
  assert.equal(inPage(page(header()), () => pdfProbe()), null);
  // The drawer it replaced is not the original's column.
  assert.equal(inPage(node("body", {}, [node("div", { attrs: { role: "dialog" }, w: 896 }, [viewer])]), () => pdfProbe()), null);
  assert.equal(inPage(column(viewer), () => pdfFrameReady()), true);
  assert.equal(inPage(column(node("p", { text: "原文" })), () => pdfFrameReady()), false);
});

/** A document's page as R13 draws it. */
function readerPage({ layout = "columns", title = "一份指南", back = "知识库", href = "/app/files?q=%E4%B8%80", dialog = false, missing = false, tabs = false } = {}) {
  return node("body", {}, [node("main", {}, [node("div", {}, [
    node("div", {}, [node("nav", { attrs: { "aria-label": "返回" } }, [node("a", { attrs: { href }, text: back })])]),
    node("header", {}, [node("h1", { text: title })]),
    node("div", layout ? { attrs: { "data-reader-layout": layout } } : {}, [
      ...(layout === "columns" ? [node("section", { attrs: { "data-reader-column": "original" } }), node("section", { attrs: { "data-reader-column": "points" } })] : []),
      ...(layout === "tabs" ? [node("div", { attrs: { role: "tablist", "aria-label": "资料视图" } }, tabs ? [node("button", { attrs: { role: "tab" }, text: "内容" }), node("button", { attrs: { role: "tab" }, text: "原文" })] : []),
        node("div", { attrs: { "data-reader-column": "original" } })] : []),
      ...(missing ? [node("p", { text: "这份资料不存在或已删除。" })] : []),
    ]),
  ]), ...(dialog ? [node("div", { attrs: { role: "dialog" } })] : [])])]);
}

test("a document's page is read for its layout, its heading, the way back and what is open; the way back to a long list is judged from what was read at each stage", () => {
  const read = (root, path = "/app/files/src_1") => inPage(root, () => readerProbe(), { path });
  const columns = read(readerPage());
  assert.deepEqual(columns, {
    path: "/app/files/src_1", layout: "columns", title: "一份指南", back: { text: "知识库", href: "/app/files?q=%E4%B8%80" }, dialogs: 0,
    columns: ["original", "points"], tabs: [], missing: false,
  });
  const expected = { title: "一份指南", list: "/app/files?q=%E4%B8%80" };
  assert.deepEqual(readerFindings(columns, expected), { failures: [], notices: [] });
  assert.deepEqual(read(readerPage({ layout: "tabs", tabs: true })).tabs, ["内容", "原文"]);
  assert.deepEqual(readerFindings(read(readerPage({ layout: "tabs", tabs: true })), expected).notices, []);
  assert.deepEqual(readerFindings(read(readerPage({ layout: "tabs" })), expected).notices, ["files@desktop: the reader is in tabs and its tab strip reads nothing (内容/原文)"]);
  assert.deepEqual(inPage(readerPage({ missing: true }), () => readerProbe()).missing, true);
  assert.deepEqual(readerFindings(read(readerPage({ layout: null, missing: true })), expected).notices, ["files@desktop: the reader of the first row says the document does not exist"]);
  assert.deepEqual(readerFindings(read(readerPage({ layout: null })), expected).notices, ["files@desktop: not observable: the document's page drew no layout (data-reader-layout) within the wait"]);
  assert.deepEqual(readerFindings({ ...columns, path: "/app/files" }, expected).notices,
    ["files@desktop: not observable: opening the first row did not go to a document's own page (/app/files), so the reader was not read"]);
  assert.deepEqual(readerFindings(null, expected).notices.length, 1);
  assert.deepEqual(readerFindings({ ...columns, title: "另一份" }, expected).notices, ["files@desktop: the reader's heading is “另一份” and the row it was opened from is “一份指南”"]);
  assert.deepEqual(readerFindings({ ...columns, back: { text: "返回", href: "/app/files" } }, expected).notices, ["files@desktop: the way back on the document's page reads “返回” (知识库)"]);
  assert.deepEqual(readerFindings({ ...columns, back: { text: "知识库", href: "/app/files" } }, expected).notices, ["files@desktop: the way back goes to /app/files and the list was /app/files?q=%E4%B8%80"]);
  assert.deepEqual(readerFindings({ ...columns, dialogs: 1 }, expected).notices, ["files@desktop: a dialog is open on the document's page (a document is a page, not a drawer)"]);
  assert.deepEqual(readerFindings({ ...columns, columns: ["original"] }, expected).notices, ["files@desktop: the reader is in two columns and shows original (original/points)"]);
  assert.equal(inPage(readerPage(), () => readerReady()), true);
  assert.equal(inPage(page(header()), () => readerReady()), false);

  // The knowledge base's list, as the walk reads it before and after a document was opened.
  const list = (rows, query = "一份指南") => node("body", {}, [node("main", {}, [
    node("input", { attrs: { "aria-label": "搜索资料和内容" }, value: query }),
    node("ul", { attrs: { "aria-label": "资料" } }, rows.map((title) => node("li", {}, [node("a", { attrs: { "data-row-title": "", href: "/app/files/src_1" }, text: title })]))),
  ])]);
  assert.deepEqual(inPage(list(["一份指南", "另一份"]), () => knowledgeProbe(["first"])), { title: "一份指南", href: "/app/files/src_1" });
  assert.equal(inPage(list([]), () => knowledgeProbe(["first"])), null);
  assert.deepEqual(inPage(list(["一份指南", "另一份"]), () => knowledgeProbe(["state", "另一份"]), { path: "/app/files" }), { path: "/app/files", query: "一份指南", rows: 2, listed: true });
  const state = (overrides = {}) => ({ path: "/app/files?q=%E4%B8%80", query: "一份指南", rows: 1, listed: true, ...overrides });
  const read3 = (overrides = {}) => ({ filtered: state(), reader: { ...columns, path: "/app/files/src_1?q=%E4%B8%80" }, back: state(), browserBack: state(), ...overrides });
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3()), { failures: [], notices: [] });
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3({ filtered: state({ rows: 0, listed: false }) })).notices,
    ["files@desktop: not observable: searching for the first document's own title left 0 row(s) and not that document, so it was not opened"]);
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3({ filtered: state({ path: "/app/files" }) })).notices[0], "files@desktop: the search is not in the address after typing (/app/files)");
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3({ reader: null })).notices, ["files@desktop: not observable: the document's row was not on the filtered list to open"]);
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3({ reader: { ...columns, path: "/app/files/src_1" } })).notices,
    ["files@desktop: the document's address does not carry the list's search (/app/files/src_1)"]);
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3({ back: state({ path: "/app/files", query: "", listed: false }) })).notices, [
    "files@desktop: after 「知识库」 on the document's page the address is /app/files and the list was /app/files?q=%E4%B8%80",
    "files@desktop: after 「知识库」 on the document's page the search box holds “” and held “一份指南”",
    "files@desktop: after 「知识库」 on the document's page the document is not in the list",
  ]);
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3({ browserBack: null })).notices, ["files@desktop: not observable: the browser's Back was not taken"]);
  assert.deepEqual(knowledgeReturnFindings("一份指南", read3({ reader: { ...columns, layout: null } })).notices.length, 1);
});

test("the new-skill drawer names its captions and its switch, names an empty field in place, and sends nothing", () => {
  const opened = { title: true, captions: 2, switchLabel: "保存后在“我的研究”里使用", needName: false, needHow: false };
  const refused = { ...opened, needName: true, needHow: true };
  assert.deepEqual(skillDrawerFindings(opened, refused, []), []);
  assert.deepEqual(skillDrawerFindings(null, null, []), ["extensions-skills@desktop: 新建技能 did not open a drawer"]);
  assert.equal(skillDrawerFindings({ ...opened, captions: 0, switchLabel: null, title: false }, refused, []).length, 3);
  assert.deepEqual(skillDrawerFindings(opened, opened, []), ["extensions-skills@desktop: 保存 with empty fields does not say 请填写名称 and 请写出这个技能怎么做 in place"]);
  assert.deepEqual(skillDrawerFindings(opened, refused, ["POST /api/personal-skills"]), ["extensions-skills@desktop: 保存 with empty fields sent a request: POST /api/personal-skills"]);
  const drawer = node("div", { attrs: { role: "dialog" } }, [
    node("h2", { text: "新建技能" }), node("p", { attrs: { id: "x-purpose-hint" }, text: "说明" }), node("p", { attrs: { id: "x-instructions-hint" }, text: "步骤" }),
    node("div", { attrs: { role: "switch", "aria-label": "保存后在“我的研究”里使用" } }), node("p", { text: "请填写名称" }),
  ]);
  assert.deepEqual(inPage(node("body", {}, [drawer]), () => skillDrawerProbe()), { title: true, captions: 2, switchLabel: "保存后在“我的研究”里使用", needName: true, needHow: false });
  assert.equal(inPage(page(header()), () => skillDrawerProbe()), null);
});

test("a start refused for cleanup shows a cover that says so and offers no allowance page; the alert after the wait offers 重试 and the way to what exists", () => {
  const cover = { cover: "正在清理上一次任务的运行环境，完成后自动继续", booted: false, quotaButtons: [], alertButtons: null };
  assert.deepEqual(cleanupFindings(cover, null), []);
  assert.deepEqual(cleanupNotices(cover), []);
  // The runtime already up: the refused start is rightly ignored and the conversation stays; said, not failed (release-11 walk).
  const up = { cover: null, booted: true, quotaButtons: [], alertButtons: null };
  assert.deepEqual(cleanupFindings(up, up), []);
  assert.deepEqual(cleanupNotices(up), ["chat@desktop: the runtime was already up, so a start refused for cleanup could not be shown"]);
  assert.deepEqual(cleanupFindings(cover, { ...cover, alertButtons: ["重试", "查看已有成果"] }), []);
  assert.deepEqual(cleanupFindings({ ...cover, cover: "正在打开", quotaButtons: ["查看额度"] }, null), [
    "chat@desktop: a start refused for cleanup does not say it is cleaning up (cover: “正在打开”)", "chat@desktop: a start refused for cleanup offers 查看额度"]);
  assert.deepEqual(cleanupFindings(cover, cover), ["chat@desktop: after the wait, a cleanup that did not finish raises no alert"]);
  assert.deepEqual(cleanupFindings(cover, { ...cover, alertButtons: ["重试"], quotaButtons: ["查看用量"] }), [
    "chat@desktop: the alert of a cleanup that did not finish has no 查看已有成果", "chat@desktop: the alert of a cleanup that did not finish offers 查看用量"]);
});

test("the evidence matrix is read by its rows: the 核对 text in view, a search by id, a dialog from a row, Escape returning focus", () => {
  const table = (...ids) => node("body", {}, [node("main", {}, [
    node("input", { attrs: { "aria-label": "搜索结论", type: "search" } }),
    node("p", { text: `显示 ${ids.length} / ${ids.length} 条` }),
    node("table", {}, [node("thead", {}, [node("tr", {}, ["结论", "核对", "内容"].map((name) => node("th", { attrs: { scope: "col" }, text: name })))]),
      node("tbody", {}, ids.map((id) => node("tr", { attrs: { id: `matrix-${id}` } }, [node("th", { attrs: { scope: "row" } }, [node("button", { text: id })]), node("td", { text: "已核对", w: 100 })])))]),
  ])]);
  const page3 = table("CLM-001", "CLM-002", "CLM-003");
  assert.equal(inPage(page3, () => matrixProbe(["ready"])), true);
  assert.equal(inPage(page(header()), () => matrixProbe(["ready"])), false);
  assert.deepEqual(inPage(page3, () => matrixProbe(["state"])), { overflow: false, rows: 3, firstId: "CLM-001", markInView: true, headers: ["结论", "核对", "内容"], marks: ["已核对", "已核对", "已核对"] });
  assert.deepEqual(inPage(page3, () => matrixProbe(["filtered"])), { rows: 3, status: "显示 3 / 3 条" });
  assert.equal(inPage(page3, () => matrixProbe(["open"])), true);
  assert.equal(descendants(page3).find((el) => el.id === "matrix-CLM-001").clicks, 1);
  const cards = node("body", {}, [node("main", {}, [node("input", { attrs: { "aria-label": "搜索结论" } }), node("ul", {}, [node("li", { attrs: { id: "matrix-CLM-007" } }, [node("button", {}, [node("span", {}, [node("span", { text: "CLM-007" }), node("span", { text: "核对中", w: 80 })])])])])])]);
  assert.deepEqual(inPage(cards, () => matrixProbe(["state"])).marks, ["核对中"]);
  const dialogPage = node("body", {}, [table("CLM-001"), node("div", { attrs: { role: "dialog" } }, [node("h2", { text: "CLM-001" })])]);
  assert.deepEqual(inPage(dialogPage, () => matrixProbe(["dialog"])), { open: true, name: "CLM-001" });
  assert.deepEqual(inPage(table("CLM-001"), () => matrixProbe(["closed"])), { open: false, focusInRow: false });

  const state = { overflow: false, rows: 3, firstId: "CLM-001", markInView: true, headers: ["结论", "核对", "内容"], marks: ["已核对", "核对中"] };
  const good = { state, filtered: { rows: 1, status: "显示 1 / 3 条" }, dialog: { open: true, name: "CLM-001" }, closed: { open: false, focusInRow: true } };
  assert.deepEqual(matrixFindings("desktop", good), { failures: [], notices: [] });
  assert.deepEqual(matrixFindings("desktop", { ...good, state: null }).failures, []);
  assert.equal(matrixFindings("desktop", { state: null }).notices.length, 1);
  const failures = (read) => matrixFindings("phone", { ...good, ...read }).failures;
  assert.deepEqual(failures({ state: { ...state, overflow: true } }), ["evidence-matrix@phone: the page overflows sideways"]);
  assert.deepEqual(failures({ state: { ...state, markInView: false } }), ["evidence-matrix@phone: the 核对 text of the first claim is outside the screen"]);
  assert.deepEqual(failures({ state: { ...state, markInView: null, headers: [] } }), []);
  assert.deepEqual(failures({ state: { ...state, headers: ["结论", "内容", "核对"] } }), ["evidence-matrix@phone: the second column is “内容” (核对)"]);
  // R13 (E-5): the column is ✓, ⚠ or blank and says 核对中 only while the checks come in. The words it used to write for a claim nobody had
  // checked are retired; one still on a page is a notice, alone or beside 核对中, and no longer the failure that the mixture was.
  assert.deepEqual(failures({ state: { ...state, marks: ["未核对", "核对中"] } }), []);
  assert.deepEqual(matrixFindings("phone", { ...good, state: { ...state, marks: ["未核对", "核对中"] } }).notices,
    ["evidence-matrix@phone: the 核对 column still reads 未核对 for a claim (R13: ✓, ⚠ or blank)"]);
  assert.deepEqual(matrixFindings("phone", { ...good, state: { ...state, marks: ["暂无核对结果", "未核对", "✓", "⚠", ""] } }).notices,
    ["evidence-matrix@phone: the 核对 column still reads 暂无核对结果, 未核对 for a claim (R13: ✓, ⚠ or blank)"]);
  assert.deepEqual(matrixFindings("phone", { ...good, state: { ...state, marks: ["✓", "⚠", "", "核对中"] } }), { failures: [], notices: [] });
  assert.deepEqual(failures({ filtered: { rows: 3, status: "显示 3 / 3 条" } }), ["evidence-matrix@phone: searching for CLM-001 leaves 3 row(s) and “显示 3 / 3 条”"]);
  assert.deepEqual(failures({ dialog: { open: false, name: null } }), ["evidence-matrix@phone: clicking the first claim does not open a dialog named CLM-001 (“none”)"]);
  assert.deepEqual(failures({ closed: { open: true, focusInRow: false } }), ["evidence-matrix@phone: Escape leaves the claim's dialog open"]);
  assert.deepEqual(failures({ closed: { open: false, focusInRow: false } }), ["evidence-matrix@phone: Escape does not return focus to the claim's row"]);
});

test("the walk opens the pages whose ids the deployment's lists name: both studies, the answer, the zone, the card, the author, the event, the matrix", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  const visited = new Set(log.filter((entry) => entry.goto).map((entry) => new URL(entry.goto).pathname + new URL(entry.goto).search));
  // The study that has produced the most (std_b), then the first other one (std_a), every tab of each.
  for (const [, segment] of VCR_TABS_WALK) {
    assert.ok(visited.has(`/app/virtual-research/std_b${segment}`), `walked std_b${segment}`);
    assert.ok(visited.has(`/app/virtual-research/std_a${segment}`), `walked std_a${segment}`);
    assert.ok(!visited.has(`/app/virtual-research/std_c${segment}`), "a third study is not walked");
  }
  assert.ok(report.pages["vcr-trial@2@desktop"] && report.pages["vcr-trial@desktop"], "the second study is reported as vcr-trial@2");
  for (const address of [
    "/app/geo/geo_1/answers/snap_1", "/app/frontier/zones/z_user", "/app/frontier/zones/z_official/evidence/card_1", "/app/frontier/authors/au_1",
    "/app/frontier/events/ev_1", "/app/frontier?view=following", "/app/virtual-research?tab=models", "/app/virtual-research?tab=precedents",
    "/app/virtual-research?tab=definitions", "/app/account?tab=notifications", "/app/ops", "/app/memory/shared/impeccable-audit-missing", "/app/extensions/plugins/impeccable-audit-missing",
    "/app/extensions/skills/impeccable-audit-missing", "/app/runs/run_1/files/deliverables/pkg/clinical-evidence-matrix.json", "/app/files/src_1",
  ]) assert.ok(visited.has(address), `walked ${address}`);
  assert.deepEqual(report.discovered.routes.filter((name) => name.endsWith("@2")).length, 7);
  assert.deepEqual([report.discovered.evidenceMatrix, report.discovered.pdf, report.discovered.keylessConnectors], [true, true, 1]);
  // Each view's structure is in the report; the phone's two Tab presses are the only keys the walk sends outside the matrix.
  assert.equal(report.pages["files@desktop"].structure.sidebar.landmarks, 1);
  assert.equal(log.filter((entry) => entry.key === "Tab").length, 2 * Object.keys(report.pages).filter((view) => view.endsWith("@phone")).length);
  assert.equal(log.filter((entry) => entry.key === "Escape").length, 2, "Escape once per width in the matrix");
  assert.deepEqual(report.pages["files@desktop"].tabStops, undefined);
  assert.deepEqual(report.pages["files@phone"].tabStops.map((stop) => stop.text), ["跳到主要内容", "跳到主要内容"]);
  // The probes of a page that is right pass quietly, and the missing records went back to their lists by a click.
  assert.equal(report.pages["geo-overview@phone"].probes, undefined);
  assert.equal(log.filter((entry) => ["回到插件列表", "回到技能列表"].includes(entry.clickNamed)).length, 2);
  assert.deepEqual(report.failures, []);
  // The step that presses 保存 wrote nothing: the guard is installed for it and removed after.
  const pressedAt = log.findIndex((entry) => entry.clickNamed === "保存");
  const routeAt = log.findLastIndex((entry, index) => index < pressedAt && entry.route === String("**/api/**"));
  assert.ok(pressedAt >= 0 && routeAt >= 0 && log.findIndex((entry, index) => index > pressedAt && entry.unroute) > pressedAt);
  assert.equal(log.filter((entry) => entry.aborted).length, 0);
  assert.deepEqual(Object.keys(report.steps).sort(), ["address-state", "evidence-matrix@desktop", "evidence-matrix@phone", "extensions-skills-create", "files-pdf", "files-return", "frontier-event-handoff", "knowledge-graph-mark", "memory-map-drawer"]);
});

test("a page that regresses on what R11 fixed fails the walk and names the page and the defect", async () => {
  const failures = async (env) => {
    const { code, report, stderr } = await walk(env);
    return { code, failures: report.failures, stderr };
  };
  const sidebar = await failures({ FAKE_STRUCTURE: "sidebar" });
  assert.equal(sidebar.code, 1);
  assert.ok(sidebar.failures.includes("autopilot@desktop: 2 sidebar landmarks named 侧栏 (exactly one)"));
  assert.ok((await failures({ FAKE_STRUCTURE: "nolink" })).failures.includes("autopilot@phone: the sidebar has no link to the conversation"));
  assert.ok((await failures({ FAKE_STRUCTURE: "notinert" })).failures.includes("files@phone: the closed sidebar is not inert — its links are still tab stops"));
  assert.ok((await failures({ FAKE_STRUCTURE: "tabs" })).failures.some((failure) => /^files@phone: with the sidebar closed, Tab reaches it: /.test(failure)));
  assert.ok((await failures({ FAKE_STRUCTURE: "scroller" })).failures.includes("files@desktop: 1 region(s) scroll sideways and are no tab stop and hold none: table"));
  const headings = await failures({ FAKE_STRUCTURE: "headings" });
  assert.ok(headings.failures.includes("geo-overview@desktop: heading levels skip: h1→h3 “标题”") && headings.failures.includes("memory@phone: heading levels skip: h1→h3 “标题”"));
  assert.ok(!headings.failures.some((failure) => failure.startsWith("files@")), "a skipped heading elsewhere is a notice");
  assert.ok((await failures({ FAKE_STRUCTURE: "twins" })).failures.includes("account-projects@desktop: two projects read alike in the list: 波立维"));
  assert.ok((await failures({ FAKE_STRUCTURE: "cutoff" })).failures.includes("vcr-overview@phone: 2 count label(s) of the study are cut off at 390 px"));

  assert.ok((await failures({ FAKE_PROBE: "followingEmpty" })).failures.includes("frontier-following@desktop: 「没有结果」 is on the page, and nothing was searched or filtered"));
  assert.ok((await failures({ FAKE_PROBE: "memoryTabs" })).failures.some((entry) => entry.includes("the address names 项目 and the page opens on 关于你")));
  assert.ok((await failures({ FAKE_PROBE: "inboxSafety" })).failures.includes("inbox@desktop: the safety heading counts 2 unread and the bell 5"));
  assert.ok((await failures({ FAKE_PROBE: "connectorRows" })).failures.includes("account-connectors@desktop: Semantic Scholar needs no key and reads 未配置"));
  assert.ok((await failures({ FAKE_PROBE: "sharedMissing" })).failures.includes("memory-shared-missing@desktop: 重试 is offered for a share that does not exist"));
  assert.ok((await failures({ FAKE_PROBE: "missingRecord" })).failures.includes("extensions-skill-missing@desktop: 「操作未完成」 on a record that is not there"));
  assert.ok((await failures({ FAKE_PROBE: "readingFolds" })).failures.includes("frontier-evidence@desktop: the fold 编写与核查 is open at first sight"));
  assert.ok((await failures({ FAKE_PROBE: "capabilityCards" })).failures.includes("capabilities@desktop: the tool cards still say 可运行"));
  assert.ok((await failures({ FAKE_BACK: "stay" })).failures.includes("extensions-skill-missing@desktop: 回到技能列表 goes to /app/extensions/skills/impeccable-audit-missing (/app/extensions/skills)"));
  const after = await failures({ FAKE_AFTER: "bad" });
  assert.ok(after.failures.includes("geo-sources@desktop: clicking the first source opened no drawer (a dialog holding data-geo-source-drawer)"));
  assert.ok(after.failures.includes("autopilot@desktop: the task bar names a time zone by its identifier: Asia/Shanghai"));
  assert.ok((await failures({ FAKE_PDF: "narrow" })).failures.includes("files@desktop: the original of a PDF is 559 px wide on its page (at least 560)"));
  assert.ok((await failures({ FAKE_SKILL: "bare" })).failures.includes("extensions-skills@desktop: the new-skill drawer has 0 caption(s) under its fields (two)"));
  assert.ok((await failures({ FAKE_MATRIX: "search" })).failures.includes("evidence-matrix@desktop: searching for CLM-001 leaves 3 row(s) and “显示 3 / 3 条”"));
  assert.ok((await failures({ FAKE_MATRIX: "focus" })).failures.includes("evidence-matrix@phone: Escape does not return focus to the claim's row"));
});

test("the new-skill drawer's 保存 sends nothing: a write the page tries is refused in the browser and fails the step", async () => {
  const { code, log, report } = await walk({ FAKE_SKILL_WRITE: "1" });
  assert.equal(code, 1);
  assert.deepEqual(log.filter((entry) => entry.aborted), [{ aborted: "POST" }]);
  assert.ok(report.failures.includes("extensions-skills@desktop: 保存 with empty fields sent a request: POST /api/personal-skills"));
});

test("a row count, a headline's place and a title column are findings the baseline decides on, never failures of their own", async () => {
  const { code, report, stdout } = await walk({ FAKE_STRUCTURE: "tall", FAKE_PROBE: "firstRowTop" });
  assert.equal(code, 0, stdout);
  assert.ok(report.notices.includes("frontier@phone: the first headline starts at 620 px (the aim is 520)"));
  const rows = await walk({ FAKE_STRUCTURE: "rows" });
  assert.equal(rows.code, 0);
  assert.ok(rows.report.notices.includes("geo-sources@desktop: 99 rows on the first screen of data (ceiling 40)"));
  const found = rows.report.findings.filter((entry) => entry.rule === "rows-ceiling").map((entry) => [entry.view, entry.value]);
  assert.deepEqual(found, [["geo-accuracy@desktop", 99], ["geo-sources@desktop", 99]]);
});

test("a page whose id the lists do not name is not walked, and the notice says why; a matrix that never appears is a notice too", async () => {
  const empty = await walk({ FAKE_EMPTY_LISTS: "1" });
  assert.equal(empty.code, 0, empty.stdout + empty.stderr);
  const visited = empty.log.filter((entry) => entry.goto).map((entry) => new URL(entry.goto).pathname);
  assert.ok(visited.every((address) => !/\/(std_|answers|zones\/z_|authors|events\/ev_|runs\/run_|files\/src_)/.test(address)), visited.join("\n"));
  for (const wanted of [
    "geo-answer: not walked — the first project lists no wrong sentence with an answer",
    "frontier-zone: not walked — the evidence zones are not offered to this account or the list is empty",
    "frontier-evidence: not walked — no official zone holds a card", "frontier-author: not walked — the first card names no author page", "frontier-event: not walked — the hot list is empty or not offered",
    "evidence-matrix: not walked — no run of this account delivered a clinical-evidence package", "files: the original of a PDF: not walked — the knowledge base holds no finished PDF",
    "files-reader: not walked — the knowledge base holds no finished document",
  ]) assert.ok(empty.report.notices.includes(wanted), `${wanted}\n${empty.report.notices.join("\n")}`);
  assert.ok(empty.report.notices.some((notice) => notice.startsWith("account-connectors@desktop: no data source without a key is unset")));
  assert.equal(empty.report.steps?.["files-pdf"], undefined);
  // A matrix that never appears is a step that could not reach its target: a failure, not a notice (R19 S3).
  const { code, report } = await walk({ FAKE_NO_MATRIX: "1" });
  assert.equal(code, 1);
  assert.ok(report.failures.some((failure) => /^evidence-matrix@desktop: the step could not run, so a finished package's evidence matrix/.test(failure)), report.failures.join("\n"));
  assert.match(report.steps["evidence-matrix@desktop"].target, /evidence matrix/);
});

/**
 * The composer as the kernel's frame draws it: a root holding the card (the editable and the toolbar's row, with its tools and its send key) and the dock
 * under the card. The kernel's classes end in a stable suffix (`InputBar_card`), which is how the shell's own stylesheet and the probe find them.
 */
function composerDom({ chipsInBar = 0, chipsInDock = 0, hero = false, dock = true, researcher = true, wrap = false, gap = 24, perStat = false } = {}) {
  const chip = (placement) => node("span", { attrs: { "data-evimed-tool-chip": "vcr-protocol", "data-evimed-chip-placement": placement }, w: 120, h: 24, top: 945 - gap - 28 });
  const lowest = 945 - gap;
  const send = node("button", { attrs: { "aria-label": "发送" }, w: 32, h: 32, top: lowest - 32 });
  const tools = node("div", { attrs: { class: "InputBar_tools" }, top: lowest - 32 }, [
    node("button", { attrs: { "aria-label": "添加" }, w: 32, h: 32, top: lowest - 32 }),
    ...Array.from({ length: chipsInBar }, () => chip("bar")),
  ]);
  const row = node("div", { attrs: { class: "InputBar_row" }, top: lowest - 32 }, [tools, node("div", { attrs: { class: "InputBar_trailing" }, top: wrap ? lowest : lowest - 32 }, [send])]);
  const card = node("div", { attrs: { class: "InputBar_card" }, top: lowest - 100, h: 100 }, [node("div", { attrs: { contenteditable: "true" }, top: lowest - 100, h: 60 }), row]);
  const hidden = researcher ? { display: "none" } : {};
  const dockEl = node("div", { attrs: { class: "InputBar_dock" }, top: lowest, h: 24 }, [
    // Until 0.2.0 one `[data-composer-stats]` held the pills; 0.2.1 draws each as its own `span[data-composer-stat=<id>]`.
    ...(perStat
      ? ["activity", "usage"].map((id) => node("span", { attrs: { "data-composer-stat": id }, text: id === "usage" ? "用量 12K" : "42 tok/s", style: hidden, top: lowest - 24 }))
      : [node("span", { attrs: { "data-composer-stats": "" }, text: "用量 12K", style: hidden, top: lowest - 24 })]),
    node("span", {}, [node("button", { attrs: { "aria-haspopup": "dialog", "aria-label": "上下文已用 20%" }, style: hidden, top: lowest - 60 })]),
    ...Array.from({ length: chipsInDock }, () => chip("bar")),
  ]);
  return node("body", {}, [node("div", { attrs: { class: hero ? "InputBar_root InputBar_hero" : "InputBar_root" } }, [card, ...(dock ? [dockEl] : [])])]);
}

test("the composer is read inside the kernel's frame: the room under it, the chips by where they are drawn, the toolbar's lines, the statistics and the ring", () => {
  assert.equal(COMPOSER_BOTTOM_PX, 16);
  const read = (options, dom = {}) => inPage(composerDom(dom), () => composerProbe([options]));
  const normal = read({ operator: false });
  assert.deepEqual(normal, {
    composer: true, hero: false, operator: false, window: { width: 1512, height: 945 }, gapCard: 24, gapLowest: 24, rowLines: 1, rowHeight: 24, scrollsSideways: false,
    chips: { total: 0, bar: 0, hero: 0, inTools: 0, inDock: 0 }, stats: { present: 1, visible: 0 }, ring: 0,
  });
  // The lowest control is the one nearest the bottom, wherever it is; the card's own edge is read beside it.
  assert.equal(read({}, { gap: 4 }).gapLowest, 4);
  assert.equal(read({}, { gap: 40 }).gapCard, 40);
  // A chip is counted where it is drawn: in the toolbar, or in the dock under the card.
  assert.deepEqual(read({}, { chipsInBar: 1 }).chips, { total: 1, bar: 1, hero: 0, inTools: 1, inDock: 0 });
  assert.deepEqual(read({}, { chipsInBar: 1, chipsInDock: 1 }).chips, { total: 2, bar: 2, hero: 0, inTools: 1, inDock: 1 });
  // The statistics and the ring are in the document for a researcher and hidden; an operator's are drawn.
  const operator = read({ operator: true }, { researcher: false });
  assert.deepEqual([operator.operator, operator.stats, operator.ring], [true, { present: 1, visible: 1 }, 1]);
  // The 0.2.1 kernel's per-pill spans are read the same way: present and hidden for a researcher, drawn for an operator.
  assert.deepEqual(read({ operator: false }, { perStat: true }).stats, { present: 2, visible: 0 });
  assert.deepEqual(read({ operator: true }, { perStat: true, researcher: false }).stats, { present: 2, visible: 2 });
  // The blank conversation has no dock under its card; a toolbar whose children start on two lines took two.
  assert.equal(read({}, { dock: false }).hero, true);
  assert.equal(read({}, { hero: true }).hero, true);
  assert.equal(read({}, { wrap: true }).rowLines, 2);
  // The tools and the send key are centred in the row and a few pixels apart (the kernel's measured: 888 and 885): still one line.
  const centred = composerDom();
  const trailing = descendants(centred).find((el) => el.attrs.class === "InputBar_trailing");
  trailing.rect.top -= 3;
  assert.equal(inPage(centred, () => composerProbe([{}])).rowLines, 1);
  // A class list that merely ends in another class is not the kernel's card: the editable of a page without one has no composer.
  const stray = node("body", {}, [node("div", { attrs: { class: "InputBar_card other" } }, [node("div", { attrs: { contenteditable: "true" } })])]);
  assert.equal(inPage(stray, () => composerProbe([{}])).composer, false);
  assert.equal(inPage(page(header()), () => composerProbe([])).composer, false);

  // Judged: every verdict a notice, each "not observable" with its reason.
  const none = "chat@desktop: not observable: the conversation runs no tool, so there is no chip to count (a tool is bound from 科研工具, whose cards write)";
  assert.deepEqual(composerFindings("desktop", normal), { failures: [], notices: [none] });
  assert.deepEqual(composerFindings("desktop", read({}, { gap: 15 })).notices, ["chat@desktop: the lowest control of the composer is 15 px above the bottom of the window (at least 16)", none]);
  assert.deepEqual(composerFindings("desktop", read({}, { gap: 16 })).notices, [none]);
  assert.deepEqual(composerFindings("desktop", read({}, { chipsInBar: 1 })), { failures: [], notices: [] });
  assert.deepEqual(composerFindings("desktop", read({}, { chipsInBar: 2 })).notices, ["chat@desktop: 2 tool chip(s) are drawn in the toolbar (exactly one)"]);
  assert.deepEqual(composerFindings("desktop", read({}, { chipsInBar: 1, chipsInDock: 1 })).notices, [
    "chat@desktop: 2 tool chip(s) are drawn in the toolbar (exactly one)",
    "chat@desktop: 2 chip(s) say they are in the toolbar and 1 are inside it",
    "chat@desktop: 1 tool chip(s) are drawn in the dock under the card (none)",
  ]);
  assert.deepEqual(composerFindings("desktop", read({ operator: true }, { researcher: false, chipsInBar: 1 })).notices,
    ["chat@desktop: not observable: the account is an operator's, whose session statistics and context ring are drawn by design, so their absence was not judged"]);
  assert.deepEqual(composerFindings("desktop", read({ operator: false }, { researcher: false, chipsInBar: 1 })).notices,
    ["chat@desktop: 1 session statistics line(s) are visible to a researcher", "chat@desktop: the context ring is visible to a researcher"]);
  assert.deepEqual(composerFindings("desktop", read({}, { hero: true, chipsInBar: 1 })).notices,
    ["chat@desktop: not observable: the conversation is the blank one, whose composer is centred with no dock under it, so the room under it was not judged"]);
  assert.deepEqual(composerFindings("desktop", { ...normal, gapLowest: null, chips: { ...normal.chips, total: 1, bar: 1, inTools: 1 } }).notices,
    ["chat@desktop: not observable: the composer holds no control, so the room under it was not judged"]);
  assert.deepEqual(composerFindings("desktop", { composer: false }).notices, ["chat@desktop: not observable: no composer was found in the conversation's frame, so its room, chips and statistics were not read"]);
  assert.deepEqual(composerFindings("phone", null).notices.length, 1);
  // At 390 px the toolbar is one line and nothing scrolls sideways; the desktop does not look at either.
  const phone = { ...read({}, { chipsInBar: 1 }), window: { width: 390, height: 844 } };
  assert.deepEqual(composerFindings("phone", phone), { failures: [], notices: [] });
  assert.deepEqual(composerFindings("phone", { ...phone, rowLines: 2, scrollsSideways: true }).notices,
    ["chat@phone: the toolbar takes 2 lines at 390 px (one)", "chat@phone: the conversation scrolls sideways at 390 px"]);
  assert.deepEqual(composerFindings("desktop", { ...phone, rowLines: 2, scrollsSideways: true }).notices, []);
});

test("with the chat asked for, the walk reads the composer at both widths, restores the window, and fails nothing", async () => {
  const { code, stdout, stderr, log, report } = await walk({ OPEN_SCIENCE_WALK_CHAT: "1" });
  assert.equal(code, 0, stdout + stderr);
  const none = (width) => `chat@${width}: not observable: the conversation runs no tool, so there is no chip to count (a tool is bound from 科研工具, whose cards write)`;
  assert.ok(report.notices.includes(none("desktop")) && report.notices.includes(none("phone")), report.notices.join("\n"));
  assert.deepEqual(Object.keys(report.steps["chat-composer"]), ["target", "desktop", "phone"]);
  assert.deepEqual([report.steps["chat-composer"].desktop.window, report.steps["chat-composer"].phone.window], [{ width: 1512, height: 945 }, { width: 390, height: 844 }]);
  assert.deepEqual(report.failures, []);
  // Without the chat page the walk does not look.
  assert.equal((await walk()).report.steps?.["chat-composer"], undefined);
  // A control too near the bottom, a toolbar that wraps, two chips, the statistics and the ring: notices, never failures.
  const low = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_COMPOSER: "low" });
  assert.equal(low.code, 0, low.stdout + low.stderr);
  assert.ok(low.report.notices.includes("chat@desktop: the lowest control of the composer is 4 px above the bottom of the window (at least 16)"));
  const wrap = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_COMPOSER: "wrap" });
  assert.equal(wrap.code, 0);
  assert.ok(wrap.report.notices.includes("chat@phone: the toolbar takes 2 lines at 390 px (one)"));
  assert.ok(!wrap.report.notices.some((notice) => notice.startsWith("chat@desktop: the toolbar")));
  const chips = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_COMPOSER: "chips" });
  assert.equal(chips.code, 0);
  assert.ok(chips.report.notices.includes("chat@desktop: 1 tool chip(s) are drawn in the dock under the card (none)"));
  const stats = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_COMPOSER: "stats" });
  assert.equal(stats.code, 0);
  assert.ok(stats.report.notices.includes("chat@desktop: the context ring is visible to a researcher"));
  // An operator's statistics are by design: said, not judged.
  const operator = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_COMPOSER: "stats", FAKE_OPERATOR: "1" });
  assert.equal(operator.code, 0);
  assert.ok(operator.report.notices.includes("chat@desktop: not observable: the account is an operator's, whose session statistics and context ring are drawn by design, so their absence was not judged"));
  assert.ok(!operator.report.notices.some((notice) => /visible to a researcher|context ring is visible/.test(notice)));
  // The blank conversation is not judged for its bottom room.
  const hero = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_COMPOSER: "hero" });
  assert.ok(hero.report.notices.some((notice) => notice.includes("the conversation is the blank one")));
  void log;
});

test("the pages the reference named have a section budget, and stacking more fails them like every other page", () => {
  for (const name of ["inbox", "geo", "frontier-zones", "autopilot", "account"]) {
    assert.ok(Number.isInteger(SECTION_SHAPES_BY_PAGE[name]), `${name} has a section budget`);
  }
  const stacked = ["ul>li", "table>thead+tbody", "svg>g", "section>h2+ul"];
  // R13 reported these as notices "until a walk has measured this page"; R19 S4 ended that: a budget is a failure.
  assert.deepEqual(pageFindings("inbox", "desktop", clean({ sectionShapes: stacked.slice(0, 3) }), []),
    { failures: ["inbox@desktop: the page stacks 3 kinds of section (budget 2): ul>li, table>thead+tbody, svg>g"], notices: [] });
  assert.deepEqual(pageFindings("inbox", "desktop", clean({ sectionShapes: stacked.slice(0, 2) }), []), { failures: [], notices: [] });
  assert.equal(pageFindings("memory", "desktop", clean({ sectionShapes: stacked.slice(0, 3) }), []).failures.length, 1);
  assert.equal(pageFindings("inbox", "desktop", clean({ controlKinds: 11 }), []).failures.length, 1);
  assert.equal(pageFindings("account", "desktop", clean({ sectionShapes: stacked }), []).failures.length, 1);
  assert.deepEqual(pageFindings("inbox", "phone", clean({ sectionShapes: stacked }), []), { failures: [], notices: [] });
});

test("the daily of a day nobody published is read for the day it names, the clock and zone it gives, and for not reading as a failure", () => {
  const view = (...blocks) => node("body", {}, [node("main", {}, [node("div", { attrs: { role: "tabpanel" } }, blocks)])]);
  const empty = (title, description, extra = []) => view(node("div", {}, [node("p", { text: title }), ...(description ? [node("div", { text: description })] : []), ...extra]));
  const read = (root) => inPage(root, () => pageProbe(["dailyEmpty"]));
  assert.deepEqual(read(empty("1月1日 周三没有日报", "日报每天 07:30（北京时间）发布；当天没有符合条件的内容时不出刊。", [node("button", { text: "往期" })])), {
    alert: null, retry: false, title: "1月1日 周三没有日报", description: "日报每天 07:30（北京时间）发布；当天没有符合条件的内容时不出刊。", past: true,
  });
  const failed = read(view(node("div", { attrs: { role: "alert" } }, [node("span", { text: "这条动态已不再提供。" }), node("button", { text: "重试" })])));
  assert.deepEqual([failed.alert, failed.retry, failed.title], ["这条动态已不再提供。", true, null]);
  assert.equal(read(view(node("p", { text: "一条普通的段落" }))).title, null);
  const one = (r) => probeFindings("frontier-daily-empty", "desktop", "dailyEmpty", r);
  assert.deepEqual(one(read(empty("1月1日 周三没有日报", "日报每天 07:30（北京时间）发布；当天没有符合条件的内容时不出刊。"))), { failures: [], notices: [] });
  assert.deepEqual(one(failed).notices, ["frontier-daily-empty@desktop: a day nobody published reads as a failure: “这条动态已不再提供。” with 重试 (an empty day and a failed one are different, A11)"]);
  assert.deepEqual(one(read(view(node("p", { text: "一条普通的段落" })))).notices, ["frontier-daily-empty@desktop: not observable: the daily view drew neither an empty day nor an error (the feed may not be offered to this account)"]);
  assert.deepEqual(one(read(empty("今日日报尚未发布", "当天没有符合条件的内容时不出刊。"))).notices, ["frontier-daily-empty@desktop: the empty day does not name the day it is about: “今日日报尚未发布”"]);
  assert.deepEqual(one(read(empty("1月1日 周三没有日报", "日报每天 07:30发布；当天没有符合条件的内容时不出刊。"))).notices, ["frontier-daily-empty@desktop: the empty day names a publication time (07:30) and not whose clock it is"]);
  // The time may stand in the title (「今日日报 07:30（北京时间）发布」), and then it carries its zone.
  assert.deepEqual(one(read(empty("今日日报 07:30（北京时间）发布", "当天没有符合条件的内容时不出刊。"))).notices, ["frontier-daily-empty@desktop: the empty day does not name the day it is about: “今日日报 07:30（北京时间）发布”"]);
  assert.deepEqual(one(null), { failures: [], notices: [] });
  assert.deepEqual(PAGE_PROBES["frontier-daily-empty"], [["dailyEmpty", ["desktop", "phone"]]]);
  assert.ok(BUDGET_BY_PAGE["frontier-daily-empty"]);
  assert.ok(ROUTES.some(([name, route]) => name === "frontier-daily-empty" && route === "/app/frontier?view=daily&day=2020-01-01"));
});

/** The inbox's filter chips and the memory page's tabs and search box, as the pages draw them. */
const listPage = ({ pressed = "未读 3", selected = "项目 5", query = "探针", search = true, dialog = false } = {}) => node("body", {}, [
  node("aside", {}, [node("a", { attrs: { href: "/app/capabilities" }, text: "科研工具" }), node("a", { attrs: { href: "/app/inbox" }, text: "收件箱" })]),
  node("main", {}, [
    node("div", { attrs: { role: "tablist", "aria-label": "消息视图" } }, [node("button", { attrs: { role: "tab", "aria-selected": String(pressed === "全部") }, text: "全部" }), node("button", { attrs: { role: "tab", "aria-selected": String(pressed.startsWith("未读")) }, text: pressed.startsWith("未读") ? pressed : "未读" })]),
    node("div", { attrs: { role: "tablist", "aria-label": "记忆" } }, ["关于你", "项目 5", "做法 2", "地图"].map((name) => node("button", { attrs: { role: "tab", "aria-selected": String(name === selected) }, text: name }))),
    ...(search ? [node("input", { attrs: { "aria-label": "搜索记忆" }, value: query })] : []),
    ...(dialog ? [node("div", { attrs: { role: "dialog" } })] : []),
  ]),
]);

test("where a list page keeps its place is read from the address and from what its controls show: chips, tabs, the search box, the open row", () => {
  const at = (path, search, fn, root = listPage()) => inPage(root, () => { globalThis.location.search = search; return fn(); }, { path });
  assert.deepEqual(at("/app/inbox", "?filter=unread", () => addressProbe(["inbox"])), { path: "/app/inbox", search: "?filter=unread", dialog: false, found: true, selected: "未读 3" });
  assert.deepEqual(at("/app/memory", "?tab=project&q=%E6%8E%A2", () => addressProbe(["memory"]), listPage({ dialog: true })),
    { path: "/app/memory", search: "?tab=project&q=%E6%8E%A2", dialog: true, found: true, selected: "项目 5", query: "探针" });
  assert.equal(inPage(page(header()), () => addressProbe(["inbox"])).found, false);
  assert.equal(inPage(listPage({ search: false }), () => addressProbe(["memory"])).query, null);
  assert.equal(inPage(page(header()), () => addressProbe(["other"])), null);
  // The controls are pressed by what they are called (a chip and a tab carry their count), or by where a sidebar link goes; nothing else.
  const body = listPage();
  inPage(body, () => {
    assert.equal(addressAct(["tab", "未读"]), true);
    assert.equal(addressAct(["chip", "别的组", "未读"]), false);
    assert.equal(addressAct(["tab", "项目"]), true);
    assert.equal(addressAct(["tab", "不存在"]), false);
    assert.equal(addressAct(["link", "/app/capabilities"]), true);
    assert.equal(addressAct(["link", "/app/nowhere"]), false);
    assert.equal(addressAct(["other"]), false);
  });
  assert.deepEqual(descendants(body).filter((el) => el.clicks > 0).map((el) => el.text), ["科研工具", "未读 3", "项目 5"]);
  assert.deepEqual(ADDRESS_CASES.map((c) => c.page), ["inbox", "memory"]);
  assert.equal(addressStateHolds({ selected: "未读" }, { selected: "未读 3" }), true);
  assert.equal(addressStateHolds({ query: "探针" }, { query: "探针 " }), false);
  assert.equal(addressStateHolds({ selected: "未读" }, null), false);

  // Judged.
  const inbox = ADDRESS_CASES[0];
  const memory = ADDRESS_CASES[1];
  const shown = { path: "/app/inbox", search: "?filter=unread", dialog: false, found: true, selected: "未读 3" };
  const good = { pressed: [true], first: shown, away: "/app/capabilities", back: shown, reload: shown };
  assert.deepEqual(addressStateFindings(inbox, good), { failures: [], notices: [] });
  assert.deepEqual(addressStateFindings(inbox, { ...good, first: { ...shown, search: "" } }).notices, [
    "inbox@desktop: the choice is not in the address after it was made: filter=unread is not in “”",
    "inbox@desktop: after Back from another page the address is “?filter=unread” and was “”",
    "inbox@desktop: after loading the address again the address is “?filter=unread” and was “”",
  ]);
  assert.deepEqual(addressStateFindings(inbox, { ...good, back: { ...shown, search: "", selected: "全部" }, reload: { ...shown, selected: "全部" } }).notices, [
    "inbox@desktop: after Back from another page the address is “” and was “?filter=unread”",
    "inbox@desktop: after Back from another page the page shows {\"selected\":\"全部\"} ({\"selected\":\"未读\"})",
    "inbox@desktop: after loading the address again the page shows {\"selected\":\"全部\"} ({\"selected\":\"未读\"})",
  ]);
  assert.deepEqual(addressStateFindings(inbox, { ...good, first: { ...shown, selected: "全部" } }).notices, ["inbox@desktop: the page does not show the choice it was given ({\"selected\":\"未读\"})"]);
  assert.deepEqual(addressStateFindings(inbox, { ...good, back: null, reload: null }).notices, ["inbox@desktop: not observable: Back from another page was not taken", "inbox@desktop: not observable: loading the address again was not taken"]);
  assert.deepEqual(addressStateFindings(inbox, { ...good, away: "/app/inbox" }).notices, ["inbox@desktop: not observable: the sidebar link did not leave the page (/app/inbox), so Back came from nowhere"]);
  assert.deepEqual(addressStateFindings(inbox, { pressed: [false], first: shown, away: null, back: null, reload: null }).notices,
    ["inbox@desktop: not observable: a control of the case was not on the page (missing), so the choice was not made"]);
  assert.deepEqual(addressStateFindings(inbox, { pressed: [], first: { ...shown, found: false }, away: null, back: null, reload: null }).notices,
    ["inbox@desktop: not observable: the page's list controls were not found, so what it keeps in its address was not read"]);
  const kept = { path: "/app/memory", search: "?tab=project&q=%E6%8E%A2%E9%92%88", dialog: false, found: true, selected: "项目 5", query: "探针" };
  assert.deepEqual(addressStateFindings(memory, { pressed: [true], first: kept, away: "/app/capabilities", back: kept, reload: kept }), { failures: [], notices: [] });
  assert.deepEqual(addressStateFindings(memory, { pressed: [true], first: { ...kept, query: null }, away: null, back: null, reload: null }).notices,
    ["memory@desktop: not observable: a control of the case was not on the page (found, search box missing), so the choice was not made"]);
  assert.deepEqual(addressStateFindings(memory, { pressed: [true], first: { ...kept, search: "?tab=project" }, away: "/app/capabilities", back: { ...kept, search: "?tab=project" }, reload: { ...kept, search: "?tab=project" } }).notices,
    ["memory@desktop: the choice is not in the address after it was made: q=探针 is not in “?tab=project”"]);

  // A row that opens in a drawer: in the address while open, and Back closes it.
  const opened = { ...kept, search: `${kept.search}&open=r1`, dialog: true };
  assert.deepEqual(addressOpenFindings("memory", { rows: 3, opened, closed: kept }), { failures: [], notices: [] });
  assert.deepEqual(addressOpenFindings("memory", { rows: 0, opened: null, closed: null }).notices, ["memory@desktop: not observable: no row of the list opens, so an open row's place in the address was not read"]);
  assert.deepEqual(addressOpenFindings("memory", { rows: 1, opened: kept, closed: kept }).notices, ["memory@desktop: not observable: the first row did not open a drawer, so its place in the address was not read"]);
  assert.deepEqual(addressOpenFindings("memory", { rows: 1, opened: { ...opened, search: kept.search }, closed: opened }).notices, [
    "memory@desktop: the open row is not in the address (“?tab=project&q=%E6%8E%A2%E9%92%88”)", "memory@desktop: Back leaves the drawer open",
    "memory@desktop: Back leaves the row in the address (“?tab=project&q=%E6%8E%A2%E9%92%88&open=r1”)"]);
  assert.deepEqual(addressOpenFindings("memory", { rows: 1, opened, closed: null }).notices, ["memory@desktop: not observable: Back was not taken"]);
});

test("the event page's 深入研究 is read at the hand-off: the title, a link to a source, a create intent that cannot send, and Back to the event", async () => {
  const eventPage = (button = true) => node("body", {}, [node("main", {}, [node("header", {}, [node("h1", { text: "某事件" })]), ...(button ? [node("button", { text: "深入研究" })] : [])])]);
  assert.deepEqual(inPage(eventPage(), () => handoffProbe(["event"]), { path: "/app/frontier/events/ev_1" }), { path: "/app/frontier/events/ev_1", title: "某事件", button: true });
  assert.equal(inPage(eventPage(false), () => handoffProbe(["event"])).button, false);
  const withState = (usr) => inPage(eventPage(), () => { globalThis.window.history = { state: usr === undefined ? null : { usr, key: "k", idx: 2 } }; return handoffProbe(["intent"]); }, { path: "/app/chat" });
  const draft = "请围绕这个事件做一次深入研究。\n\n事件：某事件\n一手来源：\n- 官方：标题（https://example.org/a）";
  const intent = { kind: "create", projectId: "p", requestId: "req_1", sessionId: "s", draft };
  assert.deepEqual(withState({ runtimeUiIntent: intent }), { path: "/app/chat", intent: { keys: ["draft", "kind", "projectId", "requestId", "sessionId"], kind: "create", draft, requestId: "req_1" } });
  assert.deepEqual(withState({}), { path: "/app/chat", intent: null });
  assert.deepEqual(withState(undefined), { path: "/app/chat", intent: null });
  // The fields of the web's `RuntimeUiIntent`, read from its declaration: a field added there is a field the walk accepts.
  const declared = (await readFile(path.join(repoRoot, "apps/web/src/lib/runtimeUiNavigation.ts"), "utf8")).match(/export interface RuntimeUiIntent \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.deepEqual(HANDOFF_FIELDS, [...declared.matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1]).sort());

  const before = { path: "/app/frontier/events/ev_1", title: "某事件", button: true };
  const after = { path: "/app/chat", intent: { keys: ["draft", "kind", "projectId", "requestId", "sessionId"], kind: "create", draft, requestId: "req_1" } };
  assert.deepEqual(handoffFindings(before, after, before.path), { failures: [], notices: [] });
  assert.deepEqual(handoffFindings({ ...before, button: false }, null, null).notices, ["frontier-event@desktop: not observable: the event page has no 深入研究 button, so the hand-off to the conversation was not read"]);
  assert.deepEqual(handoffFindings(null, null, null).notices.length, 1);
  assert.deepEqual(handoffFindings(before, { path: "/app/frontier/events/ev_1", intent: null }, null).notices, ["frontier-event@desktop: not observable: 深入研究 did not go to the conversation (/app/frontier/events/ev_1), so its draft was not read"]);
  assert.deepEqual(handoffFindings(before, { path: "/app/chat", intent: null }, null).notices, ["frontier-event@desktop: the hand-off to the conversation carries no intent in the address's state"]);
  assert.deepEqual(handoffFindings(before, { ...after, intent: { ...after.intent, kind: "open", draft: null, requestId: null, keys: [...after.intent.keys, "send"] } }, before.path).notices, [
    "frontier-event@desktop: the hand-off is a “open” intent (create: a new conversation)", "frontier-event@desktop: the hand-off carries no draft",
    "frontier-event@desktop: the hand-off has no request id, so a reload cannot tell it from a new one", "frontier-event@desktop: the hand-off carries fields a draft does not need: send"]);
  assert.deepEqual(handoffFindings(before, { ...after, intent: { ...after.intent, draft: "请深入研究" } }, before.path).notices, [
    "frontier-event@desktop: the draft does not hold the event's title “某事件”", "frontier-event@desktop: the draft holds no link to a source"]);
  assert.deepEqual(handoffFindings(before, after, "/app/chat").notices, ["frontier-event@desktop: Back from the conversation leaves the address at /app/chat and the event page was /app/frontier/events/ev_1"]);
});

test("the walk tries the address of the inbox and the memory page, the event's hand-off and a day nobody published; what it cannot try it says", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  assert.deepEqual(report.failures, []);
  // The daily of a day with no issue is a page of the walk at both widths, and its 404 is the refusal it is walked to meet.
  const visited = log.filter((entry) => entry.goto).map((entry) => entry.goto);
  assert.ok(visited.includes("https://evimed.example.org/app/frontier?view=daily&day=2020-01-01"));
  assert.ok(report.pages["frontier-daily-empty@desktop"] && report.pages["frontier-daily-empty@phone"]);
  assert.equal(report.notices.filter((notice) => /^(inbox|memory|frontier-event)@desktop: /.test(notice) && /address|hand-off|draft|Back/.test(notice)).length, 0, report.notices.join("\n"));
  // Both cases were made, then Back, then the address again; the memory row was opened and Back closed it.
  assert.deepEqual(log.filter((entry) => entry.act).map((entry) => entry.act),
    [["tab", "未读"], ["link", "/app/capabilities"], ["tab", "项目"], ["link", "/app/capabilities"]]);
  assert.deepEqual(log.filter((entry) => entry.fill).map((entry) => [entry.fill, entry.value]).filter(([name]) => name === "搜索记忆"), [["搜索记忆", "探针"]]);
  assert.deepEqual(Object.keys(report.steps["address-state"]), ["target", "inbox", "memory", "memory-landing", "memory-row-coverage", "memory-open"]);
  assert.equal(report.steps["frontier-event-handoff"].after.path, "/app/chat");

  // The address that does not come back, a row that stays open after Back.
  const lost = await walk({ FAKE_ADDRESS: "lost" });
  assert.equal(lost.code, 0, lost.stdout + lost.stderr);
  assert.ok(lost.report.notices.includes("inbox@desktop: after Back from another page the address is “” and was “?filter=unread”"), lost.report.notices.join("\n"));
  assert.ok(lost.report.notices.some((notice) => notice.startsWith("memory@desktop: after loading the address again the address is “”")));
  const open = await walk({ FAKE_ADDRESS: "open" });
  assert.ok(open.report.notices.includes("memory@desktop: Back leaves the drawer open"));
  // The hand-off with no link, and an event page without the button; no event at all.
  const bad = await walk({ FAKE_HANDOFF: "bad" });
  assert.equal(bad.code, 0);
  assert.ok(bad.report.notices.includes("frontier-event@desktop: the draft holds no link to a source"));
  assert.ok((await walk({ FAKE_HANDOFF: "nobutton" })).report.notices.some((notice) => notice.includes("the event page has no 深入研究 button")));
  const empty = await walk({ FAKE_EMPTY_LISTS: "1" });
  assert.equal(empty.code, 0, empty.stdout + empty.stderr);
  assert.ok(empty.report.notices.includes("frontier-event@desktop: not observable: the hot list names no event, so the hand-off of 深入研究 to the conversation (A01) was not read"));
  assert.equal(empty.report.steps?.["frontier-event-handoff"], undefined);

  // The daily of a day nobody published: read as a failure, as an account without the feed, with no day, with a time and no zone — notices all.
  for (const [mode, wanted] of [
    ["error", "frontier-daily-empty@desktop: a day nobody published reads as a failure: “这条动态已不再提供。” with 重试 (an empty day and a failed one are different, A11)"],
    ["off", "frontier-daily-empty@desktop: not observable: the daily view drew neither an empty day nor an error (the feed may not be offered to this account)"],
    ["nameless", "frontier-daily-empty@phone: the empty day does not name the day it is about: “今日日报尚未发布”"],
    ["zoneless", "frontier-daily-empty@desktop: the empty day names a publication time (07:30) and not whose clock it is"],
  ]) {
    const daily = await walk({ FAKE_DAILY: mode });
    assert.equal(daily.code, 0, daily.stdout + daily.stderr);
    assert.ok(daily.report.notices.includes(wanted), `${mode}\n${daily.report.notices.join("\n")}`);
  }
});

test("axe-core is looked for where the walk was told, in the copy it carries and beside a checkout; a source that is not axe's is not used; absence is an answer", async () => {
  const banner = (version) => `/*! axe v${version}\n * Copyright (c) Deque */\n!function(){window.axe={};axe.run=function(){}}();`;
  assert.equal(axeVersionOf(banner("4.12.1")), "4.12.1");
  assert.equal(axeVersionOf(`  \n${banner("4.9.0")}`), "4.9.0");
  assert.equal(axeVersionOf("/*! axe v4.12.1 */ nothing runs"), null);
  assert.equal(axeVersionOf("console.log('axe.run')"), null);
  assert.equal(axeVersionOf(""), null);
  const files = { "/mounted/axe.min.js": banner("4.13.0"), "/found/axe.min.js": banner("4.12.1"), "/other/lib.js": "console.log(1)" };
  const read = async (file) => { if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[file]; };
  const embedded = (version) => {
    const source = banner(version);
    return { version, sha256: createHash("sha256").update(source).digest("hex"), brotliBase64: brotliCompressSync(source).toString("base64") };
  };
  const none = () => null;
  // The file the walk is told about comes first, then the copy it carries, then what a checkout resolves.
  assert.deepEqual(await loadAxeSource({ env: { OPEN_SCIENCE_WALK_AXE: "/mounted/axe.min.js" }, read, resolve: () => "/found/axe.min.js", embedded: embedded("4.12.1") }),
    { source: banner("4.13.0"), version: "4.13.0", from: "/mounted/axe.min.js", why: null });
  const carried = await loadAxeSource({ env: {}, read, resolve: () => "/found/axe.min.js", embedded: embedded("4.12.1") });
  assert.deepEqual([carried.version, carried.from, carried.why], ["4.12.1", "embedded in the walk (axe-core 4.12.1)", null]);
  const resolved = await loadAxeSource({ env: {}, read, resolve: () => "/found/axe.min.js", embedded: null });
  assert.deepEqual([resolved.version, resolved.from], ["4.12.1", "/found/axe.min.js"]);
  // Off is off; a path that cannot be read or is not axe's is said, and the next place is tried.
  assert.deepEqual(await loadAxeSource({ env: { OPEN_SCIENCE_WALK_AXE: "off" }, read, resolve: () => "/found/axe.min.js", embedded: embedded("4.12.1") }),
    { source: null, version: null, from: null, why: "the scan is switched off (OPEN_SCIENCE_WALK_AXE=off)" });
  const missing = await loadAxeSource({ env: { OPEN_SCIENCE_WALK_AXE: "/nowhere.js" }, read, resolve: none, embedded: null });
  assert.deepEqual([missing.source, missing.why], [null, "/nowhere.js could not be read (ENOENT)"]);
  const wrong = await loadAxeSource({ env: { OPEN_SCIENCE_WALK_AXE: "/other/lib.js" }, read, resolve: none, embedded: null });
  assert.deepEqual([wrong.source, wrong.why], [null, "/other/lib.js is not axe-core's build"]);
  assert.equal((await loadAxeSource({ env: { OPEN_SCIENCE_WALK_AXE: "/other/lib.js" }, read, resolve: () => "/found/axe.min.js", embedded: null })).from, "/found/axe.min.js");
  assert.deepEqual(await loadAxeSource({ env: {}, read, resolve: none, embedded: null }), { source: null, version: null, from: null, why: "no copy was given, embedded or installed beside the walk" });
  // A copy that does not match its checksum is not used, and says so.
  const tampered = { ...embedded("4.12.1"), sha256: "0".repeat(64) };
  const refused = await loadAxeSource({ env: {}, read, resolve: none, embedded: tampered });
  assert.deepEqual([refused.source, refused.why], [null, "the copy embedded in the walk does not match its checksum"]);
  assert.deepEqual(AXE_TAGS, ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]);
});

test("axe-core runs in the page over a document and is cut down to rule, impact, nodes and the first node's selector; a scan that fails or runs out is null", async () => {
  // In the page: `axeLoaded` says whether it is there; `axeRun` gives the rules it was told to run on the document, with no frames.
  assert.equal(inPage(page(header()), () => axeLoaded()), false);
  const calls = [];
  const fakeAxe = { version: "4.12.1", run: async (context, options) => {
    calls.push([context === globalThis.document, options]);
    return { violations: [
      { id: "color-contrast", impact: "serious", help: "Elements must meet minimum color contrast ratio thresholds", nodes: [{ target: [".a", ".b"] }, { target: [".c"] }] },
      { id: "region", impact: null, help: "x".repeat(300), nodes: [{ target: [["#frame", "main p"]] }] },
      { id: "bare", impact: "minor", nodes: [{}] },
    ], incomplete: [{}, {}], passes: [] };
  } };
  const withAxe = (fn) => inPage(page(header()), () => { globalThis.window.axe = fakeAxe; return fn(); });
  assert.equal(withAxe(() => axeLoaded()), true);
  const result = await withAxe(() => axeRun([{ tags: AXE_TAGS }]));
  assert.deepEqual(calls, [[true, { iframes: false, resultTypes: ["violations"], runOnly: { type: "tag", values: AXE_TAGS } }]]);
  assert.deepEqual(result, { version: "4.12.1", incomplete: 2, violations: [
    { id: "color-contrast", impact: "serious", nodes: 2, target: ".a .b", help: "Elements must meet minimum color contrast ratio thresholds" },
    { id: "region", impact: null, nodes: 1, target: "#frame,main p", help: "x".repeat(100) },
    { id: "bare", impact: "minor", nodes: 1, target: "", help: "" },
  ] });
  // A page without axe-core has nothing to run; a scope is a selector axe is given instead of the document.
  assert.equal(await inPage(page(header()), () => axeRun([{ tags: AXE_TAGS }])), null);
  await withAxe(() => axeRun([{ tags: ["wcag2a"], scope: "main" }]));
  assert.equal(calls[1][0], false);
  assert.deepEqual(calls[1][1].runOnly.values, ["wcag2a"]);

  // From the walk: the source goes into the page only where axe is not, and a scan that fails or runs out is null, not an exception.
  const pageOf = ({ loaded = false, run = async () => ({ version: "4.12.1", violations: [], incomplete: 0 }) } = {}) => {
    const evaluated = [];
    return { evaluated, evaluate: async (fn, arg) => {
      evaluated.push(typeof fn === "string" ? "source" : fn.name);
      if (typeof fn === "string") return undefined;
      return fn.name === "axeLoaded" ? loaded : run(arg);
    } };
  };
  const fresh = pageOf();
  assert.deepEqual(await scanWithAxe(fresh, "AXE SOURCE"), { version: "4.12.1", violations: [], incomplete: 0 });
  assert.deepEqual(fresh.evaluated, ["axeLoaded", "source", "axeRun"]);
  const there = pageOf({ loaded: true });
  await scanWithAxe(there, "AXE SOURCE");
  assert.deepEqual(there.evaluated, ["axeLoaded", "axeRun"]);
  assert.equal(await scanWithAxe(pageOf({ run: async () => { throw new Error("axe blew up"); } }), "AXE SOURCE"), null);
  assert.equal(await scanWithAxe(pageOf({ run: () => new Promise(() => {}) }), "AXE SOURCE", { timeoutMs: 20 }), null);
});

test("the copy of axe-core the walk carries is the pinned build, keeps its notice, and is the package's byte for byte where the package is installed", async () => {
  // The default is the copy in the file: the container the walk runs in has no other.
  const loaded = await loadAxeSource({ env: {}, resolve: () => null });
  assert.deepEqual([loaded.version, loaded.from, loaded.why], ["4.12.1", "embedded in the walk (axe-core 4.12.1)", null]);
  assert.equal(createHash("sha256").update(/** @type {string} */ (loaded.source)).digest("hex"), "66a8aaa95a8b044a7fd74a5435873bf04ff65a1ca75567c921b7509742085a14");
  assert.equal(axeVersionOf(/** @type {string} */ (loaded.source)), "4.12.1");
  // The licence asks its notice in every file that holds a substantial part of the source; the file keeps it as text beside the copy.
  const text = await readFile(path.join(repoRoot, "scripts/ops/ui-walk.mjs"), "utf8");
  assert.match(text, /\/\*! axe v4\.12\.1\n \* Copyright \(c\) 2015 - 2026 Deque Systems, Inc\./);
  assert.match(text, /This entire copyright notice must appear in every copy of this file you\n \* distribute or in any file that contains substantial portions of this source\n \* code\./);
  // What is between the markers is what the generator writes for that build, so it can be regenerated and checked.
  const { BEGIN, END, embeddedBlock } = await import("../../../scripts/ops/embed-axe-core.mjs");
  assert.equal(embeddedBlock(/** @type {string} */ (loaded.source)), text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length));
  assert.equal(text.split(BEGIN).length, 2);
  // Where the package is installed (a checkout; the pnpm store holds eslint-plugin-jsx-a11y's), it is that file.
  const installed = path.join(repoRoot, "node_modules/.pnpm/axe-core@4.12.1/node_modules/axe-core/axe.min.js");
  const package_ = await readFile(installed, "utf8").catch(() => null);
  if (package_ !== null) {
    assert.equal(loaded.source, package_);
    const check = await new Promise((resolve) => execFile(process.execPath, [path.join(repoRoot, "scripts/ops/embed-axe-core.mjs"), "--check", installed], (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
    assert.deepEqual([check.code, check.stdout.startsWith("the copy in ui-walk.mjs is ")], [0, true]);
  }
  // Another build, or a file that is not axe-core's, is not "the copy in the walk".
  assert.throws(() => embeddedBlock("console.log(1)"), /not axe-core's browser build/);
  assert.notEqual(embeddedBlock(`${loaded.source}\n`), text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length));
});

test("what axe found is told once per page: new rules by impact with their first node, what repeats from an earlier page counted, and one line for the walk", () => {
  const violation = (id, impact, nodes, target) => ({ id, impact, nodes, target, help: "" });
  const shell = violation("region", "moderate", 1, "aside");
  const scan = (view, violations) => ({ view, result: { version: "4.12.1", violations, incomplete: 0 } });
  assert.deepEqual(axeNotices([]), { findings: [], summary: null });
  assert.deepEqual(axeNotices([scan("capabilities@desktop", [])]), { findings: [], summary: "axe-core 4.12.1: 1 page view(s) scanned, 0 with violations, 0 node(s) in all; the whole list is in the report" });
  const read = axeNotices([
    scan("capabilities@desktop", [shell]),
    scan("files@desktop", [shell, violation("color-contrast", "serious", 4, ".text-text-3"), violation("label", "critical", 1, "input.q")]),
    scan("memory@desktop", [shell]),
    { view: "inbox@desktop", result: null },
  ]);
  // A finding of rule `axe` carries the number of rules the page violates anew, so a baseline can hold a page at the count it has; a page
  // that could not be scanned is a coverage gap; the line for the walk is information.
  assert.deepEqual(read.findings.map((entry) => [entry.rule, entry.view, entry.value, entry.text]), [
    ["axe", "capabilities@desktop", 1, "capabilities@desktop: axe-core: 1 rule(s) violated: region (moderate, 1 node, aside)"],
    ["axe", "files@desktop", 2, "files@desktop: axe-core: 2 rule(s) violated: label (critical, 1 node, input.q); color-contrast (serious, 4 nodes, .text-text-3); 1 more as on an earlier page"],
    ["not-observable", "inbox@desktop", undefined, "inbox@desktop: not observable: axe-core could not scan this page"],
  ]);
  assert.equal(read.summary, "axe-core 4.12.1: 3 page view(s) scanned, 3 with violations, 8 node(s) in all (region on 3, color-contrast on 1, label on 1); the whole list is in the report");
  // A page names at most AXE_RULES_PER_NOTICE rules and counts the rest.
  const many = Array.from({ length: AXE_RULES_PER_NOTICE + 2 }, (_, index) => violation(`rule-${index}`, "minor", 1, `.n${index}`));
  const named = axeNotices([scan("geo@desktop", many)]).findings[0].text;
  assert.equal(named.split("; ").length, AXE_RULES_PER_NOTICE + 1, named);
  assert.match(named, /; and 2 more$/);
  // The same rule at another node is another finding.
  assert.match(axeNotices([scan("a@desktop", [shell]), scan("b@desktop", [violation("region", "moderate", 1, "main")])]).findings[1].text, /^b@desktop: axe-core: 1 rule\(s\) violated: region \(moderate, 1 node, main\)$/);
});

test("the walk scans each desktop page with axe-core, hands what it finds to the baseline, and says once when it has none", async () => {
  // The walk carries its own copy, so the container it runs in needs none: the default is a scan with that.
  const carried = await walk();
  assert.equal(carried.code, 0, carried.stdout + carried.stderr);
  assert.deepEqual([carried.report.axe.from, carried.report.axe.version, carried.report.axe.why], ["embedded in the walk (axe-core 4.12.1)", "4.12.1", null]);
  assert.ok(carried.report.axe.scanned > 30 && carried.log.filter((entry) => entry.axe).length === carried.report.axe.scanned);
  assert.ok(!carried.report.notices.some((notice) => notice.includes("axe-core is not available")));
  // A path that is not axe-core's is said (to the report) and the carried copy is used.
  const stray = await walk({ OPEN_SCIENCE_WALK_AXE: "/nowhere/axe.min.js" });
  assert.equal(stray.report.axe.from, "embedded in the walk (axe-core 4.12.1)");
  // With one: the source goes into every desktop page view once and into no phone page view; the report holds each page's list.
  const scanned = await walk({}, { axe: true });
  assert.equal(scanned.code, 0, scanned.stdout + scanned.stderr);
  assert.deepEqual(scanned.report.failures, []);
  assert.ok(!scanned.report.notices.some((notice) => notice.includes("axe-core is not available")));
  const desktopViews = Object.keys(scanned.report.pages).filter((view) => view.endsWith("@desktop") && scanned.report.pages[view].axe !== undefined);
  assert.ok(desktopViews.length > 30, `${desktopViews.length} desktop page views were scanned`);
  assert.equal(scanned.log.filter((entry) => entry.axe).length, desktopViews.length);
  assert.ok(Object.keys(scanned.report.pages).filter((view) => view.endsWith("@phone")).every((view) => scanned.report.pages[view].axe === undefined));
  assert.deepEqual(scanned.report.pages["files@desktop"].axe.violations.map((violation) => violation.id), ["region", "color-contrast"]);
  assert.deepEqual([scanned.report.axe.scanned, scanned.report.axe.version], [desktopViews.length, "4.12.1"]);
  assert.equal(scanned.report.axe.from.endsWith("/axe.min.js"), true, "the file the walk was given comes before the copy it carries");
  // The shell's rule is named on the first page only; the page's own rule on its page; the line for the walk counts all.
  const lines = scanned.report.notices.filter((notice) => notice.includes("axe-core"));
  assert.equal(lines.filter((notice) => notice.includes("region (moderate")).length, 1);
  assert.ok(lines.some((notice) => notice.startsWith("files@desktop: axe-core: 1 rule(s) violated: color-contrast (serious, 4 nodes, .text-text-3); 1 more as on an earlier page")), lines.join("\n"));
  const total = scanned.report.info.find((line) => line.startsWith("axe-core 4.12.1:"));
  assert.ok(total.startsWith(`axe-core 4.12.1: ${desktopViews.length} page view(s) scanned, ${desktopViews.length} with violations`), total);
  // With no baseline each page's violations fail the walk, the count being the number the baseline would hold the page at.
  const strict = await walk({ OPEN_SCIENCE_WALK_BASELINE: "none" }, { axe: true });
  assert.ok(strict.report.findings.some((entry) => entry.rule === "axe" && entry.view === "files@desktop" && entry.value === 1 && entry.accepted === null));
  // A scan that throws is a coverage gap for the page, a page with nothing is quiet, and switching it off scans nothing.
  const failed = await walk({ FAKE_AXE: "fail" }, { axe: true });
  assert.equal(failed.code, 0, failed.stdout + failed.stderr);
  assert.ok(failed.report.notices.includes("files@desktop: not observable: axe-core could not scan this page"));
  assert.equal(failed.report.axe.scanned, 0);
  const clean = await walk({ FAKE_AXE: "clean" }, { axe: true });
  assert.equal(clean.code, 0);
  assert.ok(!clean.report.notices.some((notice) => /axe-core: \d+ rule/.test(notice)));
  const off = await walk({ OPEN_SCIENCE_WALK_AXE: "off" });
  assert.deepEqual(off.report.info.filter((line) => line.startsWith("axe-core:")), ["axe-core: the scan is switched off (OPEN_SCIENCE_WALK_AXE=off)"]);
  assert.ok(!off.report.notices.some((notice) => notice.includes("axe-core is not available")));
  assert.equal(off.log.filter((entry) => entry.axe).length, 0);
  assert.deepEqual([off.report.axe.scanned, off.report.axe.from], [0, null]);
  assert.equal(off.report.pages["files@desktop"].axe, undefined);
});

test("with the chat asked for, the walk answers a start with the cleanup refusal itself, reads the cover and the alert after the wait, and starts nothing", async () => {
  const { code, stdout, stderr, log, report } = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS: "10" });
  assert.equal(code, 0, stdout + stderr);
  assert.match(report.steps["chat-cleanup-cover"].early.cover, /^正在清理上一次任务的运行环境/);
  assert.deepEqual(report.steps["chat-cleanup-cover"].late.alertButtons, ["重试", "查看已有成果"]);
  assert.deepEqual(log.filter((entry) => entry.start).slice(-1).map((entry) => entry.verdict), ["fulfilled"]);
  const quota = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_CLEANUP: "quota" });
  assert.equal(quota.code, 1);
  assert.ok(quota.report.failures.includes("chat@desktop: a start refused for cleanup offers 查看额度"));
  // Without the chat page, the walk does not open it and does not wait.
  assert.equal((await walk()).report.steps?.["chat-cleanup-cover"], undefined);
});

test("the memory page's project tab stacks one shape of section, and 记忆地图 is held to the data-page controls", () => {
  // Release 18's switch walk: the tab drew a quiet line, a table and a list as three shapes under a budget of two.
  const three = ["section>h2+p", "section>h2+div", "section>h2+ul"];
  assert.deepEqual(pageFindings("memory-project", "desktop", clean({ sectionShapes: three }), []).failures,
    [`memory-project@desktop: the page stacks 3 kinds of section (budget 2): ${three.join(", ")}`]);
  assert.deepEqual(pageFindings("memory-project", "desktop", clean({ sectionShapes: ["section>h2+div"] }), []), { failures: [], notices: [] });
  // The same switch counted eleven kinds of control on the map under the reading page's eight; the data-page budget is ten, and
  // the page measures nine now that its sentence's count and its replay button are chips.
  assert.equal(budgetKey("memory-map"), "memory-map");
  assert.equal(BUDGET_BY_PAGE["memory-map"].controls, 10);
  assert.deepEqual(pageFindings("memory-map", "desktop", clean({ controlKinds: 9, colorKinds: 6 }), []).failures, []);
  assert.deepEqual(pageFindings("memory-map", "desktop", clean({ controlKinds: 11 }), []).failures, ["memory-map@desktop: 11 kinds of control (budget 10)"]);
  assert.deepEqual(pageFindings("memory-tab-other", "desktop", clean({ controlKinds: 9 }), []).failures, ["memory-tab-other@desktop: 9 kinds of control (budget 8)"], "a reading page keeps its eight");
});

test("记忆地图 is a data page: three kinds of section, and its first mark and drawer are checked", () => {
  assert.equal(SECTION_SHAPES_BY_PAGE["memory-map"], 3);
  assert.ok(ROW_CLICK_PAGES.has("memory-map"), "a mark that opens nothing fails the page");
  assert.ok(ROUTES.some(([name, route]) => name === "memory-map" && route === "/app/memory/map"));
  assert.ok(ROUTES.some(([name, route]) => name === "memory" && route === "/app/memory?tab=self"), "the row-list probe names the list tab rather than the map landing");
  assert.deepEqual(PAGE_PROBES["memory-map"], [["memoryMap", ["desktop", "phone"]]]);
  // The sentence, the canvas and the list are three shapes; a fourth is one too many.
  const sentence = ["section>p+div", "canvas>", "ul>li"];
  assert.deepEqual(pageFindings("memory-map", "desktop", clean({ sectionShapes: sentence }), []), { failures: [], notices: [] });
  const stacked = pageFindings("memory-map", "desktop", clean({ sectionShapes: [...sentence, "table>thead+tbody"] }), []);
  assert.match(stacked.failures[0], /memory-map@desktop: the page stacks 4 kinds of section \(budget 3\)/u);
  // A mark pressed that shows nothing is a failure; an account with no mark is "not observable", never a pass.
  assert.deepEqual(rowClickVerdict("memory-map", [{ label: "标记", shown: false }]).failures, ["memory-map@desktop: clicking the first row of the list “标记” showed nothing — no drawer, no page, no opened row"]);
  assert.deepEqual(rowClickVerdict("memory-map", [{ label: "标记", shown: true }]), { failures: [], notices: [] });
});

test("记忆地图's probe judges the view switch, the names of its figures and the list under the graph", () => {
  const one = (name, viewport, kind, result) => probeFindings(name, viewport, kind, result);
  const read = (over = {}) => ({ views: [...MEMORY_MAP_VIEWS], figures: [{ kind: "relations", named: true }], lists: [{ label: "标记", rows: 12 }], thin: false, empty: false, ...over });
  assert.deepEqual(one("memory-map", "desktop", "memoryMap", read()), { failures: [], notices: [] });
  assert.deepEqual(one("memory-map", "desktop", "memoryMap", read({ views: ["关系", "主题"] })).failures, ["memory-map@desktop: the view switch reads “关系、主题” (关系、主题、维度、时间、活跃)"]);
  assert.deepEqual(one("memory-map", "phone", "memoryMap", read({ figures: [{ kind: "relations", named: false }] })).failures, ["memory-map@phone: the relations figure has no accessible name"]);
  assert.deepEqual(one("memory-map", "desktop", "memoryMap", read({ lists: [] })).failures, ["memory-map@desktop: the graph has no list of the same marks under it"]);
  assert.deepEqual(one("memory-map", "desktop", "memoryMap", read({ thin: true })).failures, ["memory-map@desktop: the page says there is too little to draw and draws the graph"]);
  assert.deepEqual(one("memory-map", "desktop", "memoryMap", read({ figures: [], thin: true, lists: [{ label: "标记", rows: 3 }] })).failures, []);
  assert.deepEqual(one("memory-map", "desktop", "memoryMap", read({ figures: [], empty: true, lists: [] })).failures, []);
});

test("记忆地图's drawer is read open and in the address, then closed and gone from it", () => {
  const was = (dialog, address) => ({ dialog, address });
  assert.deepEqual(memoryMapFindings("memory-map", { rows: 5, opened: was(true, true), closed: was(false, false) }), { failures: [], notices: [] });
  assert.deepEqual(memoryMapFindings("memory-map", { rows: 5, opened: was(false, false), closed: null }).failures,
    ["memory-map@desktop: pressing the first mark opened no drawer", "memory-map@desktop: the open drawer is not in the address (a reload or Back would lose it)"]);
  assert.deepEqual(memoryMapFindings("memory-map", { rows: 5, opened: was(true, true), closed: was(true, true) }).failures,
    ["memory-map@desktop: the drawer did not close", "memory-map@desktop: the drawer closed and its mark is still in the address"]);
  assert.deepEqual(memoryMapFindings("memory-map", { rows: 5, opened: was(true, true), closed: null }).failures, ["memory-map@desktop: the drawer has no 关闭 button to press"]);
  const none = memoryMapFindings("memory-map", { rows: 0, opened: null, closed: null });
  assert.deepEqual(none.failures, []);
  assert.match(none.notices[0], /not observable/u, "an account with no mark proves nothing");
});

test("the knowledge graph's first mark opens a knowledge page with no engine address in it, and Back brings the graph again", () => {
  const read = (opened, closed) => ({ rows: 4, opened, closed });
  const page = { reader: true, address: true, engineAddress: false, title: true };
  const back = { graph: true, address: true };
  assert.deepEqual(knowledgeGraphFindings("knowledge-graph", read(page, back)), { failures: [], notices: [] });
  assert.deepEqual(knowledgeGraphFindings("knowledge-graph", read({ ...page, address: false, reader: false }, back)).failures,
    ["knowledge-graph@desktop: pressing the first mark did not go to a document's page", "knowledge-graph@desktop: the page the first mark opened shows no knowledge page"]);
  assert.deepEqual(knowledgeGraphFindings("knowledge-graph", read({ ...page, engineAddress: true }, back)).failures,
    ["knowledge-graph@desktop: the page the first mark opened shows a viking:// address"]);
  assert.deepEqual(knowledgeGraphFindings("knowledge-graph", read(page, { graph: false, address: false })).failures,
    ["knowledge-graph@desktop: Back did not return to the graph's address", "knowledge-graph@desktop: Back returned and the graph is not drawn"]);
  assert.deepEqual(knowledgeGraphFindings("knowledge-graph", read(page, null)).failures, ["knowledge-graph@desktop: there was no way back to the graph to read"]);
  const none = knowledgeGraphFindings("knowledge-graph", { rows: 0, opened: null, closed: null });
  assert.deepEqual(none.failures, []);
  assert.match(none.notices[0], /not observable/u, "a project with no compiled pages proves nothing");
});

test("the knowledge base's tabs are read by their names, whatever they count", () => {
  // 资料 holds twelve documents and 知识页 sixty-six pages on a project that has them (PAGESA's data-rich fixture); the switch is still 资料 · 知识页 · 图谱.
  const tabs = (labels) => [node("div", { attrs: { role: "tablist" } }, labels.map(([name, count]) => node("button", { attrs: { role: "tab" }, text: `${name}${count ?? ""}` })))];
  assert.deepEqual(read(tabs([["资料", 12], ["知识页", 66], ["图谱"]]), "knowledgeGraph").views, ["资料", "知识页", "图谱"]);
  assert.deepEqual(read(tabs([["资料"], ["知识页"], ["图谱"]]), "knowledgeGraph").views, ["资料", "知识页", "图谱"]);
  assert.deepEqual(read(tabs([["资料", "1,204"], ["知识页", 7], ["图谱"]]), "knowledgeGraph").views, ["资料", "知识页", "图谱"]);
});

test("the knowledge graph's figure has a name, a legend and the same marks as a list, the three tabs of the knowledge base are one tab list, and no engine address is on the page", () => {
  const ok = { figures: [{ kind: "knowledge-kg", named: true }], lists: [{ label: "实体", rows: 12 }], legend: true, views: [...KNOWLEDGE_VIEWS], engineAddress: false, empty: false };
  assert.deepEqual(probeFindings("knowledge-graph", "desktop", "knowledgeGraph", ok), { failures: [], notices: [] });
  const broken = probeFindings("knowledge-graph", "phone", "knowledgeGraph", { ...ok, figures: [{ kind: "knowledge-kg", named: false }], lists: [], legend: false, views: ["图谱"], engineAddress: true });
  assert.deepEqual(broken.failures, [
    "knowledge-graph@phone: the knowledge-kg figure has no accessible name",
    "knowledge-graph@phone: the graph has no legend saying what its shapes and colours are",
    "knowledge-graph@phone: the graph has no list of the same marks under it",
    "knowledge-graph@phone: a viking:// address is on the page",
    "knowledge-graph@phone: the view switch reads “图谱” (资料、知识页、图谱)",
  ]);
  // A thin graph draws no figure and needs no legend.
  assert.deepEqual(probeFindings("knowledge-graph", "desktop", "knowledgeGraph", { ...ok, figures: [], legend: false }), { failures: [], notices: [] });
});

test("the walk presses the knowledge graph's first mark and comes back, and says so when there is none to press", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  assert.ok(log.some((entry) => /^\/app\/files\/src_a{32}$/.test(entry.knowledgeMark ?? "")), "the first mark was pressed");
  assert.deepEqual(report.steps["knowledge-graph-mark"].closed, { graph: true, address: true });
  assert.ok(ROUTES.some(([name, route]) => name === "knowledge-graph" && route === "/app/files?kind=wiki&view=graph"));
  assert.deepEqual(PAGE_PROBES["knowledge-graph"], [["knowledgeGraph", ["desktop", "phone"]]]);
  assert.ok(Number.isInteger(SECTION_SHAPES_BY_PAGE["knowledge-graph"]) && ROW_CLICK_PAGES.has("knowledge-graph"));
  const none = await walk({ FAKE_ROWS: "none" });
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.match(none.report.notices.find((notice) => notice.startsWith("knowledge-graph@desktop: not observable")) ?? "", /not observable/u);
});


test("frontier readers are discovered only from the account's published items", () => {
  assert.equal(frontierItemRoute({ items: [{ id: "article/a" }] }), "/app/frontier/items/article%2Fa");
  assert.equal(frontierItemRoute({ items: [] }), null);
  assert.equal(frontierItemRoute(null), null);
});


test("explicit empty self remains self while a separate populated methods route supplies real row coverage", () => {
  const tabs = [{ name: "关于你", count: 0, selected: true }, { name: "项目", count: 0, selected: false }, { name: "做法", count: 24, selected: false }];
  assert.deepEqual(probeFindings("memory", "desktop", "memoryTabs", { tabs }).failures, []);
  assert.deepEqual(memoryRowCoverage(tabs, "还没有关于你的记忆"), { explicitEmpty: "self", emptyTitle: "还没有关于你的记忆", rowTab: "methods", route: "/app/memory?tab=methods" });
  assert.equal(memoryRowCoverage(tabs, "读取失败"), null);
  assert.equal(memoryRowCoverage(tabs.map((t) => ({ ...t, count: 0 })), "还没有关于你的记忆"), null);
  assert.equal(probeFindings("memory-landing", "desktop", "memoryTabs", { tabs }).failures.length, 1);
});

test("scheduled pending daily preserves today's truth and separately names a real published archive day", () => {
  const archive = { publication: { day: "2026-10-20", state: "pending" }, schedule: { time: "07:30", timeZone: "Asia/Shanghai" }, dailies: [{ day: "2026-10-19", itemCount: 14, generatedAt: "2026-10-18T23:30:57.759Z" }] };
  const title = "10月20日 周二的日报尚未发布，每天 07:30（北京时间）发布。";
  assert.deepEqual(dailyRowCoverage(title, archive), { publicationDay: "2026-10-20", publicationState: "pending", schedule: archive.schedule, publishedDay: "2026-10-19", route: "/app/frontier?view=daily&day=2026-10-19" });
  assert.throws(() => dailyRowCoverage(title, { ...archive, publication: { ...archive.publication, state: "failed" } }), /daily_pending_identity_missing/);
  assert.throws(() => dailyRowCoverage("今日日报尚未发布", archive), /daily_pending_ui_mismatch/);
  assert.throws(() => dailyRowCoverage(title, { ...archive, dailies: [] }), /daily_published_archive_missing/);
  assert.throws(() => dailyRowCoverage(title, { ...archive, dailies: [{ ...archive.dailies[0], itemCount: 0 }] }), /daily_published_archive_missing/);
});

test("a rendered load error retries exactly once only for this view's observed network change", async () => {
  const failed = { failed: true, message: "研究暂时无法读取。重试" }, ready = { failed: false, message: null };
  let states, visits;
  const page = { evaluate: async () => states.shift(), goto: async (url) => { visits.push(url); }, waitForFunction: async () => {}, waitForTimeout: async () => {} };
  states = [failed, ready]; visits = [];
  const recovered = await recoverWalkLoad(page, "https://example.org/app/virtual-research/a/comparator", ["net::ERR_NETWORK_CHANGED"], []);
  assert.equal(recovered.loaded, true); assert.equal(recovered.retried, true); assert.deepEqual(recovered.initial, failed); assert.equal(visits.length, 1);
  states = [failed, failed]; visits = [];
  const persistent = await recoverWalkLoad(page, "https://example.org/app/vcr", ["net::ERR_NETWORK_CHANGED"], []);
  assert.equal(persistent.loaded, false); assert.equal(visits.length, 1);
  for (const [errors, http, prior] of [[[], [], false], [["net::ERR_FAILED"], [], false], [["net::ERR_NETWORK_CHANGED"], ["500 /api/vcr/studies/a"], false], [["net::ERR_NETWORK_CHANGED"], [], true]]) {
    states = [failed]; visits = [];
    const result = await recoverWalkLoad(page, "https://example.org/app/vcr", errors, http, prior);
    assert.equal(result.loaded, false); assert.equal(result.retried, false); assert.equal(visits.length, 0);
  }
});


test("captured comparator network failure is retried once and an unrecovered view never invents chrome or family defects", async () => {
  const recovered = await walk({ OPEN_SCIENCE_WALK_ONLY: "vcr-comparator", FAKE_ROUTE_LOAD: "recover" });
  const view = "vcr-comparator@2@phone";
  assert.equal(recovered.report.pages[view].routeLoad.retried, true);
  assert.equal(recovered.report.pages[view].routeLoad.loaded, true);
  assert.equal(recovered.report.pages[view].routeLoad.initial.message, "研究暂时无法读取。重试");
  const failed = await walk({ OPEN_SCIENCE_WALK_ONLY: "vcr-comparator", FAKE_ROUTE_LOAD: "persistent" });
  assert.equal(failed.report.pages[view].routeLoad.loaded, false);
  assert.equal(failed.report.pages[view].composition, undefined);
  assert.ok(failed.report.failures.some((entry) => entry.includes(view + ": route load failed")));
  assert.ok(!failed.report.findings.some((entry) => entry.view === view && ["chrome", "step-rail", "module-steps"].includes(entry.rule)));
});


test("rendered load probe distinguishes the actual retry alert from honest empty or hidden states", () => {
  const alert = node("div", { attrs: { role: "alert" } }, [node("span", { text: "研究暂时无法读取。" }), node("button", { text: "重试" })]);
  const result = inPage(page(alert), routeLoadProbe);
  assert.equal(result.failed, true); assert.match(result.message, /研究暂时无法读取/);
  assert.equal(inPage(page(node("div", { attrs: { "data-empty": "" }, text: "日报尚未发布" })), routeLoadProbe).failed, false);
  assert.equal(inPage(page(node("div", { attrs: { role: "alert" }, style: { display: "none" } }, [node("button", { text: "重试" })])), routeLoadProbe).failed, false);
});

test("a retry navigation failure retains the original error and remains a failed read", async () => {
  const initial = { failed: true, message: "研究暂时无法读取。重试" };
  const page = { evaluate: async () => initial, goto: async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); } };
  const result = await recoverWalkLoad(page, "https://example.org/app/vcr", ["net::ERR_NETWORK_CHANGED"], []);
  assert.equal(result.loaded, false); assert.equal(result.retried, true); assert.deepEqual(result.initial, initial); assert.match(result.retryError, /ERR_CONNECTION_REFUSED/);
});
