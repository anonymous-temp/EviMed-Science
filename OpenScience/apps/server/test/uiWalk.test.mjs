// scripts/ops/ui-walk.mjs: its budgets name the pages it walks, it walks every
// GEO tab, it starts no runtime, and a font-pair count is a notice.
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
import { BACK_OFFICE, BUDGET_BY_PAGE, GEO_TABS, ROUTES, TYPE_PAIR_NOTICE, measure, pageFindings } from "../../../scripts/ops/ui-walk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A page that measures clean, as `measure` would report it. */
function clean(overrides = {}) {
  return {
    title: "知识库 · EviMed", controlKinds: 5, colorKinds: 4, borderKinds: 2, sizeWeightPairs: ["14px/400", "24px/600"],
    pageLefts: [240], rowTitleLefts: [], subtitle: [], backOfficeHits: [], leakHits: [], unnamedControls: [],
    overflowX: false, smallTargets: 0, decorativeSvgs: 0, ...overrides,
  };
}

test("every page the budget table names is a page the walk visits", () => {
  // The table said `knowledge`; the route is `files`, so the knowledge base
  // kept the reading budget and failed on its ninth control.
  const walked = new Set([...ROUTES.map(([name]) => name), ...GEO_TABS.map(([name]) => name)]);
  for (const name of Object.keys(BUDGET_BY_PAGE)) assert.ok(walked.has(name), `the budget names ${name}, which no route walks`);
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9 }), []).failures, []);
  assert.equal(pageFindings("files", "desktop", clean({ controlKinds: 11 }), []).failures.length, 1);
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
  const make = ({ tag, text = "", height, width = 120, declaredHeight = "auto", icon = false, style = {}, statusMark = false, chartMark = false, chartRoot = false }) => {
    const el = {
      tag, text, attributes: {}, tagName: tag.toUpperCase(), id: "", style: { ...base, ...style },
      children: [], childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
      get textContent() { return text; },
      getBoundingClientRect: () => ({ width, height, left: 0 }),
      computedStyleMap: () => ({ get: (property) => ({ toString: () => (property === "height" ? declaredHeight : "auto") }) }),
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
    return measure([[], BACK_OFFICE.map(re => [re.source, re.flags])]);
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
        url = target; routeSettled = false; log({ goto: target }); await fire(new URL("/api/commands/start_runtime", target).href);
        if (chatMode && target.endsWith("/app/chat")) for (const handler of failed) handler({ failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }) });
      },
      async evaluate(fn) {
        if (url.endsWith("/app/chat") && typeof fn === "function" && String(fn).includes("document.body.innerText")) return chatFailing() ? "打开超时，请重试\n重试" : "";
        if (typeof fn === "function" && fn.name === "measure") {
          return { title: (process.env.FAKE_SLOW_ROUTE && !routeSettled && new URL(url).pathname === "/app/account") || process.env.FAKE_MISSING_TITLE ? "" : "页面 · EviMed", controlKinds: 3, colorKinds: 3, borderKinds: 1, sizeWeightPairs: ["12px/400", "13px/400", "14px/400", "14px/500", "24px/600"],
            pageLefts: [240], rowTitleLefts: [], subtitle: [], backOfficeHits: [], leakHits: [], unnamedControls: [], overflowX: false, smallTargets: 0, decorativeSvgs: 0 };
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
