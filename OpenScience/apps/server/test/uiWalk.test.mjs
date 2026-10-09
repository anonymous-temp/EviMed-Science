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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AFTER_CLICK_KIND, afterClickFindings, afterClickProbe, BACK_OFFICE, BUDGET_BY_PAGE, budgetKey, cleanupFindings, cleanupNotices, clickNamed, clickRowTitled,
  EXPECTED_REFUSALS, focusProbe, frontierTargets, GEO_TABS, geoAnswerSnapshot, HEADING_ORDER_PAGES, keylessTitles, knowledgeProbe, knowledgeReturnFindings,
  leftEdgeNotices, matrixFindings, matrixProbe, matrixRoute, measure, measureStructure, MISSING_RECORDS, NOTICE_ROW_CLICK_PAGES, ORIGINAL_MIN_WIDTH,
  pageFindings, pageProbe, PAGE_PROBES, pdfFrameReady, pdfPreviewFindings, pdfProbe, pdfSourceTitle, pickVcrStudies, probeFindings, PROVISIONAL_PAGES,
  readerFindings, readerProbe, readerReady, RETIRED_NAMES, ROUTES, ROW_CLICK_PAGES, ROW_LINK_BY_PAGE, ROW_REVEAL_BY_PAGE, rowClickFindings, rowClickShown,
  rowClickVerdict, rowProbe, sameBox, SECTION_SHAPES_BY_PAGE, skillDrawerFindings, skillDrawerProbe, sourceReaderRoute, structureFindings, tabOrderFindings,
  addressAct, ADDRESS_CASES, addressOpenFindings, addressProbe, addressStateFindings, addressStateHolds, composerFindings, composerProbe, COMPOSER_BOTTOM_PX,
  handoffFindings, handoffProbe, HANDOFF_FIELDS, NOTICE_SECTION_PAGES, taskPageFindings, taskPaneReady, TYPE_PAIR_NOTICE, unexpectedRefusals, VCR_TABS_WALK,
} from "../../../scripts/ops/ui-walk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The pages the walk finds by an id in a list the deployment answers, so that no static route names them. */
const DISCOVERED_PAGES = ["geo-answer", "frontier-zone", "frontier-evidence", "frontier-author", "frontier-event", "evidence-matrix", "files-reader"];

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

test("the evidence zones' home may draw the four kinds of border it was measured at, the daily nine controls — and no more", () => {
  const zones = (overrides) => pageFindings("frontier-zones", "desktop", clean({ controlKinds: 8, colorKinds: 5, ...overrides }), []).failures;
  assert.deepEqual(zones({ borderKinds: 4 }), []);
  assert.deepEqual(zones({ borderKinds: 5 }), ["frontier-zones@desktop: 5 kinds of border (budget 4)"]);
  // The feed's own pages keep the reading page's three.
  assert.deepEqual(pageFindings("frontier", "desktop", clean({ controlKinds: 8, borderKinds: 4 }), []).failures, ["frontier@desktop: 4 kinds of border (budget 3)"]);
  const daily = (controlKinds) => pageFindings("frontier-daily", "desktop", clean({ controlKinds }), []).failures;
  assert.deepEqual(daily(9), []);
  assert.deepEqual(daily(10), ["frontier-daily@desktop: 10 kinds of control (budget 9)"]);
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
  assert.equal(keys.length, 7, `read the app's GEO tabs (${keys.join(", ")})`);
  assert.deepEqual(GEO_TABS.map(([, segment]) => segment), keys.map((key) => (key === "overview" ? "" : `/${key}`)));
  for (const [name] of GEO_TABS) assert.ok(BUDGET_BY_PAGE[name], `${name} has the GEO budget`);
});

test("a GEO tab may spend the six kinds of border it was measured at, not a seventh", () => {
  assert.deepEqual(pageFindings("geo-overview", "desktop", clean({ borderKinds: 6 }), []).failures, []);
  assert.deepEqual(pageFindings("geo-overview", "desktop", clean({ borderKinds: 7 }), []).failures, ["geo-overview@desktop: 7 kinds of border (budget 6)"]);
  // The knowledge base is a data page but not a GEO page: its borders stay three.
  assert.equal(pageFindings("files", "desktop", clean({ borderKinds: 4 }), []).failures.length, 1);
});

test("more than four font-size × weight pairs is a notice, never a failure", () => {
  const pairs = ["12px/400", "13px/400", "14px/400", "14px/500", "24px/600"];
  const verdict = pageFindings("memory", "desktop", clean({ sizeWeightPairs: pairs }), []);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.notices.length, 1);
  assert.match(verdict.notices[0], new RegExp(`memory@desktop: 5 font-size × weight pairs \\(rule ${TYPE_PAIR_NOTICE}\\)`));
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
  assert.equal(caught("解读 · 综合 · 引文已核对 1/2 · AI 已评议"), false);
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
  const card = (height) => ({ tag: "button", text: "用“工具”开始一次对话", height, icon: true, declaredMinHeight: "128px", style: { borderTopLeftRadius: "12px" } });
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
  });
  assert.equal(descendants(open).find((el) => el.text === "第一行").clicks, 1);
  assert.equal(descendants(open).find((el) => el.text === "第二行").clicks, 0);
  // A list that holds another list finds the inner list's first row as its own: one row, one target. 问题与回答's groups hold their questions.
  const nested = page(header(), node("ul", {}, [node("li", { attrs: { "data-geo-group": "g1" } }, [
    node("button", { attrs: { "aria-expanded": "true" }, text: "第一组" }),
    node("ul", { attrs: { "aria-label": "测量问句" } }, [node("li", {}, [node("a", { attrs: { "data-row-title": "", href: "/answers/1" }, text: "一个问句" })])]),
  ])]));
  inPage(nested, () => assert.deepEqual(rowProbe(["targets"]), ["一个问句"]));
  // The groups of 问题与回答 are closed until their toggle is pressed; the probe presses the ones it is told to, at most `limit`, and says how many.
  const groups = page(header(), node("ul", {}, [1, 2, 3].map((n) => node("li", { attrs: { "data-geo-group": `g${n}` } }, [node("button", { attrs: { "aria-expanded": n === 3 ? "true" : "false" }, text: `组${n}` })]))));
  const toggle = ROW_REVEAL_BY_PAGE["geo-questions"];
  // The fake DOM's selector engine knows tags, attributes and descendants, which is all this selector is.
  assert.equal(inPage(groups, () => rowProbe(["reveal", 0, { selector: "[data-geo-group] button[aria-expanded='false']", limit: 1 }])), 1);
  assert.equal(inPage(groups, () => rowProbe(["reveal", 0, { selector: "[data-geo-group] button[aria-expanded='false']", limit: 12 }])), 2);
  assert.equal(inPage(groups, () => rowProbe(["reveal", 0, { selector: "", limit: 12 }])), 0);
  assert.equal(inPage(groups, () => rowProbe(["reveal", 0, null])), 0);
  assert.equal(toggle, "[data-geo-group] button[aria-expanded='false']");
  // The card page: a link the page names is the first row when no list has one, and the second target when one has.
  const cards = page(header(), node("div", { attrs: { "data-geo-error-list": "" } }, [node("article", {}, [node("a", { attrs: { href: "/app/geo/g/answers/s1" }, text: "看回答" })])]));
  inPage(cards, () => {
    assert.deepEqual(rowProbe(["targets"]), []);
    assert.deepEqual(rowProbe(["targets", 0, ROW_LINK_BY_PAGE["geo-accuracy"]]), ["讲错清单"]);
    assert.deepEqual(rowProbe(["external", 0, ROW_LINK_BY_PAGE["geo-accuracy"]]), false);
    assert.equal(rowProbe(["click", 0, ROW_LINK_BY_PAGE["geo-accuracy"]]), true);
  });
  assert.equal(descendants(cards).find((el) => el.text === "看回答").clicks, 1);
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

test("a page's first-row clicks come to failures on the pages clicked before R13 and to notices on the ones new in it; a page with nothing to click says so", () => {
  const rows = [{ label: "资料", shown: true }, { label: "笔记", shown: false }];
  const nothing = (name, label) => `${name}@desktop: clicking the first row of the list “${label}” showed nothing — no drawer, no page, no opened row`;
  assert.deepEqual(rowClickVerdict("files", rows), { failures: [nothing("files", "笔记")], notices: [] });
  assert.deepEqual(rowClickVerdict("inbox", rows), { failures: [], notices: [nothing("inbox", "笔记")] });
  assert.deepEqual(rowClickVerdict("geo-questions", [{ label: "测量问句", shown: true }]), { failures: [], notices: [] });
  const empty = (name) => `${name}@desktop: not observable: no list on the page has a first row that opens (an empty list, a page without rows, or an account with none), so no click was made`;
  assert.deepEqual(rowClickVerdict("memory-growth", []), { failures: [], notices: [empty("memory-growth")] });
  assert.deepEqual(rowClickVerdict("geo-accuracy", []), { failures: [], notices: [empty("geo-accuracy")] });
  // A click that shows nothing is the same notice whichever way a page is spelled.
  assert.deepEqual(rowClickVerdict("geo-sources", rows).failures, [nothing("geo-sources", "笔记")]);
  for (const name of NOTICE_ROW_CLICK_PAGES) assert.ok(ROW_CLICK_PAGES.has(name), `${name} is clicked`);
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
    case "geoRail": return wrong ? { folded: 0, closed: false, steps: 8 } : { folded: 1, closed: true, steps: 0 };
    case "geoMarketOff": return wrong ? { present: true, top: 4000, viewport: 945 } : { present: true, top: 300, viewport: 945 };
    case "followingEmpty": return wrong ? { adds: 1, chips: 3, noResults: true } : { adds: 1, chips: 0, noResults: false };
    case "eventGroups": return wrong ? { primary: false, other: false, none: false } : { primary: true, other: true, none: false };
    case "firstRowTop": return { top: wrong ? 620 : 276 };
    case "rowWidth": return wrong ? { widths: [96], min: 96 } : { widths: [300], min: 300 };
    case "capabilityCards": return wrong ? { hits: ["可运行"], wraps: 2 } : { hits: [], wraps: 0 };
    case "memoryTabs": {
      const names = { project: "项目", methods: "做法", growth: "成长" };
      const selected = wrong ? "关于你" : names[tab] || "项目";
      return { tabs: [["关于你", 0], ["项目", 2], ["做法", 3], ["成长", 0]].map(([name, count]) => ({ name, count, selected: name === selected })), headline: { memories: 5, practices: wrong ? 9 : 3 } };
    }
    case "sharedMissing": return wrong ? { title: true, back: true, retry: true } : { title: true, back: true, retry: false };
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
    const pageRoutes = [];
    let phone = false;
    // The page one sidebar link left, for Back; and how often each list page's address was read (the walk reads it in a fixed order).
    let previousUrl = null;
    const addressCalls = {};
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
      on(event, handler) { if (event === "requestfailed") failed.push(handler); }, off() {},
      async setViewportSize(size) { phone = size.width < 600; }, async close() {}, async screenshot() {}, async waitForTimeout() {},
      async goBack() { log({ goBack: true }); if (previousUrl) { url = previousUrl; previousUrl = null; } },
      async route(pattern, handler) { pageRoutes.push([pattern, handler]); log({ route: String(pattern) }); },
      async unroute() { pageRoutes.length = 0; log({ unroute: true }); },
      async waitForFunction() {
        if (process.env.FAKE_SLOW_ROUTE === "never" && new URL(url).pathname === "/app/account") throw Error("route still loading after 30000ms");
        if (process.env.FAKE_NO_MATRIX && url.endsWith("clinical-evidence-matrix.json")) throw Error("no matrix");
        routeSettled = true;
      },
      frames: () => [{
        url: () => "https://evimed.example.org/__evimed/f/x",
        evaluate: async (fn, arg) => {
          if (typeof fn === "function" && fn.name === "composerProbe") return composerRead(Boolean(arg && arg[0] && arg[0].operator), phone);
          return { composer: !chatFailing(), stats: [] };
        },
      }],
      getByRole: (role, { name }) => locator(role, name),
      async goto(target, options) {
        url = target; routeSettled = false; dialogOpen = false; log({ goto: target });
        const start = new URL("/api/commands/start_runtime", target).href;
        // A page's own route answers before the context's: the walk's cleanup cover answers the start itself.
        const own = pageRoutes.find(([pattern]) => typeof pattern.test === "function" && pattern.test(start));
        if (own) { log({ start, verdict: "fulfilled" }); await own[1]({ fulfill: async () => {} }); }
        else await fire(start);
        if (chatMode && target.endsWith("/app/chat")) for (const handler of failed) handler({ failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }) });
      },
      async evaluate(fn, arg) {
        if (url.endsWith("/app/chat") && typeof fn === "function" && String(fn).includes("document.body.innerText")) return chatFailing() ? "打开超时，请重试\n重试" : "";
        // FAKE_ROWS=dead: a row that does nothing when clicked; FAKE_ROWS=two: two lists on every page, so the walk loads the page again between clicks.
        if (typeof fn === "function" && fn.name === "rowProbe") {
          const [action] = arg;
          if (action === "reveal") { log({ reveal: new URL(url).pathname, option: arg[2] }); return 2; }
          if (action === "targets") {
            if (arg[2]) log({ link: new URL(url).pathname, option: arg[2] });
            // FAKE_ROWS=none: a page with no row to click, as an account with no data draws.
            return process.env.FAKE_ROWS === "none" ? [] : process.env.FAKE_ROWS === "two" ? ["第一张清单", "第二张清单"] : ["资料清单"];
          }
          if (action === "state") return { dialog: dialogOpen, path: new URL(url).pathname, expanded: 0 };
          // FAKE_ROWS=external: the row's title is a link to an outside address; the browser reports no popup, and the row is not silent.
          if (action === "external") return process.env.FAKE_ROWS === "external";
          dialogOpen = process.env.FAKE_ROWS !== "dead" && process.env.FAKE_ROWS !== "external";
          log({ rowClick: new URL(url).pathname, index: arg[1] });
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
          if (name === "保存" && process.env.FAKE_SKILL_WRITE) for (const [, handler] of pageRoutes) handler({ request: () => ({ method: () => "POST", url: () => "https://evimed.example.org/api/personal-skills" }), abort: async () => log({ aborted: "POST" }), continue: async () => {}, fallback: async () => {} });
          if (name === "回到插件列表") url = new URL("/app/extensions/plugins", url).href;
          if (name === "回到技能列表") url = new URL(process.env.FAKE_BACK === "stay" ? "/app/extensions/skills/impeccable-audit-missing" : "/app/extensions/skills", url).href;
          return true;
        }
        if (typeof fn === "function" && fn.name === "clickRowTitled") return true;
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
          if (kind === "inbox") return { path: "/app/inbox", search: lost ? "" : "?filter=unread", dialog: false, found: true, pressed: lost ? "全部" : "未读 3" };
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
          return { cover: "正在清理上一次任务的运行环境，完成后自动继续", quotaButtons: bad ? ["查看科研额度"] : [], alertButtons: cleanupProbes > 1 ? ["重试", "查看已有成果"] : null };
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
    newPage,
    request: {
      async post(url) { if (url.endsWith("/api/auth/login")) { loggedIn = true; return json(200, {}); } loggedIn = false; return json(200, {}); },
      async get(url) {
        // FAKE_EMPTY_LISTS: the lists the walk reads its ids from answer nothing, as a module that is off for the account does.
        if (process.env.FAKE_EMPTY_LISTS && /\/api\/(vcr|frontier|agent-runs|sources|connectors)|\/diagnosis$/.test(url)) return json(404, {});
        if (url.endsWith("/api/agents")) return json(200, { data: ["a1", "a2", "a3", "a4", "a5"].map((id) => ({ id: "capability-" + id })) });
        if (url.endsWith("/api/geo/projects")) return json(200, { data: { projects: [{ id: "geo_1" }] } });
        if (url.endsWith("/api/geo/projects/geo_1/diagnosis")) return json(200, { data: { errors: [{ snapshotId: "snap_old", firstSnapshotId: "snap_1" }] } });
        if (url.endsWith("/api/vcr/studies")) return json(200, { data: { studies: [{ id: "std_a", steps: {} }, { id: "std_b", steps: { population: { status: "done" }, trial: { status: "minimal" } } }, { id: "std_c", steps: { population: { status: "done" } } }] } });
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

async function walk(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-walk-"));
  await mkdir(path.join(dir, "playwright-core"));
  await writeFile(path.join(dir, "playwright-core", "index.js"), FAKE_PLAYWRIGHT);
  await writeFile(path.join(dir, "password"), "not-a-real-password\n");
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
        FAKE_PLAYWRIGHT_LOG: path.join(dir, "log.jsonl"),
        ...env,
      },
      timeout: 60_000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const log = (await readFile(path.join(dir, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const report = JSON.parse(await readFile(path.join(dir, "out", "report.json"), "utf8"));
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
  // All seven tabs of the account's first GEO project were walked.
  const visited = log.filter((entry) => entry.goto).map((entry) => new URL(entry.goto).pathname);
  for (const [, segment] of GEO_TABS) assert.ok(visited.includes(`/app/geo/geo_1${segment}`), `walked /app/geo/geo_1${segment}`);
  // The font pairs are a notice: printed, in the report, and the walk passed.
  assert.match(stdout, /NOTICE files@desktop: 5 font-size × weight pairs/);
  assert.ok(report.notices.length > 0);
  assert.deepEqual(report.failures, []);
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
  assert.ok(report.notices.some((notice) => /chat@desktop: loaded after one 重试/.test(notice)), report.notices.join("\n"));
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

test("a row that shows nothing when clicked fails the page it is on — except the pages whose click is new in R13, where it is a notice", async () => {
  const { code, report } = await walk({ FAKE_ROWS: "dead" });
  assert.equal(code, 1);
  const sentence = (name) => `${name}@desktop: clicking the first row of the list “资料清单” showed nothing — no drawer, no page, no opened row`;
  const failing = [...ROW_CLICK_PAGES].filter((name) => !NOTICE_ROW_CLICK_PAGES.has(name));
  for (const name of failing) assert.ok(report.failures.includes(sentence(name)), name);
  for (const name of NOTICE_ROW_CLICK_PAGES) {
    assert.ok(!report.failures.includes(sentence(name)), `${name} fails on a click that shows nothing; the click is new, so it is a notice`);
    assert.ok(report.notices.includes(sentence(name)), `${name} says so as a notice`);
  }
  assert.equal(report.failures.length, failing.length);
  // The pages R10 and R11 clicked keep failing; the R13 additions are exactly the ones the reference named.
  assert.deepEqual([...NOTICE_ROW_CLICK_PAGES].sort(), ["account", "frontier-zones", "geo", "geo-accuracy", "geo-questions", "inbox"]);
  for (const name of ["geo-sources", "autopilot", "files"]) assert.ok(failing.includes(name), name);
});

test("a row that is a link to an outside address is not a row that shows nothing, even when the browser reports no new tab", async () => {
  const { code, stdout, stderr, report } = await walk({ FAKE_ROWS: "external" });
  assert.equal(code, 0, stdout + stderr);
  assert.deepEqual(report.pages["frontier@desktop"].rowClicks, [{ label: "资料清单", shown: true }]);
});

test("with two lists on a page the walk loads the page again before the second click", async () => {
  const { code, stdout, stderr, log } = await walk({ FAKE_ROWS: "two" });
  assert.equal(code, 0, stdout + stderr);
  const events = log.filter((entry) => (entry.goto && entry.goto.endsWith("/app/files")) || entry.rowClick === "/app/files");
  // The page, the first click, the page again, the second click — then the knowledge base's PDF step and its way-back step each open the page
  // once more, and the phone's view is the last.
  assert.deepEqual(events.map((entry) => (entry.rowClick ? `click ${entry.index}` : "goto")), ["goto", "click 0", "goto", "click 1", "goto", "goto", "goto"]);
});

test("R13 first-row clicks: the closed groups of 问题与回答 are opened first, the cards of 准确与安全 are clicked on their link, the task page and the drawer are read", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  assert.deepEqual(ROW_REVEAL_BY_PAGE, { "geo-questions": "[data-geo-group] button[aria-expanded='false']" });
  assert.deepEqual(ROW_LINK_BY_PAGE, { "geo-accuracy": { label: "讲错清单", selector: "[data-geo-error-list] a[href*='/answers/']" } });
  // The groups are opened on 问题与回答 and nowhere else, with the walk's limit; the click comes after.
  assert.deepEqual(log.filter((entry) => entry.reveal).map((entry) => [entry.reveal, entry.option]),
    [["/app/geo/geo_1/questions", { selector: ROW_REVEAL_BY_PAGE["geo-questions"], limit: 12 }]]);
  const revealAt = log.findIndex((entry) => entry.reveal);
  assert.equal(log.findIndex((entry, index) => index > revealAt && entry.rowClick === "/app/geo/geo_1/questions"), revealAt + 1);
  // The accuracy page's link is passed to the probe; no other page is given one.
  assert.deepEqual(log.filter((entry) => entry.link).map((entry) => [entry.link, entry.option]), [["/app/geo/geo_1/accuracy", ROW_LINK_BY_PAGE["geo-accuracy"]]]);
  // Every R13 page was clicked, and what the first click opened was read where the page has a reading (the source's drawer, the task's page).
  for (const name of NOTICE_ROW_CLICK_PAGES) assert.deepEqual(report.pages[`${name}@desktop`].rowClicks, [{ label: "资料清单", shown: true }], name);
  assert.deepEqual(report.pages["geo-sources@desktop"].rowClicks[0].after, { dialog: true, drawers: 1 });
  assert.equal(report.pages["autopilot@desktop"].rowClicks[0].after.pane, "conversation");
  // The walk starts no runtime, so the task's frame container is compared and the notice says there was no iframe to compare.
  assert.ok(report.notices.includes("autopilot@desktop: not observable: the frame's container is placed over the pane, and holds no iframe (the walk starts no runtime), so only the container was compared"), report.notices.join("\n"));
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
  assert.ok(writes.report.notices.includes("inbox@desktop: clicking the first row tried 1 write(s), refused in the browser: POST /api/inbox/n1/read"), writes.report.notices.join("\n"));
  assert.ok(writes.log.some((entry) => entry.aborted === "POST") && writes.log.some((entry) => entry.fellBack === "GET") && writes.log.some((entry) => entry.fellBack === "start_runtime"));
  assert.ok(!writes.log.some((entry) => entry.aborted === "start_runtime" || entry.aborted === "GET"));
  // The pages clicked before R13 are not guarded: their clicks are what they always were.
  assert.ok(!writes.report.notices.some((notice) => /^(files|memory|frontier|geo-sources|autopilot)@desktop: clicking the first row tried/.test(notice)));
  // The guard is removed after every page it was put on.
  const routes = writes.log.filter((entry) => entry.route === "**/api/**").length;
  assert.equal(routes, [...NOTICE_ROW_CLICK_PAGES].length + 1, "one guard per R13 page, and the new-skill drawer's own");
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

test("a variant page is held to its page's budget, and a page no walk has measured reports a number past it as a notice", () => {
  assert.equal(budgetKey("vcr-trial@2"), "vcr-trial");
  assert.equal(budgetKey("vcr-trial"), "vcr-trial");
  // The second study is the same page: the same numbers fail it.
  assert.equal(pageFindings("vcr-trial@2", "desktop", clean({ controlKinds: 11, sectionShapes: ["a", "b", "c"] }), []).failures.length, 1);
  // A page of the provisional list: the budget breach is a notice that says so, and what is not a number still fails.
  const provisional = pageFindings("frontier-zone", "desktop", clean({ controlKinds: 12, borderKinds: 5, pageLefts: [240, 300] }), []);
  assert.deepEqual(provisional.failures, []);
  assert.equal(provisional.notices.filter((notice) => notice.endsWith("provisional: this page has not been measured by a walk yet")).length, 3);
  assert.deepEqual(pageFindings("frontier-zone", "desktop", clean({ leakHits: ["undefined"], retiredNameHits: ["循证传播"] }), []).failures.length, 2); // retired-word-ok
  assert.deepEqual(pageFindings("frontier-zone", "phone", clean({ overflowX: true }), []).failures, ["frontier-zone@phone: the page overflows horizontally at 390 px"]);
  for (const name of PROVISIONAL_PAGES) assert.ok(walkedNames().has(name), `${name} is on the provisional list and no route walks it`);
});

/** Every name the walk reports a page under, static or found. */
function walkedNames() {
  return new Set([...ROUTES.map(([name]) => name), ...GEO_TABS.map(([name]) => name), ...VCR_TABS_WALK.map(([name]) => name), ...DISCOVERED_PAGES]);
}

test("the refusals a page is walked to meet are not failures, and any other refusal still is", () => {
  assert.deepEqual(Object.keys(EXPECTED_REFUSALS).sort(), ["extensions-skill-missing", "frontier-daily-empty", "memory-shared-missing"]);
  // A day nobody published answers 404, and the page is walked to say so in words.
  assert.deepEqual(unexpectedRefusals("frontier-daily-empty", ["404 /api/frontier/dailies/2020-01-01", "500 /api/frontier/dailies"]), ["500 /api/frontier/dailies"]);
  assert.deepEqual(unexpectedRefusals("extensions-skill-missing", ["404 /api/skills/impeccable-audit-missing", "500 /api/skills"]), ["500 /api/skills"]);
  assert.deepEqual(unexpectedRefusals("memory-shared-missing", ["404 /api/capsules/shares/x", "410 /api/capsules/shares/x", "403 /api/capsules"]), ["403 /api/capsules"]);
  // A page with no expected refusal keeps all of them, and a refusal that is not the API's was never a refusal of the page.
  assert.deepEqual(unexpectedRefusals("memory", ["404 /api/memory"]), ["404 /api/memory"]);
  assert.deepEqual(pageFindings("extensions-skill-missing", "desktop", clean(), unexpectedRefusals("extensions-skill-missing", ["404 /api/skills/x"])).failures, []);
  assert.equal(pageFindings("extensions-skill-missing", "desktop", clean(), unexpectedRefusals("extensions-skill-missing", ["502 /api/skills/x"])).failures.length, 1);
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
  assert.deepEqual(elsewhere.notices, ["files@desktop: heading levels skip: h1→h3 “本周”"]);

  // Height and rows depend on the account's data: notices.
  const tall = findings("geo-answer", "phone", { height: 69000 });
  assert.deepEqual(tall.failures, []);
  assert.match(tall.notices[0], /^geo-answer@phone: the page is 69000 px tall, 73\.0 viewports \(notice above 12\)$/);
  assert.deepEqual(findings("geo-answer", "phone", { height: 11 * 945 }).notices, []);
  assert.match(findings("geo-sources", "desktop", { rows: 41 }).notices[0], /^geo-sources@desktop: 41 rows on the first screen of data \(notice above 40\)$/);
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

test("the page probes read what a fix left behind: the folded rail, the empty 关注, the memory tabs, the bell, the Feishu rows", () => {
  assert.deepEqual(read([node("div", { attrs: { "data-rail-folded": "" } }, [node("details", { open: false }, [node("ol", {}, [node("li", { attrs: { "data-rail-step": "evidence" }, w: 0, h: 0 })])])])], "geoRail"), { folded: 1, closed: true, steps: 0 });
  assert.deepEqual(read([node("div", { attrs: { "data-rail-folded": "" } }, [node("details", { open: true })])], "geoRail").closed, false);
  assert.deepEqual(read([node("p", { attrs: { "data-geo-market-off": "" }, text: "投放要等媒介集市接通" })], "geoMarketOff"), { present: true, top: 0, viewport: 945 });
  assert.deepEqual(read([node("p")], "geoMarketOff"), { present: false });

  assert.deepEqual(read([node("button", { text: "添加关注" }), node("a", { text: "浏览证据专区" })], "followingEmpty"), { adds: 1, chips: 0, noResults: false });
  assert.deepEqual(read([node("button", { text: "添加关注" }), node("button", { attrs: { "aria-pressed": "false" }, text: "药物" }), node("p", { text: "没有结果" })], "followingEmpty"), { adds: 1, chips: 1, noResults: true });
  assert.deepEqual(read([node("p", { text: "暂无一手材料，以下均为转述报道。" })], "eventGroups"), { primary: true, other: false, none: true });

  const tabs = [tab("关于你", 0, true), tab("项目", 5, false), tab("做法", 15, false), tab("成长", 0, false)];
  assert.deepEqual(read([...tabs, node("p", { text: "2026年9月29日开始记住你，现在有 79 条记忆，学会 6 种做法" })], "memoryTabs"), {
    tabs: [{ name: "关于你", count: 0, selected: true }, { name: "项目", count: 5, selected: false }, { name: "做法", count: 15, selected: false }, { name: "成长", count: 0, selected: false }],
    headline: { memories: 79, practices: 6 },
  });
  assert.equal(read(tabs, "memoryTabs").headline, null);

  assert.deepEqual(read([node("a", { text: "回到记忆胶囊" }), node("h2", { text: "x" })], "sharedMissing"), { title: false, back: true, retry: false });

  const bell = node("button", { attrs: { "aria-label": "收件箱，8 条未读，其中 3 条涉及临床安全" } });
  const bare = node("button", { attrs: { "aria-label": "收件箱，8 条未读" } });
  const inbox = (button, count) => inPage(node("body", {}, [node("aside", {}, [button]), node("main", {}, [node("h2", { text: `涉及临床安全 · 未读 ${count} 条` })])]), () => pageProbe(["inboxSafety"]));
  assert.deepEqual(inbox(bell, 3), { heading: 3, bell: 3 });
  assert.deepEqual(inbox(bare, 0), { heading: 0, bell: 0 });
  assert.deepEqual(read([node("h2", { text: "收件箱" })], "inboxSafety"), { heading: null, bell: null });

  assert.deepEqual(read([node("div", {}, [node("span", { text: "飞书" })]), node("p", { text: "飞书机器人已绑定" })], "feishuRows"), { rows: 1 });
  assert.deepEqual(read([node("div", {}, [node("div", {}, [node("div", { text: "Semantic Scholar" }), node("div", { text: "有了自己的密钥，访问更稳" })]), node("div", { text: "可选" })])], "connectorRows", ["Semantic Scholar", "PubMed"]), {
    rows: [{ title: "Semantic Scholar", found: true, optional: true, configured: false, missing: false }, { title: "PubMed", found: false, optional: false, configured: false, missing: false }],
  });
  assert.equal(read([node("div", {}, [node("div", { text: "运行状况" }), node("div", { text: "部署配置检查" }), node("p", { text: "openlist_storage_missing" })])], "opsOrder").health, 0);
  assert.deepEqual(read([node("p", { text: "运行状况 部署配置检查 openlist_storage_missing geo_market_unconfigured" })], "opsOrder").tokens, ["openlist_storage_missing", "geo_market_unconfigured"]);
  assert.deepEqual(read([node("p", { text: "页面不存在" })], "notFound"), { said: true });
  const missing = inPage(node("body", {}, [node("main", {}, [node("div", { attrs: { role: "dialog" } }, [node("p", { text: "找不到这个插件，它可能已被移除。" }), node("button", { text: "回到插件列表" })])])]), () => pageProbe(["missingRecord", ["找不到这个插件，它可能已被移除。", "回到插件列表"]]));
  assert.deepEqual(missing, { dialog: true, said: true, back: true, failedWord: false });
  const folds = read([node("details", { open: false }, [node("summary", { text: "编写与核查" })]), node("details", { open: true }, [node("summary", { text: "更新记录" })]), node("details", {}, [node("summary", { text: "别的折叠" })]), node("p", { text: "由 DeepSeek 起草" })], "readingFolds");
  assert.deepEqual(folds, { folds: [{ label: "编写与核查", open: false }, { label: "更新记录", open: true }], models: ["deepseek"] });
  assert.equal(read([], "unknown"), null);
});

test("a page probe is judged on what it exists to guard, and a probe that read nothing is not a finding", () => {
  const one = (name, viewport, kind, result) => probeFindings(name, viewport, kind, result);
  assert.deepEqual(one("geo-overview", "phone", "geoRail", null), { failures: [], notices: [] });
  assert.deepEqual(one("geo-overview", "phone", "geoRail", { folded: 1, closed: true, steps: 0 }).failures, []);
  assert.deepEqual(one("geo-overview", "phone", "geoRail", { folded: 0, closed: false, steps: 8 }).failures, [
    "geo-overview@phone: the progress rail is not folded into one line", "geo-overview@phone: 8 step(s) of the progress rail are on the first screen"]);
  assert.deepEqual(one("geo-overview", "phone", "geoRail", { folded: 1, closed: false, steps: 0 }).failures, ["geo-overview@phone: the folded progress rail is open at first sight"]);

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

  const tabs = (selected, counts) => ({ tabs: ["关于你", "项目", "做法", "成长"].map((name, index) => ({ name, count: counts[index], selected: name === selected })), headline: null });
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("项目", [0, 5, 15, 0])).failures, []);
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("关于你", [3, 5, 15, 0])).failures, []);
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("关于你", [0, 5, 15, 0])).failures, ["memory@desktop: the page opens on an empty 关于你 while 项目 holds 5 and 做法 15"]);
  assert.deepEqual(one("memory", "desktop", "memoryTabs", tabs("关于你", [0, 0, 0, 0])).failures, []);
  assert.deepEqual(one("memory-growth", "desktop", "memoryTabs", tabs("项目", [0, 5, 15, 0])).failures, ["memory-growth@desktop: the address names 成长 and the page opens on 项目"]);
  assert.deepEqual(one("memory-methods", "desktop", "memoryTabs", tabs("做法", [0, 5, 15, 0])).failures, []);
  assert.deepEqual(one("memory-growth", "desktop", "memoryTabs", { ...tabs("成长", [0, 5, 15, 0]), headline: { memories: 79, practices: 6 } }).failures, ["memory-growth@desktop: the growth line counts 6 做法 and the tab 15"]);
  assert.deepEqual(one("memory-growth", "desktop", "memoryTabs", { ...tabs("成长", [0, 5, 15, 0]), headline: { memories: 79, practices: 15 } }).failures, []);

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
  assert.deepEqual(one("account-ops", "desktop", "opsOrder", { health: 0, config: 80, tokens: [] }), { failures: [], notices: [] });
  assert.deepEqual(one("account-ops", "desktop", "opsOrder", { health: 120, config: 10, tokens: ["a_b"] }), {
    failures: ["account-ops@desktop: 部署配置检查 comes before 运行状况"], notices: ["account-ops@desktop: identifiers in the visible text: a_b"] });
  assert.deepEqual(one("account-ops", "desktop", "opsOrder", { health: -1, config: 10, tokens: [] }).failures, []);
  assert.deepEqual(one("account-simulated-refunds", "phone", "notFound", { said: false }).failures, ["account-simulated-refunds@phone: an address that is not a page does not say 页面不存在"]);
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
  assert.deepEqual(taskPageFindings("autopilot", good), { failures: [], notices: [] });

  // The walk starts no runtime: the container is over the pane and holds no iframe, and the notice says what was and was not compared.
  const bare = read(taskPage({ frame: false }));
  assert.equal(bare.frameBox, null);
  assert.deepEqual(taskPageFindings("autopilot", bare), { failures: [], notices: ["autopilot@desktop: not observable: the frame's container is placed over the pane, and holds no iframe (the walk starts no runtime), so only the container was compared"] });

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
  assert.deepEqual(taskPageFindings("autopilot", null), { failures: [], notices: [] });
  assert.deepEqual(afterClickFindings("autopilot", "taskPage", good), { failures: [], notices: [] });
  assert.deepEqual(afterClickFindings("autopilot", "taskPage", null), { failures: [], notices: [] });

  // The one failure is carried over from the drawer: a time zone is named, never shown by its identifier.
  const named = read(taskPage({ barText: "每天 07:00 · Asia/Shanghai · 下次 10月12日 07:00" }));
  assert.deepEqual(named.zoneIds, ["Asia/Shanghai"]);
  assert.deepEqual(taskPageFindings("autopilot", named).failures, ["autopilot@desktop: the task bar names a time zone by its identifier: Asia/Shanghai"]);
  // The pane's wait is the pane being on the page.
  assert.equal(inPage(taskPage(), () => taskPaneReady()), true);
  assert.equal(inPage(taskPage({ pane: null }), () => taskPaneReady()), false);
});

test("the title column of a page is held against the one most pages share", () => {
  const pages = { "files@desktop": { pageLefts: [296] }, "memory@desktop": { pageLefts: [296, 300] }, "inbox@desktop": { pageLefts: [296] }, "autopilot@desktop": { pageLefts: [24] }, "files@phone": { pageLefts: [16] } };
  assert.deepEqual(leftEdgeNotices(pages), ["autopilot@desktop: the title starts at 24 px; most pages start at 296 px"]);
  assert.deepEqual(leftEdgeNotices({}), []);
  assert.deepEqual(leftEdgeNotices({ "files@desktop": { pageLefts: [] } }), []);
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
  assert.deepEqual(cleanupFindings({ ...cover, cover: "正在打开", quotaButtons: ["查看科研额度"] }, null), [
    "chat@desktop: a start refused for cleanup does not say it is cleaning up (cover: “正在打开”)", "chat@desktop: a start refused for cleanup offers 查看科研额度"]);
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
    "/app/virtual-research?tab=definitions", "/app/account?tab=notifications", "/app/account?tab=ops", "/app/account/simulated/membership",
    "/app/account/simulated/refunds", "/app/memory/shared/impeccable-audit-missing", "/app/extensions/plugins/impeccable-audit-missing",
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
  assert.deepEqual(report.pages["geo-overview@phone"].probes, { geoRail: { folded: 1, closed: true, steps: 0 } });
  assert.equal(log.filter((entry) => ["回到插件列表", "回到技能列表"].includes(entry.clickNamed)).length, 2);
  assert.deepEqual(report.failures, []);
  // The step that presses 保存 wrote nothing: the guard is installed for it and removed after.
  const pressedAt = log.findIndex((entry) => entry.clickNamed === "保存");
  const routeAt = log.findLastIndex((entry, index) => index < pressedAt && entry.route === String("**/api/**"));
  assert.ok(pressedAt >= 0 && routeAt >= 0 && log.findIndex((entry, index) => index > pressedAt && entry.unroute) > pressedAt);
  assert.equal(log.filter((entry) => entry.aborted).length, 0);
  assert.deepEqual(Object.keys(report.steps).sort(), ["address-state", "evidence-matrix@desktop", "evidence-matrix@phone", "extensions-skills-create", "files-pdf", "files-return", "frontier-event-handoff"]);
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

  assert.ok((await failures({ FAKE_PROBE: "geoRail" })).failures.includes("geo-overview@phone: the progress rail is not folded into one line"));
  assert.ok((await failures({ FAKE_PROBE: "followingEmpty" })).failures.includes("frontier-following@desktop: 「没有结果」 is on the page, and nothing was searched or filtered"));
  assert.ok((await failures({ FAKE_PROBE: "memoryTabs" })).failures.includes("memory@desktop: the page opens on an empty 关于你 while 项目 holds 2 and 做法 3"));
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

test("a height, a row count, a headline's place and a title column are notices, never failures", async () => {
  const { code, report, stdout } = await walk({ FAKE_STRUCTURE: "tall", FAKE_PROBE: "firstRowTop" });
  assert.equal(code, 0, stdout);
  assert.ok(report.notices.some((notice) => /^geo-answer@desktop: the page is 90000 px tall/.test(notice)));
  assert.ok(report.notices.includes("frontier@phone: the first headline starts at 620 px (the aim is 520)"));
  const rows = await walk({ FAKE_STRUCTURE: "rows" });
  assert.equal(rows.code, 0);
  assert.ok(rows.report.notices.includes("geo-sources@desktop: 99 rows on the first screen of data (notice above 40)"));
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
  const { code, report } = await walk({ FAKE_NO_MATRIX: "1" });
  assert.equal(code, 0);
  assert.ok(report.notices.some((notice) => /^evidence-matrix@desktop: the step could not run/.test(notice)), report.notices.join("\n"));
});

/**
 * The composer as the kernel's frame draws it: a root holding the card (the editable and the toolbar's row, with its tools and its send key) and the dock
 * under the card. The kernel's classes end in a stable suffix (`InputBar_card`), which is how the shell's own stylesheet and the probe find them.
 */
function composerDom({ chipsInBar = 0, chipsInDock = 0, hero = false, dock = true, researcher = true, wrap = false, gap = 24 } = {}) {
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
    node("span", { attrs: { "data-composer-stats": "" }, text: "用量 12K", style: hidden, top: lowest - 24 }),
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
  assert.deepEqual(Object.keys(report.steps["chat-composer"]), ["desktop", "phone"]);
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

test("the pages the reference named have a section budget, and stacking more is a notice there until a walk has measured them; every other budget still fails", () => {
  for (const name of ["inbox", "geo", "frontier-zones", "autopilot", "account"]) {
    assert.ok(Number.isInteger(SECTION_SHAPES_BY_PAGE[name]) && NOTICE_SECTION_PAGES.has(name), `${name} has a notice-first section budget`);
  }
  const stacked = ["ul>li", "table>thead+tbody", "svg>g", "section>h2+ul"];
  const inbox = pageFindings("inbox", "desktop", clean({ sectionShapes: stacked.slice(0, 3) }), []);
  assert.deepEqual(inbox.failures, []);
  assert.deepEqual(inbox.notices, ["inbox@desktop: the page stacks 3 kinds of section (budget 2): ul>li, table>thead+tbody, svg>g — new in R13: reported, not failed, until a walk has measured this page"]);
  assert.deepEqual(pageFindings("inbox", "desktop", clean({ sectionShapes: stacked.slice(0, 2) }), []), { failures: [], notices: [] });
  // The budget of the page R10 rebuilt is a failure still; so is everything else a page spends past a number.
  assert.equal(pageFindings("memory", "desktop", clean({ sectionShapes: stacked.slice(0, 3) }), []).failures.length, 1);
  assert.equal(pageFindings("inbox", "desktop", clean({ controlKinds: 11 }), []).failures.length, 1);
  assert.deepEqual(pageFindings("account", "desktop", clean({ sectionShapes: stacked }), []).failures, []);
  assert.equal(pageFindings("account", "desktop", clean({ sectionShapes: stacked }), []).notices.length, 1);
  assert.deepEqual(pageFindings("inbox", "phone", clean({ sectionShapes: stacked }), []), { failures: [], notices: [] });
  // The budgeted pages of R10 are not among them.
  for (const name of ["files", "memory", "frontier", "capabilities", "virtual-research"]) assert.ok(!NOTICE_SECTION_PAGES.has(name), name);
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
  assert.ok(PROVISIONAL_PAGES.has("frontier-daily-empty") && BUDGET_BY_PAGE["frontier-daily-empty"]);
  assert.ok(ROUTES.some(([name, route]) => name === "frontier-daily-empty" && route === "/app/frontier?view=daily&day=2020-01-01"));
});

/** The inbox's filter chips and the memory page's tabs and search box, as the pages draw them. */
const listPage = ({ pressed = "未读 3", selected = "项目 5", query = "探针", search = true, dialog = false } = {}) => node("body", {}, [
  node("aside", {}, [node("a", { attrs: { href: "/app/capabilities" }, text: "科研工具" }), node("a", { attrs: { href: "/app/inbox" }, text: "收件箱" })]),
  node("main", {}, [
    node("div", { attrs: { role: "group", "aria-label": "消息筛选" } }, [node("button", { attrs: { "aria-pressed": String(pressed === "全部") }, text: "全部" }), node("button", { attrs: { "aria-pressed": String(pressed.startsWith("未读")) }, text: pressed.startsWith("未读") ? pressed : "未读" })]),
    node("div", { attrs: { role: "tablist" } }, ["关于你", "项目 5", "做法 2", "成长"].map((name) => node("button", { attrs: { role: "tab", "aria-selected": String(name === selected) }, text: name }))),
    ...(search ? [node("input", { attrs: { "aria-label": "搜索记忆" }, value: query })] : []),
    ...(dialog ? [node("div", { attrs: { role: "dialog" } })] : []),
  ]),
]);

test("where a list page keeps its place is read from the address and from what its controls show: chips, tabs, the search box, the open row", () => {
  const at = (path, search, fn, root = listPage()) => inPage(root, () => { globalThis.location.search = search; return fn(); }, { path });
  assert.deepEqual(at("/app/inbox", "?filter=unread", () => addressProbe(["inbox"])), { path: "/app/inbox", search: "?filter=unread", dialog: false, found: true, pressed: "未读 3" });
  assert.deepEqual(at("/app/memory", "?tab=project&q=%E6%8E%A2", () => addressProbe(["memory"]), listPage({ dialog: true })),
    { path: "/app/memory", search: "?tab=project&q=%E6%8E%A2", dialog: true, found: true, selected: "项目 5", query: "探针" });
  assert.equal(inPage(page(header()), () => addressProbe(["inbox"])).found, false);
  assert.equal(inPage(listPage({ search: false }), () => addressProbe(["memory"])).query, null);
  assert.equal(inPage(page(header()), () => addressProbe(["other"])), null);
  // The controls are pressed by what they are called (a chip and a tab carry their count), or by where a sidebar link goes; nothing else.
  const body = listPage();
  inPage(body, () => {
    assert.equal(addressAct(["chip", "消息筛选", "未读"]), true);
    assert.equal(addressAct(["chip", "消息筛选", "不存在"]), false);
    assert.equal(addressAct(["chip", "别的组", "未读"]), false);
    assert.equal(addressAct(["tab", "项目"]), true);
    assert.equal(addressAct(["tab", "不存在"]), false);
    assert.equal(addressAct(["link", "/app/capabilities"]), true);
    assert.equal(addressAct(["link", "/app/nowhere"]), false);
    assert.equal(addressAct(["other"]), false);
  });
  assert.deepEqual(descendants(body).filter((el) => el.clicks > 0).map((el) => el.text), ["科研工具", "未读 3", "项目 5"]);
  assert.deepEqual(ADDRESS_CASES.map((c) => c.page), ["inbox", "memory"]);
  assert.equal(addressStateHolds({ pressed: "未读" }, { pressed: "未读 3" }), true);
  assert.equal(addressStateHolds({ query: "探针" }, { query: "探针 " }), false);
  assert.equal(addressStateHolds({ pressed: "未读" }, null), false);

  // Judged.
  const inbox = ADDRESS_CASES[0];
  const memory = ADDRESS_CASES[1];
  const shown = { path: "/app/inbox", search: "?filter=unread", dialog: false, found: true, pressed: "未读 3" };
  const good = { pressed: [true], first: shown, away: "/app/capabilities", back: shown, reload: shown };
  assert.deepEqual(addressStateFindings(inbox, good), { failures: [], notices: [] });
  assert.deepEqual(addressStateFindings(inbox, { ...good, first: { ...shown, search: "" } }).notices, [
    "inbox@desktop: the choice is not in the address after it was made: filter=unread is not in “”",
    "inbox@desktop: after Back from another page the address is “?filter=unread” and was “”",
    "inbox@desktop: after loading the address again the address is “?filter=unread” and was “”",
  ]);
  assert.deepEqual(addressStateFindings(inbox, { ...good, back: { ...shown, search: "", pressed: "全部" }, reload: { ...shown, pressed: "全部" } }).notices, [
    "inbox@desktop: after Back from another page the address is “” and was “?filter=unread”",
    "inbox@desktop: after Back from another page the page shows {\"pressed\":\"全部\"} ({\"pressed\":\"未读\"})",
    "inbox@desktop: after loading the address again the page shows {\"pressed\":\"全部\"} ({\"pressed\":\"未读\"})",
  ]);
  assert.deepEqual(addressStateFindings(inbox, { ...good, first: { ...shown, pressed: "全部" } }).notices, ["inbox@desktop: the page does not show the choice it was given ({\"pressed\":\"未读\"})"]);
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

test("the event page's 深入研究 is read at the hand-off: the title, a link to a source, a create intent that cannot send, and Back to the event", () => {
  const eventPage = (button = true) => node("body", {}, [node("main", {}, [node("header", {}, [node("h1", { text: "某事件" })]), ...(button ? [node("button", { text: "深入研究" })] : [])])]);
  assert.deepEqual(inPage(eventPage(), () => handoffProbe(["event"]), { path: "/app/frontier/events/ev_1" }), { path: "/app/frontier/events/ev_1", title: "某事件", button: true });
  assert.equal(inPage(eventPage(false), () => handoffProbe(["event"])).button, false);
  const withState = (usr) => inPage(eventPage(), () => { globalThis.window.history = { state: usr === undefined ? null : { usr, key: "k", idx: 2 } }; return handoffProbe(["intent"]); }, { path: "/app/chat" });
  const draft = "请围绕这个事件做一次深入研究。\n\n事件：某事件\n一手来源：\n- 官方：标题（https://example.org/a）";
  const intent = { kind: "create", projectId: "p", requestId: "req_1", sessionId: "s", draft };
  assert.deepEqual(withState({ runtimeUiIntent: intent }), { path: "/app/chat", intent: { keys: ["draft", "kind", "projectId", "requestId", "sessionId"], kind: "create", draft, requestId: "req_1" } });
  assert.deepEqual(withState({}), { path: "/app/chat", intent: null });
  assert.deepEqual(withState(undefined), { path: "/app/chat", intent: null });
  assert.deepEqual(HANDOFF_FIELDS, ["draft", "kind", "projectId", "requestId", "resultRevision", "sessionId"]);

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
    [["chip", "消息筛选", "未读"], ["link", "/app/capabilities"], ["tab", "项目"], ["link", "/app/capabilities"]]);
  assert.deepEqual(log.filter((entry) => entry.fill).map((entry) => [entry.fill, entry.value]).filter(([name]) => name === "搜索记忆"), [["搜索记忆", "探针"]]);
  assert.deepEqual(Object.keys(report.steps["address-state"]), ["inbox", "memory", "memory-open"]);
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

test("with the chat asked for, the walk answers a start with the cleanup refusal itself, reads the cover and the alert after the wait, and starts nothing", async () => {
  const { code, stdout, stderr, log, report } = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS: "10" });
  assert.equal(code, 0, stdout + stderr);
  assert.match(report.steps["chat-cleanup-cover"].early.cover, /^正在清理上一次任务的运行环境/);
  assert.deepEqual(report.steps["chat-cleanup-cover"].late.alertButtons, ["重试", "查看已有成果"]);
  assert.deepEqual(log.filter((entry) => entry.start).slice(-1).map((entry) => entry.verdict), ["fulfilled"]);
  const quota = await walk({ OPEN_SCIENCE_WALK_CHAT: "1", FAKE_CLEANUP: "quota" });
  assert.equal(quota.code, 1);
  assert.ok(quota.report.failures.includes("chat@desktop: a start refused for cleanup offers 查看科研额度"));
  // Without the chat page, the walk does not open it and does not wait.
  assert.equal((await walk()).report.steps?.["chat-cleanup-cover"], undefined);
});
