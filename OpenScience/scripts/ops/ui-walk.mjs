#!/usr/bin/env node
/**
 * A read-only walk of a live deployment's pages, at the owner's desktop width
 * and a phone width, that fails when a page regresses on what the
 * 2026-09-15/16/23 walks found by hand (review appendix C: "fix the walk into
 * scripts/ops"; 2026-09-23 plan §7 gate 3: "上线后走查带预算").
 *
 * What it asserts, per page and viewport:
 *   - no runtime vocabulary in the visible text (run/session ids, provider
 *     model ids, SHOUTED capability keys, `undefined`, `NaN`, `[object …]`,
 *     leftover `<!-- claim:… -->` markers), and none of the back office the
 *     2026-09-23 plan took off the pages (已交付, 核对 N 条, 用过 N 次,
 *     起生效, token, 缓存命中, tok/s, feed and API names — a feed's name,
 *     「openFDA 药品召回（enforcement）API」, not the data source 「openFDA」
 *     a researcher sets a key for in 设置 → 数据源);
 *   - every visible control has a name;
 *   - the page has its own title (not the bare product name), and its header
 *     carries no subtitle and at most one primary action (a solid accent
 *     button; DESIGN.md 「页面结构」 rule 3);
 *   - neither retired module name — 「循证传播」, 「虚拟临研」 — is on any page
 *     (the owner's renames of 2026-10-07; RETIRED_NAMES);
 *   - on the pages rebuilt in R10, the page's body stacks no more kinds of
 *     section than its budget says (SECTION_SHAPES_BY_PAGE; rule 1), and
 *     clicking the first row of each of its lists shows a drawer, a new page
 *     or an opened row — a row that looks clickable does something where the
 *     reader is looking (rule 6);
 *   - at 390 px nothing overflows horizontally;
 *   - at the desktop width, the style budget of §7: at most 8 kinds of
 *     control (9 on the frontier feed, whose headlines are links; 10 on a
 *     data page — the knowledge base and 循证 GEO), 5 text colours (8 on the
 *     frontier feed, which adds the safety red and the rank colours; 7 on a
 *     data page) and 3 kinds of border (6 on a GEO project's tabs, the
 *     measured number — see GEO_BUDGET), with each kind of control named in
 *     the report by its first example; the title and the page
 *     body's blocks start on one left edge; within a list, every row's title
 *     (`[data-row-title]`) starts on one left edge;
 *   - no page is replaced by the router's English error page, and a lazy page
 *     whose chunk is gone (the state an open tab is in after a release) keeps
 *     the sidebar and says so in Chinese;
 *   - no call a page makes to the control plane's API is refused (4xx/5xx).
 * It also records, without failing on them, small click targets, decorative
 * SVGs without aria-hidden, console errors and other HTTP errors — the things
 * that need a person to judge — and, as a NOTICE, a page that sets its text in
 * more than four font-size × font-weight pairs (design spec chapter 5 rule 1,
 * acceptance row 4). A notice is reported, never failed on (principle 4: a
 * check ships as a notice until its real distribution is known); the per-page
 * counts are in the report so a budget can be set from them.
 *
 * What it changes on the deployment: a session (it logs in and logs out), and
 * — only when asked for the chat page — the account's default runtime. The
 * shell warms that runtime from every page, not only the conversation, so a
 * walk that let those requests through started a runtime on each run
 * (2026-09-26 audit, F-G20: a walk began 14:46:59Z, the acceptance account's
 * default runtime started 14:47:07Z). Every `start_runtime` is therefore
 * refused in the browser, and counted per page in the report.
 *
 * It opens the chat page only when asked (`OPEN_SCIENCE_WALK_CHAT=1`), and
 * there it lets `start_runtime` through, because a frame bound to a live
 * session needs the account's default runtime — and it should be asked after
 * every release: on 2026-09-21 every page here walked clean while no
 * conversation of the acceptance account could load at all (its kernel frame
 * fetched a plugin bundle from a runtime that had not composed it, a 404, and
 * stopped at 「对话界面 60 秒内没有载入完成」). With it the walk waits for the
 * frame's composer, fails on any 4xx for a kernel application file, and
 * records whether the kernel's session statistics line is on screen.
 *
 * The release switch (host-release-switch.sh) runs it after every release, in
 * a container of the release's runtime image, as the account
 * `shared/ui-walk.env` names.
 *
 * Nothing is added to package.json: a browser automation dependency would
 * change the lockfile, and a changed lockfile makes the next release a full
 * runtime image rebuild. Point it at an installed playwright-core instead.
 *
 *   OPEN_SCIENCE_WALK_BASE_URL=https://evimed.example.org \
 *   OPEN_SCIENCE_WALK_USER=cdss-access \
 *   OPEN_SCIENCE_WALK_PASSWORD_FILE=/path/to/password \
 *   OPEN_SCIENCE_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
 *   [OPEN_SCIENCE_WALK_CHROMIUM=/path/to/chrome] \
 *   [OPEN_SCIENCE_WALK_OUT=/tmp/ui-walk] \
 *   [OPEN_SCIENCE_WALK_CHAT=1] \
 *   node scripts/ops/ui-walk.mjs
 *
 * Exit 0 when every assertion holds, 1 when one does not (the report names
 * which), 2 when the walk could not run at all.
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pages, by the name the report uses. 知识库 and 记忆胶囊 are one page each
 * since 2026-09-20; 设置 is walked section by section. The frontier feed's
 * views are walked only where the account is offered the feed.
 */
export const ROUTES = [
  ["frontier", "/app/frontier"],
  ["frontier-hot", "/app/frontier?view=hot"],
  ["frontier-daily", "/app/frontier?view=daily"],
  ["frontier-all", "/app/frontier?view=all"],
  // The evidence zones' home (2026-10-01). A zone and a reading page are
  // content addresses with ids; the home is the one every account can open.
  ["frontier-zones", "/app/frontier/zones"],
  ["capabilities", "/app/capabilities"],
  // 循证 GEO's home — its one sentence where the account is not offered the
  // module; one project's seven tabs are added when the account has one
  // (`geoProjectRoutes`).
  ["geo", "/app/geo"],
  // 虚拟临床研究's home — its one sentence where the account is not offered
  // the module; one study's seven tabs are added when the account has one.
  ["virtual-research", "/app/virtual-research"],
  ["files", "/app/files"],
  ["memory", "/app/memory"],
  // The memory page's other three tabs (R10): one list each, and the growth
  // tab's curve over its timeline. The default tab was the only one walked.
  ["memory-project", "/app/memory?tab=project"],
  ["memory-methods", "/app/memory?tab=methods"],
  ["memory-growth", "/app/memory?tab=growth"],
  ["autopilot", "/app/autopilot"],
  ["inbox", "/app/inbox"],
  ["account", "/app/account"],
  ["account-usage", "/app/account?tab=usage"],
  ["account-connectors", "/app/account?tab=connectors"],
  ["account-projects", "/app/account?tab=projects"],
  // The extension centre's two lists (2026-10-02), reached from 设置. Neither
  // was walked until 2026-10-03: the list above was written before they were.
  ["extensions-plugins", "/app/extensions/plugins"],
  ["extensions-skills", "/app/extensions/skills"],
  ["not-found", "/app/does-not-exist"],
];
// 1512 is the owner's screen (2026-09-23 plan §3: measured at that width).
const VIEWPORTS = [["desktop", { width: 1512, height: 945 }], ["phone", { width: 390, height: 844 }]];
const LEAKS = [
  /\brun_[0-9a-f]{32}\b/, /\bses_[A-Za-z0-9]{8,}/, /deepseek\//i,
  /\bundefined\b/, /\bNaN\b/, /\[object /, /<!--\s*claim/i,
];

/**
 * The back office a page no longer describes (2026-09-23 plan §4, checklist
 * item 8). A closed list of the product's own phrases, not a pattern over
 * open prose: each is something this code base used to print. 「已交付」 is the
 * status label standing on its own; inside a run of Chinese text it is a word of
 * the researcher's content (a lesson titled 「修订已交付报告后重系引证与数值」
 * failed the 2026-10-07 walk of the memory page).
 */
export const BACK_OFFICE = [
  /(?<!\p{Script=Han})已交付(?!\p{Script=Han})/u, /核对\s*\d+\s*条/, /已核对\s*\d+\s*[\/／]/, /用过\s*\d+\s*次/, /\d+月\d+日\s*起生效/, /缓存命中/, /tok\/s/,
  /\b\d[\d,.]*[KMk]?\s*tok(en)?s?\b/, /openFDA (药品召回|Drugs@FDA|器械)/, /理解遗漏/, /处理第\s*\d+\s*代/, /Unexpected Application Error/, /dynamically imported module/,
];

/**
 * The two module names the owner replaced on 2026-10-07 (R10 plan §1): none may
 * be on any page of the deployment, in any viewport. A closed list of words,
 * not a pattern over prose — the rename's own acceptance: "searching the test
 * server finds neither" (plan §12). The sources are the walk's and are never
 * shown back to a reader: a search still reads them as the new names until
 * 2027-01-07 (`@evimed/domain`'s `retiredNames.mjs`), but only as input.
 */
export const RETIRED_NAMES = [/循证传播/, /虚拟临研/]; // retired-word-ok

/**
 * The style budget per page (2026-09-23 plan §7 gate 3). The frontier feed may
 * spend three more text colours — the safety red and the rank colours — and
 * one more kind of control: an item's headline is the link to its original
 * (owner, 2026-09-24).
 */
const BUDGET = { controls: 8, colors: 5, borders: 3 };
const FRONTIER_BUDGET = { controls: 9, colors: 8 };
/**
 * The data-page budget (fusion plan §6.3): 10 controls, 7 text colours, 3
 * borders, against the reading page's 8 / 5 / 3. A dashboard legitimately
 * carries more — a metric band, a chart's legend and axis labels, a severity
 * scale, a table's own header — and it is a wider budget, not the absence of
 * one: 循证 GEO shipped inside the old budget and still looked cheap, which is
 * why the fix was its information architecture and not its allowance.
 *
 * 循证 GEO is the page it was written for (fusion plan §5.5, §5.9): it spends
 * the severity reds of 讲错我方 and the single-hue heat ramp on top of the
 * chrome, and its header carries a rail of eight steps beside the tabs. The
 * per-number 「问 AI」 buttons are gone — one 「对话」 in the header replaced
 * them — so the control budget covers the rail, not a control per row.
 */
const DATA_BUDGET = { controls: 10, colors: 7, borders: 3 };
/**
 * A GEO project's tabs spend more kinds of border than any other page, and the
 * number is the measured one, not a wish: the 2026-09-26 walk of the rebuilt
 * pages counted 6 (总览), 6 (可见度) and 5 (准确与安全) — the card frame,
 * the rail's step dots, the tab underline, the table's row rule and the
 * metric band's divider — against the reading page's 3 (fusion audit F-G2).
 * The other four tabs were first walked by this script after that date; a tab
 * that goes past the measured six is a new kind of border, which is what this
 * budget is for. Colours and controls stay the data page's.
 */
const GEO_BUDGET = { ...DATA_BUDGET, borders: 6 };
/** The seven tabs of one GEO project, by the report's name and path segment. */
export const GEO_TABS = [
  ["geo-overview", ""], ["geo-visibility", "/visibility"], ["geo-accuracy", "/accuracy"],
  ["geo-questions", "/questions"], ["geo-sources", "/sources"], ["geo-actions", "/actions"], ["geo-plan", "/plan"],
];
/**
 * The seven tabs of one 虚拟临床研究 study, by the report's name and path segment
 * (build plan 2026-09-28 §9.4). Walked like GEO's: the module's home page is
 * one sentence for an account it is not open to, and a study's own pages only
 * exist where that account has a study.
 */
export const VCR_TABS_WALK = [
  ["vcr-overview", ""], ["vcr-population", "/population"], ["vcr-patients", "/patients"],
  ["vcr-comparator", "/comparator"], ["vcr-trial", "/trial"], ["vcr-matching", "/matching"], ["vcr-data", "/data"],
];
/**
 * The extension centre's two lists, first walked on 2026-10-03, a day after
 * they shipped. The numbers are the measured ones: 插件 draws five kinds of
 * border (the tab underline, the row rule, the project card, the saved-state
 * box inside it and the field) and 技能 four, against the reading page's 3.
 * With skills in the list, 技能 also draws nine kinds of control (the row's
 * own history action is the ninth) against the reading page's 8. Nobody has
 * ruled what a settings list may spend; this holds the pages where they are,
 * so one more kind of either fails, until someone does.
 */
const EXTENSION_BUDGET = { controls: 9, borders: 5 };
export const BUDGET_BY_PAGE = {
  frontier: FRONTIER_BUDGET, "frontier-hot": FRONTIER_BUDGET, "frontier-daily": FRONTIER_BUDGET, "frontier-all": FRONTIER_BUDGET,
  // The zones' home is a frontier page: the same rail and tabs, measured at nine.
  "frontier-zones": FRONTIER_BUDGET,
  "extensions-plugins": EXTENSION_BUDGET, "extensions-skills": EXTENSION_BUDGET,
  geo: DATA_BUDGET,
  ...Object.fromEntries(GEO_TABS.map(([name]) => [name, GEO_BUDGET])),
  "virtual-research": DATA_BUDGET,
  ...Object.fromEntries(VCR_TABS_WALK.map(([name]) => [name, GEO_BUDGET])),
  // The knowledge base became a data page when it grew its project-and-type
  // rail. Its route is `files`: the key used to read `knowledge`, a page name
  // no route has, so the page kept the reading budget and failed on its ninth
  // control (2026-09-26 walk).
  files: DATA_BUDGET,
};

/**
 * What a page stacks (DESIGN.md 「页面结构」 rule 1: one page, one kind of
 * object; the 2026-10-07 plan's R1: two kinds of section one above the other,
 * on nineteen pages). `measure` reads the page body's top-level sections — a
 * `<section>`, a list of rows, a table, a chart — and names each by its shape
 * (its tag and its first two distinct kinds of child). Sections of one shape are one kind: the
 * skills page's five groups, the feed's one group per day and the memory page's
 * small headers each repeat a single shape however many the data has. What is
 * counted is the number of different shapes, so a page that gains a chart, a
 * statistics block or a second list of another kind beside its list passes a
 * budget of one fewer and fails this one.
 *
 * The numbers are the designed ones, the pages R10 rebuilt and nothing else:
 * one list is one shape, a banner or a hot list beside it two, and the feed's
 * safety strip, hot list and day groups three. They are not yet measured on a
 * live deployment — the first walk of R10 reports each page's shapes
 * (`sectionShapes`), and a number it contradicts is moved with that reason in
 * this table, not around it. A page not named here is not held to a budget.
 */
export const SECTION_SHAPES_BY_PAGE = {
  files: 2,
  memory: 2, "memory-project": 2, "memory-methods": 2, "memory-growth": 2,
  frontier: 3, "frontier-hot": 3, "frontier-daily": 3, "frontier-all": 3,
  capabilities: 2,
  "extensions-plugins": 2, "extensions-skills": 2,
  "virtual-research": 2,
  ...Object.fromEntries(VCR_TABS_WALK.map(([name]) => [name, 3])),
};

/**
 * The pages whose lists are clicked: the first row of each list must show
 * something where the reader is looking (DESIGN.md 「页面结构」 rule 6). The
 * same pages as the section budget, minus 科研工具, whose grid is cards that
 * start a conversation — a click there would write to the deployment — and
 * minus the study's own tabs, whose rows are results, not a place to go.
 */
export const ROW_CLICK_PAGES = new Set([
  "files", "memory", "memory-project", "memory-methods", "memory-growth",
  "frontier", "frontier-hot", "frontier-daily", "frontier-all",
  "extensions-plugins", "extensions-skills", "virtual-research",
]);
/** The lists of one page the walk clicks at most; a skills page has six groups, and the first row of each is enough to prove the pattern. */
const ROW_CLICK_LISTS_PER_PAGE = 8;

/**
 * One GEO project's seven tabs, when the account has a GEO project to walk —
 * the first the list names. None when the module is off here or the account
 * has none: the home is walked either way. It walked three of the seven until
 * 2026-09-27, so four tabs had never been through the walk.
 * @param {any} context a logged-in browser context @param {string} base
 * @returns {Promise<Array<[string, string]>>}
 */
async function vcrStudyRoutes(context, base) {
  const answer = await context.request.get(`${base}/api/vcr/studies`).catch(() => null);
  if (!answer || !answer.ok()) return [];
  const studies = (await answer.json().catch(() => null))?.data?.studies;
  const id = Array.isArray(studies) && typeof studies[0]?.id === "string" ? studies[0].id : null;
  if (!id) return [];
  const at = `/app/virtual-research/${encodeURIComponent(id)}`;
  return VCR_TABS_WALK.map(([name, segment]) => [name, `${at}${segment}`]);
}

/**
 * @param {any} context a logged-in browser context @param {string} base
 * @returns {Promise<Array<[string, string]>>}
 */
async function geoProjectRoutes(context, base) {
  const answer = await context.request.get(`${base}/api/geo/projects`).catch(() => null);
  if (!answer || !answer.ok()) return [];
  const projects = (await answer.json().catch(() => null))?.data?.projects;
  const id = Array.isArray(projects) && typeof projects[0]?.id === "string" ? projects[0].id : null;
  if (!id) return [];
  const at = `/app/geo/${encodeURIComponent(id)}`;
  return GEO_TABS.map(([name, segment]) => [name, `${at}${segment}`]);
}

/**
 * A capability id printed as a SHOUTED key, from the deployment's own catalogue.
 *
 * This was `/\b[A-Z][A-Z-]{9,}\b/`, an open pattern over page text, and on
 * 2026-09-17 it failed the inbox for naming the EMPA-KIDNEY trial — a run's own
 * question, in a product whose subject matter is trials with acronyms like
 * that. What it was written to catch is a closed vocabulary (the 2026-09-16
 * walk found `CLINICAL-EVIDENCE-SYNTHESIS` used as a title), so it is asked of
 * the catalogue instead of guessed from the shape of a word.
 * @param {string[]} ids @returns {RegExp[]}
 */
function shoutedCapabilityKeys(ids) {
  return ids
    .filter((id) => /^[a-z][a-z0-9-]{3,}$/.test(id))
    .map((id) => new RegExp(`\\b${id.toUpperCase().replace(/-/g, "[-_ ]")}\\b`));
}

/**
 * At most four font-size × font-weight pairs per page (design spec chapter 5
 * rule 1). Reported as a NOTICE: the rule has no measured distribution yet
 * (the 2026-09-26 walk counted 4–16 per page), and a check ships as a notice
 * until it has one.
 */
export const TYPE_PAIR_NOTICE = 4;

/**
 * What one measured page view fails on, and what it is only noticed for.
 * @param {string} name the report's page name @param {"desktop" | "phone"} viewportName
 * @param {any} measured what `measure` returned for the page
 * @param {string[]} httpErrors `<status> <path>` of every response ≥ 400 the page drew
 * @returns {{ failures: string[], notices: string[] }}
 */
export function pageFindings(name, viewportName, measured, httpErrors) {
  const current = `${name}@${viewportName}`;
  const failures = [];
  const notices = [];
  // A page whose own API call is refused shows an error state and otherwise
  // measures clean: the 主动科研 page answered every load with a 400 through
  // two walks that passed (2026-09-24).
  const refused = httpErrors.filter((entry) => / \/api\//.test(entry));
  if (refused.length) failures.push(`${current}: the page's API refused it: ${refused.join(", ")}`);
  if (measured.leakHits.length) failures.push(`${current}: runtime vocabulary on the page: ${measured.leakHits.join(", ")}`);
  if (measured.backOfficeHits.length) failures.push(`${current}: the back office on the page: ${measured.backOfficeHits.join(", ")}`);
  if (measured.retiredNameHits?.length) failures.push(`${current}: a retired module name on the page: ${measured.retiredNameHits.join(", ")}`);
  if (measured.unnamedControls.length) failures.push(`${current}: ${measured.unnamedControls.length} control(s) without a name`);
  if (!measured.title || measured.title.trim() === "EviMed") failures.push(`${current}: the page has no title of its own`);
  if (measured.subtitle.length) failures.push(`${current}: the page header has a subtitle: ${measured.subtitle.join(" / ")}`);
  if ((measured.headerPrimaryActions?.length ?? 0) > 1) failures.push(`${current}: the page header has ${measured.headerPrimaryActions.length} primary actions (at most one): ${measured.headerPrimaryActions.join(" / ")}`);
  if (viewportName === "phone" && measured.overflowX) failures.push(`${current}: the page overflows horizontally at 390 px`);
  if (viewportName === "desktop") {
    const budget = { ...BUDGET, ...(BUDGET_BY_PAGE[name] ?? {}) };
    if (measured.controlKinds > budget.controls) failures.push(`${current}: ${measured.controlKinds} kinds of control (budget ${budget.controls})`);
    if (measured.colorKinds > budget.colors) failures.push(`${current}: ${measured.colorKinds} text colours (budget ${budget.colors})`);
    if (measured.borderKinds > budget.borders) failures.push(`${current}: ${measured.borderKinds} kinds of border (budget ${budget.borders})`);
    if (measured.pageLefts.length > 1) failures.push(`${current}: the page's blocks start on ${measured.pageLefts.length} left edges (${measured.pageLefts.join(", ")})`);
    for (const lefts of measured.rowTitleLefts) {
      if (lefts.length > 1) failures.push(`${current}: a list's row titles start on ${lefts.length} left edges (${lefts.join(", ")})`);
    }
    const sectionBudget = SECTION_SHAPES_BY_PAGE[name];
    const shapes = measured.sectionShapes ?? [];
    if (sectionBudget !== undefined && shapes.length > sectionBudget) failures.push(`${current}: the page stacks ${shapes.length} kinds of section (budget ${sectionBudget}): ${shapes.join(", ")}`);
    const pairs = measured.sizeWeightPairs ?? [];
    if (pairs.length > TYPE_PAIR_NOTICE) notices.push(`${current}: ${pairs.length} font-size × weight pairs (rule ${TYPE_PAIR_NOTICE}): ${pairs.join(", ")}`);
  }
  return { failures, notices };
}

/**
 * What clicking the first row of a page's lists showed. A row that looks
 * clickable has to do something where the reader is looking: open a drawer,
 * go to another page, open a new tab, or open itself in place (rule 6).
 * @param {string} name the report's page name
 * @param {Array<{ label: string, shown: boolean }>} rows one entry per list clicked
 * @returns {string[]} failures
 */
export function rowClickFindings(name, rows) {
  return rows.filter((row) => !row.shown)
    .map((row) => `${name}@desktop: clicking the first row of the list “${row.label}” showed nothing — no drawer, no page, no opened row`);
}

/**
 * Whether a click on a row changed what the reader sees: a dialog that was not
 * there, another address, a new tab, or more opened rows on the page.
 *
 * `external` is a row whose title is a link to an outside address that opens in
 * a new tab (a feed headline, a daily-brief item): the row declares what it
 * opens, and it is not counted as silent because the walk's browser reported no
 * popup — the first live walk of R10 failed both frontier pages on it, while the
 * link was a real one (2026-10-07).
 * @param {{ dialog: boolean, path: string, expanded: number }} before
 * @param {{ dialog: boolean, path: string, expanded: number }} after
 * @param {number} popups tabs the click opened
 * @param {boolean} [external] whether the row's title is a link that opens an outside address in a new tab
 */
export function rowClickShown(before, after, popups, external = false) {
  return (after.dialog && !before.dialog) || after.path !== before.path || popups > 0 || after.expanded > before.expanded || external;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required; see the header of scripts/ops/ui-walk.mjs.`);
    process.exit(2);
  }
  return value;
}

/**
 * What one page shows, measured in the page. It runs in the browser
 * (`page.evaluate`), so it reads nothing from this module; exported so a test
 * can run it over a page it describes.
 */
export function measure([leakSources, backOfficeSources, retiredSources = []]) {
  const leaks = leakSources.map(([source, flags]) => new RegExp(source, flags));
  const backOffice = backOfficeSources.map(([source, flags]) => new RegExp(source, flags));
  const retired = retiredSources.map(([source, flags]) => new RegExp(source, flags));
  // Visually hidden is not visible: the skip link until it has focus and a
  // screen-reader-only phrase are clipped to a 1 px box (`sr-only`), and the
  // skip link counted as a kind of control on every page (2026-09-27 walk).
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const clipped = cs.clip === "rect(0px, 0px, 0px, 0px)" || cs.clipPath === "inset(50%)" || (r.width <= 1 && r.height <= 1);
    return r.width > 0 && r.height > 0 && !clipped && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const text = document.body.innerText || "";
  const kinds = (values) => new Set(values).size;

  // The style inventory of the 2026-09-23 walk (the plan's §3 numbers were
  // taken with it): distinct control looks, text colours and borders.
  const all = [...document.querySelectorAll("body *")].filter(visible);
  const borders = [];
  // A status ring drawn by code — a progress-rail step, a next-step dot — is
  // a mark, not a stroke (spec §7.2: 「焦点环和进度轨的状态环不是描边」); the
  // component says so with `data-status-mark`, and its ring is not a border.
  // CSS dots/axes inside the existing chart drawing have the same role as
  // SVG strokes. Keep the drawing root's frame in the chrome inventory.
  for (const el of all.filter((node) => {
    const chart = node.closest("[data-geo-chart][aria-hidden='true']");
    return !node.closest("[data-status-mark]") && (!chart || chart === node);
  })) {
    const cs = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(cs[`border${side}Width`]) > 0
      && cs[`border${side}Style`] !== "none" && cs[`border${side}Color`] !== "rgba(0, 0, 0, 0)");
    if (!sides.length) continue;
    const side = sides[0];
    borders.push(`${sides.length === 4 ? "box" : sides.join("+").toLowerCase()} ${cs[`border${side}Width`]} ${cs[`border${side}Color`]}`);
  }
  const texty = all.filter((el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()));
  const colors = texty.map((el) => getComputedStyle(el).color);
  // Type pairs are counted in the page body, not the sidebar: the rule is
  // about what a page sets, and the chrome is the same on every page.
  const typeScope = document.querySelector("main") ?? document.body;
  const sizeWeightPairs = [...new Set(texty.filter((el) => typeScope.contains(el)).map((el) => {
    const cs = getComputedStyle(el);
    return `${cs.fontSize}/${cs.fontWeight}`;
  }))].sort();
  // A control's height, the first part of its look. A text control's height
  // is its number of lines, and a headline that wraps is the same control as
  // one that does not: an inline link by its display, and a text-only control
  // whose height is its content — no height and no minimum set on it, its box
  // a whole number of its line-height — by what surrounds the lines (its
  // vertical padding and border), not by how many there are. A list row's
  // title that wraps to 44 px counted as a second kind beside the 22 px one
  // (2026-09-27 walk). A control with a height of its own, or an icon in it,
  // keeps its measured height: a 44 px button and a two-line title are not
  // one kind.
  const sizeOf = (el, cs, r) => {
    if (cs.display === "inline") return "inline";
    const declared = typeof el.computedStyleMap === "function" ? el.computedStyleMap() : null;
    const contentSized = declared !== null && String(declared.get("height")) === "auto"
      && ["auto", "0px"].includes(String(declared.get("min-height")));
    const textOnly = !el.querySelector("svg, img, canvas, video, input, select, textarea");
    const lineHeight = parseFloat(cs.lineHeight);
    const around = ["Top", "Bottom"].reduce((sum, side) => sum + (parseFloat(cs[`padding${side}`]) || 0) + (parseFloat(cs[`border${side}Width`]) || 0), 0);
    const lines = (r.height - around) / lineHeight;
    if (contentSized && textOnly && lineHeight > 0 && Math.round(lines) >= 1 && Math.abs(lines - Math.round(lines)) < 0.05) {
      return around ? `text+${Math.round(around)}` : "text";
    }
    // A card whose CSS sets a minimum height and lets its text grow it past
    // that is one kind at every height its text gives it: the tools of 科研工具
    // (`min-h-32`) drew 136, 162 and 182 px for descriptions of three lengths
    // and failed the walk as three kinds (2026-10-06). At its minimum it is
    // measured like any other control.
    const minHeight = declared !== null ? String(declared.get("min-height")) : "auto";
    if (declared !== null && String(declared.get("height")) === "auto" && /^[\d.]+px$/.test(minHeight) && r.height > parseFloat(minHeight) + 0.5) {
      return `min${Math.round(parseFloat(minHeight))}+`;
    }
    return `${Math.round(r.height)}h`;
  };
  const looks = new Map();
  const controlLooks = all.filter((el) => el.matches("button, a, [role='button'], [role='tab'], select, input, summary")).map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const framed = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
    const filled = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "rgb(255, 255, 255)";
    const look = `${sizeOf(el, cs, r)} ${cs.fontSize}/${cs.fontWeight}${framed ? " framed" : ""}${filled ? " filled" : ""} r${cs.borderTopLeftRadius}`;
    // The report names each kind by its first control, so a page over budget
    // says which controls to converge, not only how many kinds it has.
    const seen = looks.get(look);
    if (seen) seen.count += 1;
    else {
      const name = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      looks.set(look, { count: 1, example: `${el.tagName.toLowerCase()}${name ? `: ${name}` : ""}` });
    }
    return look;
  });

  // One left edge: the title, what stands over it (the way back, 「‹ 虚拟临床研究」)
  // and the page body's top-level blocks, and within a list every row's title.
  // The body is what follows the header: a page with a way back has a block
  // before it, and taking "the first child that is not the header" measured that
  // block as the body — so the seven tabs of a study were never measured at
  // all, only their back link (2026-10-07 R10.1).
  const title = document.querySelector("main h1, h1");
  const header = title?.closest("header") ?? null;
  const column = header?.parentElement ?? null;
  const siblings = column ? [...column.children] : [];
  const at = header ? siblings.indexOf(header) : -1;
  const lead = at > 0 ? siblings.slice(0, at) : [];
  const body = at >= 0 ? siblings[at + 1] ?? null : null;
  const blocks = [title, ...lead.flatMap((el) => [...el.children]), ...(body ? [...body.children] : [])].filter((el) => el && visible(el));
  const pageLefts = [...new Set(blocks.map((el) => Math.round(el.getBoundingClientRect().left)))];
  const rowTitleLefts = [];
  for (const list of document.querySelectorAll("ul, ol")) {
    const titles = [...list.querySelectorAll(":scope > li [data-row-title]")].filter(visible);
    if (titles.length >= 2) rowTitleLefts.push([...new Set(titles.map((el) => Math.round(el.getBoundingClientRect().left)))]);
  }
  const controls = [...document.querySelectorAll("button, a, [role='button'], input, select, textarea")].filter(visible);
  const unnamed = controls.filter((el) => {
    const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("placeholder") || "").trim();
    const labelled = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    // A control wrapped in its label is named by it — `<label>分享个人背景<input
    // type="checkbox"></label>` is how this codebase writes checkboxes and file
    // inputs, and reading only `for=` called three named controls unnamed
    // (2026-09-20 walk).
    const wrapped = el.closest("label")?.textContent?.trim();
    return !name && !labelled && !wrapped && !el.getAttribute("aria-labelledby");
  });
  // DESIGN.md 「页面结构」 rule 3: the header's one primary action. A primary
  // button is the solid accent one (`bg-accent`); a header with two has a
  // second main thing to do, which is what the rule is there to remove.
  const nameOf = (el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30);
  const headerPrimaryActions = header
    ? [...header.querySelectorAll("button, a, [role='button']")].filter((el) => visible(el) && el.classList.contains("bg-accent")).map(nameOf)
    : [];
  // Rule 1: what the page body stacks. Its top-level sections — a <section>, a
  // list of rows, a table, a chart — each named by its shape; sections of one
  // shape (a group per day, a group per use) are one kind.
  const sectionScope = document.querySelector("main");
  const SECTION = "section, ul, ol, table, canvas, svg";
  const sectionUnits = sectionScope ? [...sectionScope.querySelectorAll(SECTION)].filter((el) => {
    if (!visible(el) || el.closest("header, nav, aside, [role='tablist'], [role='dialog'], li, button, a, [role='button']")) return false;
    const box = el.getBoundingClientRect();
    if (el.matches("svg, canvas") && (box.width < 160 || box.height < 64)) return false;
    if (el.matches("ul, ol") && !el.querySelector(":scope > li")) return false;
    const outer = el.parentElement?.closest(SECTION);
    return !(outer && sectionScope.contains(outer));
  }) : [];
  // A shape is the element and its first two distinct kinds of child, so a
  // list of two rows and a list of twenty are the one shape.
  const sectionShapes = [...new Set(sectionUnits.map((el) => `${el.tagName.toLowerCase()}>${[...new Set([...el.children].map((child) => child.tagName.toLowerCase()))].slice(0, 2).join("+")}`))];
  // Text a reader or a screen reader meets: the body, the tab title and the names on controls.
  const named = [...document.querySelectorAll("[aria-label], [title], [placeholder]")]
    .map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.getAttribute("placeholder") ?? ""}`).join("\n");
  const everything = `${document.title}\n${text}\n${named}`;
  return {
    title: document.title,
    controlKinds: kinds(controlLooks),
    controlLooks: Object.fromEntries(looks),
    colorKinds: kinds(colors),
    borderKinds: kinds(borders),
    sizeWeightPairs,
    pageLefts,
    rowTitleLefts,
    subtitle: header ? [...header.querySelectorAll("p")].filter(visible).map((el) => el.textContent.trim().slice(0, 60)) : [],
    backOfficeHits: backOffice.map((re) => text.match(re)?.[0]?.slice(0, 60)).filter(Boolean),
    retiredNameHits: retired.map((re) => everything.match(re)?.[0]?.slice(0, 60)).filter(Boolean),
    headerPrimaryActions,
    sectionShapes,
    leakHits: leaks.map((re) => text.match(re)?.[0]?.slice(0, 60)).filter(Boolean),
    unnamedControls: unnamed.map((el) => el.outerHTML.slice(0, 90)),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    smallTargets: controls.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).length,
    decorativeSvgs: [...document.querySelectorAll("svg")].filter((s) => visible(s) && !s.getAttribute("aria-hidden") && !s.getAttribute("role") && !s.getAttribute("aria-label")).length,
  };
}

/** A lazy route is ready only after the shell and its routed content mount. */
export function routeReady() {
  const routeMain = document.querySelector("main");
  if (!routeMain || routeMain.getBoundingClientRect().width === 0) return false;
  return ![...routeMain.querySelectorAll('[role="status"]')].some((node) => {
    const rect = node.getBoundingClientRect();
    return node.textContent?.trim() === "正在载入" && rect.width > 0 && rect.height > 0
      && getComputedStyle(node).visibility !== "hidden";
  });
}

/**
 * The first row of each list on the page, found, clicked and read again, in the
 * page (`page.evaluate`, so it reads nothing from this module). `["targets"]`
 * names the lists whose first row is a control; `["click", i]` clicks the
 * i-th; `["external", i]` says whether the i-th opens an outside address in a
 * new tab; `["state"]` reports what is on screen: whether a dialog is open, the
 * address, and how many rows are open in place. A row whose title is not a
 * control — a list of results, not a place to go — is not a target.
 */
export function rowProbe([action, index = 0]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  if (action === "state") {
    return {
      dialog: [...document.querySelectorAll("[role='dialog']")].some(visible),
      path: `${location.pathname}${location.search}`,
      expanded: document.querySelectorAll("main [aria-expanded='true']").length,
    };
  }
  const targets = [];
  for (const list of document.querySelectorAll("main ul, main ol")) {
    if (!visible(list) || list.closest("[role='dialog'], nav, aside")) continue;
    const title = [...list.querySelectorAll(":scope > li [data-row-title]")].find(visible);
    if (!title) continue;
    const control = title.matches("a, button, [role='button']") ? title : title.querySelector("a, button, [role='button']");
    if (!control) continue;
    targets.push({ control, label: (list.getAttribute("aria-label") || title.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) });
  }
  if (action === "targets") return targets.map(({ label }) => label);
  if (action === "external") {
    const control = targets[index]?.control;
    return Boolean(control && control.tagName === "A" && control.getAttribute("target") === "_blank" && /^https?:\/\//i.test(control.getAttribute("href") ?? ""));
  }
  const target = targets[index];
  if (!target) return false;
  target.control.click();
  return true;
}

async function main() {
  const base = required("OPEN_SCIENCE_WALK_BASE_URL").replace(/\/+$/, "");
  const username = required("OPEN_SCIENCE_WALK_USER");
  // Read from a file and never printed: the password is not an argument, an
  // environment value or a log line.
  const password = (await readFile(required("OPEN_SCIENCE_WALK_PASSWORD_FILE"), "utf8")).trim();
  const require = createRequire(import.meta.url);
  const playwright = require(required("OPEN_SCIENCE_PLAYWRIGHT_CORE"));
  const out = process.env.OPEN_SCIENCE_WALK_OUT?.trim() || "/tmp/evimed-ui-walk";
  await mkdir(out, { recursive: true });

  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.OPEN_SCIENCE_WALK_CHROMIUM ? { executablePath: process.env.OPEN_SCIENCE_WALK_CHROMIUM } : {}),
    args: ["--no-sandbox"],
  });
  const failures = [];
  const notices = [];
  const report = { base, startedAt: new Date().toISOString(), pages: {} };
  /** Per page view, the `start_runtime` calls the browser refused. */
  const runtimeStartsRefused = {};
  let current = "";
  let allowRuntimeStart = false;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    // The walk starts no runtime (F-G20): the shell warms the account's
    // default runtime from every page. Refused here, before any page loads;
    // let through only for the chat page, which cannot load without one.
    await context.route(/\/api\/commands\/start_runtime(?:[/?]|$)/, (route) => {
      if (allowRuntimeStart) return route.continue();
      runtimeStartsRefused[current] = (runtimeStartsRefused[current] ?? 0) + 1;
      return route.abort();
    });
    const login = await context.request.post(`${base}/api/auth/login`, {
      data: { username, password }, headers: { "content-type": "application/json" },
    });
    if (login.status() !== 200) {
      console.error(`login answered ${login.status()}; nothing was walked.`);
      return 2;
    }
    // The catalogue the leak check is derived from. An unreadable catalogue
    // fails the walk: silently checking against no ids would pass every page.
    const catalogue = await context.request.get(`${base}/api/agents`);
    const agents = catalogue.ok() ? (await catalogue.json())?.data : null;
    const ids = Array.isArray(agents) ? agents.map((agent) => String(agent?.id ?? "")).filter(Boolean) : [];
    if (ids.length < 5) {
      console.error(`the capability catalogue answered ${catalogue.status()} with ${ids.length} ids; nothing was walked.`);
      return 2;
    }
    const leaks = [...LEAKS, ...shoutedCapabilityKeys([...ids, "open-domain-answer"])];
    const routes = [...ROUTES, ...await geoProjectRoutes(context, base), ...await vcrStudyRoutes(context, base)];
    const page = await context.newPage();
    // A row that opens a link in a new tab has shown something: the tab is
    // counted and closed.
    let popups = 0;
    page.on("popup", (popup) => { popups += 1; popup.close?.().catch(() => {}); });
    const consoleErrors = {};
    const httpErrors = {};
    page.on("console", (message) => { if (message.type() === "error") (consoleErrors[current] ||= []).push(message.text().slice(0, 160)); });
    page.on("response", (response) => { if (response.status() >= 400) (httpErrors[current] ||= []).push(`${response.status()} ${new URL(response.url()).pathname.slice(0, 60)}`); });
    // An open tab after a release asks for a page chunk the new image no
    // longer has (2026-09-23 plan §2.1). Played here by refusing the inbox's
    // chunk to a fresh page and navigating to it in place: the sidebar must
    // stay and the words must be Chinese — never the router's English page.
    // First, before the phone width folds the sidebar away (its state is kept
    // per browser), and by the router's own history, not by a sidebar click.
    {
      current = "stale-chunk@desktop";
      const probe = await context.newPage();
      await probe.setViewportSize(VIEWPORTS[0][1]);
      try {
        await probe.goto(`${base}/app/capabilities`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await probe.waitForFunction(routeReady, undefined, { timeout: 30_000 });
        await probe.waitForTimeout(3_000);
        await probe.route(/\/assets\/InboxPage-[^/]+\.js$/, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "" }));
        await probe.evaluate(() => {
          window.history.pushState({}, "", "/app/inbox");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await probe.waitForTimeout(8_000);
        const state = await probe.evaluate(() => ({
          english: /Unexpected Application Error|dynamically imported module|Failed to fetch/.test(document.body.innerText),
          sidebar: Boolean(document.querySelector("aside a[href='/app/chat']")),
          text: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
        }));
        await probe.screenshot({ path: path.join(out, `${current}.png`) }).catch(() => {});
        report.pages[current] = { route: "/app/inbox (chunk refused)", ...state };
        if (state.english) failures.push(`${current}: a missing page chunk shows the router's English error page`);
        if (!state.sidebar) failures.push(`${current}: a missing page chunk takes the sidebar with it`);
      } catch (error) {
        failures.push(`${current}: the probe could not run (${String(error).slice(0, 120)})`);
      } finally {
        await probe.close().catch(() => {});
      }
    }
    for (const [viewportName, viewport] of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const [name, route] of routes) {
        current = `${name}@${viewportName}`;
        try {
          await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForFunction(routeReady, undefined, { timeout: 30_000 });
          await page.waitForTimeout(3_000);
          await page.screenshot({ path: path.join(out, `${current}.png`) });
          const measured = await page.evaluate(measure, [leaks.map((re) => [re.source, re.flags]), BACK_OFFICE.map((re) => [re.source, re.flags]),
            RETIRED_NAMES.map((re) => [re.source, re.flags])]);
          report.pages[current] = { route, ...measured, consoleErrors: consoleErrors[current] ?? [], httpErrors: httpErrors[current] ?? [],
            runtimeStartsRefused: runtimeStartsRefused[current] ?? 0 };
          const verdict = pageFindings(name, viewportName, measured, httpErrors[current] ?? []);
          failures.push(...verdict.failures);
          notices.push(...verdict.notices);
          if (viewportName === "desktop" && ROW_CLICK_PAGES.has(name)) {
            // Read-only by construction: a row's title opens a drawer, a page
            // or itself; nothing on these pages writes when it is clicked.
            const rows = [];
            const labels = ((await page.evaluate(rowProbe, ["targets"])) ?? []).slice(0, ROW_CLICK_LISTS_PER_PAGE);
            for (let index = 0; index < labels.length; index += 1) {
              if (index > 0) {
                // The last click may have opened a drawer or left the page: start the next from the page as it loads.
                await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
                await page.waitForFunction(routeReady, undefined, { timeout: 30_000 });
                await page.waitForTimeout(1_500);
              }
              const before = await page.evaluate(rowProbe, ["state"]);
              const external = await page.evaluate(rowProbe, ["external", index]);
              popups = 0;
              await page.evaluate(rowProbe, ["click", index]);
              await page.waitForTimeout(1_500);
              const after = await page.evaluate(rowProbe, ["state"]);
              rows.push({ label: labels[index], shown: rowClickShown(before, after, popups, external === true) });
            }
            report.pages[current].rowClicks = rows;
            failures.push(...rowClickFindings(name, rows));
          }
        } catch (error) {
          failures.push(`${current}: did not load (${String(error).slice(0, 120)})`);
        }
      }
    }
    if (process.env.OPEN_SCIENCE_WALK_CHAT === "1") {
      current = "chat@desktop";
      allowRuntimeStart = true;
      await page.setViewportSize(VIEWPORTS[0][1]);
      const kernelMisses = [];
      page.on("response", (response) => {
        if (response.status() >= 400 && /\/__evimed\/[ka]\//.test(new URL(response.url()).pathname)) {
          kernelMisses.push(`${response.status()} ${new URL(response.url()).pathname.slice(0, 60)}`);
        }
      });
      const chat = await walkChat(page, base).catch((error) => ({ loaded: false, error: String(error).slice(0, 160) }));
      await page.screenshot({ path: path.join(out, `${current}.png`) }).catch(() => {});
      report.pages[current] = { route: "/app/chat", ...chat, kernelMisses, consoleErrors: consoleErrors[current] ?? [] };
      if (!chat.loaded) failures.push(`${current}: the conversation frame did not load (${chat.error ?? chat.state ?? "no composer"})`);
      else if (chat.retriedAfterNetworkChange) notices.push(`${current}: loaded after one 重试 — the walk's host network changed while the runtime started (${chat.retriedAfterNetworkChange} request(s) dropped)`);
      if (kernelMisses.length) failures.push(`${current}: kernel application files answered ${kernelMisses.join(", ")}`);
    }
    // Log out for real: the request needs the shell's origin and the
    // session's CSRF token (under `data` in /api/me), and without them the
    // logout answered 403 and left a seven-day session behind after every
    // walk. Checked, not assumed — /api/me must answer 401 afterwards.
    const me = await context.request.get(`${base}/api/me`).catch(() => null);
    const csrf = me?.ok() ? (await me.json().catch(() => ({})))?.data?.csrfToken : undefined;
    const logout = await context.request.post(`${base}/api/auth/logout`, {
      headers: { origin: base, ...(csrf ? { "x-open-science-csrf": String(csrf) } : {}) },
    }).catch(() => null);
    const after = await context.request.get(`${base}/api/me`).catch(() => null);
    report.logout = { status: logout?.status() ?? null, meAfter: after?.status() ?? null };
    if (after?.status() !== 401) failures.push(`logout: /api/me still answers ${after?.status() ?? "nothing"} after logging out — the walk's session is alive`);
  } finally {
    await browser.close();
  }
  report.failures = failures;
  report.notices = notices;
  report.runtimeStartsRefused = Object.values(runtimeStartsRefused).reduce((sum, count) => sum + count, 0);
  await writeFile(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  for (const notice of notices) console.log(`NOTICE ${notice}`);
  console.log(`${Object.keys(report.pages).length} page views walked, ${failures.length} failure(s), ${notices.length} notice(s), `
    + `${report.runtimeStartsRefused} runtime start(s) refused; report and screenshots in ${out}`);
  return failures.length ? 1 : 0;
}

/**
 * Open the conversation page and wait for the kernel frame's composer.
 *
 * The walk runs on the host's network, and opening the chat starts the
 * account's runtime container: Docker adds an interface, Chromium reports
 * ERR_NETWORK_CHANGED and drops the requests in flight, and the page says
 * 打开超时，请重试 (release walks of 2026-09-28). A reader's browser is not on
 * the host's network and never sees that, so when the page fails after such a
 * change the walk presses the page's own 重试 once, as a reader would, and
 * says so in the report instead of failing the release on its own vantage.
 * @param {any} page @param {string} base
 */
async function walkChat(page, base) {
  let networkChanged = 0;
  const onFailed = (request) => { if (/ERR_NETWORK_CHANGED/.test(request.failure()?.errorText ?? "")) networkChanged += 1; };
  page.on?.("requestfailed", onFailed);
  try {
    await page.goto(`${base}/app/chat`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let retried = false;
    let deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3_000);
      for (const frame of page.frames()) {
        if (!frame.url().includes("/__evimed/f/")) continue;
        const seen = await frame.evaluate(() => ({
          composer: document.querySelectorAll("textarea, [contenteditable='true']").length > 0,
          stats: [...document.querySelectorAll("[data-composer-stats]")].map((node) => node.textContent?.trim() ?? ""),
        })).catch(() => null);
        if (seen?.composer) return { loaded: true, statsLine: seen.stats.join(" | ") || null, ...(retried ? { retriedAfterNetworkChange: networkChanged } : {}) };
      }
      const shell = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (/秒内没有载入完成|无法载入|载入失败|打开超时|暂时无法打开|无法连接/.test(shell)) {
        if (!retried && networkChanged > 0) {
          const retry = page.getByRole("button", { name: "重试" });
          if (await retry.count().catch(() => 0)) {
            retried = true;
            await retry.first().click().catch(() => {});
            deadline = Date.now() + 120_000;
            continue;
          }
        }
        return { loaded: false, state: shell.split("\n").find((line) => /载入|超时|无法/.test(line))?.slice(0, 80), networkChanged };
      }
    }
    return { loaded: false, state: "no composer within two minutes", networkChanged };
  } finally {
    page.off?.("requestfailed", onFailed);
  }
}

// Run only as a program: the tests import the budgets and the verdict. By
// real path, because the host runs it through `current`, a symlink.
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`walk failed: ${String(error).slice(0, 300)}`);
    process.exit(2);
  });
}
