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
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

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
  // A day that has no issue (R13, A11): the page says which day and when issues come, and reads as an empty day and not as a failure. Its own
  // read answers 404 by design, and the day is one nobody published (the feed did not exist in 2020).
  ["frontier-daily-empty", "/app/frontier?view=daily&day=2020-01-01"],
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
  "frontier-daily-empty": FRONTIER_BUDGET,
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
  "evidence-matrix", "files-reader", "frontier-daily-empty",
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
  // R13 (V-7): the pages the reference named (design reference §21.3). The numbers are the designed ones — a pinned list over the list of the
  // rest (the inbox), the project list beside its one sentence (循证 GEO's home), the zones of each kind and the topic request (the zones'
  // home), a list column and a main area (the scheduled tasks), a settings page's own sections — and they are not measured: a page of
  // `NOTICE_SECTION_PAGES` that stacks more says so as a notice, with its shapes, until a walk has reported them.
  inbox: 2, geo: 2, "frontier-zones": 3, autopilot: 2, account: 3,
};
/**
 * The pages whose section budget is new in R13: stacking more kinds of section than the budget says is a notice there, with the shapes in
 * it, and not a failure (principle 4: a check ships as a notice until it has a distribution). The pages of the table above that are not
 * named here keep failing, as they have since R10.
 */
export const NOTICE_SECTION_PAGES = new Set(["inbox", "geo", "frontier-zones", "autopilot", "account"]);

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
    if (sectionBudget !== undefined && shapes.length > sectionBudget) {
      const finding = `${current}: the page stacks ${shapes.length} kinds of section (budget ${sectionBudget}): ${shapes.join(", ")}`;
      if (NOTICE_SECTION_PAGES.has(key)) notices.push(`${finding} — new in R13: reported, not failed, until a walk has measured this page`);
      else budgetFindings.push(finding);
    }
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
  "frontier-daily-empty": [404],
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
  if (kind === "dailyEmpty") {
    // What the daily view says for a day that has no issue: an empty state (a title and a description) or an error (a alert with 重试).
    const alert = all("[role='alert']").find(visible);
    const lines = all("p, div").filter((el) => visible(el) && el.children.length === 0).map(words).filter(Boolean);
    const title = lines.find((text) => /没有日报|日报.{0,24}发布|暂无日报|尚未发布/.test(text)) ?? null;
    return {
      // The alert's text is the message and its button (「…重试」); the message is what is said.
      alert: alert ? words(alert).replace(/重试$/, "").trim() : null,
      retry: alert ? all("button", alert).some((el) => visible(el) && words(el) === "重试") : false,
      title,
      description: lines.find((text) => text !== title && /不出刊/.test(text)) ?? null,
      past: all("button").some((el) => visible(el) && words(el) === "往期"),
    };
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
  "frontier-daily-empty": [["dailyEmpty", ["desktop", "phone"]]],
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
    case "dailyEmpty": {
      // R13 (E-3, A11), notices: a day with no issue reads as an empty day, names the day, and says when issues come and in which zone. A
      // page the account is not offered, or one that drew neither, is not observable.
      if (r.alert) {
        notices.push(`${current}: a day nobody published reads as a failure: “${r.alert.slice(0, 60)}”${r.retry ? " with 重试" : ""} (an empty day and a failed one are different, A11)`);
      } else if (!r.title) {
        notices.push(`${current}: not observable: the daily view drew neither an empty day nor an error (the feed may not be offered to this account)`);
      } else {
        if (!/\d{1,2}月\d{1,2}日/.test(r.title)) notices.push(`${current}: the empty day does not name the day it is about: “${r.title.slice(0, 40)}”`);
        const time = /(\d{1,2}:\d{2})(（[^）]+）)?/.exec(`${r.title} ${r.description ?? ""}`);
        if (time && !time[2]) notices.push(`${current}: the empty day names a publication time (${time[1]}) and not whose clock it is`);
      }
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
    // axe-core (V-6): looked for once; its absence is one notice and the walk goes on.
    const axe = await loadAxeSource();
    if (!axe.source) notices.push(`axe-core not available in this image: ${axe.why}`);
    /** @type {Array<{ view: string, result: any }>} */ const axeScans = [];
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
          // A scan of the page as it loaded, at the desktop width (V-6); before any click changes it. Never a failure.
          if (viewportName === "desktop" && axe.source) {
            const result = await scanWithAxe(page, axe.source);
            report.pages[current].axe = result;
            axeScans.push({ view: current, result });
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
    notices.push(...axeNotices(axeScans));
    report.axe = { from: axe.from, version: axe.version, scanned: axeScans.filter((scan) => scan.result).length, why: axe.why };
    // R13 (V-7), the cases that are more than a page's measure and run at the desktop width: where the reader is lives in the address (A08), and
    // the event page's hand-off to the conversation (A01). Each is a notice that says "not observable" when the account has nothing to try it on.
    await page.setViewportSize(VIEWPORTS[0][1]);
    current = "address@desktop";
    await recordStep(report, failures, notices, "address-state", () => walkAddressState(page, base));
    const eventRoute = found.routes.find(([name]) => name === "frontier-event")?.[1] ?? null;
    if (eventRoute) await recordStep(report, failures, notices, "frontier-event-handoff", () => walkEventHandoff(page, base, eventRoute));
    else notices.push("frontier-event@desktop: not observable: the hot list names no event, so the hand-off of 深入研究 to the conversation (A01) was not read");
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

/* ------------------------------------------------------------------------- R13: axe-core (V-6) */

/** The rules axe runs: WCAG 2.0, 2.1 and 2.2 at A and AA, and its best practices (design reference §19.1). */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
/** How long one page's scan may take before the walk gives up on it. */
export const AXE_SCAN_TIMEOUT_MS = 30_000;
/** The rules one page's notice names; the report holds all of them. */
export const AXE_RULES_PER_NOTICE = 6;

/**
 * Whether a text is the source of axe-core's browser build (`axe.min.js` starts with its banner), and which version.
 * @param {string} source @returns {string | null} the version, or null when it is not axe-core
 */
export function axeVersionOf(source) {
  const banner = /^\s*\/\*!\s*axe v(\d+\.\d+\.\d+)/.exec(String(source).slice(0, 400));
  return banner && String(source).includes("axe.run") ? banner[1] : null;
}

/**
 * axe-core's source, for the walk to put into each page it scans. The walk runs in a throwaway container with one file mounted, so it
 * cannot count on a package being installed there; it looks, in this order, at the file `OPEN_SCIENCE_WALK_AXE` names (`off` switches the
 * scan off), at the copy embedded in this file when there is one (`AXE_EMBEDDED`, below), and at the `axe-core` package a checkout resolves
 * beside the walk or beside playwright-core. A source that is not axe-core's is not used. Absence is an answer, not an error.
 * @param {{ env?: Record<string, string | undefined>, read?: (file: string) => Promise<string>, resolve?: (from: string) => string | null,
 *   embedded?: { version: string, sha256: string, brotliBase64: string } | null }} [options]
 * @returns {Promise<{ source: string | null, version: string | null, from: string | null, why: string | null }>}
 */
export async function loadAxeSource({ env = process.env, read = (file) => readFile(file, "utf8"), resolve = resolveAxe, embedded = AXE_EMBEDDED } = {}) {
  const wanted = (env.OPEN_SCIENCE_WALK_AXE ?? "").trim();
  if (wanted === "off") return { source: null, version: null, from: null, why: "the scan is switched off (OPEN_SCIENCE_WALK_AXE=off)" };
  /** @type {string[]} */ const unusable = [];
  const accept = (source, from) => {
    const version = axeVersionOf(source);
    if (version) return { source, version, from, why: null };
    unusable.push(`${from} is not axe-core's build`);
    return null;
  };
  if (wanted) {
    try {
      const found = accept(await read(wanted), wanted);
      if (found) return found;
    } catch (error) {
      unusable.push(`${wanted} could not be read (${String(error?.code ?? error).slice(0, 40)})`);
    }
  }
  if (embedded) {
    const source = brotliDecompressSync(Buffer.from(embedded.brotliBase64, "base64")).toString("utf8");
    if (createHash("sha256").update(source).digest("hex") === embedded.sha256) {
      const found = accept(source, `embedded in the walk (axe-core ${embedded.version})`);
      if (found) return found;
    } else unusable.push("the copy embedded in the walk does not match its checksum");
  }
  for (const from of [import.meta.url, process.env.OPEN_SCIENCE_PLAYWRIGHT_CORE ?? ""].filter(Boolean)) {
    try {
      const file = resolve(from);
      if (!file) continue;
      const found = accept(await read(file), file);
      if (found) return found;
    } catch {
      // Not installed beside this one: the next place.
    }
  }
  return { source: null, version: null, from: null, why: unusable.length ? unusable.join("; ") : "no copy was given, embedded or installed beside the walk" };
}

/** The `axe-core` package that resolves from a file or directory, or null. */
function resolveAxe(from) {
  try {
    const anchor = from.startsWith("file:") ? from : path.join(from.startsWith("/") ? from : process.cwd(), "package.json");
    return createRequire(anchor).resolve("axe-core/axe.min.js");
  } catch {
    return null;
  }
}

/** Whether axe-core is already in the page (a page of a single-page app keeps it across a route change). */
export function axeLoaded() {
  return typeof window.axe === "object" && typeof window.axe.run === "function";
}

/**
 * axe-core run over a page already holding it (`page.evaluate(source)` first), and cut down to what the report keeps. The frames are not
 * scanned (`iframes: false`): the kernel's is another origin without axe, and waiting for it is a minute per page. The scan reads and
 * changes nothing on the page.
 * @param {[{ tags: string[], scope?: string | null }]} args
 */
export async function axeRun([options]) {
  const axe = window.axe;
  if (!axe) return null;
  const result = await axe.run(options.scope ? options.scope : document, { iframes: false, resultTypes: ["violations"], runOnly: { type: "tag", values: options.tags } });
  const target = (violation) => String((violation.nodes[0] && violation.nodes[0].target ? [].concat(violation.nodes[0].target).join(" ") : "")).slice(0, 140);
  return {
    version: axe.version ?? null,
    violations: result.violations.map((violation) => ({
      id: violation.id, impact: violation.impact ?? null, nodes: violation.nodes.length, target: target(violation), help: String(violation.help ?? "").slice(0, 100),
    })),
    incomplete: Array.isArray(result.incomplete) ? result.incomplete.length : 0,
  };
}

const IMPACT_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const impactRank = (impact) => IMPACT_RANK[/** @type {keyof typeof IMPACT_RANK} */ (impact)] ?? 4;

/**
 * What axe found on each page view, as notices (V-6; a scan is never a failure): one line for each page that has something new to say —
 * the rules it violates by impact, with the nodes counted and the first one named by its selector — and one line for the walk. A
 * violation the walk already named on an earlier page view (the same rule at the same first node: the shell's own, which every page
 * carries) is counted, not named again. The report holds every page's whole list.
 * @param {Array<{ view: string, result: { version: string | null, violations: Array<{ id: string, impact: string | null, nodes: number, target: string, help: string }>, incomplete: number } | null }>} scans
 * @returns {string[]}
 */
export function axeNotices(scans) {
  /** @type {string[]} */ const notices = [];
  const seen = new Set();
  let scanned = 0;
  let withViolations = 0;
  let total = 0;
  const rules = new Map();
  let version = null;
  for (const { view, result } of scans) {
    if (!result) {
      notices.push(`${view}: axe-core could not scan this page`);
      continue;
    }
    scanned += 1;
    version = result.version ?? version;
    if (result.violations.length) withViolations += 1;
    const fresh = result.violations.filter((violation) => !seen.has(`${violation.id}|${violation.target}`))
      .sort((a, b) => impactRank(a.impact) - impactRank(b.impact) || b.nodes - a.nodes);
    for (const violation of result.violations) {
      seen.add(`${violation.id}|${violation.target}`);
      total += violation.nodes;
      rules.set(violation.id, (rules.get(violation.id) ?? 0) + 1);
    }
    if (!fresh.length) continue;
    const named = fresh.slice(0, AXE_RULES_PER_NOTICE).map((violation) => `${violation.id} (${violation.impact ?? "unrated"}, ${violation.nodes} node${violation.nodes === 1 ? "" : "s"}, ${violation.target || "no selector"})`);
    const repeated = result.violations.length - fresh.length;
    const more = fresh.length - named.length;
    notices.push(`${view}: axe-core: ${fresh.length} rule(s) violated: ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}${repeated > 0 ? `; ${repeated} more as on an earlier page` : ""}`);
  }
  if (scans.length) {
    const common = [...rules.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([id, pages]) => `${id} on ${pages}`);
    notices.push(`axe-core${version ? ` ${version}` : ""}: ${scanned} page view(s) scanned, ${withViolations} with violations, ${total} node(s) in all${common.length ? ` (${common.join(", ")})` : ""}; never a failure, the whole list is in the report`);
  }
  return notices;
}

/**
 * One page view scanned with axe-core: the source is put into the page when it is not there, and the scan is given
 * `AXE_SCAN_TIMEOUT_MS`; a scan that fails or runs out is `null` (and said so by `axeNotices`), never an exception into the walk.
 * @param {any} page @param {string} source axe-core's source
 * @param {{ tags?: string[], timeoutMs?: number }} [options]
 */
export async function scanWithAxe(page, source, { tags = AXE_TAGS, timeoutMs = AXE_SCAN_TIMEOUT_MS } = {}) {
  try {
    if (!await page.evaluate(axeLoaded)) await page.evaluate(source);
    /** @type {any} */ let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    try {
      return await Promise.race([page.evaluate(axeRun, [{ tags }]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- R13: where the reader is lives in the address (A08, A01) */

/**
 * Presses a control that only chooses what a list shows and goes nowhere: a chip of a group (the inbox's 未读), a tab of a page (the
 * memory page's 项目), or a link of the sidebar (to leave a page and come back). Never a button that writes.
 * @param {["chip" | "tab" | "link", string?, string?]} args `["chip", group, label-prefix]`, `["tab", label-prefix]`, `["link", href]`
 * @returns {boolean} whether the control was found and pressed
 */
export function addressAct([kind, first = "", second = ""]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  let target = null;
  if (kind === "chip") {
    const group = [...document.querySelectorAll("[role='group']")].find((el) => el.getAttribute("aria-label") === first && visible(el));
    target = group ? [...group.querySelectorAll("button")].find((el) => visible(el) && words(el).startsWith(second)) ?? null : null;
  } else if (kind === "tab") {
    target = [...document.querySelectorAll("[role='tab']")].find((el) => visible(el) && words(el).startsWith(first)) ?? null;
  } else if (kind === "link") {
    target = [...document.querySelectorAll("aside a")].find((el) => visible(el) && el.getAttribute("href") === first) ?? null;
  }
  if (!target) return false;
  target.click();
  return true;
}

/**
 * Where a list page is and what its controls say, read in the page: the address, and — per `kind` — the inbox's pressed chip, or the memory
 * page's selected tab and the text of its search box.
 * @param {["inbox" | "memory"]} args
 */
export function addressProbe([kind]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const base = { path: location.pathname, search: location.search, dialog: [...document.querySelectorAll("[role='dialog']")].some(visible) };
  if (kind === "inbox") {
    const group = [...document.querySelectorAll("[role='group']")].find((el) => el.getAttribute("aria-label") === "消息筛选" && visible(el));
    const pressed = group ? [...group.querySelectorAll("button[aria-pressed='true']")].map(words) : [];
    return { ...base, found: Boolean(group), pressed: pressed[0] ?? null };
  }
  if (kind === "memory") {
    const tabs = [...document.querySelectorAll("[role='tab']")].filter(visible);
    const selected = tabs.find((el) => el.getAttribute("aria-selected") === "true");
    const box = [...document.querySelectorAll("main input")].find((el) => el.getAttribute("aria-label") === "搜索记忆" && visible(el));
    return { ...base, found: tabs.length > 0, selected: selected ? words(selected) : null, query: box ? box.value : null };
  }
  return null;
}

/**
 * The pages whose list state is in the address (R13 E-8; design reference A08): what the walk chooses on each, what the address must then
 * say, and what the page must show — after the choice, after leaving for another page and pressing Back, and after the address is loaded
 * again. The choices only filter a list; nothing here writes. `state` values match by prefix, because a chip and a tab carry their count.
 */
export const ADDRESS_CASES = [
  { page: "inbox", route: "/app/inbox", probe: "inbox", act: [["chip", "消息筛选", "未读"]], fill: null, search: { filter: "unread" }, state: { pressed: "未读" } },
  { page: "memory", route: "/app/memory", probe: "memory", act: [["tab", "项目"]], fill: ["搜索记忆", "探针"], search: { tab: "project", q: "探针" }, state: { selected: "项目", query: "探针" } },
];

/**
 * Whether a page's state is what a case says. Strings match by prefix, except a search box's text, which is exact.
 * @param {Record<string, string>} wanted @param {any} read
 */
export function addressStateHolds(wanted, read) {
  if (!read) return false;
  return Object.entries(wanted).every(([key, value]) => (key === "query" ? read[key] === value : typeof read[key] === "string" && read[key].startsWith(value)));
}

/**
 * One list page's way back, judged (A08): the choice is in the address, the page shows it, and both Back from another page and loading the
 * address again find it. `read` is what the walk read at each stage; a stage that was not reached is null. Notices only (new in R13).
 * @param {typeof ADDRESS_CASES[number]} c
 * @param {{ pressed: boolean[], first: any, away: string | null, back: any, reload: any }} read
 * @returns {{ failures: string[], notices: string[] }}
 */
export function addressStateFindings(c, read) {
  const current = `${c.page}@desktop`;
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!read.first || !read.first.found) {
    notices.push(`${current}: not observable: the page's list controls were not found, so what it keeps in its address was not read`);
    return { failures, notices };
  }
  if (read.pressed.includes(false) || (c.fill && read.first.query === null)) {
    notices.push(`${current}: not observable: a control of the case was not on the page (${[...read.pressed.map((found) => (found ? "found" : "missing")), ...(c.fill ? [read.first.query === null ? "search box missing" : "search box found"] : [])].join(", ")}), so the choice was not made`);
    return { failures, notices };
  }
  const params = new URLSearchParams(read.first.search);
  for (const [name, value] of Object.entries(c.search)) {
    if (params.get(name) !== value) notices.push(`${current}: the choice is not in the address after it was made: ${name}=${value} is not in “${read.first.search}”`);
  }
  if (!addressStateHolds(c.state, read.first)) notices.push(`${current}: the page does not show the choice it was given (${JSON.stringify(c.state)})`);
  for (const [way, stage] of [["Back from another page", read.back], ["loading the address again", read.reload]]) {
    if (!stage) {
      notices.push(`${current}: not observable: ${way} was not taken`);
      continue;
    }
    if (stage.search !== read.first.search) notices.push(`${current}: after ${way} the address is “${stage.search}” and was “${read.first.search}”`);
    if (!addressStateHolds(c.state, stage)) notices.push(`${current}: after ${way} the page shows ${JSON.stringify(Object.fromEntries(Object.keys(c.state).map((key) => [key, stage[key] ?? null])))} (${JSON.stringify(c.state)})`);
  }
  if (read.away !== null && read.away === read.first.path) notices.push(`${current}: not observable: the sidebar link did not leave the page (${read.away}), so Back came from nowhere`);
  return { failures, notices };
}

/**
 * A row that opens in a drawer is in the address while it is open, and Back closes it (A08; `useAddressOpen`). Judged from the address and
 * the dialog right after the row was opened and right after Back. Notices only; a page with no row says so.
 * @param {string} page the report's page name @param {{ rows: number, opened: any, closed: any }} read
 * @returns {{ failures: string[], notices: string[] }}
 */
export function addressOpenFindings(page, read) {
  const current = `${page}@desktop`;
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (read.rows === 0) {
    notices.push(`${current}: not observable: no row of the list opens, so an open row's place in the address was not read`);
    return { failures, notices };
  }
  if (!read.opened?.dialog) notices.push(`${current}: not observable: the first row did not open a drawer, so its place in the address was not read`);
  else {
    if (!/[?&]open=/.test(read.opened.search)) notices.push(`${current}: the open row is not in the address (“${read.opened.search}”)`);
    if (!read.closed) notices.push(`${current}: not observable: Back was not taken`);
    else {
      if (read.closed.dialog) notices.push(`${current}: Back leaves the drawer open`);
      if (/[?&]open=/.test(read.closed.search)) notices.push(`${current}: Back leaves the row in the address (“${read.closed.search}”)`);
    }
  }
  return { failures, notices };
}

/**
 * A08 on the inbox and the memory page: the filter, the tab and the search are chosen, the address is read, another page is opened by the
 * sidebar and Back is pressed, the address is loaded again — and a memory row is opened and closed by Back. The choices only change what a
 * list shows. The walk's window is the desktop's.
 */
async function walkAddressState(page, base) {
  /** @type {string[]} */ const notices = [];
  const reads = {};
  for (const c of ADDRESS_CASES) {
    await openRoute(page, base, c.route);
    const pressed = [];
    for (const act of c.act) {
      pressed.push(Boolean(await page.evaluate(addressAct, act)));
      await page.waitForTimeout(400);
    }
    if (c.fill) {
      // A page without the box says so in the probe (its text is null); the fill gives up soon and is not what fails the step.
      await page.getByRole("searchbox", { name: c.fill[0] }).fill(c.fill[1], { timeout: 5_000 }).catch(() => null);
      await page.waitForTimeout(1_200);
    }
    const first = await page.evaluate(addressProbe, [c.probe]);
    let away = null;
    let back = null;
    let reload = null;
    if (first && first.found && !pressed.includes(false) && !(c.fill && first.query === null)) {
      // Leave by the sidebar (another page of the same shell), and come back by the browser's Back.
      if (await page.evaluate(addressAct, ["link", "/app/capabilities"])) {
        await page.waitForTimeout(1_500);
        away = await page.evaluate(() => location.pathname);
        await page.goBack();
        await page.waitForTimeout(1_500);
        back = await page.evaluate(addressProbe, [c.probe]);
      }
      // The address loaded again: a reload, a pasted link.
      await openRoute(page, base, `${first.path}${first.search}`);
      reload = await page.evaluate(addressProbe, [c.probe]);
    }
    const read = { pressed, first, away, back, reload };
    reads[c.page] = read;
    notices.push(...addressStateFindings(c, read).notices);
  }
  // A memory row that opens in a drawer: in the address while open, closed by Back.
  await openRoute(page, base, "/app/memory");
  const rows = (await page.evaluate(rowProbe, ["targets"])) ?? [];
  /** @type {{ rows: number, opened: any, closed: any }} */ const open = { rows: rows.length, opened: null, closed: null };
  if (rows.length > 0) {
    await page.evaluate(rowProbe, ["click", 0]);
    await page.waitForTimeout(1_200);
    open.opened = await page.evaluate(addressProbe, ["memory"]);
    await page.goBack();
    await page.waitForTimeout(1_200);
    open.closed = await page.evaluate(addressProbe, ["memory"]);
  }
  reads["memory-open"] = open;
  notices.push(...addressOpenFindings("memory", open).notices);
  return { failures: [], notices, read: reads };
}

/**
 * The event page's 「深入研究」 (A01): the draft that goes to the conversation. The click is a route change whose state (React Router's
 * `history.state.usr`) holds the hand-off; read there, it is the event's title, a link to its sources and a draft that is never sent (the
 * hand-off has no field that sends). `["event"]` reads the page before; `["intent"]` reads the address and the hand-off after.
 * @param {["event" | "intent"]} args
 */
export function handoffProbe([action]) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (action === "event") {
    const heading = document.querySelector("main h1");
    return {
      path: `${location.pathname}${location.search}`,
      title: heading ? words(heading) : null,
      button: [...document.querySelectorAll("main button")].some((el) => visible(el) && words(el) === "深入研究"),
    };
  }
  const state = window.history.state && typeof window.history.state === "object" ? window.history.state.usr : null;
  const intent = state && typeof state === "object" ? state.runtimeUiIntent ?? null : null;
  return {
    path: `${location.pathname}${location.search}`,
    intent: intent && typeof intent === "object"
      ? { keys: Object.keys(intent).sort(), kind: intent.kind ?? null, draft: typeof intent.draft === "string" ? intent.draft : null, requestId: typeof intent.requestId === "string" ? intent.requestId : null }
      : null,
  };
}

/** The fields a hand-off to the conversation may carry (`RuntimeUiIntent`): none of them sends. */
export const HANDOFF_FIELDS = ["draft", "kind", "projectId", "requestId", "resultRevision", "sessionId"];

/**
 * The event page's hand-off, judged (A01). `before` is the event page, `after` the address and state once 「深入研究」 was pressed, and
 * `back` the address after Back. Notices only (new in R13); an account with no event, or a page without the button, says so.
 * @param {any} before @param {any} after @param {string | null} back
 * @returns {{ failures: string[], notices: string[] }}
 */
export function handoffFindings(before, after, back) {
  const current = "frontier-event@desktop";
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const notices = [];
  if (!before || !before.button) {
    notices.push(`${current}: not observable: the event page has no 深入研究 button, so the hand-off to the conversation was not read`);
    return { failures, notices };
  }
  if (!after || !/^\/app\/chat(?:[/?]|$)/.test(after.path ?? "")) {
    notices.push(`${current}: not observable: 深入研究 did not go to the conversation (${after?.path ?? "nowhere"}), so its draft was not read`);
    return { failures, notices };
  }
  const intent = after.intent;
  if (!intent) {
    notices.push(`${current}: the hand-off to the conversation carries no intent in the address's state`);
    return { failures, notices };
  }
  if (intent.kind !== "create") notices.push(`${current}: the hand-off is a “${intent.kind}” intent (create: a new conversation)`);
  if (!intent.draft) notices.push(`${current}: the hand-off carries no draft`);
  else {
    if (before.title && !intent.draft.includes(before.title)) notices.push(`${current}: the draft does not hold the event's title “${before.title.slice(0, 30)}”`);
    if (!/https?:\/\/\S+/.test(intent.draft)) notices.push(`${current}: the draft holds no link to a source`);
  }
  if (!intent.requestId) notices.push(`${current}: the hand-off has no request id, so a reload cannot tell it from a new one`);
  const extra = intent.keys.filter((key) => !HANDOFF_FIELDS.includes(key));
  if (extra.length) notices.push(`${current}: the hand-off carries fields a draft does not need: ${extra.join(", ")}`);
  if (back !== null && back !== before.path) notices.push(`${current}: Back from the conversation leaves the address at ${back} and the event page was ${before.path}`);
  return { failures, notices };
}

/** A01: the event page's 「深入研究」, read at the hand-off, and Back to the event page. Nothing is sent: the draft is in the address's state. */
async function walkEventHandoff(page, base, route) {
  await openRoute(page, base, route);
  const before = await page.evaluate(handoffProbe, ["event"]);
  if (!before || !before.button) return { failures: [], notices: handoffFindings(before, null, null).notices, read: { before } };
  await page.evaluate(clickNamed, ["button", "深入研究", "main"]);
  await page.waitForTimeout(1_500);
  const after = await page.evaluate(handoffProbe, ["intent"]);
  let back = null;
  if (after && /^\/app\/chat(?:[/?]|$)/.test(after.path ?? "")) {
    await page.goBack();
    await page.waitForTimeout(1_500);
    back = await page.evaluate(() => `${location.pathname}${location.search}`);
  }
  return { ...handoffFindings(before, after, back), read: { before, after, back } };
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

/**
 * The copy of axe-core that travels with the walk (V-6): the walk is the one file the release switch mounts into its container, and
 * axe-core is in neither image, so the dependency that is to run there is in this file. It is the build compressed with brotli, checked
 * against its checksum before it is used, and written by `scripts/ops/embed-axe-core.mjs` between the markers below (`null` there means
 * none is embedded: the walk then reads `OPEN_SCIENCE_WALK_AXE` or a checkout's package, or does without).
 * @type {{ version: string, sha256: string, brotliBase64: string } | null}
 */
// BEGIN EMBEDDED AXE-CORE (generated by scripts/ops/embed-axe-core.mjs; do not edit by hand)
// axe-core's notice, as the licence asks it in every file that holds a substantial part of the source:
/*! axe v4.12.1
 * Copyright (c) 2015 - 2026 Deque Systems, Inc.
 *
 * Your use of this Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * This entire copyright notice must appear in every copy of this file you
 * distribute or in any file that contains substantial portions of this source
 * code.
 */
const AXE_EMBEDDED = {
  version: "4.12.1",
  sha256: "66a8aaa95a8b044a7fd74a5435873bf04ff65a1ca75567c921b7509742085a14",
  brotliBase64: `
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
`.replace(/\s+/g, ""),
};
// END EMBEDDED AXE-CORE

// Run only as a program: the tests import the budgets and the verdict. By
// real path, because the host runs it through `current`, a symlink.
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`walk failed: ${String(error).slice(0, 300)}`);
    process.exit(2);
  });
}
