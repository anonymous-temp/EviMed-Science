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
  BACK_OFFICE, BUDGET_BY_PAGE, GEO_TABS, RETIRED_NAMES, ROUTES, ROW_CLICK_PAGES, SECTION_SHAPES_BY_PAGE, VCR_TABS_WALK, TYPE_PAIR_NOTICE,
  measure, pageFindings, rowClickFindings, rowClickShown, rowProbe,
} from "../../../scripts/ops/ui-walk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
  const walked = new Set([...ROUTES.map(([name]) => name), ...GEO_TABS.map(([name]) => name), ...VCR_TABS_WALK.map(([name]) => name)]);
  for (const name of Object.keys(BUDGET_BY_PAGE)) assert.ok(walked.has(name), `the budget names ${name}, which no route walks`);
  for (const name of Object.keys(SECTION_SHAPES_BY_PAGE)) assert.ok(walked.has(name), `the section budget names ${name}, which no route walks`);
  for (const name of ROW_CLICK_PAGES) assert.ok(walked.has(name), `the row-click list names ${name}, which no route walks`);
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9 }), []).failures, []);
  assert.equal(pageFindings("files", "desktop", clean({ controlKinds: 11 }), []).failures.length, 1);
});

test("every page the router serves at a fixed address is walked, or says why it is not", async () => {
  // The extension centre's two pages and the evidence zones' home shipped
  // without the walk ever opening them (found 2026-10-03): the route list is
  // written by hand and nothing compared it with the router.
  const router = await readFile(path.join(repoRoot, "apps/web/src/app/router.tsx"), "utf8");
  const app = router.slice(router.indexOf('path: "/app"'), router.indexOf('{ path: "*", element: <NotFound /> }'));
  const pages = [...app.matchAll(/\{ path: "([^"]+)", element: <(\w+)/g)]
    .filter(([, address, element]) => element !== "Navigate" && !address.includes(":") && !address.includes("*"))
    .map(([, address]) => `/app/${address}`);
  assert.ok(pages.length >= 12 && pages.includes("/app/frontier") && pages.includes("/app/account"), `read ${pages.length} fixed pages from the router; the scan did not walk`);
  const notWalked = {
    // The conversation is the kernel's own frame; OPEN_SCIENCE_WALK_CHAT=1 opens it.
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
function node(tag, { attrs = {}, text = "", w = 600, h = 24, left = 0, style = {} } = {}, children = []) {
  const el = {
    tag, text, attrs, children, parent: null, tagName: tag.toUpperCase(), clicks: 0, rect: { width: w, height: h, left },
    style: {
      display: "block", visibility: "visible", opacity: "1", color: "rgb(20, 20, 20)", backgroundColor: "rgba(0, 0, 0, 0)", fontSize: "14px",
      fontWeight: "400", lineHeight: "22px", borderTopLeftRadius: "0px", paddingTop: "0px", paddingBottom: "0px", clip: "auto", clipPath: "none",
      ...Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((side) => [[`border${side}Width`, "0px"], [`border${side}Style`, "none"], [`border${side}Color`, "rgb(20, 20, 20)"]])),
      ...style,
    },
    id: "", childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
    get textContent() { return text + children.map((child) => child.textContent).join(""); },
    get parentElement() { return el.parent; },
    classList: { contains: (name) => (attrs.class ?? "").split(/\s+/).includes(name) },
    getAttribute: (name) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ ...el.rect, top: 0 }),
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
    document: { body, title: "页面 · EviMed", documentElement: { scrollWidth: 1512 }, querySelector: (selector) => queryAll(body, selector)[0] ?? null, querySelectorAll: (selector) => queryAll(body, selector) },
    window: { innerWidth: 1512 },
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
    // FAKE_CHAT=network-changed: the chat page drops its requests with
    // ERR_NETWORK_CHANGED and shows 打开超时 until 重试 is pressed;
    // FAKE_CHAT=broken: 重试 does not help either.
    const chatMode = process.env.FAKE_CHAT || "";
    let retried = false;
    const chatFailing = () => chatMode && url.endsWith("/app/chat") && !(chatMode === "network-changed" && retried);
    return {
      on(event, handler) { if (event === "requestfailed") failed.push(handler); }, off() {},
      async setViewportSize() {}, async route() {}, async close() {}, async screenshot() {}, async waitForTimeout() {},
      async waitForFunction() {
        if (process.env.FAKE_SLOW_ROUTE === "never" && new URL(url).pathname === "/app/account") throw Error("route still loading after 30000ms");
        routeSettled = true;
      },
      frames: () => [{ url: () => "https://evimed.example.org/__evimed/f/x", evaluate: async () => ({ composer: !chatFailing(), stats: [] }) }],
      getByRole: (role, { name }) => ({ count: async () => (chatFailing() && role === "button" && name === "重试" ? 1 : 0), first: () => ({ click: async () => { retried = true; log({ click: name }); } }) }),
      async goto(target) {
        url = target; routeSettled = false; dialogOpen = false; log({ goto: target }); await fire(new URL("/api/commands/start_runtime", target).href);
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
        if (url.endsWith("/api/agents")) return json(200, { data: ["a1", "a2", "a3", "a4", "a5"].map((id) => ({ id: "capability-" + id })) });
        if (url.endsWith("/api/geo/projects")) return json(200, { data: { projects: [{ id: "geo_1" }] } });
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
  assert.deepEqual(log.slice(chatAt).filter((entry) => entry.start).map((entry) => entry.verdict), ["allowed"]);
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
  assert.deepEqual([...clicked].sort(), [...ROW_CLICK_PAGES].map((name) => ROUTES.find(([route]) => route === name)[1].split("?")[0]).filter((value, index, all) => all.indexOf(value) === index).sort());
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
  assert.deepEqual(events.map((entry) => (entry.rowClick ? `click ${entry.index}` : "goto")), ["goto", "click 0", "goto", "click 1", "goto"]);
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
