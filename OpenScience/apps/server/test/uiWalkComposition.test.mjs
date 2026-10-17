// scripts/ops/ui-walk.mjs: the composition rules, judged on the facts `measureComposition` reads (R19, audit D §4 S6, S9).
//
// The judge is pure: it takes what the page-side function returned and says which rule that breaks. These tests give it facts, so they run
// anywhere; `uiWalkComposition.chromium.test.mjs` gives the collector real HTML in a real browser and judges what it read. Each rule has a
// good page that passes it and a page that breaks it, and a finding names the element (what the reader would look for on the page).
import assert from "node:assert/strict";
import test from "node:test";
import { applyBaseline, compositionFindings, familyFindings, finding, templateOf } from "../../../scripts/ops/ui-walk.mjs";

const box = (top, height = 40, left = 296, width = 1152) => ({ top, bottom: top + height, left, right: left + width, width, height });

/** What a module page of the framework reads like when it is right (a GEO tab at the owner's width, scrolled to its top). */
function good(over = {}) {
  return {
    viewport: { width: 1512, height: 945 }, height: 1800, title: { text: "测试品牌", ...box(26, 32) },
    chrome: { ...box(60, 124, 272, 1200), position: "sticky", sticky: true, held: { scrolled: 480, before: 60, after: 0, scrollerTop: 0 } },
    stepRail: { ...box(60), folded: false, count: 8, inChrome: true, steps: [] },
    tablists: [{ label: "项目视图", tabs: 8, dots: 0, inChrome: true, inToolbar: false, inSection: false, ...box(100) }],
    viewGroups: [], toolbars: [{ label: "筛选与操作", inChrome: true, inSection: false, ...box(148, 28), controls: {} }],
    controlsAfterContent: [], orphans: [], tags: [], tagLike: [], words: [], primaries: [], zeroCounts: [], outline: { outlines: 0, showMore: 0 },
    chartGrids: [], empties: [], notes: [], headline: 1, activity: 0, stepStates: [], ...over,
  };
}
const rules = (name, viewport, facts) => compositionFindings(name, viewport, facts).notices.map((entry) => entry.rule);
const texts = (name, viewport, facts) => compositionFindings(name, viewport, facts).notices.map((entry) => entry.text);

test("a module page that is right has nothing to say, at both widths", () => {
  assert.deepEqual(compositionFindings("geo-plan", "desktop", good()), { failures: [], notices: [] });
  // A phone folds the rail into one chip and scrolls below the app's bar: the band stands where its scroll area starts.
  const phone = good({
    viewport: { width: 390, height: 844 }, stepRail: { ...box(148, 40, 16, 358), folded: true, count: 8, inChrome: true, steps: [] },
    chrome: { ...box(148, 124, 0, 390), position: "sticky", sticky: true, held: { scrolled: 295, before: 148, after: 48, scrollerTop: 48 } },
  });
  assert.deepEqual(compositionFindings("geo-plan", "phone", phone), { failures: [], notices: [] });
  assert.deepEqual(compositionFindings("geo-plan", "desktop", null).notices.map((entry) => entry.rule), ["not-observable"], "a page whose composition was not read is not a pass");
});

test("control after content: a toolbar or a chip group below the table, chart or list it controls is named", () => {
  const page = { stepRail: null, tablists: [{ label: "记忆", tabs: 4, dots: 0, inChrome: true, inToolbar: false, inSection: false, ...box(100) }] };
  const bad = good({ ...page, controlsAfterContent: [{ control: "地图的视图", controlTop: 1320, content: "canvas", contentTop: 410 }] });
  assert.deepEqual(texts("memory-map", "desktop", bad), ["memory-map@desktop: [control-after-content] “地图的视图” (at 1320 px) stands after the canvas it controls (at 410 px)"]);
  assert.deepEqual(rules("memory-map", "desktop", good({ ...page })), []);
});

test("a toolbar further down than the window's height and a fifth is below the fold of the page it filters", () => {
  const low = good({ toolbars: [{ label: "筛选与操作", inChrome: false, inSection: false, ...box(1200, 28), controls: {} }] });
  assert.deepEqual(rules("geo-sources", "desktop", low), ["toolbar-position"]);
  assert.match(texts("geo-sources", "desktop", low)[0], /the toolbar “筛选与操作” starts at 1200 px, below 1134 px \(1.2 × the window\)/);
  assert.deepEqual(rules("geo-sources", "desktop", good({ toolbars: [{ label: "筛选与操作", inChrome: true, inSection: false, ...box(1133, 28), controls: {} }] })), []);
});

test("toggle layers: one tab list, one view switch written as radios, one toolbar on a page; a block's own tab list and toolbar are its block's", () => {
  const list = (label, over = {}) => ({ label, tabs: 3, dots: 0, inChrome: false, inToolbar: false, inSection: false, ...box(300), ...over });
  const bar = (label, over = {}) => ({ label, inChrome: false, inSection: false, ...box(400, 28), controls: {}, ...over });
  const two = good({ tablists: [list("项目视图", { inChrome: true }), list("动态视图", { inToolbar: true })] });
  assert.deepEqual(texts("geo-plan", "desktop", two), ["geo-plan@desktop: [toggle-layers] 2 tab lists on the page (one): “项目视图”、“动态视图”"]);
  assert.match(texts("geo-plan", "desktop", good({ viewGroups: [{ label: "图表视图", inSection: false, ...box(300) }, { label: "显示切换", inSection: false, ...box(340) }] }))[0], /^geo-plan@desktop: \[toggle-layers\] 2 view switches written as radio groups \(one\): “图表视图”、“显示切换”$/);
  assert.match(texts("geo-plan", "desktop", good({ toolbars: [bar("筛选与操作", { inChrome: true }), bar("试验先例的检索")] }))[0], /\[toggle-layers\] 2 toolbars on the page \(one in the band\): “筛选与操作 at 400 px”、“试验先例的检索 at 400 px”/);
  // A toolbar of a section (Section's `toolbar` slot) and a tab list inside a card are not a second layer of the page.
  assert.deepEqual(rules("geo-plan", "desktop", good({ toolbars: [bar("筛选与操作", { inChrome: true }), bar("本节", { inSection: true })], tablists: [list("项目视图", { inChrome: true }), list("本节", { inSection: true })] })), []);
});

test("the band holds: it is sticky, it is where the scroll area starts after the page moved, and a module's steps are in it", () => {
  const position = (over) => good({ chrome: { ...good().chrome, ...over } });
  assert.match(texts("geo-plan", "desktop", position({ position: "static", sticky: false }))[0], /^geo-plan@desktop: \[chrome\] the band \(124 px high\) is not sticky \(position static\)$/);
  const slid = position({ held: { scrolled: 480, before: 60, after: -420, scrollerTop: 0 } });
  assert.match(texts("geo-plan", "desktop", slid)[0], /\[chrome\] the band is at -420 px after the page moved 480 px; the scroll area starts at 0 px, where a band that holds stands/);
  assert.deepEqual(rules("geo-plan", "desktop", position({ held: { scrolled: 480, before: 60, after: 2, scrollerTop: 0 } })), [], "two pixels is the tolerance");
  assert.deepEqual(rules("geo-plan", "desktop", position({ held: null })), [], "a page too short to scroll cannot show that it holds, and says nothing");
  // The tab list and the rail are in the band or they scroll away.
  const loose = good({ tablists: [{ label: "项目视图", tabs: 8, dots: 0, inChrome: false, inToolbar: false, inSection: false, ...box(400) }], stepRail: { ...box(300), folded: false, count: 8, inChrome: false, steps: [] } });
  assert.deepEqual(texts("geo-plan", "desktop", loose), ["geo-plan@desktop: [chrome] the tab list “项目视图” is outside the band, so it scrolls away", "geo-plan@desktop: [chrome] the step rail is outside the band, so it scrolls away"]);
  // A module page has a band and steps: a rail, or a tab row with a state dot on its tabs (虚拟临床研究's: the overview is not a step).
  assert.deepEqual(rules("geo-plan", "desktop", good({ chrome: null })), ["chrome"]);
  assert.match(texts("geo-plan", "desktop", good({ stepRail: null }))[0], /\[step-rail\] a module page shows no steps/);
  const dotted = good({ stepRail: null, tablists: [{ label: "研究视图", tabs: 7, dots: 6, inChrome: true, inToolbar: false, inSection: false, ...box(100) }] });
  assert.deepEqual(rules("vcr-trial", "desktop", dotted), []);
  assert.deepEqual(rules("vcr-trial", "desktop", good({ stepRail: null, tablists: [{ label: "研究视图", tabs: 7, dots: 1, inChrome: true, inToolbar: false, inSection: false, ...box(100) }] })), ["step-rail"]);
});

test("a page keeps to its template's slots: a list page has no step rail, a settings page no tab list or toolbar", () => {
  const list = templateOf("frontier");
  assert.equal(list.template.name, "list page");
  assert.deepEqual(rules("frontier", "desktop", good({ tablists: [{ label: "动态视图", tabs: 6, dots: 0, inChrome: true, inToolbar: true, inSection: false, ...box(100) }] })), ["template-slot"]);
  assert.match(texts("frontier", "desktop", good({ tablists: [] }))[0], /^frontier@desktop: \[template-slot\] a list page has a step rail \(only a module page does\)$/);
  const settings = good({ stepRail: null, chrome: null, toolbars: [], tablists: [{ label: "设置", tabs: 3, dots: 0, inChrome: false, inToolbar: false, inSection: false, ...box(100) }] });
  assert.match(texts("account-usage", "desktop", settings)[0], /^account-usage@desktop: \[template-slot\] a settings page has a tab list: “设置”$/);
  assert.match(texts("account-usage", "desktop", good({ stepRail: null, chrome: null, tablists: [] }))[0], /\[template-slot\] a settings page has a toolbar at 148 px/);
  assert.deepEqual(rules("account-usage", "desktop", good({ stepRail: null, chrome: null, tablists: [], toolbars: [] })), []);
});

test("an orphan sentence is a block of text with no action, no number and no row; one is allowed, two are named", () => {
  const sentence = (text, top) => ({ text, tag: "p", ...box(top, 24) });
  assert.deepEqual(rules("geo-plan", "desktop", good({ orphans: [sentence("这一轮还没有统计出回答的构成。", 300)] })), []);
  const two = good({ orphans: [sentence("这一轮还没有统计出回答的构成。", 300), sentence("这一轮没有测到讲错我方的说法。", 700)] });
  assert.deepEqual(texts("geo-plan", "desktop", two), ["geo-plan@desktop: [orphan-sentence] 2 sentences stand alone, with no action in them and no number (one is allowed): “这一轮还没有统计出回答的构成。”、“这一轮没有测到讲错我方的说法。”"]);
  assert.equal(compositionFindings("geo-plan", "desktop", two).notices[0].value, 2, "a baseline can hold a page at the count it has");
  const many = good({ orphans: ["甲乙丙丁戊己庚辛壬癸子丑", "乙丙丁戊己庚辛壬癸子丑寅", "丙丁戊己庚辛壬癸子丑寅卯", "丁戊己庚辛壬癸子丑寅卯辰"].map((text, index) => sentence(text, 300 + index * 50)) });
  assert.match(texts("geo-plan", "desktop", many)[0], /4 sentences stand alone.*“丙丁戊己庚辛壬癸子丑寅卯” and 1 more$/);
});

test("a tag is a label: one in a button, with a role or the pointer, and a button drawn as a tag, are controls dressed as labels", () => {
  const tag = (over = {}) => ({ text: "第 1 周", cursor: "auto", role: null, insideControl: null, ...box(35, 22, 400, 50), ...over });
  assert.deepEqual(rules("geo-plan", "desktop", good({ tags: [tag()] })), []);
  assert.deepEqual(texts("geo-plan", "desktop", good({ tags: [tag({ insideControl: "button" })] })), ["geo-plan@desktop: [tag-as-control] the tag “第 1 周” is inside a button (a tag is a label)"]);
  assert.match(texts("geo-plan", "desktop", good({ tags: [tag({ role: "button" })] }))[0], /the tag “第 1 周” has the role button/);
  assert.match(texts("geo-plan", "desktop", good({ tags: [tag({ cursor: "pointer" })] }))[0], /the tag “第 1 周” shows the pointer's cursor/);
  assert.match(texts("geo-plan", "desktop", good({ tagLike: [{ text: "仅看对照组", tag: "button", ...box(300, 22) }] }))[0], /the button “仅看对照组” is drawn as a tag \(the tag's height, corner and type size\) and can be pressed/);
});

test("a word that is the name of a tab or a step, written as plain text that looks pressable, is named", () => {
  assert.deepEqual(texts("virtual-research", "desktop", good({ stepRail: null, chrome: null, words: [{ text: "对照", tag: "span", ...box(300, 20) }] })).filter((line) => line.includes("[word-as-link]")),
    ["virtual-research@desktop: [word-as-link] “对照” is plain text in a span that looks pressable, and is the name of a tab or a step"]);
});

test("the primary action stands on the header's row, unless it is the way forward of an empty state, a recipe or a form", () => {
  const primary = (over) => ({ text: "新建研究", ...box(26, 32, 1300, 120), inHeader: true, excused: false, ...over });
  assert.deepEqual(rules("geo-plan", "desktop", good({ primaries: [primary()] })), []);
  assert.deepEqual(texts("geo-plan", "desktop", good({ primaries: [primary({ ...box(520, 32), inHeader: false })] })), ["geo-plan@desktop: [primary-action] the primary action “新建研究” is at 520 px, below the header's row"]);
  assert.deepEqual(rules("geo-plan", "desktop", good({ primaries: [primary({ ...box(520, 32), inHeader: false, excused: true })] })), []);
});

test("a tab or a chip that counts nothing is a switch to an empty place", () => {
  assert.deepEqual(texts("inbox", "desktop", good({ stepRail: null, chrome: null, zeroCounts: [{ text: "未读0", role: "tab" }] })).filter((line) => line.includes("zero-count")),
    ["inbox@desktop: [zero-count] the tab “未读0” counts 0: a switch to an empty place is hidden or disabled"]);
});

test("a long page has contents or a list read a page at a time; a reading page has contents from six windows", () => {
  const tall = (windows, over = {}) => good({ height: Math.round(945 * windows), ...over });
  assert.deepEqual(rules("geo-plan", "desktop", tall(12)), []);
  assert.match(texts("geo-plan", "desktop", tall(13))[0], /^geo-plan@desktop: \[long-page\] 13.0 windows tall \(12285 px; more than 12\) with no contents \(\[data-outline\]\) and no 显示更多$/);
  assert.deepEqual(rules("geo-plan", "desktop", tall(13, { outline: { outlines: 0, showMore: 1 } })), [], "a list read a page at a time is not a page of 13 windows to scroll through");
  assert.deepEqual(rules("geo-plan", "desktop", tall(13, { outline: { outlines: 1, showMore: 0 } })), []);
  // A document is read from the top: contents from six windows, and a 显示更多 does not stand in for them.
  const reader = (windows, outline) => good({ stepRail: null, chrome: null, tablists: [], toolbars: [], height: Math.round(945 * windows), outline });
  assert.deepEqual(rules("frontier-evidence", "desktop", reader(6, { outlines: 0, showMore: 0 })), []);
  assert.match(texts("frontier-evidence", "desktop", reader(42.5, { outlines: 0, showMore: 1 }))[0], /\[long-page\] 42.5 windows tall \(40163 px; more than 6\) with no contents \(\[data-outline\]\)$/);
  assert.deepEqual(rules("frontier-evidence", "desktop", reader(42.5, { outlines: 1, showMore: 0 })), []);
});

test("a grid of charts fills its box: a row that is not full leaves a hole", () => {
  assert.deepEqual(rules("geo-plan", "desktop", good({ chartGrids: [{ cells: 5, rows: 2, ratio: 0.97, ...box(300, 600) }] })), []);
  assert.deepEqual(texts("geo-plan", "desktop", good({ chartGrids: [{ cells: 5, rows: 2, ratio: 0.81, ...box(300, 600) }] })), ["geo-plan@desktop: [chart-grid] a grid of 5 charts in 2 row(s) fills 81% of its box (at least 92%): a row is not full"]);
});

test("an empty state is a mark, a title and a way forward: an action, or the reason there is none", () => {
  const empty = (over = {}) => ({ title: "还没有人群定义", icon: true, hasTitle: true, action: true, reason: false, ...box(300, 210), ...over });
  assert.deepEqual(rules("geo-plan", "desktop", good({ empties: [empty(), empty({ action: false, reason: true })] })), []);
  assert.deepEqual(texts("geo-plan", "desktop", good({ empties: [empty({ icon: false })] })), ["geo-plan@desktop: [empty-state] the empty state “还没有人群定义” has no a mark"]);
  assert.deepEqual(texts("geo-plan", "desktop", good({ empties: [empty({ action: false, icon: false })] })), ["geo-plan@desktop: [empty-state] the empty state “还没有人群定义” has no a mark and no an action or the reason there is none"]);
});

/** The report's pages for a module's tabs, as `familyFindings` reads them. */
function moduleTabs(counts, { tops = [100, 100, 100], heights = [124, 124, 124], lefts = [296, 296, 296] } = {}) {
  const names = ["geo-overview", "geo-visibility", "geo-plan"];
  return Object.fromEntries(names.map((name, index) => [`${name}@desktop`, { composition: good({
    title: { text: "测试品牌", ...box(26, 32, lefts[index]) }, stepRail: { ...box(60), folded: false, count: counts[index], inChrome: true, steps: [] },
    chrome: { ...box(60, heights[index], 272, 1200), position: "sticky", sticky: true, held: null },
    tablists: [{ label: "项目视图", tabs: 8, dots: 0, inChrome: true, inToolbar: false, inSection: false, ...box(tops[index]) }],
  }) }]));
}

test("a module's tabs show the same steps and stand at the same height, and the pages of a family start their title on one left edge", () => {
  assert.deepEqual(familyFindings(moduleTabs([8, 8, 8])), []);
  const steps = familyFindings(moduleTabs([8, 7, 8]));
  assert.deepEqual(steps.map((entry) => entry.rule), ["module-steps"]);
  assert.equal(steps[0].text, "geo@desktop: the steps are not the same on every tab: geo-overview 8, geo-visibility 7, geo-plan 8");
  const tabRow = familyFindings(moduleTabs([8, 8, 8], { tops: [100, 100, 148] }));
  assert.deepEqual(tabRow.map((entry) => entry.rule), ["module-chrome"]);
  assert.match(tabRow[0].text, /the tab row stands at a different height on some tabs: geo-overview 100 px, geo-visibility 100 px, geo-plan 148 px/);
  assert.deepEqual(familyFindings(moduleTabs([8, 8, 8], { tops: [100, 101, 102] })), [], "two pixels is the tolerance");
  assert.equal(familyFindings(moduleTabs([8, 8, 8], { heights: [124, 124, 84] }))[0].text, "geo@desktop: the band is not the same height on every tab: geo-overview 124 px, geo-visibility 124 px, geo-plan 84 px");
  // The left edge: the family's majority is the page's own; a page that starts elsewhere is named with the number it should have.
  const edge = familyFindings(moduleTabs([8, 8, 8], { lefts: [296, 296, 248] }));
  assert.deepEqual(edge.map((entry) => [entry.rule, entry.view]), [["left-edge", "geo-plan@desktop"]]);
  assert.equal(edge[0].text, "geo-plan@desktop: the title starts at 248 px; the other pages of geo start at 296 px");
  // Only desktops are compared for the edge; a module's second study is its own group.
  const phone = Object.fromEntries(Object.entries(moduleTabs([8, 8, 8], { lefts: [16, 16, 24] })).map(([view, page]) => [view.replace("@desktop", "@phone"), page]));
  assert.deepEqual(familyFindings(phone), []);
});

test("a finding of a rule is accepted by the baseline entry that names the rule, the page and a number it may not exceed", () => {
  const found = compositionFindings("geo-plan", "desktop", good({ orphans: [1, 2, 3].map((n) => ({ text: `第${n}句话说了十二个汉字以上的内容`, tag: "p", ...box(300 + n * 40, 24) })) })).notices;
  const entry = (max) => ({ entries: [{ view: "geo-plan@desktop", rule: "orphan-sentence", max, owner: "geob", until: "2026-12-31", why: "the empty cards of a project with no measurement" }] });
  assert.equal(applyBaseline(found, entry(3), { profile: "owner", today: "2026-10-17" }).accepted.length, 1);
  assert.equal(applyBaseline(found, entry(2), { profile: "owner", today: "2026-10-17" }).unaccepted.length, 1);
  assert.deepEqual(finding("orphan-sentence", "geo-plan@desktop", "x", 3).rule, "orphan-sentence");
});
