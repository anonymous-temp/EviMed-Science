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
  afterClickFindings, afterClickProbe, BACK_OFFICE, BUDGET_BY_PAGE, budgetKey, cleanupFindings, cleanupNotices, clickNamed, clickRowTitled, EXPECTED_REFUSALS, focusProbe,
  frontierTargets, GEO_TABS, geoAnswerSnapshot, HEADING_ORDER_PAGES, keylessTitles, leftEdgeNotices, matrixFindings, matrixProbe, matrixRoute,
  measure, measureStructure, MISSING_RECORDS, pageFindings, pageProbe, PAGE_PROBES, pdfPreviewFindings, pdfProbe, pdfSourceTitle,
  pickVcrStudies, probeFindings, PROVISIONAL_PAGES, RETIRED_NAMES, ROUTES, ROW_CLICK_PAGES, rowClickFindings, rowClickShown, rowProbe,
  SECTION_SHAPES_BY_PAGE, skillDrawerFindings, skillDrawerProbe, sourceReaderRoute, structureFindings, tabOrderFindings, TYPE_PAIR_NOTICE, unexpectedRefusals,
  VCR_TABS_WALK,
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
function node(tag, { attrs = {}, text = "", w = 600, h = 24, left = 0, style = {}, scrollW = w, scrollH = h, tabIndex = -1, open = false } = {}, children = []) {
  const el = {
    tag, text, attrs, children, parent: null, tagName: tag.toUpperCase(), clicks: 0, rect: { width: w, height: h, left },
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
    getBoundingClientRect: () => ({ ...el.rect, top: 0, right: el.rect.left + el.rect.width }),
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
    default: return null;
  }
}
let skillProbes = 0;
let cleanupProbes = 0;
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
      async route(pattern, handler) { pageRoutes.push([pattern, handler]); log({ route: String(pattern) }); },
      async unroute() { pageRoutes.length = 0; log({ unroute: true }); },
      async waitForFunction() {
        if (process.env.FAKE_SLOW_ROUTE === "never" && new URL(url).pathname === "/app/account") throw Error("route still loading after 30000ms");
        if (process.env.FAKE_NO_MATRIX && url.endsWith("clinical-evidence-matrix.json")) throw Error("no matrix");
        routeSettled = true;
      },
      frames: () => [{ url: () => "https://evimed.example.org/__evimed/f/x", evaluate: async () => ({ composer: !chatFailing(), stats: [] }) }],
      getByRole: (role, { name }) => locator(role, name),
      async goto(target, options) {
        url = target; routeSettled = false; dialogOpen = false; log({ goto: target });
        const start = new URL("/api/commands/start_runtime", target).href;
        // A page's own route answers before the context's: the walk's cleanup cover answers the start itself.
        const own = pageRoutes.find(([pattern]) => pattern.test(start));
        if (own) { log({ start, verdict: "fulfilled" }); await own[1]({ fulfill: async () => {} }); }
        else await fire(start);
        if (chatMode && target.endsWith("/app/chat")) for (const handler of failed) handler({ failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }) });
      },
      async evaluate(fn, arg) {
        if (url.endsWith("/app/chat") && typeof fn === "function" && String(fn).includes("document.body.innerText")) return chatFailing() ? "打开超时，请重试\n重试" : "";
        // FAKE_ROWS=dead: a row that does nothing when clicked; FAKE_ROWS=two: two lists on every page, so the walk loads the page again between clicks.
        if (typeof fn === "function" && fn.name === "rowProbe") {
          const [action] = arg;
          if (action === "targets") return process.env.FAKE_ROWS === "two" ? ["第一张清单", "第二张清单"] : ["资料清单"];
          if (action === "state") return { dialog: dialogOpen, path: new URL(url).pathname, expanded: 0 };
          // FAKE_ROWS=external: the row's title is a link to an outside address; the browser reports no popup, and the row is not silent.
          if (action === "external") return process.env.FAKE_ROWS === "external";
          dialogOpen = process.env.FAKE_ROWS !== "dead" && process.env.FAKE_ROWS !== "external";
          log({ rowClick: new URL(url).pathname, index: arg[1] });
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
          if (arg[0] === "sourceDetail") return { details: process.env.FAKE_AFTER === "bad" ? 0 : 1 };
          return process.env.FAKE_AFTER === "bad" ? { header: "每天 07:00", zoneIds: ["Asia/Shanghai"], workingFilesOpen: ["a.py"] } : { header: "每天 07:00 · 中国标准时间 · 单次上限 ¥8", zoneIds: [], workingFilesOpen: [] };
        }
        if (typeof fn === "function" && fn.name === "clickNamed") {
          const [role, name] = arg;
          log({ clickNamed: name });
          if (name === "保存" && process.env.FAKE_SKILL_WRITE) for (const [, handler] of pageRoutes) handler({ request: () => ({ method: () => "POST", url: () => "https://evimed.example.org/api/personal-skills" }), abort: async () => log({ aborted: "POST" }), continue: async () => {} });
          if (name === "回到插件列表") url = new URL("/app/extensions/plugins", url).href;
          if (name === "回到技能列表") url = new URL(process.env.FAKE_BACK === "stay" ? "/app/extensions/skills/impeccable-audit-missing" : "/app/extensions/skills", url).href;
          return true;
        }
        if (typeof fn === "function" && fn.name === "clickRowTitled") return true;
        if (typeof fn === "function" && fn.name === "pdfProbe") return { width: process.env.FAKE_PDF === "narrow" ? 576 : 896, src: "blob:x#view=FitH&navpanes=0" };
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
        if (url.endsWith("/api/me")) return loggedIn ? json(200, { data: { csrfToken: "t" } }) : json(401, {});
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

test("a row that shows nothing when clicked fails the page it is on", async () => {
  const { code, report } = await walk({ FAKE_ROWS: "dead" });
  assert.equal(code, 1);
  for (const name of ROW_CLICK_PAGES) {
    assert.ok(report.failures.includes(`${name}@desktop: clicking the first row of the list “资料清单” showed nothing — no drawer, no page, no opened row`), name);
  }
  assert.equal(report.failures.length, ROW_CLICK_PAGES.size);
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
  // The page, the first click, the page again, the second click — then the knowledge base's PDF step opens the page once more, and the phone's view is the last.
  assert.deepEqual(events.map((entry) => (entry.rowClick ? `click ${entry.index}` : "goto")), ["goto", "click 0", "goto", "click 1", "goto", "goto"]);
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
  assert.deepEqual(Object.keys(EXPECTED_REFUSALS).sort(), ["extensions-skill-missing", "memory-shared-missing"]);
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

test("what a first row opened to is read while it is open: a source's detail in place, a task's drawer", () => {
  const detail = inPage(page(header(), node("span", { attrs: { "data-geo-source-detail": "" }, text: "备案" })), () => afterClickProbe(["sourceDetail"]));
  assert.deepEqual(detail, { details: 1 });
  assert.deepEqual(inPage(page(header()), () => afterClickProbe(["sourceDetail"])), { details: 0 });
  const drawer = (headerText, extra = []) => node("div", { attrs: { role: "dialog" } }, [node("header", {}, [node("p", { text: headerText })]), ...extra]);
  const open = (dialog) => inPage(node("body", {}, [node("main", {}, [dialog])]), () => afterClickProbe(["taskDrawer"]));
  assert.deepEqual(open(drawer("每天 07:00 · 中国标准时间 · 单次上限 ¥8")), { header: "每天 07:00 · 中国标准时间 · 单次上限 ¥8", zoneIds: [], workingFilesOpen: [] });
  const bad = open(drawer("每天 07:00 · Asia/Shanghai · 单次上限 ¥8", [node("a", { text: "analysis.py" }), node("details", {}, [node("summary", { text: "其他文件 1 个" }), node("a", { text: "kept.py" })])]));
  assert.deepEqual([bad.zoneIds, bad.workingFilesOpen], [["Asia/Shanghai"], ["analysis.py"]]);
  assert.deepEqual(open(node("div", { attrs: { role: "dialog" } }, [node("form")])), { header: null });

  assert.deepEqual(afterClickFindings("geo-sources", "sourceDetail", { details: 1 }), { failures: [], notices: [] });
  assert.deepEqual(afterClickFindings("geo-sources", "sourceDetail", { details: 0 }).failures, ["geo-sources@desktop: clicking the first source opened no detail in place"]);
  assert.deepEqual(afterClickFindings("autopilot", "taskDrawer", { header: "每天 07:00 · 单次上限 ¥8", zoneIds: [], workingFilesOpen: [] }), { failures: [], notices: [] });
  assert.equal(afterClickFindings("autopilot", "taskDrawer", { header: "每天 07:00", zoneIds: ["Asia/Shanghai"], workingFilesOpen: ["a.py"] }).failures.length, 3);
  assert.equal(afterClickFindings("autopilot", "taskDrawer", { header: null }).notices.length, 1);
  assert.deepEqual(afterClickFindings("autopilot", "taskDrawer", null), { failures: [], notices: [] });
});

test("the title column of a page is held against the one most pages share", () => {
  const pages = { "files@desktop": { pageLefts: [296] }, "memory@desktop": { pageLefts: [296, 300] }, "inbox@desktop": { pageLefts: [296] }, "autopilot@desktop": { pageLefts: [24] }, "files@phone": { pageLefts: [16] } };
  assert.deepEqual(leftEdgeNotices(pages), ["autopilot@desktop: the title starts at 24 px; most pages start at 296 px"]);
  assert.deepEqual(leftEdgeNotices({}), []);
  assert.deepEqual(leftEdgeNotices({ "files@desktop": { pageLefts: [] } }), []);
});

test("a PDF's original opens wide and fit to the width, and a drawer that is too narrow or a viewer without the fragment fails", () => {
  assert.deepEqual(pdfPreviewFindings({ width: 896, src: "blob:x#view=FitH&navpanes=0" }), []);
  assert.deepEqual(pdfPreviewFindings({ width: 576, src: "blob:x#view=FitH&navpanes=0" }), ["files@desktop: the original of a PDF opens in a 576 px drawer (wider than 576)"]);
  assert.deepEqual(pdfPreviewFindings({ width: 896, src: "blob:x" }), ["files@desktop: the PDF is not opened fit to width without the thumbnail column"]);
  assert.deepEqual(pdfPreviewFindings({ width: 896, src: null }), []);
  assert.deepEqual(pdfPreviewFindings(null), []);
  const dialog = node("div", { attrs: { role: "dialog" }, w: 896 }, [node("iframe", { attrs: { title: "PDF 预览", src: "blob:x#view=FitH&navpanes=0" } })]);
  assert.deepEqual(inPage(node("body", {}, [dialog]), () => pdfProbe()), { width: 896, src: "blob:x#view=FitH&navpanes=0" });
  assert.equal(inPage(page(header()), () => pdfProbe()), null);
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
  assert.deepEqual(failures({ state: { ...state, marks: ["未核对", "核对中"] } }), ["evidence-matrix@phone: some claims read 未核对 while others read 核对中"]);
  assert.deepEqual(failures({ state: { ...state, marks: ["未核对"] } }), []);
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
  const routeAt = log.findIndex((entry) => entry.route === String("**/api/**"));
  assert.ok(routeAt >= 0 && log.findIndex((entry, index) => index > routeAt && entry.unroute) > routeAt);
  assert.equal(log.filter((entry) => entry.aborted).length, 0);
  assert.deepEqual(Object.keys(report.steps).sort(), ["evidence-matrix@desktop", "evidence-matrix@phone", "extensions-skills-create", "files-pdf"]);
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
  assert.ok(after.failures.includes("geo-sources@desktop: clicking the first source opened no detail in place"));
  assert.ok(after.failures.includes("autopilot@desktop: working files are listed outside 其他文件: a.py"));
  assert.ok((await failures({ FAKE_PDF: "narrow" })).failures.includes("files@desktop: the original of a PDF opens in a 576 px drawer (wider than 576)"));
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
