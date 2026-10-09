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
 *     reader is looking (rule 6); a row whose title is a link to an outside
 *     address in a new tab (a feed headline) declares what it opens and is
 *     not silent for the browser reporting no popup;
 *   - at 390 px nothing overflows horizontally;
 *   - at the desktop width, the style budget of §7: at most 8 kinds of
 *     control (9 on the frontier feed, whose headlines are links; 10 on a
 *     data page — the knowledge base and 循证 GEO), 5 text colours (8 on the
 *     frontier feed, which adds the safety red and the rank colours; 7 on a
 *     data page) and 3 kinds of border (6 on a GEO project's tabs, the
 *     measured number — see GEO_BUDGET), with each kind of control named in
 *     the report by its first example; the title and the page
 *     body's blocks — the way back over the title, and the body that follows
 *     the header — start on one left edge; within a list, every row's title
 *     (`[data-row-title]`) starts on one left edge;
 *   - no page is replaced by the router's English error page, and a lazy page
 *     whose chunk is gone (the state an open tab is in after a release) keeps
 *     the sidebar and says so in Chinese;
 *   - no call a page makes to the control plane's API is refused (4xx/5xx).
 *
 * R11 (the two front-end audits of 2026-10-07) added what each fix left behind to look for, in two kinds. A check that guards a
 * defect the release fixed and is measured exactly — an element is there or not, an attribute, a computed width, an answer the walk
 * stubs itself — fails: the sidebar is one landmark that is inert when closed and not a Tab stop, a region that scrolls sideways is a Tab
 * stop or holds one, the heading levels of GEO's overview and the memory page go down one at a time, a phone's rail and
 * study counts are folded and not cut off, a record that is not there says so and goes back to its list, 关注 is one sentence and one
 * button, the memory page opens on a tab that holds something, a PDF's original opens wide and fit to width, the new-skill drawer
 * names an empty field in place, the evidence matrix opens a dialog from a row and Escape returns the focus. What depends on the
 * account's data or is a measure of taste is a NOTICE: a page more than twelve viewports tall, more rows on a first screen than the
 * page's ceiling, a headline below 520 px on a phone, the title column of a page against the others'. Pages no walk has measured
 * yet (`PROVISIONAL_PAGES`) report a number past their budget as a notice too. Nothing here writes: the steps that click only open a
 * menu, a drawer, a tab or a row, the new-skill drawer's 保存 is pressed with every request that is not a read refused in the
 * browser, and the chat's cleanup cover is the walk's own answer to `start_runtime` (asked for with the chat page; it waits up to
 * 135 s for the shell to give up, which `OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS=0` skips).
 *
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
 *   [OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS=0] \
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
  // 关注 (R11): what an account that follows nothing sees — one sentence and one way to start — and what one that follows something does.
  ["frontier-following", "/app/frontier?view=following"],
  // The evidence zones' home (2026-10-01). A zone and a reading page are
  // content addresses with ids; the home is the one every account can open.
  ["frontier-zones", "/app/frontier/zones"],
  ["capabilities", "/app/capabilities"],
  // 循证 GEO's home — its one sentence where the account is not offered the
  // module; one project's seven tabs (and an answer) are added when the
  // account has one (`discoverRoutes`).
  ["geo", "/app/geo"],
  // 虚拟临床研究's home — its one sentence where the account is not offered
  // the module; one study's seven tabs are added when the account has one.
  ["virtual-research", "/app/virtual-research"],
  // The home's three libraries (R11): the first live walk of R10 opened a study and never these tabs.
  ["virtual-research-models", "/app/virtual-research?tab=models"],
  ["virtual-research-precedents", "/app/virtual-research?tab=precedents"],
  ["virtual-research-definitions", "/app/virtual-research?tab=definitions"],
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
  // 通知 (where Feishu is bound) and 运维 (an operator's; any other account is shown the first section, and the checks on it say so).
  ["account-notifications", "/app/account?tab=notifications"],
  ["account-ops", "/app/account?tab=ops"],
  // The simulated wallet has two pages; membership and refunds are not among them and answer the not-found page (R11).
  ["account-simulated-membership", "/app/account/simulated/membership"],
  ["account-simulated-refunds", "/app/account/simulated/refunds"],
  // A share link that does not exist: the page says so and offers the way back, not a retry (R11). Its own read answers 4xx by design.
  ["memory-shared-missing", "/app/memory/shared/impeccable-audit-missing"],
  // The extension centre's two lists (2026-10-02), reached from 设置. Neither
  // was walked until 2026-10-03: the list above was written before they were.
  ["extensions-plugins", "/app/extensions/plugins"],
  ["extensions-skills", "/app/extensions/skills"],
  // A plugin and a skill that are not there (R11): the drawer says so and goes back to its list instead of advising a retry.
  ["extensions-plugin-missing", "/app/extensions/plugins/impeccable-audit-missing"],
  ["extensions-skill-missing", "/app/extensions/skills/impeccable-audit-missing"],
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
 * failed the 2026-10-07 walk of the memory page). 「已核对 41/72」 is the
 * ledger's count; the evidence card's own tag, 「引文已核对 1/2」 (R13, E-12), is
 * a label a reader weighs the card by and is not that.
 */
export const BACK_OFFICE = [
  /(?<!\p{Script=Han})已交付(?!\p{Script=Han})/u, /核对\s*\d+\s*条/, /(?<!引文)已核对\s*\d+\s*[\/／]/, /用过\s*\d+\s*次/, /\d+月\d+日\s*起生效/, /缓存命中/, /tok\/s/,
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
  // The zones' home is a frontier page: the same rail and tabs, measured at nine. It also draws four kinds of border where the feed
  // draws two — the tab row's hairline and the selected tab's underline, the rule between zones, and the frame of the topic request's
  // field — the measured number of the first live walk of R10 (2026-10-07), not a wish: the field is the page's one input, and the
  // other three are the tabs' and the list's own. A fifth is a new kind of border, which is what this budget is for.
  "frontier-zones": { ...FRONTIER_BUDGET, borders: 4 },
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
  // R11 pages, walked for the first time with the release that built them. Their numbers are the designed ones (the feed's, a data
  // page's), so they are in PROVISIONAL_PAGES: a number they exceed is a notice until a walk has measured them.
  "frontier-following": FRONTIER_BUDGET, "frontier-zone": FRONTIER_BUDGET, "frontier-evidence": FRONTIER_BUDGET,
  "frontier-author": FRONTIER_BUDGET, "frontier-event": FRONTIER_BUDGET,
  "geo-answer": GEO_BUDGET,
  "virtual-research-models": DATA_BUDGET, "virtual-research-precedents": DATA_BUDGET, "virtual-research-definitions": DATA_BUDGET,
  "evidence-matrix": DATA_BUDGET,
  // R13 (E-19): a document has a page of its own, the original beside what it says; the first walk of it reports its numbers.
  "files-reader": DATA_BUDGET,
};

/**
 * Pages that no walk has measured yet: the numbers above are designed, not observed. What a page of this list spends past its budget
 * — kinds of control, colour and border, left edges, kinds of section — is a NOTICE, with the page's numbers in the report; the
 * checks that do not depend on a number (vocabulary, names, titles, one primary action, overflow, a refused call) stay failures.
 * A page leaves the list when a walk has reported its numbers and the budget has been set from them (principle 4: a check ships as
 * a notice until it has a distribution).
 */
export const PROVISIONAL_PAGES = new Set([
  "frontier-following", "frontier-zone", "frontier-evidence", "frontier-author", "frontier-event",
  "geo-answer",
  "virtual-research-models", "virtual-research-precedents", "virtual-research-definitions",
  "account-notifications", "account-ops", "memory-shared-missing", "extensions-plugin-missing", "extensions-skill-missing",
  "evidence-matrix", "files-reader",
]);

/**
 * The page a view is held to the budget of. The second study of the virtual-research walk is named `vcr-trial@2` and is the same
 * page as `vcr-trial`.
 * @param {string} name the report's page name
 */
export function budgetKey(name) {
  return name.replace(/@\d+$/, "");
}

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
  frontier: 3, "frontier-hot": 3, "frontier-daily": 3, "frontier-all": 3, "frontier-following": 3,
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
  // R11 (re-aimed in R13, V-11): a source row opens a drawer (it opened its three conditions in place), a scheduled-task row goes to the
  // task's own page (it opened a drawer). Both read what the row holds and write nothing.
  "geo-sources", "autopilot",
  // R13 (V-11, V-7): the rows of 问题与回答 and the findings of 准确与安全 (the 看回答 link), and the pages the reference named for a
  // first-row click (design reference §21.3): the inbox, settings, 循证 GEO's home and the evidence zones' home. New coverage, so a
  // click that shows nothing there is a notice (`NOTICE_ROW_CLICK_PAGES`).
  "geo-questions", "geo-accuracy", "inbox", "account", "geo", "frontier-zones",
]);
/**
 * The pages of `ROW_CLICK_PAGES` whose first-row click is new in R13: what it shows is reported, and a click that shows nothing is a
 * notice, not a failure, until a walk has reported how these pages behave (principle 4: a check ships as a notice first). The pages that
 * were clicked before R13 keep failing on a row that does nothing.
 */
export const NOTICE_ROW_CLICK_PAGES = new Set(["geo-questions", "geo-accuracy", "inbox", "account", "geo", "frontier-zones"]);
/**
 * Pages whose first rows are not on the page when it loads. 问题与回答 draws its groups closed, and a group's measured questions — the
 * rows — are inside it: the walk opens the groups (a click on a disclosure toggle, which only shows more of the page) before it looks
 * for a row. The selector names the toggles; at most `ROW_REVEAL_LIMIT` are opened.
 */
export const ROW_REVEAL_BY_PAGE = { "geo-questions": "[data-geo-group] button[aria-expanded='false']" };
const ROW_REVEAL_LIMIT = 12;
/**
 * Pages whose findings are cards, not rows of a list: the one thing on a card that opens is its link. 准确与安全's 讲错清单 draws each
 * finding as an `<article>` with a 「看回答」 link to the answer that says it, in no list and with no row title, so the list probe finds
 * nothing there. The selector names those links; the first one is the page's first "row".
 */
export const ROW_LINK_BY_PAGE = { "geo-accuracy": { label: "讲错清单", selector: "[data-geo-error-list] a[href*='/answers/']" } };
/** The lists of one page the walk clicks at most; a skills page has six groups, and the first row of each is enough to prove the pattern. */
const ROW_CLICK_LISTS_PER_PAGE = 8;

/**
 * The 虚拟临床研究 studies to walk: the one with the most steps done (a step that is `done` or `minimal` has produced something to
 * read), and the first other one. The walk used to open `studies[0]` only, which was a population-only study, so the trial,
 * comparator, patients and matching pages of a study that had run never met it (R11). Ties go to the list's order.
 * @param {unknown} studies `GET /api/vcr/studies` → `data.studies`
 * @returns {{ primary: string | null, second: string | null }}
 */
export function pickVcrStudies(studies) {
  const rows = Array.isArray(studies) ? studies.filter((row) => typeof row?.id === "string") : [];
  const produced = (row) => Object.values(row.steps ?? {}).filter((step) => ["done", "minimal"].includes(step?.status)).length;
  let primary = null;
  for (const row of rows) if (primary === null || produced(row) > produced(primary)) primary = row;
  const second = rows.find((row) => row !== primary) ?? null;
  return { primary: primary?.id ?? null, second: second?.id ?? null };
}

/**
 * The snapshot an answer page is walked for: the answer that holds the first listed wrong sentence, else the error's own snapshot.
 * @param {unknown} diagnosis `GET /api/geo/projects/:id/diagnosis` → `data`
 * @returns {string | null}
 */
export function geoAnswerSnapshot(diagnosis) {
  const errors = Array.isArray(/** @type {any} */ (diagnosis)?.errors) ? /** @type {any} */ (diagnosis).errors : [];
  for (const error of errors) {
    for (const candidate of [error?.firstSnapshotId, error?.snapshotId]) if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

/**
 * The ids of the 前沿动态 pages the walk opens, from the lists it reads: the first evidence zone, the first card of the first official
 * zone, that card's author and the first event on the hot list. A missing id is a page not walked, with the reason in the notices.
 * @param {{ zones?: any, cards?: any, links?: any, hot?: any }} read the `data` of each GET
 * @returns {{ zoneId: string | null, official: string | null, cardId: string | null, authorId: string | null, eventId: string | null }}
 */
export function frontierTargets({ zones, cards, links, hot }) {
  const text = (value) => (typeof value === "string" && value ? value : null);
  const zoneList = Array.isArray(zones?.items) ? zones.items : [];
  const cardList = Array.isArray(cards?.items) ? cards.items : [];
  const events = Array.isArray(hot?.events) ? hot.events : [];
  return {
    zoneId: text(zoneList[0]?.id),
    official: text(zoneList.find((zone) => zone?.kind === "official")?.id),
    cardId: text(cardList[0]?.id),
    authorId: text(links?.author?.id),
    eventId: text(events[0]?.id),
  };
}

/**
 * The run and path of a finished evidence matrix, from the run list: the newest delivered `clinical-evidence-synthesis` deliverable,
 * whose package holds `clinical-evidence-matrix.json` beside the report (the one capability that writes it).
 * @param {unknown} runs `GET /api/agent-runs` → `data`
 * @returns {string | null} the reader route, or null
 */
export function matrixRoute(runs) {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (typeof run?.id !== "string") continue;
    const done = (Array.isArray(run.deliverables) ? run.deliverables : [])
      .find((item) => item?.capability === "clinical-evidence-synthesis" && ["accepted", "delivered"].includes(item?.status) && typeof item?.id === "string");
    if (done) return `/app/runs/${encodeURIComponent(run.id)}/files/deliverables/${encodeURIComponent(done.id)}/clinical-evidence-matrix.json`;
  }
  return null;
}

/**
 * The title of a finished PDF in the project's knowledge base, to open its original.
 * @param {unknown} page `GET /api/sources` → `data`
 * @returns {string | null}
 */
export function pdfSourceTitle(page) {
  const items = Array.isArray(/** @type {any} */ (page)?.items) ? /** @type {any} */ (page).items : [];
  const found = items.find((item) => item?.display?.format === "pdf" && item?.payload?.status === "complete" && typeof item?.display?.title === "string" && item.display.title.trim());
  return found ? found.display.title.trim() : null;
}

/**
 * The address of a document's own page (`/app/files/:sourceId`, R13 E-19), from the project's knowledge-base list: the first document
 * that has been read to the end. Like the zone, the card and the answer, a page whose address holds an id is walked at the id the
 * deployment's own list names, and not at all (with a notice saying why) where the list names none.
 * @param {unknown} page `GET /api/sources` → `data`
 * @returns {string | null}
 */
export function sourceReaderRoute(page) {
  const items = Array.isArray(/** @type {any} */ (page)?.items) ? /** @type {any} */ (page).items : [];
  const found = items.find((item) => item?.payload?.status === "complete" && typeof item?.id === "string" && item.id);
  return found ? `/app/files/${encodeURIComponent(found.id)}` : null;
}

/**
 * The data sources that need no key and that nobody has given one: each reads 可选 in 设置 → 数据源, never 未配置 (that word is for a
 * source a capability cannot work without).
 * @param {unknown} connectors `GET /api/connectors` → `data`
 * @returns {string[]}
 */
export function keylessTitles(connectors) {
  return (Array.isArray(connectors) ? connectors : [])
    .filter((item) => item?.keyless === true && item?.source === "none" && typeof item?.title === "string" && item.title)
    .map((item) => item.title);
}

/** Read one JSON `data` from the deployment, or null: a page whose id cannot be read is not walked, and the walk says so. */
async function readData(context, base, pathname) {
  const answer = await context.request.get(`${base}${pathname}`).catch(() => null);
  if (!answer || !answer.ok()) return null;
  return (await answer.json().catch(() => null))?.data ?? null;
}

/**
 * The pages whose address holds an id the deployment's own lists name, read from the same GET endpoints the pages use: one GEO
 * project's seven tabs and an answer; the 虚拟临床研究 studies' seven tabs each; the 前沿动态 zone, card, author and event pages.
 * Each is None where the module is off for the account or the list is empty — the home pages are walked either way. A page left out
 * for want of an id is a notice, never a pass that looks like a walk.
 * @param {any} context a logged-in browser context @param {string} base @param {string[]} notices
 * @returns {Promise<{ routes: Array<[string, string]>, matrix: string | null, pdfTitle: string | null, keyless: string[] }>}
 */
async function discoverRoutes(context, base, notices) {
  /** @type {Array<[string, string]>} */
  const routes = [];
  const skip = (name, why) => notices.push(`${name}: not walked — ${why}`);

  const geo = (await readData(context, base, "/api/geo/projects"))?.projects;
  const geoId = Array.isArray(geo) && typeof geo[0]?.id === "string" ? geo[0].id : null;
  if (geoId) {
    const at = `/app/geo/${encodeURIComponent(geoId)}`;
    routes.push(...GEO_TABS.map(([name, segment]) => /** @type {[string, string]} */ ([name, `${at}${segment}`])));
    const snapshot = geoAnswerSnapshot(await readData(context, base, `/api/geo/projects/${encodeURIComponent(geoId)}/diagnosis`));
    if (snapshot) routes.push(["geo-answer", `${at}/answers/${encodeURIComponent(snapshot)}`]);
    else skip("geo-answer", "the first project lists no wrong sentence with an answer");
  }

  const { primary, second } = pickVcrStudies((await readData(context, base, "/api/vcr/studies"))?.studies);
  for (const [id, suffix] of [[primary, ""], [second, "@2"]]) {
    if (!id) continue;
    const at = `/app/virtual-research/${encodeURIComponent(id)}`;
    routes.push(...VCR_TABS_WALK.map(([name, segment]) => /** @type {[string, string]} */ ([`${name}${suffix}`, `${at}${segment}`])));
  }
  if (primary && !second) skip("vcr-*@2", "the account has one study");

  const zones = await readData(context, base, "/api/frontier/zones");
  const hot = await readData(context, base, "/api/frontier/hot");
  const first = frontierTargets({ zones, hot });
  const cards = first.official ? await readData(context, base, `/api/frontier/zones/${encodeURIComponent(first.official)}/evidence`) : null;
  const cardId = frontierTargets({ cards }).cardId;
  const links = cardId ? await readData(context, base, `/api/frontier/evidence/${encodeURIComponent(cardId)}/links`) : null;
  const targets = { ...first, cardId, authorId: frontierTargets({ links }).authorId };
  if (targets.zoneId) routes.push(["frontier-zone", `/app/frontier/zones/${encodeURIComponent(targets.zoneId)}`]);
  else skip("frontier-zone", "the evidence zones are not offered to this account or the list is empty");
  if (targets.official && targets.cardId) routes.push(["frontier-evidence", `/app/frontier/zones/${encodeURIComponent(targets.official)}/evidence/${encodeURIComponent(targets.cardId)}`]);
  else skip("frontier-evidence", "no official zone holds a card");
  if (targets.authorId) routes.push(["frontier-author", `/app/frontier/authors/${encodeURIComponent(targets.authorId)}`]);
  else skip("frontier-author", "the first card names no author page");
  if (targets.eventId) routes.push(["frontier-event", `/app/frontier/events/${encodeURIComponent(targets.eventId)}`]);
  else skip("frontier-event", "the hot list is empty or not offered");

  const matrix = matrixRoute(await readData(context, base, "/api/agent-runs"));
  if (!matrix) skip("evidence-matrix", "no run of this account delivered a clinical-evidence package");
  const sources = await readData(context, base, "/api/sources?projectId=default&limit=50");
  const pdfTitle = pdfSourceTitle(sources);
  if (!pdfTitle) skip("files: the original of a PDF", "the knowledge base holds no finished PDF");
  // A document's own page (R13): the reader is a page of the knowledge base, found from its list like the other pages with an id.
  const reader = sourceReaderRoute(sources);
  if (reader) routes.push(["files-reader", reader]);
  else skip("files-reader", "the knowledge base holds no finished document");
  return { routes, matrix, pdfTitle, keyless: keylessTitles(await readData(context, base, "/api/connectors")) };
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
  const key = budgetKey(name);
  const failures = [];
  const notices = [];
  // What a page spends past a designed number: a failure, except on a page no walk has measured yet (`PROVISIONAL_PAGES`).
  const budgetFindings = [];
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
    const budget = { ...BUDGET, ...(BUDGET_BY_PAGE[key] ?? {}) };
    if (measured.controlKinds > budget.controls) budgetFindings.push(`${current}: ${measured.controlKinds} kinds of control (budget ${budget.controls})`);
    if (measured.colorKinds > budget.colors) budgetFindings.push(`${current}: ${measured.colorKinds} text colours (budget ${budget.colors})`);
    if (measured.borderKinds > budget.borders) budgetFindings.push(`${current}: ${measured.borderKinds} kinds of border (budget ${budget.borders})`);
    if (measured.pageLefts.length > 1) budgetFindings.push(`${current}: the page's blocks start on ${measured.pageLefts.length} left edges (${measured.pageLefts.join(", ")})`);
    for (const lefts of measured.rowTitleLefts) {
      if (lefts.length > 1) budgetFindings.push(`${current}: a list's row titles start on ${lefts.length} left edges (${lefts.join(", ")})`);
    }
    const sectionBudget = SECTION_SHAPES_BY_PAGE[key];
    const shapes = measured.sectionShapes ?? [];
    if (sectionBudget !== undefined && shapes.length > sectionBudget) budgetFindings.push(`${current}: the page stacks ${shapes.length} kinds of section (budget ${sectionBudget}): ${shapes.join(", ")}`);
    const pairs = measured.sizeWeightPairs ?? [];
    if (pairs.length > TYPE_PAIR_NOTICE) notices.push(`${current}: ${pairs.length} font-size × weight pairs (rule ${TYPE_PAIR_NOTICE}): ${pairs.join(", ")}`);
  }
  if (PROVISIONAL_PAGES.has(key)) notices.push(...budgetFindings.map((finding) => `${finding} — provisional: this page has not been measured by a walk yet`));
  else failures.push(...budgetFindings);
  return { failures, notices };
}

/**
 * The refusals of a page's own API calls that the page is walked to meet: a skill and a share link that do not exist answer 404
 * (and a malformed or closed share, 400 and 410), and the page is expected to say so in words. Every other refusal stays a failure.
 */
export const EXPECTED_REFUSALS = {
  "extensions-skill-missing": [404],
  "memory-shared-missing": [400, 404, 410],
};

/**
 * `<status> <path>` of the responses a page drew, without the refusals it was walked to meet (`EXPECTED_REFUSALS`).
 * @param {string} name the report's page name @param {string[]} httpErrors
 * @returns {string[]}
 */
export function unexpectedRefusals(name, httpErrors) {
  const allowed = EXPECTED_REFUSALS[/** @type {keyof typeof EXPECTED_REFUSALS} */ (budgetKey(name))] ?? [];
  return httpErrors.filter((entry) => !(allowed.includes(Number(entry.split(" ")[0])) && / \/api\//.test(entry)));
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
 * What the first-row clicks of a page come to: a row that shows nothing fails the pages that have been clicked since R10/R11, and is a
 * notice on the pages whose click is new in R13 (`NOTICE_ROW_CLICK_PAGES`). A page where nothing could be clicked — the account has no
 * row there, or the page draws none — says so, so that the absence of a failure is not read as a pass: the assertion has to prove it
 * reached its target.
 * @param {string} name the report's page name
 * @param {Array<{ label: string, shown: boolean }>} rows one entry per list clicked
 * @returns {{ failures: string[], notices: string[] }}
 */
export function rowClickVerdict(name, rows) {
  const nothing = rowClickFindings(name, rows);
  const notices = rows.length === 0
    ? [`${name}@desktop: not observable: no list on the page has a first row that opens (an empty list, a page without rows, or an account with none), so no click was made`]
    : [];
  return NOTICE_ROW_CLICK_PAGES.has(budgetKey(name)) ? { failures: [], notices: [...nothing, ...notices] } : { failures: nothing, notices };
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

/* ------------------------------------------------------------------------- R11 */

/**
 * The structure of one page view, measured in the page (`page.evaluate`, so it reads nothing from this module): the sidebar
 * landmark, the regions that scroll sideways, the order of the headings, the page's height and a few counts that the checks of
 * `structureFindings` compare. Separate from `measure`, which is the style inventory.
 */
export function measureStructure() {
  // `checkVisibility` is what says that the inside of a closed <details> is not there: its boxes keep their last size.
  const rendered = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && rendered(el);
  };
  const main = document.querySelector("main");
  const scope = main ?? document.body;
  const hasAttribute = (el, name) => el.getAttribute(name) !== null;

  // The sidebar is one landmark that holds its own divider; collapsed, it is inert (the column is 0 wide and clipped, not gone).
  const sidebars = [...document.querySelectorAll("aside")].filter((el) => el.getAttribute("aria-label") === "侧栏");
  const sidebar = sidebars[0] ?? null;
  const side = {
    landmarks: sidebars.length,
    holdsDivider: sidebar ? [...sidebar.querySelectorAll("*")].some((el) => el.getAttribute("role") === "separator") : false,
    chatLink: sidebar ? [...sidebar.querySelectorAll("a")].some((el) => el.getAttribute("href") === "/app/chat") : false,
    closed: sidebar ? sidebar.getBoundingClientRect().width <= 1 : false,
    inert: sidebar ? hasAttribute(sidebar, "inert") || sidebar.inert === true : false,
  };

  // Regions that scroll sideways must be reachable by the keyboard — focusable themselves, or holding something focusable — and a
  // region that is a tab stop of its own needs a name (axe `scrollable-region-focusable`).
  const scrollers = [];
  let tallest = Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0);
  for (const el of [...document.querySelectorAll("body *")]) {
    const cs = getComputedStyle(el);
    if (["auto", "scroll"].includes(cs.overflowY) && el.clientHeight > 0 && el.scrollHeight > tallest) tallest = el.scrollHeight;
    if (!["auto", "scroll"].includes(cs.overflowX) || !scope.contains(el)) continue;
    if (!(el.clientWidth > 0) || !(el.scrollWidth > el.clientWidth + 1) || !visible(el)) continue;
    const stop = el.tabIndex >= 0;
    const holds = [...el.querySelectorAll("*")].some((child) => child.tabIndex >= 0 && visible(child));
    scrollers.push({
      label: (el.getAttribute("aria-label") || el.getAttribute("class") || el.tagName.toLowerCase()).slice(0, 40),
      reachable: stop || holds,
      stop: stop && hasAttribute(el, "tabindex"),
      named: Boolean(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title")),
    });
  }

  // Heading levels go down one at a time: an h3 straight under the h1 is a heading the page skipped (axe `heading-order`). A heading
  // that is only for screen readers counts, which is why this asks whether it is rendered, not whether it can be seen.
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
    .filter((el) => rendered(el) && scope.contains(el) && !el.closest("[role='dialog']"));
  const headingJumps = [];
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    if (previous > 0 && level > previous + 1) headingJumps.push(`h${previous}→h${level} “${(heading.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24)}”`);
    previous = level;
  }

  // The top-level rows of the page's lists, the row titles that read alike, and the labels of the study counts that are cut off.
  const rows = [...scope.querySelectorAll("li")]
    .filter((el) => visible(el) && !el.closest("[role='dialog'], nav, aside") && !el.parentElement?.closest("li")).length;
  const titles = [...scope.querySelectorAll("[data-row-title]")].filter((el) => visible(el) && !el.closest("[role='dialog']"))
    .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const duplicateTitles = [...new Set(titles.filter((title, index) => titles.indexOf(title) !== index))];
  const truncatedCounts = [...document.querySelectorAll("[data-vcr-count]")].filter(visible)
    .filter((el) => [el, el.previousElementSibling].some((part) => part && part.scrollWidth > part.clientWidth + 1)).length;

  return {
    sidebar: side,
    scrollers,
    headingJumps,
    height: Math.round(tallest),
    viewport: window.innerHeight,
    rows,
    duplicateTitles,
    truncatedCounts,
  };
}

/** The pages whose heading order was fixed in R11: a heading that skips a level there fails; elsewhere it is noticed. */
export const HEADING_ORDER_PAGES = new Set(["geo-overview", "memory"]);
/** Pages whose first screen of rows has a designed ceiling (R11: 准确与安全's cards, 信源's rows); more is noticed, since rows are data. */
export const ROW_COUNT_NOTICE_BY_PAGE = { "geo-accuracy": 20, "geo-sources": 40 };
/** A page this many viewports tall is noticed: GEO's answer page was 69,000 px (R11). */
export const TALL_PAGE_VIEWPORTS = 12;
/** The settings list in which two projects must not read alike. */
export const PROJECT_LIST_PAGES = new Set(["account-projects"]);

/**
 * What the page-wide structure fails on, and what it is only noticed for. The structure that guards a defect R11 fixed and that is
 * measured exactly (an element or an attribute is there or not) fails; the height and the row counts, which depend on the data, are
 * notices.
 * @param {string} name the report's page name @param {"desktop" | "phone"} viewportName
 * @param {ReturnType<typeof measureStructure> | null | undefined} s
 * @returns {{ failures: string[], notices: string[] }}
 */
export function structureFindings(name, viewportName, s) {
  const current = `${name}@${viewportName}`;
  const key = budgetKey(name);
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!s) return { failures, notices };
  const side = s.sidebar;
  if (side.landmarks !== 1) failures.push(`${current}: ${side.landmarks} sidebar landmarks named 侧栏 (exactly one)`);
  else {
    if (!side.holdsDivider) failures.push(`${current}: the sidebar landmark does not hold its divider`);
    if (!side.chatLink) failures.push(`${current}: the sidebar has no link to the conversation`);
    if (viewportName === "phone" && side.closed && !side.inert) failures.push(`${current}: the closed sidebar is not inert — its links are still tab stops`);
  }
  const unreachable = s.scrollers.filter((region) => !region.reachable);
  if (unreachable.length) failures.push(`${current}: ${unreachable.length} region(s) scroll sideways and are no tab stop and hold none: ${unreachable.map((region) => region.label).join(", ")}`);
  const unnamed = s.scrollers.filter((region) => region.stop && !region.named);
  if (unnamed.length) failures.push(`${current}: ${unnamed.length} focusable scrolling region(s) without a name: ${unnamed.map((region) => region.label).join(", ")}`);
  if (s.headingJumps.length) {
    (HEADING_ORDER_PAGES.has(key) ? failures : notices).push(`${current}: heading levels skip: ${s.headingJumps.join(", ")}`);
  }
  if (s.viewport > 0 && s.height > TALL_PAGE_VIEWPORTS * s.viewport) {
    notices.push(`${current}: the page is ${s.height} px tall, ${(s.height / s.viewport).toFixed(1)} viewports (notice above ${TALL_PAGE_VIEWPORTS})`);
  }
  const rowCeiling = ROW_COUNT_NOTICE_BY_PAGE[/** @type {keyof typeof ROW_COUNT_NOTICE_BY_PAGE} */ (key)];
  if (viewportName === "desktop" && rowCeiling !== undefined && s.rows > rowCeiling) notices.push(`${current}: ${s.rows} rows on the first screen of data (notice above ${rowCeiling})`);
  if (PROJECT_LIST_PAGES.has(key) && s.duplicateTitles.length) failures.push(`${current}: two projects read alike in the list: ${s.duplicateTitles.join(", ")}`);
  if (viewportName === "phone" && s.truncatedCounts > 0) failures.push(`${current}: ${s.truncatedCounts} count label(s) of the study are cut off at 390 px`);
  return { failures, notices };
}

/** Where keyboard focus is: what it names and whether it is inside the sidebar. */
export function focusProbe() {
  const el = document.activeElement;
  if (!el || el === document.body) return { text: "", inSidebar: false };
  return {
    text: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
    inSidebar: el.closest("[data-sidebar]") !== null,
  };
}

/**
 * The first two Tab stops of a page at 390 px. The first is the skip link; with the sidebar closed the second must not be in it —
 * its forty-odd links were tab stops the reader could not see (2026-10-07 audit B-02).
 * @param {string} name the report's page name
 * @param {Array<{ text: string, inSidebar: boolean }>} stops the stops, in order @param {boolean} closed whether the sidebar is closed
 * @returns {string[]} failures
 */
export function tabOrderFindings(name, stops, closed) {
  if (!closed) return [];
  const inside = stops.map((stop, index) => (stop.inSidebar ? `#${index + 1} “${stop.text}”` : null)).filter(Boolean);
  return inside.length ? [`${name}@phone: with the sidebar closed, Tab reaches it: ${inside.join(", ")}`] : [];
}

/**
 * A named control clicked in the page: a button, a menu item, a tab or a link, by its accessible name, inside `within` (a selector)
 * when one is given. Used for clicks that only open or close something (a menu, a drawer, a tab) — never for a button that writes.
 * @param {[("button" | "menuitem" | "tab" | "link"), string, (string | null)?]} args
 * @returns {boolean} whether it was found and clicked
 */
export function clickNamed([role, name, within = null]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const root = within ? [...document.querySelectorAll(within)].find(visible) : document;
  if (!root) return false;
  const selector = { button: "button, [role='button']", menuitem: "[role='menuitem']", tab: "[role='tab']", link: "a" }[role] ?? "*";
  const label = (el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  const target = [...root.querySelectorAll(selector)].find((el) => visible(el) && label(el) === name);
  if (!target) return false;
  target.click();
  return true;
}

/**
 * The row of a list whose title holds `title`, clicked: the knowledge base's row for one document.
 * @param {[string]} args @returns {boolean}
 */
export function clickRowTitled([title]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const row = [...document.querySelectorAll("main [data-row-title]")].find((el) => visible(el) && !el.closest("[role='dialog']") && (el.textContent ?? "").includes(title));
  if (!row) return false;
  (row.matches("a, button, [role='button']") ? row : row.querySelector("a, button, [role='button']") ?? row).click();
  return true;
}

/**
 * What a page of the R11 list shows that one measure of the style inventory cannot: read in the page, per `kind`, and judged by
 * `probeFindings`. Each reads what a defect fixed in R11 left behind — an element, an attribute, a word of the product's own fixed
 * copy — and nothing of the account's content.
 * @param {[string, any?]} args the kind of probe and its argument
 */
export function pageProbe([kind, arg]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const main = document.querySelector("main") ?? document.body;
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const ownText = (el) => [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
  const all = (selector, root = main) => [...root.querySelectorAll(selector)];
  const outside = (el) => !el.closest("[role='dialog'], nav, aside");

  if (kind === "geoRail") {
    const folded = all("[data-rail-folded]");
    const details = folded.flatMap((el) => all("details", el));
    return { folded: folded.length, closed: details.length > 0 && details.every((el) => !el.open), steps: all("[data-rail-step]").filter(visible).length };
  }
  if (kind === "geoMarketOff") {
    const el = all("[data-geo-market-off]")[0];
    return el ? { present: true, top: Math.round(el.getBoundingClientRect().top), viewport: window.innerHeight } : { present: false };
  }
  if (kind === "followingEmpty") {
    return {
      adds: all("button").filter((el) => visible(el) && words(el) === "添加关注").length,
      chips: all("[aria-pressed]").filter(visible).length,
      noResults: words(main).includes("没有结果"),
    };
  }
  if (kind === "eventGroups") {
    const text = words(main);
    return { primary: text.includes("一手材料"), other: text.includes("其他报道"), none: text.includes("暂无一手材料，以下均为转述报道。") };
  }
  if (kind === "firstRowTop") {
    const title = all("[data-row-title]").find((el) => visible(el) && outside(el));
    return { top: title ? Math.round(title.getBoundingClientRect().top) : null };
  }
  if (kind === "rowWidth") {
    const widths = all("[data-row-title]").filter((el) => visible(el) && outside(el)).slice(0, 5).map((el) => Math.round(el.getBoundingClientRect().width));
    return { widths, min: widths.length ? Math.min(...widths) : null };
  }
  if (kind === "capabilityCards") {
    const stateWords = ["可运行", "已安装", "未验证"];
    const spans = all("button span").filter(visible);
    return {
      hits: [...new Set(spans.map(words).filter((text) => stateWords.includes(text)))],
      wraps: spans.filter((el) => el.classList.contains("mt-auto") && el.getBoundingClientRect().height > 1.9 * (parseFloat(getComputedStyle(el).lineHeight) || 16)).length,
    };
  }
  if (kind === "memoryTabs") {
    const names = ["关于你", "项目", "做法", "成长"];
    const tabs = all("[role='tab']").filter(visible).map((el) => {
      const text = words(el);
      const name = names.find((candidate) => text.startsWith(candidate)) ?? text;
      return { name, count: Number(/^\s*(\d+)/.exec(text.slice(name.length))?.[1] ?? 0), selected: el.getAttribute("aria-selected") === "true" };
    });
    const headline = /现在有\s*(\d+)\s*条记忆，学会\s*(\d+)\s*种做法/.exec(words(main));
    return { tabs, headline: headline ? { memories: Number(headline[1]), practices: Number(headline[2]) } : null };
  }
  if (kind === "sharedMissing") {
    const text = words(main);
    const names = all("a, button").map(words);
    return { title: text.includes("这个分享不能打开"), back: names.includes("回到记忆胶囊"), retry: names.includes("重试") };
  }
  if (kind === "inboxSafety") {
    const heading = all("h2").map(words).map((text) => /^涉及临床安全 · 未读 (\d+) 条$/.exec(text)).find(Boolean);
    const bell = [...document.querySelectorAll("button[aria-label], a[aria-label]")].map((el) => el.getAttribute("aria-label") ?? "").find((label) => label.startsWith("收件箱"));
    return { heading: heading ? Number(heading[1]) : null, bell: bell === undefined ? null : Number(/其中 (\d+) 条涉及临床安全/.exec(bell)?.[1] ?? 0) };
  }
  if (kind === "feishuRows") {
    return { rows: all("*").filter((el) => ownText(el) === "飞书").length };
  }
  if (kind === "connectorRows") {
    const titles = Array.isArray(arg) ? arg : [];
    return {
      rows: titles.map((title) => {
        const label = all("*").find((el) => visible(el) && ownText(el) === title);
        let row = label ?? null;
        for (let up = 0; row && up < 4 && !/可选|已配置|未配置/.test(words(row)); up += 1) row = row.parentElement;
        const text = row ? words(row) : "";
        return { title, found: Boolean(row && /可选|已配置|未配置/.test(text)), optional: text.includes("可选"), configured: text.includes("已配置"), missing: text.includes("未配置") };
      }),
    };
  }
  if (kind === "opsOrder") {
    const text = words(main);
    const tokens = [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].slice(0, 5);
    return { health: text.indexOf("运行状况"), config: text.indexOf("部署配置检查"), tokens };
  }
  if (kind === "notFound") {
    return { said: words(document.body).includes("页面不存在") };
  }
  if (kind === "missingRecord") {
    const [sentence, back] = Array.isArray(arg) ? arg : ["", ""];
    const dialog = [...document.querySelectorAll("[role='dialog']")].find(visible);
    const text = dialog ? words(dialog) : "";
    return { dialog: Boolean(dialog), said: Boolean(sentence) && text.includes(sentence), back: Boolean(dialog) && all("button", dialog).some((el) => visible(el) && words(el) === back), failedWord: words(document.body).includes("操作未完成") };
  }
  if (kind === "readingFolds") {
    const text = words(main).toLowerCase();
    return {
      folds: all("details").map((el) => ({ label: words(el.querySelector("summary") ?? el).slice(0, 20), open: Boolean(el.open) }))
        .filter((fold) => ["编写与核查", "评议与讨论", "更新记录"].some((label) => fold.label.startsWith(label))),
      models: ["deepseek", "qwen", "千问"].filter((model) => text.includes(model)),
    };
  }
  return null;
}

/** The pages R11 walks with a probe, by kind, and the viewports each is read at. */
export const PAGE_PROBES = {
  "geo-overview": [["geoRail", ["phone"]]],
  "geo-actions": [["geoMarketOff", ["desktop", "phone"]]],
  "frontier-following": [["followingEmpty", ["desktop", "phone"]]],
  "frontier-event": [["eventGroups", ["desktop", "phone"]]],
  frontier: [["firstRowTop", ["phone"]]],
  "virtual-research": [["rowWidth", ["phone"]]],
  capabilities: [["capabilityCards", ["desktop"]]],
  memory: [["memoryTabs", ["desktop"]]],
  "memory-project": [["memoryTabs", ["desktop"]]],
  "memory-methods": [["memoryTabs", ["desktop"]]],
  "memory-growth": [["memoryTabs", ["desktop"]]],
  "memory-shared-missing": [["sharedMissing", ["desktop", "phone"]]],
  inbox: [["inboxSafety", ["desktop"]]],
  account: [["feishuRows", ["desktop"]]],
  "account-notifications": [["feishuRows", ["desktop"]]],
  "account-connectors": [["connectorRows", ["desktop"]]],
  "account-ops": [["opsOrder", ["desktop"]]],
  "account-simulated-membership": [["notFound", ["desktop", "phone"]]],
  "account-simulated-refunds": [["notFound", ["desktop", "phone"]]],
  "extensions-plugin-missing": [["missingRecord", ["desktop"]]],
  "extensions-skill-missing": [["missingRecord", ["desktop"]]],
  "frontier-evidence": [["readingFolds", ["desktop"]]],
};

/** The record that is not there on each walked missing-record address: what the drawer says, its button, and the list it returns to. */
export const MISSING_RECORDS = {
  "extensions-plugin-missing": { sentence: "找不到这个插件，它可能已被移除。", back: "回到插件列表", to: "/app/extensions/plugins" },
  "extensions-skill-missing": { sentence: "找不到这个技能，它可能已被移除。", back: "回到技能列表", to: "/app/extensions/skills" },
};

/** The tabs a memory address names, and the one it must open on. */
const MEMORY_TAB_OF = { "memory-project": "项目", "memory-methods": "做法", "memory-growth": "成长" };

/**
 * What a probe read, judged. A probe that returned nothing (a page that did not render what it looks for) is not a pass the walk
 * can claim, but not a failure it can name either: the page's own findings (title, API, vocabulary) say when it did not load.
 * @param {string} name the report's page name @param {"desktop" | "phone"} viewportName @param {string} kind
 * @param {any} r what `pageProbe` returned
 * @returns {{ failures: string[], notices: string[] }}
 */
export function probeFindings(name, viewportName, kind, r) {
  const current = `${name}@${viewportName}`;
  const key = budgetKey(name);
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!r) return { failures, notices };
  switch (kind) {
    case "geoRail":
      if (r.folded === 0) failures.push(`${current}: the progress rail is not folded into one line`);
      else if (!r.closed) failures.push(`${current}: the folded progress rail is open at first sight`);
      if (r.steps > 0) failures.push(`${current}: ${r.steps} step(s) of the progress rail are on the first screen`);
      break;
    case "geoMarketOff":
      if (r.present && r.top >= r.viewport) failures.push(`${current}: the sentence about placing being off is below the first screen (${r.top} px)`);
      break;
    case "followingEmpty":
      if (r.noResults) failures.push(`${current}: 「没有结果」 is on the page, and nothing was searched or filtered`);
      if (r.adds > 1) failures.push(`${current}: ${r.adds} buttons named 添加关注 (one)`);
      if (r.adds === 1 && r.chips > 0) failures.push(`${current}: ${r.chips} filter chip(s) beside an empty follow list`);
      break;
    case "eventGroups":
      if (!r.primary && !r.other && !r.none) failures.push(`${current}: the event page has neither report group nor the line that says there is no first-hand material`);
      break;
    case "firstRowTop":
      if (viewportName === "phone" && r.top !== null && r.top > 520) notices.push(`${current}: the first headline starts at ${r.top} px (the aim is 520)`);
      break;
    case "rowWidth":
      if (viewportName === "phone" && r.min !== null && r.min < 160) failures.push(`${current}: a study row's title is ${r.min} px wide (at least 160)`);
      break;
    case "capabilityCards":
      if (r.hits.length) failures.push(`${current}: the tool cards still say ${r.hits.join(", ")}`);
      if (r.wraps > 0) notices.push(`${current}: ${r.wraps} card footer(s) take two lines`);
      break;
    case "memoryTabs": {
      const selected = r.tabs.find((tab) => tab.selected);
      const count = (tabName) => r.tabs.find((tab) => tab.name === tabName)?.count ?? 0;
      const wanted = MEMORY_TAB_OF[/** @type {keyof typeof MEMORY_TAB_OF} */ (key)];
      if (wanted && selected && selected.name !== wanted) failures.push(`${current}: the address names ${wanted} and the page opens on ${selected.name}`);
      if (key === "memory" && selected?.name === "关于你" && count("关于你") === 0 && (count("项目") > 0 || count("做法") > 0)) {
        failures.push(`${current}: the page opens on an empty 关于你 while 项目 holds ${count("项目")} and 做法 ${count("做法")}`);
      }
      if (r.headline && r.headline.practices !== count("做法")) failures.push(`${current}: the growth line counts ${r.headline.practices} 做法 and the tab ${count("做法")}`);
      break;
    }
    case "sharedMissing":
      if (!r.title) failures.push(`${current}: a share that does not exist is not said to be unopenable`);
      if (!r.back) failures.push(`${current}: no way back to the capsules`);
      if (r.retry) failures.push(`${current}: 重试 is offered for a share that does not exist`);
      break;
    case "inboxSafety":
      if (r.heading !== null && r.bell !== null && r.heading !== r.bell) failures.push(`${current}: the safety heading counts ${r.heading} unread and the bell ${r.bell}`);
      break;
    case "feishuRows":
      if (key === "account" && r.rows > 0) failures.push(`${current}: the account section still has a 飞书 row (it is bound under 通知)`);
      if (key === "account-notifications" && r.rows > 1) failures.push(`${current}: ${r.rows} 飞书 rows under 通知 (one)`);
      break;
    case "connectorRows":
      for (const row of r.rows) {
        if (row.found && row.missing) failures.push(`${current}: ${row.title} needs no key and reads 未配置`);
        else if (!row.found) notices.push(`${current}: the row of ${row.title} was not found`);
      }
      break;
    case "opsOrder":
      if (r.health >= 0 && r.config >= 0 && r.health > r.config) failures.push(`${current}: 部署配置检查 comes before 运行状况`);
      if (r.tokens.length) notices.push(`${current}: identifiers in the visible text: ${r.tokens.join(", ")}`);
      break;
    case "notFound":
      if (!r.said) failures.push(`${current}: an address that is not a page does not say 页面不存在`);
      break;
    case "missingRecord": {
      const expected = MISSING_RECORDS[/** @type {keyof typeof MISSING_RECORDS} */ (key)];
      if (!r.dialog || !r.said) failures.push(`${current}: the missing record's drawer does not say “${expected?.sentence ?? ""}”`);
      else if (!r.back) failures.push(`${current}: the missing record's drawer has no button ${expected?.back ?? ""}`);
      if (r.failedWord) failures.push(`${current}: 「操作未完成」 on a record that is not there`);
      break;
    }
    case "readingFolds":
      for (const fold of r.folds) if (fold.open) failures.push(`${current}: the fold ${fold.label} is open at first sight`);
      if (!r.folds.some((fold) => fold.label.startsWith("编写与核查"))) notices.push(`${current}: the card has no 编写与核查 fold`);
      if (r.models.length) notices.push(`${current}: a model name on the reading page: ${r.models.join(", ")}`);
      break;
    default:
  }
  return { failures, notices };
}

/**
 * What an opened row shows, read while it is open. Per `kind`; judged by `afterClickFindings`.
 *
 *  - `sourceDrawer` (R13, E-15): a 信源 row opens the site's drawer — a dialog holding `[data-geo-source-drawer]` — and no longer its
 *    three conditions in place. The drawer's wrapper is drawn the moment it opens, whatever the measurements hold, so it is read here;
 *    what is in it (the answers behind a row's three numbers) needs a measured round and is held by the page's own tests.
 *  - `taskPage` (R13, E-18): a task row is a link to the task's own page, `/app/autopilot/:taskId`, and no longer a drawer. The page is
 *    a list column and a main area whose pane is the kernel's conversation: the shell keeps one resident frame and places it over the
 *    pane, so the page itself draws no input box and no dialog for the conversation. Read: the layout and its hooks, which pane is on
 *    (`conversation`, `progress`, `waiting`, `no-conversation`, `never-run`), the pane's box and the frame's, the text inputs of the
 *    page's own DOM, the dialogs, and the task bar's text for a time-zone identifier.
 * @param {[string]} args
 */
export function afterClickProbe([kind]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (kind === "sourceDrawer") {
    const dialog = [...document.querySelectorAll("[role='dialog']")].find(visible);
    return { dialog: Boolean(dialog), drawers: dialog ? [...dialog.querySelectorAll("[data-geo-source-drawer]")].filter(visible).length : 0 };
  }
  if (kind === "taskPage") {
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
    };
    const layout = document.querySelector("[data-autopilot-layout]");
    const main = document.querySelector("[data-task-main]");
    const bar = document.querySelector("[data-task-bar]");
    const pane = document.querySelector("[data-task-pane]");
    const holder = document.querySelector("[data-task-frame]");
    const frame = holder ? [...holder.querySelectorAll("iframe")].find(visible) ?? null : null;
    const surface = document.querySelector("[data-session-surface]");
    const barText = bar ? [...bar.querySelectorAll("p")].filter(visible).map(words).join(" ") : "";
    const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone").filter((zone) => zone.includes("/")) : [];
    return {
      path: location.pathname,
      layout: layout ? layout.getAttribute("data-autopilot-layout") : null,
      list: Boolean(document.querySelector("[data-task-list]")),
      main: Boolean(main),
      bar: Boolean(bar),
      // The open task's row is marked in a list beside the task; with the list not beside it there is no row to mark.
      marked: [...document.querySelectorAll("[data-task-list] [data-task-id][aria-current='page']")].length,
      pane: pane ? pane.getAttribute("data-task-pane") : null,
      paneBox: rect(pane),
      surface: surface ? surface.getAttribute("data-session-surface") : null,
      holderBox: rect(holder),
      frameBox: rect(frame),
      // A box for typing that the page itself draws: the sidebar's search is the shell's, the list's search is not in the main area.
      editors: [...document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")].filter((el) => visible(el) && !el.closest("aside, nav")).length,
      inputsInMain: main ? [...main.querySelectorAll("input")].filter((el) => visible(el) && !["checkbox", "radio", "hidden", "file", "button", "submit"].includes(el.getAttribute("type") ?? "")).length : 0,
      dialogs: [...document.querySelectorAll("[role='dialog']")].filter(visible).length,
      zoneIds: zones.filter((zone) => barText.includes(zone)).slice(0, 3),
    };
  }
  return null;
}

/** The pane's box and the frame's are one rectangle, to the pixel the shell rounds to. */
const PANE_TOLERANCE_PX = 2;

/**
 * Whether two boxes (`{ left, top, width, height }`) are the same rectangle, give or take the shell's rounding.
 * @param {{ left: number, top: number, width: number, height: number } | null} a @param {{ left: number, top: number, width: number, height: number } | null} b
 */
export function sameBox(a, b, tolerance = PANE_TOLERANCE_PX) {
  return Boolean(a && b) && ["left", "top", "width", "height"].every((key) => Math.abs(/** @type {any} */ (a)[key] - /** @type {any} */ (b)[key]) <= tolerance);
}

const boxText = (box) => (box ? `${box.width}×${box.height} at ${box.left},${box.top}` : "none");

/**
 * The task page as a reader meets it right after a task's row was clicked (R13, V-11). The shell places the kernel's conversation over
 * the pane, so what the walk can hold the page to is where that frame is and what the page does not draw: every one of these is a
 * NOTICE (new in R13), each says "not observable" and why when the thing it looks at is not there — a throwaway account has no task,
 * a task that never ran has no conversation, and the walk starts no runtime, so the frame's container is placed but may hold no
 * iframe. The one failure is carried over from the drawer it replaces: a time zone is named, never shown by its identifier.
 * @param {string} name the report's page name @param {any} r what `afterClickProbe` returned for `taskPage`
 * @returns {{ failures: string[], notices: string[] }}
 */
export function taskPageFindings(name, r) {
  const current = `${name}@desktop`;
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!r) return { failures, notices };
  if (!/^\/app\/autopilot\/[^/]+$/.test(r.path ?? "")) {
    notices.push(`${current}: not observable: the first row did not go to a task's own page (the address is ${r.path}), so the task page was not read`);
    return { failures, notices };
  }
  if (!r.main) notices.push(`${current}: the task page has no main area (data-task-main)`);
  if (!r.bar) notices.push(`${current}: the task page has no task bar (data-task-bar)`);
  if (r.layout === "split") {
    if (!r.list) notices.push(`${current}: the split layout has no task list beside the task (data-task-list)`);
    else if (r.marked !== 1) notices.push(`${current}: ${r.marked} row(s) of the list are marked as the open task (aria-current=page; one)`);
  } else if (r.layout === null) notices.push(`${current}: the task page declares no layout (data-autopilot-layout)`);
  if (r.editors > 0 || r.inputsInMain > 0) {
    notices.push(`${current}: the task page draws ${r.editors + r.inputsInMain} text box(es) of its own; the conversation's input is the kernel's, inside the frame`);
  }
  if (r.dialogs > 0) notices.push(`${current}: ${r.dialogs} dialog(s) open on the task page right after the task opened (the conversation is not in a dialog)`);
  if (r.pane === null) notices.push(`${current}: not observable: the task's pane (data-task-pane) had not rendered, so the conversation's place was not read`);
  else if (r.pane !== "conversation") notices.push(`${current}: not observable: the first task's pane reads ${r.pane}, so no conversation frame is placed over it`);
  else {
    if (r.surface !== "task") notices.push(`${current}: the conversation surface reads ${r.surface ?? "nothing"} while the task's conversation is on (task)`);
    if (!r.holderBox) notices.push(`${current}: not observable: the pane reads conversation and no frame container (data-task-frame) is placed over it`);
    else {
      // The iframe when the runtime is up; otherwise its container, which the shell places at the same rectangle.
      const box = r.frameBox ?? r.holderBox;
      if (!sameBox(box, r.paneBox)) {
        notices.push(`${current}: the kernel frame${r.frameBox ? "" : "'s container"} is ${boxText(box)} and the pane ${boxText(r.paneBox)} (the same rectangle)`);
      } else if (!r.frameBox) {
        notices.push(`${current}: not observable: the frame's container is placed over the pane, and holds no iframe (the walk starts no runtime), so only the container was compared`);
      }
    }
  }
  if (r.zoneIds.length) failures.push(`${current}: the task bar names a time zone by its identifier: ${r.zoneIds.join(", ")}`);
  return { failures, notices };
}

/**
 * @param {string} name the report's page name @param {string} kind @param {any} r what `afterClickProbe` returned
 * @returns {{ failures: string[], notices: string[] }}
 */
export function afterClickFindings(name, kind, r) {
  const current = `${name}@desktop`;
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!r) return { failures, notices };
  // The old form opened the conditions in place and failed on no detail; the drawer is the same thing in its R13 form.
  if (kind === "sourceDrawer" && r.drawers === 0) failures.push(`${current}: clicking the first source opened no drawer (a dialog holding data-geo-source-drawer)`);
  if (kind === "taskPage") return taskPageFindings(name, r);
  return { failures, notices };
}

/**
 * The title column of every desktop page, against the one most pages share. A page whose title starts on another left edge has lost
 * the sidebar or its column (the 定时任务 page began at 0 px beside a sidebar that was not there).
 * @param {Record<string, { pageLefts?: number[] }>} pages the report's pages
 * @returns {string[]} notices
 */
export function leftEdgeNotices(pages) {
  const edges = Object.entries(pages).filter(([view, page]) => view.endsWith("@desktop") && Array.isArray(page.pageLefts) && page.pageLefts.length > 0)
    .map(([view, page]) => [view, /** @type {number[]} */ (page.pageLefts)[0]]);
  const tally = new Map();
  for (const [, left] of edges) tally.set(left, (tally.get(left) ?? 0) + 1);
  const [common] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (common === undefined) return [];
  return edges.filter(([, left]) => left !== common).map(([view, left]) => `${view}: the title starts at ${left} px; most pages start at ${common} px`);
}

/**
 * The original column of a document's page is never narrower than this: below it a page of a PDF is read at a size nobody reads at, and
 * the original and the key points go back to being two tabs (R13 E-19, `useReaderBox`'s `ORIGINAL_MIN_WIDTH`). The drawer it replaces
 * was held to 576 px; the page holds the original wider than that.
 */
export const ORIGINAL_MIN_WIDTH = 560;

/**
 * The pdf a document's page shows for its original: in a column not narrower than `ORIGINAL_MIN_WIDTH`, and fit to the column's width
 * with no thumbnail column. The same two defects R11 fixed for the drawer, read where the original is now.
 * @param {{ width: number, src: string | null } | null} r @returns {string[]} failures
 */
export function pdfPreviewFindings(r) {
  if (!r) return [];
  const failures = [];
  if (r.width < ORIGINAL_MIN_WIDTH) failures.push(`files@desktop: the original of a PDF is ${r.width} px wide on its page (at least ${ORIGINAL_MIN_WIDTH})`);
  if (r.src !== null && !r.src.endsWith("view=FitH&navpanes=0")) failures.push("files@desktop: the PDF is not opened fit to width without the thumbnail column");
  return failures;
}

/** What the original of a PDF on a document's page is shown in: the original column's width and the address its viewer was given. */
export function pdfProbe() {
  const column = [...document.querySelectorAll("[data-reader-column='original']")].find((el) => el.getBoundingClientRect().width > 0);
  if (!column) return null;
  const frame = [...column.querySelectorAll("iframe")].find((el) => (el.getAttribute("title") ?? "").includes("PDF"));
  return { width: Math.round(column.getBoundingClientRect().width), src: frame ? frame.getAttribute("src") ?? "" : null };
}

/**
 * A document's own page (`/app/files/:sourceId`, R13 E-19), read in the page: where it is, which layout the page chose (two columns, or
 * two tabs when the original would be narrower than `ORIGINAL_MIN_WIDTH`), its heading, the way back and what it names, whether a
 * dialog is open (a document is a page, not a drawer), and the sentence of a document that is not there.
 */
export function readerProbe() {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const layout = document.querySelector("[data-reader-layout]");
  const heading = document.querySelector("main h1");
  const back = document.querySelector("nav[aria-label='返回'] a");
  const tabs = [...document.querySelectorAll("[role='tablist']")].find((el) => el.getAttribute("aria-label") === "资料视图");
  return {
    path: `${location.pathname}${location.search}`,
    layout: layout ? layout.getAttribute("data-reader-layout") : null,
    title: heading ? words(heading) : null,
    back: back ? { text: words(back), href: back.getAttribute("href") } : null,
    dialogs: [...document.querySelectorAll("[role='dialog']")].filter(visible).length,
    columns: [...document.querySelectorAll("[data-reader-column]")].filter(visible).map((el) => el.getAttribute("data-reader-column")),
    tabs: tabs ? [...tabs.querySelectorAll("[role='tab']")].map(words) : [],
    missing: words(document.body).includes("这份资料不存在或已删除。"),
  };
}

/**
 * The document's page as a reader meets it after a row of the list was opened (R13 E-19, A08): the page is the document's own address,
 * its heading is the row's title, the way back reads 知识库 and goes to the list as it was left, and nothing is open in a dialog. All
 * notices — new in R13 — and each says "not observable" when the page did not render what it looks at.
 * @param {any} r what `readerProbe` returned @param {{ title: string, list: string }} expected the row's title and the list's address
 * @returns {{ failures: string[], notices: string[] }}
 */
export function readerFindings(r, expected) {
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  const current = "files@desktop";
  if (!r || !/^\/app\/files\/[^/?]+/.test(r.path ?? "")) {
    notices.push(`${current}: not observable: opening the first row did not go to a document's own page (${r?.path ?? "no page"}), so the reader was not read`);
    return { failures, notices };
  }
  if (r.missing) {
    notices.push(`${current}: the reader of the first row says the document does not exist`);
    return { failures, notices };
  }
  if (r.layout === null) {
    notices.push(`${current}: not observable: the document's page drew no layout (data-reader-layout) within the wait`);
    return { failures, notices };
  }
  const same = (a, b) => String(a ?? "").replace(/\s+/g, " ").trim() === String(b ?? "").replace(/\s+/g, " ").trim();
  if (!same(r.title, expected.title)) notices.push(`${current}: the reader's heading is “${String(r.title ?? "").slice(0, 40)}” and the row it was opened from is “${expected.title.slice(0, 40)}”`);
  if (!r.back || !same(r.back.text, "知识库")) notices.push(`${current}: the way back on the document's page reads “${r.back?.text ?? "nothing"}” (知识库)`);
  else if (r.back.href !== expected.list) notices.push(`${current}: the way back goes to ${r.back.href} and the list was ${expected.list}`);
  if (r.dialogs > 0) notices.push(`${current}: a dialog is open on the document's page (a document is a page, not a drawer)`);
  if (r.layout === "tabs" && !(r.tabs.includes("内容") && r.tabs.includes("原文"))) notices.push(`${current}: the reader is in tabs and its tab strip reads ${r.tabs.join("/") || "nothing"} (内容/原文)`);
  if (r.layout === "columns" && !(r.columns.includes("original") && r.columns.includes("points"))) notices.push(`${current}: the reader is in two columns and shows ${r.columns.join("/") || "none"} (original/points)`);
  return { failures, notices };
}

/** What the new-skill drawer shows: its captions, the switch for this project, and the words a refused empty form puts beside its fields. */
export function skillDrawerProbe() {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const dialog = [...document.querySelectorAll("[role='dialog']")].find(visible);
  if (!dialog) return null;
  const text = words(dialog);
  return {
    title: [...dialog.querySelectorAll("h1, h2, h3")].some((el) => words(el) === "新建技能"),
    captions: [...dialog.querySelectorAll("p")].filter((el) => visible(el) && (el.id ?? "").endsWith("-hint")).length,
    // A switch whose label is shown carries it as its own text (the `Switch` primitive's `showLabel`); one labelled from outside
    // has it on the attribute or beside it. The parent alone read the whole form (release-11 walk: a present switch went unseen).
    switchLabel: [...dialog.querySelectorAll("[role='switch']")].flatMap((el) => [el.getAttribute("aria-label") ?? "", words(el), words(el.parentElement ?? el)])
      .find((label) => label.startsWith("保存后在")) ?? null,
    needName: text.includes("请填写名称"),
    needHow: text.includes("请写出这个技能怎么做"),
  };
}

/**
 * @param {any} opened the drawer as it opened @param {any} refused the drawer after 保存 with every field empty
 * @param {string[]} writes the requests that would have changed the deployment, which the walk refused to send
 * @returns {string[]} failures
 */
export function skillDrawerFindings(opened, refused, writes) {
  const failures = [];
  if (!opened) return ["extensions-skills@desktop: 新建技能 did not open a drawer"];
  if (!opened.title) failures.push("extensions-skills@desktop: the new-skill drawer is not titled 新建技能");
  if (opened.captions < 2) failures.push(`extensions-skills@desktop: the new-skill drawer has ${opened.captions} caption(s) under its fields (two)`);
  if (!opened.switchLabel) failures.push("extensions-skills@desktop: the new-skill drawer has no switch for using the skill in this project");
  if (refused && !(refused.needName && refused.needHow)) failures.push("extensions-skills@desktop: 保存 with empty fields does not say 请填写名称 and 请写出这个技能怎么做 in place");
  if (writes.length) failures.push(`extensions-skills@desktop: 保存 with empty fields sent a request: ${writes.join(", ")}`);
  return failures;
}

/** The whole-page cover and alert of a chat that cannot start because the previous runtime is being cleaned up. */
export function cleanupProbe() {
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const cover = document.querySelector("[data-frame-skeleton]");
  const alert = [...document.querySelectorAll("[role='alert']")].find((el) => el.getBoundingClientRect().width > 0);
  // The conversation frame on screen with no cover: the project's runtime was already up, and a refused start is then rightly
  // ignored, so the cover cannot be exercised here (release-11 walk, the owner's runtime running).
  const frame = [...document.querySelectorAll("iframe")].find((el) => { const box = el.getBoundingClientRect(); return box.width > 200 && box.height > 200; });
  return {
    cover: cover ? words(cover) : null,
    booted: Boolean(frame) && !cover,
    quotaButtons: [...document.querySelectorAll("button")].map(words).filter((text) => text === "查看科研额度" || text === "查看用量"),
    alertButtons: alert ? [...alert.querySelectorAll("button, a")].map(words) : null,
  };
}

/**
 * Said instead of judging when the cover could not be shown: the runtime was already up, so the start the walk refused was not
 * needed and the page rightly kept the conversation. The cover itself is held by the page's own tests.
 * @param {ReturnType<typeof cleanupProbe>} early @returns {string[]} notices
 */
export function cleanupNotices(early) {
  return early.booted && !early.cover ? ["chat@desktop: the runtime was already up, so a start refused for cleanup could not be shown"] : [];
}

/**
 * A start the control plane refuses because the previous task's runtime is still being cleaned up (`runtime_cleanup_required`,
 * answered by the walk itself): the cover says so and offers no allowance page; once the wait is spent the alert offers 重试 and the
 * way to what the project already holds.
 * @param {ReturnType<typeof cleanupProbe>} early @param {ReturnType<typeof cleanupProbe> | null} late null when the wait was not waited out
 * @returns {string[]} failures
 */
export function cleanupFindings(early, late) {
  const failures = [];
  if (cleanupNotices(early).length) return failures;
  if (!early.cover?.includes("正在清理上一次任务的运行环境")) failures.push(`chat@desktop: a start refused for cleanup does not say it is cleaning up (cover: “${early.cover ?? "none"}”)`);
  if (early.quotaButtons.length) failures.push(`chat@desktop: a start refused for cleanup offers ${early.quotaButtons.join(", ")}`);
  if (late) {
    if (!late.alertButtons) failures.push("chat@desktop: after the wait, a cleanup that did not finish raises no alert");
    else {
      for (const wanted of ["重试", "查看已有成果"]) if (!late.alertButtons.includes(wanted)) failures.push(`chat@desktop: the alert of a cleanup that did not finish has no ${wanted}`);
      if (late.quotaButtons.length) failures.push(`chat@desktop: the alert of a cleanup that did not finish offers ${late.quotaButtons.join(", ")}`);
    }
  }
  return failures;
}

/**
 * The evidence matrix of a finished package, read in the page. `["state"]` — layout, the 核对 column and the marks; `["filtered"]` —
 * the rows left and the count line; `["open"]` — click the first row and read the dialog; `["closed"]` — after Escape, whether the
 * dialog is gone and focus is back in the row.
 * @param {[string]} args
 */
export function matrixProbe([action]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const rows = () => [...document.querySelectorAll("tr, li")].filter((el) => /^matrix-CLM-\d{3,6}$/.test(el.id ?? "") && visible(el));
  const idOf = (row) => row.id.slice("matrix-".length);
  const search = [...document.querySelectorAll("input")].find((el) => el.getAttribute("aria-label") === "搜索结论" && visible(el)) ?? null;
  if (action === "ready") return Boolean(search) && rows().length > 0;
  const list = rows();
  if (action === "state") {
    const first = list[0] ?? null;
    const mark = first ? (first.tagName === "TR" ? first.querySelectorAll("td")[0] : first.querySelectorAll("button span span")[1]) ?? null : null;
    const box = mark?.getBoundingClientRect();
    const headers = [...document.querySelectorAll("th")].filter((el) => el.getAttribute("scope") === "col" && visible(el)).map(words);
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      rows: list.length,
      firstId: first ? idOf(first) : null,
      markInView: box ? box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1 : null,
      headers,
      marks: list.map((row) => (row.tagName === "TR" ? row.querySelectorAll("td")[0] : row.querySelectorAll("button span span")[1]))
        .filter(Boolean).map(words),
    };
  }
  if (action === "filtered") {
    const status = [...document.querySelectorAll("p")].map(words).find((text) => /^显示 \d+ \/ \d+ 条$/.test(text)) ?? null;
    return { rows: list.length, status };
  }
  if (action === "open") {
    const first = list[0];
    if (!first) return null;
    (first.tagName === "TR" ? first : first.querySelector("button") ?? first).click();
    return true;
  }
  if (action === "dialog") {
    const dialog = [...document.querySelectorAll("[role='dialog']")].find(visible) ?? null;
    const name = dialog ? dialog.getAttribute("aria-label") || words(dialog.querySelector("h1, h2, h3") ?? dialog).slice(0, 60) : null;
    return { open: Boolean(dialog), name };
  }
  if (action === "closed") {
    const dialog = [...document.querySelectorAll("[role='dialog']")].find(visible);
    const focused = document.activeElement;
    return { open: Boolean(dialog), focusInRow: Boolean(focused && list.some((row) => row.contains(focused))) };
  }
  return null;
}

/**
 * The evidence matrix as a reader meets it at one width.
 * @param {"desktop" | "phone"} viewportName
 * @param {{ state: any, filtered: any, dialog: any, closed: any }} read what `matrixProbe` returned at each step
 * @returns {{ failures: string[], notices: string[] }}
 */
export function matrixFindings(viewportName, { state, filtered, dialog, closed }) {
  const current = `evidence-matrix@${viewportName}`;
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!state || !state.firstId) return { failures, notices: [`${current}: no row to read`] };
  if (state.overflow) failures.push(`${current}: the page overflows sideways`);
  if (state.markInView === false) failures.push(`${current}: the 核对 text of the first claim is outside the screen`);
  if (state.headers.length > 1 && state.headers[1] !== "核对") failures.push(`${current}: the second column is “${state.headers[1]}” (核对)`);
  // R13 (E-5): the column is ✓, ⚠ or blank, and says 核对中 only while the checks are on their way; the words it used to write for a claim
  // nobody had checked are gone. They were a failure together with 核对中 on the same page; they are a notice alone.
  const retired = [...new Set(state.marks.filter((mark) => ["未核对", "暂无核对结果"].includes(mark)))];
  if (retired.length) notices.push(`${current}: the 核对 column still reads ${retired.join(", ")} for a claim (R13: ✓, ⚠ or blank)`);
  if (filtered && (filtered.rows !== 1 || !/^显示 1 \/ \d+ 条$/.test(filtered.status ?? ""))) {
    failures.push(`${current}: searching for ${state.firstId} leaves ${filtered.rows} row(s) and “${filtered.status ?? "no count"}”`);
  }
  if (dialog && (!dialog.open || !(dialog.name ?? "").includes(state.firstId))) failures.push(`${current}: clicking the first claim does not open a dialog named ${state.firstId} (“${dialog.name ?? "none"}”)`);
  if (closed && (closed.open || !closed.focusInRow)) failures.push(`${current}: Escape ${closed.open ? "leaves the claim's dialog open" : "does not return focus to the claim's row"}`);
  return { failures, notices };
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
 *
 * R13: `["reveal", 0, { selector, limit }]` opens the disclosure toggles that hold
 * a page's rows (`ROW_REVEAL_BY_PAGE`) and says how many it opened; a third
 * argument `{ label, selector }` on the other actions adds the first link of a
 * page whose findings are cards (`ROW_LINK_BY_PAGE`) to the targets.
 */
export function rowProbe([action, index = 0, option = null]) {
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
  if (action === "reveal") {
    // Opens the disclosure toggles that hold the page's rows (`ROW_REVEAL_BY_PAGE`): it only shows more of the page.
    const { selector = "", limit = 0 } = option && typeof option === "object" ? option : {};
    const toggles = selector ? [...document.querySelectorAll(selector)].filter((el) => visible(el) && !el.closest("[role='dialog'], nav, aside")).slice(0, limit) : [];
    for (const toggle of toggles) toggle.click();
    return toggles.length;
  }
  const targets = [];
  for (const list of document.querySelectorAll("main ul, main ol")) {
    if (!visible(list) || list.closest("[role='dialog'], nav, aside")) continue;
    const title = [...list.querySelectorAll(":scope > li [data-row-title]")].find(visible);
    if (!title) continue;
    const control = title.matches("a, button, [role='button']") ? title : title.querySelector("a, button, [role='button']");
    // A list that holds another list (问题与回答's groups hold their questions) finds the inner list's first row as its own: one row, one target.
    if (!control || targets.some((target) => target.control === control)) continue;
    targets.push({ control, label: (list.getAttribute("aria-label") || title.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) });
  }
  // A page whose findings are cards (`ROW_LINK_BY_PAGE`): the first link of the cards is its one first row.
  if (option && typeof option === "object" && typeof option.selector === "string" && action !== "reveal") {
    const link = [...document.querySelectorAll(option.selector)].find((el) => visible(el) && !el.closest("[role='dialog'], nav, aside"));
    if (link) targets.push({ control: link, label: String(option.label ?? "").slice(0, 40) });
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

/** What the first row of a page's first list opened to, and the probe that reads it (`afterClickProbe`). */
export const AFTER_CLICK_KIND = { "geo-sources": "sourceDrawer", autopilot: "taskPage" };

/** How long the walk waits for a cleanup that never finishes to give up (`CLEANUP_WAIT_MS` of the shell, plus the margin of a slow start). */
const CLEANUP_WALK_WAIT_MS = 135_000;

/**
 * Run one step of the walk that clicks through a page, and keep what it found. A step that cannot run — the page it needs is not
 * there, a control did not answer — is a notice with the reason, never a failure of the release and never a silent pass.
 * @param {any} report @param {string[]} failures @param {string[]} notices @param {string} name
 * @param {() => Promise<{ failures: string[], notices?: string[], read?: any }>} step
 */
async function recordStep(report, failures, notices, name, step) {
  try {
    const result = await step();
    failures.push(...result.failures);
    notices.push(...(result.notices ?? []));
    (report.steps ||= {})[name] = result.read ?? { ok: result.failures.length === 0 };
  } catch (error) {
    notices.push(`${name}: the step could not run (${String(error).slice(0, 140)})`);
    (report.steps ||= {})[name] = { error: String(error).slice(0, 140) };
  }
}

/** Load a page of the walk and wait until its route has rendered. */
async function openRoute(page, base, route, settle = 1_500) {
  await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(routeReady, undefined, { timeout: 30_000 });
  await page.waitForTimeout(settle);
}

/** A document's page has drawn its layout: the reader is on screen, whatever it holds. */
export function readerReady() {
  return Boolean(document.querySelector("[data-reader-layout]"));
}

/** A PDF's viewer is in the original's column (the file is fetched before its frame is drawn). */
export function pdfFrameReady() {
  return Boolean(document.querySelector("[data-reader-column='original'] iframe[title*='PDF']"));
}

/** A task's page has drawn its pane (the conversation's place, or what stands in for it). */
export function taskPaneReady() {
  return Boolean(document.querySelector("[data-task-pane]"));
}

/**
 * A document's page for a PDF (R13, E-19): the original is in a column not narrower than 560 px, fit to its width, without the
 * viewer's thumbnails. The document is the first finished PDF the API lists; its row is a link to its page, so opening it is a route
 * change, and reading it (switching to its 原文 tab when the page chose tabs) writes nothing. It was a drawer's 原文 tab before.
 */
async function walkPdfPreview(page, base, route, title) {
  await openRoute(page, base, route);
  const opened = await page.evaluate(clickRowTitled, [title]);
  if (!opened) return { failures: [], notices: [`files@desktop: the PDF “${title.slice(0, 24)}” was not among the rows on the first screen`] };
  await page.waitForFunction(readerReady, undefined, { timeout: 12_000 }).catch(() => null);
  const page1 = await page.evaluate(readerProbe);
  if (!page1 || page1.layout === null) return { failures: [], notices: ["files@desktop: not observable: the PDF's page drew no layout within twelve seconds"], read: page1 };
  // Two tabs when the page has no room for both columns: the original is the second tab.
  if (page1.layout === "tabs" && !await page.evaluate(clickNamed, ["tab", "原文", null])) return { failures: [], notices: ["files@desktop: the PDF's page has no 原文 tab"], read: page1 };
  await page.waitForFunction(pdfFrameReady, undefined, { timeout: 8_000 }).catch(() => null);
  const read = await page.evaluate(pdfProbe);
  if (read && read.src === null) return { failures: [], notices: ["files@desktop: the original of the PDF showed no viewer within eight seconds"], read };
  return { failures: pdfPreviewFindings(read), read };
}

/**
 * What the knowledge base's list holds, read in the page: its first row's title, the address, what the search box holds, how many rows
 * the list has and whether one of them is the row of `title`.
 * @param {[string, string?]} args `["first"]` or `["state", title]`
 */
export function knowledgeProbe([action, title = ""]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll("main ul[aria-label='资料'] a[data-row-title]")].filter(visible);
  if (action === "first") return rows[0] ? { title: words(rows[0]), href: rows[0].getAttribute("href") } : null;
  const box = [...document.querySelectorAll("main input")].find((el) => el.getAttribute("aria-label") === "搜索资料和内容" && visible(el)) ?? null;
  return {
    path: `${location.pathname}${location.search}`,
    query: box ? box.value : null,
    rows: rows.length,
    listed: rows.some((row) => words(row) === title),
  };
}

/**
 * The way back to a long list (A08, R13 E-8/E-19), on the knowledge base: the search of a document's own title is in the address, the
 * document opens on its own page with the list's state in its address, and both ways back — 「知识库」 on the page and the browser's
 * Back — find the list with the search in the box and the document in the list. The search is the page's own filter box and nothing
 * here writes. Every verdict is a notice; an account with no document says so.
 */
async function walkKnowledgeReturn(page, base, route) {
  await openRoute(page, base, route);
  const first = await page.evaluate(knowledgeProbe, ["first"]);
  if (!first) return { failures: [], notices: ["files@desktop: not observable: the knowledge base lists no document, so there is nothing to open and come back from"] };
  const title = first.title.slice(0, 80);
  await page.getByRole("searchbox", { name: "搜索资料和内容" }).fill(title);
  await page.waitForTimeout(1_500);
  const filtered = await page.evaluate(knowledgeProbe, ["state", first.title]);
  /** @type {any} */ const read = { filtered, reader: null, back: null, browserBack: null };
  if (await page.evaluate(clickRowTitled, [title])) {
    await page.waitForFunction(readerReady, undefined, { timeout: 12_000 }).catch(() => null);
    read.reader = await page.evaluate(readerProbe);
  }
  if (read.reader && read.reader.layout !== null) {
    // 「知识库」 on the page.
    if (await page.evaluate(clickNamed, ["link", "知识库", "nav[aria-label='返回']"])) {
      await page.waitForTimeout(1_500);
      read.back = await page.evaluate(knowledgeProbe, ["state", first.title]);
    }
    // The browser's Back, from the same document opened again.
    if (read.back && await page.evaluate(clickRowTitled, [title])) {
      await page.waitForFunction(readerReady, undefined, { timeout: 12_000 }).catch(() => null);
      await page.goBack();
      await page.waitForTimeout(1_500);
      read.browserBack = await page.evaluate(knowledgeProbe, ["state", first.title]);
    }
  }
  const verdict = knowledgeReturnFindings(first.title, read);
  return { ...verdict, read };
}

/**
 * The knowledge base's way back, judged (A08). `read` is what `walkKnowledgeReturn` read at each stage. Notices only.
 * @param {string} title the first row's title @param {{ filtered: any, reader: any, back: any, browserBack: any }} read
 * @returns {{ failures: string[], notices: string[] }}
 */
export function knowledgeReturnFindings(title, read) {
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  const current = "files@desktop";
  const { filtered } = read;
  if (!filtered || filtered.rows === 0 || !filtered.listed) {
    notices.push(`${current}: not observable: searching for the first document's own title left ${filtered?.rows ?? 0} row(s) and not that document, so it was not opened`);
    return { failures, notices };
  }
  if (!/[?&]q=/.test(filtered.path)) notices.push(`${current}: the search is not in the address after typing (${filtered.path})`);
  if (!read.reader) {
    notices.push(`${current}: not observable: the document's row was not on the filtered list to open`);
    return { failures, notices };
  }
  const reader = readerFindings(read.reader, { title, list: filtered.path });
  notices.push(...reader.notices);
  if (read.reader.layout === null || read.reader.missing) return { failures, notices };
  if (!/[?&]q=/.test(read.reader.path)) notices.push(`${current}: the document's address does not carry the list's search (${read.reader.path})`);
  for (const [way, back] of [["「知识库」 on the document's page", read.back], ["the browser's Back", read.browserBack]]) {
    if (!back) {
      notices.push(`${current}: not observable: ${way} was not taken`);
      continue;
    }
    if (back.path !== filtered.path) notices.push(`${current}: after ${way} the address is ${back.path} and the list was ${filtered.path}`);
    if (back.query !== null && back.query.trim() !== filtered.query?.trim()) notices.push(`${current}: after ${way} the search box holds “${String(back.query).slice(0, 30)}” and held “${String(filtered.query ?? "").slice(0, 30)}”`);
    if (!back.listed) notices.push(`${current}: after ${way} the document is not in the list`);
  }
  return { failures, notices };
}

/**
 * The first row of each list of one page, clicked, and what that showed (R10 rule 6; R13 V-11). Lists are found by `rowProbe`; a page
 * whose rows are inside closed groups has them opened first (`ROW_REVEAL_BY_PAGE`), and one whose findings are cards is clicked on its
 * first link (`ROW_LINK_BY_PAGE`). The first list's first row is read again with `afterClickProbe` while it is open. The pages that are
 * new to this check in R13 are clicked behind a guard that refuses every request that is not a read, so the walk's clicks write nothing
 * there even where a row marks itself read on the way (the inbox); what the guard refused is a notice.
 * @param {any} page @param {string} base @param {string} route @param {string} name the report's page name
 * @param {{ count: number }} popups the tabs the page opened since the walk last zeroed it
 * @returns {Promise<{ rows: Array<{ label: string, shown: boolean, after?: any }>, failures: string[], notices: string[] }>}
 */
async function walkRowClicks(page, base, route, name, popups) {
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  const guarded = NOTICE_ROW_CLICK_PAGES.has(name);
  const selector = ROW_REVEAL_BY_PAGE[/** @type {keyof typeof ROW_REVEAL_BY_PAGE} */ (name)];
  const reveal = selector ? { selector, limit: ROW_REVEAL_LIMIT } : null;
  const link = ROW_LINK_BY_PAGE[/** @type {keyof typeof ROW_LINK_BY_PAGE} */ (name)] ?? null;
  /** @type {string[]} */ const writes = [];
  const guard = (/** @type {any} */ request) => {
    const method = request.request().method();
    const url = request.request().url();
    // The context's own route answers `start_runtime` (and counts it): the guard hands it on.
    if (["GET", "HEAD"].includes(method) || /\/api\/commands\/start_runtime(?:[/?]|$)/.test(url)) return request.fallback();
    writes.push(`${method} ${new URL(url).pathname.slice(0, 60)}`);
    return request.abort();
  };
  if (guarded) await page.route("**/api/**", guard);
  /** @type {Array<{ label: string, shown: boolean, after?: any }>} */ const rows = [];
  try {
    const prepare = async () => {
      if (!reveal) return;
      await page.evaluate(rowProbe, ["reveal", 0, reveal]);
      await page.waitForTimeout(400);
    };
    await prepare();
    const labels = ((await page.evaluate(rowProbe, ["targets", 0, link])) ?? []).slice(0, ROW_CLICK_LISTS_PER_PAGE);
    for (let index = 0; index < labels.length; index += 1) {
      if (index > 0) {
        // The last click may have opened a drawer or left the page: start the next from the page as it loads.
        await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(routeReady, undefined, { timeout: 30_000 });
        await page.waitForTimeout(1_500);
        await prepare();
      }
      const before = await page.evaluate(rowProbe, ["state"]);
      const external = await page.evaluate(rowProbe, ["external", index, link]);
      popups.count = 0;
      await page.evaluate(rowProbe, ["click", index, link]);
      await page.waitForTimeout(1_500);
      const after = await page.evaluate(rowProbe, ["state"]);
      rows.push({ label: labels[index], shown: rowClickShown(before, after, popups.count, external === true) });
      const kind = AFTER_CLICK_KIND[/** @type {keyof typeof AFTER_CLICK_KIND} */ (name)];
      if (index === 0 && kind) {
        // The first list's first row is open: read what it opened to, before the next load closes it. A task's page draws its pane once
        // the task and its executions are read.
        if (kind === "taskPage") await page.waitForFunction(taskPaneReady, undefined, { timeout: 6_000 }).catch(() => null);
        const opened = await page.evaluate(afterClickProbe, [kind]);
        rows[0].after = opened;
        const judged = afterClickFindings(name, kind, opened);
        failures.push(...judged.failures);
        notices.push(...judged.notices);
      }
    }
  } finally {
    if (guarded) await page.unroute("**/api/**", guard).catch(() => {});
  }
  const verdict = rowClickVerdict(name, rows);
  failures.push(...verdict.failures);
  notices.push(...verdict.notices);
  if (writes.length) notices.push(`${name}@desktop: clicking the first row tried ${writes.length} write(s), refused in the browser: ${[...new Set(writes)].join(", ")}`);
  return { rows, failures, notices };
}

/**
 * The new-skill drawer: opened from the 新建技能 menu, it says what its fields are for and offers to use the skill in this project,
 * and 保存 with every field empty names what is missing in place. The save button writes, so every request that is not a read is
 * refused in the browser before it leaves, and the step fails if one was tried.
 */
async function walkSkillDrawer(page, base, route) {
  await openRoute(page, base, route);
  /** @type {string[]} */ const writes = [];
  const guard = (route) => {
    if (["GET", "HEAD"].includes(route.request().method())) return route.continue();
    writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname.slice(0, 60)}`);
    return route.abort();
  };
  await page.route("**/api/**", guard);
  try {
    if (!await page.evaluate(clickNamed, ["button", "新建技能"])) return { failures: [], notices: ["extensions-skills@desktop: no 新建技能 button to open"] };
    await page.waitForTimeout(500);
    if (!await page.evaluate(clickNamed, ["menuitem", "创建技能"])) return { failures: [], notices: ["extensions-skills@desktop: the 新建技能 menu has no 创建技能"] };
    await page.waitForTimeout(800);
    const opened = await page.evaluate(skillDrawerProbe);
    let refused = null;
    if (opened) {
      await page.evaluate(clickNamed, ["button", "保存", "[role='dialog']"]);
      await page.waitForTimeout(600);
      refused = await page.evaluate(skillDrawerProbe);
      await page.evaluate(clickNamed, ["button", "取消", "[role='dialog']"]);
    }
    return { failures: skillDrawerFindings(opened, refused, writes), read: { opened, refused, writes } };
  } finally {
    await page.unroute("**/api/**", guard).catch(() => {});
  }
}

/**
 * One evidence matrix at one width: the row for each claim, searched by its id, opened into a dialog that Escape closes and returns
 * focus from. Only typing into the page's own search box, a click on a row and Escape: all of them read.
 */
async function walkMatrix(page, base, route, viewportName) {
  await openRoute(page, base, route, 1_500);
  const ready = await page.waitForFunction(matrixProbe, ["ready"], { timeout: 20_000 }).then(() => true).catch(() => false);
  if (!ready) return { failures: [], notices: [`evidence-matrix@${viewportName}: the package's matrix did not appear within twenty seconds, so it was not read`] };
  const state = await page.evaluate(matrixProbe, ["state"]);
  /** @type {any} */ let filtered = null; /** @type {any} */ let dialog = null; /** @type {any} */ let closed = null;
  if (state?.firstId) {
    const search = page.getByRole("searchbox", { name: "搜索结论" });
    await search.fill(state.firstId);
    await page.waitForTimeout(500);
    filtered = await page.evaluate(matrixProbe, ["filtered"]);
    if (await page.evaluate(matrixProbe, ["open"])) {
      await page.waitForTimeout(800);
      dialog = await page.evaluate(matrixProbe, ["dialog"]);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      closed = await page.evaluate(matrixProbe, ["closed"]);
    }
    await search.fill("");
  }
  const verdict = matrixFindings(viewportName, { state, filtered, dialog, closed });
  return { ...verdict, read: { state: state && { ...state, marks: [...new Set(state.marks)] }, filtered, dialog, closed } };
}

/**
 * The conversation page when the previous task's runtime is still being cleaned up. The walk answers the start itself with the
 * refusal the control plane gives (503, `runtime_cleanup_required`, Retry-After 5), so the real runtime is not asked and nothing is
 * started. The cover must say what is happening and offer no allowance page; once the shell has waited its two minutes the alert
 * offers 重试 and the way to what the project already holds. The long wait is the shell's own and is skipped with
 * `OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS=0`.
 */
async function walkCleanupCover(context, base, waitMs) {
  const probe = await context.newPage();
  try {
    await probe.setViewportSize(VIEWPORTS[0][1]);
    await probe.route(/\/api\/commands\/start_runtime(?:[/?]|$)/, (route) => route.fulfill({
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "5" },
      body: JSON.stringify({ error: "The previous runtime is still being cleaned up.", code: "runtime_cleanup_required" }),
    }));
    await probe.goto(`${base}/app/chat`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await probe.waitForTimeout(10_000);
    const early = await probe.evaluate(cleanupProbe);
    let late = null;
    if (waitMs > 0 && !cleanupNotices(early).length) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await probe.waitForTimeout(5_000);
        late = await probe.evaluate(cleanupProbe);
        if (late.alertButtons) break;
      }
    }
    return { failures: cleanupFindings(early, late), notices: cleanupNotices(early), read: { early, late } };
  } finally {
    await probe.close().catch(() => {});
  }
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
    // Whether this account is an operator's: its conversation draws session statistics and the context ring by design (R13 E-17), a
    // researcher's does not. Presentation only, as in the app (`useOperator`): an unreadable answer is a researcher.
    const meAtStart = await context.request.get(`${base}/api/me`).catch(() => null);
    const operator = meAtStart?.ok() ? (await meAtStart.json().catch(() => ({})))?.data?.operator === true : false;
    const found = await discoverRoutes(context, base, notices);
    const routes = [...ROUTES, ...found.routes];
    report.discovered = { routes: found.routes.map(([name]) => name), evidenceMatrix: found.matrix !== null, pdf: found.pdfTitle !== null, keylessConnectors: found.keyless.length };
    const page = await context.newPage();
    // A row that opens a link in a new tab has shown something: the tab is
    // counted and closed.
    const popups = { count: 0 };
    page.on("popup", (popup) => { popups.count += 1; popup.close?.().catch(() => {}); });
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
          const refusals = unexpectedRefusals(name, httpErrors[current] ?? []);
          const verdict = pageFindings(name, viewportName, measured, refusals);
          failures.push(...verdict.failures);
          notices.push(...verdict.notices);
          // The page's structure (R11): the sidebar landmark, the regions that scroll sideways, the order of the headings, the height.
          const structure = await page.evaluate(measureStructure);
          report.pages[current].structure = structure;
          const shape = structureFindings(name, viewportName, structure);
          failures.push(...shape.failures);
          notices.push(...shape.notices);
          if (viewportName === "phone") {
            // Focus order is read, never changed: two presses of Tab from the top of the page, and where each landed.
            const stops = [];
            for (let press = 0; press < 2; press += 1) {
              await page.keyboard.press("Tab");
              stops.push(await page.evaluate(focusProbe));
            }
            report.pages[current].tabStops = stops;
            failures.push(...tabOrderFindings(name, stops, structure.sidebar.closed));
          }
          for (const [kind, viewports] of PAGE_PROBES[budgetKey(name)] ?? []) {
            if (!viewports.includes(viewportName)) continue;
            const record = MISSING_RECORDS[budgetKey(name)];
            const arg = kind === "connectorRows" ? found.keyless : kind === "missingRecord" ? [record.sentence, record.back] : undefined;
            if (kind === "connectorRows" && found.keyless.length === 0) {
              notices.push(`${current}: no data source without a key is unset, so the 可选 rows were not read`);
              continue;
            }
            const read = await page.evaluate(pageProbe, [kind, arg]);
            (report.pages[current].probes ||= {})[kind] = read;
            const judged = probeFindings(name, viewportName, kind, read);
            failures.push(...judged.failures);
            notices.push(...judged.notices);
          }
          if (viewportName === "desktop" && MISSING_RECORDS[name]) {
            // The way back is a click that only navigates: the button names the list and the address must be that list's.
            const record = MISSING_RECORDS[name];
            const clicked = await page.evaluate(clickNamed, ["button", record.back, "[role='dialog']"]);
            await page.waitForTimeout(1_500);
            const where = await page.evaluate(() => location.pathname);
            if (!clicked || where !== record.to) failures.push(`${current}: ${record.back} ${clicked ? `goes to ${where}` : "is not on the page"} (${record.to})`);
          }
          if (viewportName === "desktop" && ROW_CLICK_PAGES.has(name)) {
            // Read-only by construction: a row's title opens a drawer, a page or itself; the pages new to the walk in R13 also have
            // every request that is not a read refused in the browser while their row is clicked (`walkRowClicks`).
            const clicked = await walkRowClicks(page, base, route, name, popups);
            report.pages[current].rowClicks = clicked.rows;
            failures.push(...clicked.failures);
            notices.push(...clicked.notices);
            if (name === "files" && found.pdfTitle) await recordStep(report, failures, notices, "files-pdf", () => walkPdfPreview(page, base, route, found.pdfTitle));
            // A08 on the knowledge base: a search, a document opened from it, and both ways back (only where there is a document to open).
            if (name === "files" && clicked.rows.length > 0) await recordStep(report, failures, notices, "files-return", () => walkKnowledgeReturn(page, base, route));
            if (name === "extensions-skills") await recordStep(report, failures, notices, "extensions-skills-create", () => walkSkillDrawer(page, base, route));
          }
        } catch (error) {
          failures.push(`${current}: did not load (${String(error).slice(0, 120)})`);
        }
      }
      if (found.matrix) {
        // A finished package's evidence matrix, read at this width (R11); it is a page of the run's own files, found from the run list.
        current = `evidence-matrix@${viewportName}`;
        await recordStep(report, failures, notices, current, () => walkMatrix(page, base, found.matrix, viewportName));
      }
    }
    notices.push(...leftEdgeNotices(report.pages));
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
      // The composer's room, chips and statistics at both widths (R13 E-17, A20), read through the frame that just loaded.
      if (chat.loaded) await recordStep(report, failures, notices, "chat-composer", () => walkComposer(page, operator));
      // A start the control plane refuses for a cleanup in progress, answered by the walk (R11); it starts nothing.
      const waitMs = process.env.OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS !== undefined ? Number(process.env.OPEN_SCIENCE_WALK_CLEANUP_WAIT_MS) || 0 : CLEANUP_WALK_WAIT_MS;
      allowRuntimeStart = false;
      await recordStep(report, failures, notices, "chat-cleanup-cover", () => walkCleanupCover(context, base, waitMs));
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

/* ------------------------------------------------------------------------- R13: the composer */

/** A control sits at least this far above the bottom of the conversation's window (R13 E-17: `max(16px, the device's bottom inset)`). */
export const COMPOSER_BOTTOM_PX = 16;

/**
 * The composer of the conversation, read inside the kernel's frame (`frame.evaluate`; it reads nothing from this module). The kernel's
 * classes end in a stable suffix — `…_card`, `…_row`, `…_tools`, `…_dock`, `…_root` — which the shell's own stylesheet addresses by
 * `[class$="…"]`; they are found the same way here, from the editable the reader types in. Read: whether there is a composer and whether
 * it is the blank conversation's (centred, with no dock under it), the lowest control and how far it is above the bottom of the window,
 * how many lines the toolbar's row takes, whether the page scrolls sideways, the tool chips by where they are drawn (the toolbar,
 * the hero's seat, the dock), and the session statistics and the context ring, which are drawn for an operator and hidden (not removed)
 * for a researcher.
 * @param {[{ operator?: boolean }?]} args
 */
export function composerProbe([options] = [{}]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  // `[class$="_card"]` matches the whole attribute, so a class list that ends in another class is not a match.
  const endsWith = (el, suffix) => String(el.getAttribute("class") ?? "").endsWith(suffix);
  const ancestor = (el, suffix) => { for (let at = el; at; at = at.parentElement) if (endsWith(at, suffix)) return at; return null; };
  const within = (root, suffix) => (root ? [...root.querySelectorAll("*")].find((el) => endsWith(el, suffix)) ?? null : null);
  const bottomOf = (el) => (el ? Math.round(el.getBoundingClientRect().bottom) : null);
  const editable = [...document.querySelectorAll("[contenteditable='true']")].filter(visible).pop() ?? null;
  const card = editable ? ancestor(editable, "_card") : null;
  const root = card ? card.parentElement : null;
  const row = within(card, "_row");
  const tools = within(card, "_tools");
  const dock = within(root, "_dock");
  const height = window.innerHeight;
  const controls = root ? [...root.querySelectorAll("button, select, summary, input, [role='button']")].filter(visible) : [];
  const lowest = controls.reduce((max, el) => Math.max(max, el.getBoundingClientRect().bottom), 0);
  const chips = [...document.querySelectorAll("[data-evimed-tool-chip]")].filter(visible);
  const placed = (placement) => chips.filter((el) => el.getAttribute("data-evimed-chip-placement") === placement).length;
  // The toolbar's lines: children that overlap vertically are on one line (the tools and the send key are centred in a row, a few px apart),
  // and a child that starts below the line before it wrapped onto its own.
  let lines = null;
  if (row) {
    const boxes = [...row.children].filter(visible).map((el) => el.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    lines = 0;
    let lineBottom = -Infinity;
    for (const box of boxes) {
      if (box.top >= lineBottom - 1) { lines += 1; lineBottom = box.bottom; } else lineBottom = Math.max(lineBottom, box.bottom);
    }
  }
  const ring = [...document.querySelectorAll("button[aria-haspopup='dialog']")].filter((el) => visible(el)
    && (String(el.getAttribute("aria-label") ?? "").startsWith("上下文已用") || String(el.getAttribute("aria-label") ?? "").endsWith("of context used")));
  return {
    composer: Boolean(card),
    // The blank conversation's composer is centred and has no dock under it; the room under it is not the rule's.
    hero: Boolean(root && String(root.getAttribute("class") ?? "").includes("_hero")) || (Boolean(card) && !dock),
    operator: Boolean(options && options.operator),
    window: { width: window.innerWidth, height },
    gapCard: bottomOf(card) === null ? null : height - /** @type {number} */ (bottomOf(card)),
    gapLowest: controls.length ? Math.round(height - lowest) : null,
    rowLines: lines,
    rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
    scrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    chips: {
      total: chips.length, bar: placed("bar"), hero: placed("hero"),
      inTools: tools ? chips.filter((el) => tools.contains(el)).length : 0,
      inDock: dock ? chips.filter((el) => dock.contains(el)).length : 0,
    },
    stats: { present: document.querySelectorAll("[data-composer-stats]").length, visible: [...document.querySelectorAll("[data-composer-stats]")].filter(visible).length },
    ring: ring.length,
  };
}

/**
 * The composer as a reader meets it at one width (R13 E-17, A20): the lowest control is at least 16 px above the bottom of the window;
 * a conversation that runs a tool draws exactly one chip in the toolbar and none in the dock; a researcher sees neither the session
 * statistics nor the context ring; at 390 px the toolbar's row is one line and the page does not scroll sideways. Every verdict is a
 * NOTICE (new in R13). Each says "not observable" and why when what it looks at is not there: the walk's conversation runs no tool (a
 * tool is bound by the 科研工具 page, whose cards write), may be the blank conversation, and may belong to an operator.
 * @param {"desktop" | "phone"} viewportName @param {any} r what `composerProbe` returned
 * @returns {{ failures: string[], notices: string[] }}
 */
export function composerFindings(viewportName, r) {
  const current = `chat@${viewportName}`;
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!r || !r.composer) {
    notices.push(`${current}: not observable: no composer was found in the conversation's frame, so its room, chips and statistics were not read`);
    return { failures, notices };
  }
  if (r.hero) notices.push(`${current}: not observable: the conversation is the blank one, whose composer is centred with no dock under it, so the room under it was not judged`);
  else if (r.gapLowest === null) notices.push(`${current}: not observable: the composer holds no control, so the room under it was not judged`);
  else if (r.gapLowest < COMPOSER_BOTTOM_PX) notices.push(`${current}: the lowest control of the composer is ${r.gapLowest} px above the bottom of the window (at least ${COMPOSER_BOTTOM_PX})`);
  if (r.chips.total === 0) notices.push(`${current}: not observable: the conversation runs no tool, so there is no chip to count (a tool is bound from 科研工具, whose cards write)`);
  else {
    if (r.chips.bar !== 1) notices.push(`${current}: ${r.chips.bar} tool chip(s) are drawn in the toolbar (exactly one)`);
    if (r.chips.inTools !== r.chips.bar) notices.push(`${current}: ${r.chips.bar} chip(s) say they are in the toolbar and ${r.chips.inTools} are inside it`);
    if (r.chips.inDock > 0) notices.push(`${current}: ${r.chips.inDock} tool chip(s) are drawn in the dock under the card (none)`);
  }
  if (r.operator) notices.push(`${current}: not observable: the account is an operator's, whose session statistics and context ring are drawn by design, so their absence was not judged`);
  else {
    if (r.stats.visible > 0) notices.push(`${current}: ${r.stats.visible} session statistics line(s) are visible to a researcher`);
    if (r.ring > 0) notices.push(`${current}: the context ring is visible to a researcher`);
  }
  if (viewportName === "phone") {
    if (r.rowLines !== null && r.rowLines > 1) notices.push(`${current}: the toolbar takes ${r.rowLines} lines at ${r.window.width} px (one)`);
    if (r.scrollsSideways) notices.push(`${current}: the conversation scrolls sideways at ${r.window.width} px`);
  }
  return { failures, notices };
}

/** The kernel's frame holding a composer, read with `composerProbe`; null when none of the shell's frames has one. */
async function readComposer(page, operator) {
  for (const frame of page.frames()) {
    if (!frame.url().includes("/__evimed/f/")) continue;
    const read = await frame.evaluate(composerProbe, [{ operator }]).catch(() => null);
    if (read?.composer) return read;
  }
  return null;
}

/**
 * The conversation's composer at the desktop width and at 390 px (R13 E-17, A20), through the frame the chat step already loaded. The
 * window is made narrow and then made what it was; nothing is typed, clicked or sent.
 * @param {any} page @param {boolean} operator whether the walk's account is an operator's
 */
async function walkComposer(page, operator) {
  const desktop = await readComposer(page, operator);
  await page.setViewportSize(VIEWPORTS[1][1]);
  await page.waitForTimeout(1_500);
  const phone = await readComposer(page, operator);
  await page.setViewportSize(VIEWPORTS[0][1]);
  await page.waitForTimeout(500);
  const a = composerFindings("desktop", desktop);
  const b = composerFindings("phone", phone);
  return { failures: [...a.failures, ...b.failures], notices: [...a.notices, ...b.notices], read: { desktop, phone } };
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
          // On screen: a researcher's statistics are in the document and hidden (R13 E-17), and are not what this records.
          stats: [...document.querySelectorAll("[data-composer-stats]")].filter((node) => node.getClientRects().length > 0).map((node) => node.textContent?.trim() ?? ""),
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
