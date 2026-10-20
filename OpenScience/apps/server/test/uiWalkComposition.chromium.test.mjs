// scripts/ops/ui-walk.mjs `measureComposition`, read on small HTML pages in a real browser (R19, audit D §4 S6, S9).
//
// `uiWalkComposition.test.mjs` judges facts. These are the facts' source: a good page and one page per defect class, laid out by Chromium, read by
// the very function the walk sends to the page, and judged by `compositionFindings`; the right rule fails and names the element, and the
// good page says nothing. The pages are the framework's markup in miniature (the attributes of PageShell.tsx's table), with inline CSS of
// fixed boxes so that no font or theme decides a number. Like the other browser tests this one needs a disposable Chromium of its own
// (`OPEN_SCIENCE_MANAGED_BROWSER_TEST_CHROME`, which CI's browser step sets); missing is not pass, so it says so.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";
import { compositionFindings, familyFindings, forgetProjectChoice, measureComposition, scrollPage, verifyCompactWorkflowViews, memoryReady, addressProbe, addressStateFindings, ADDRESS_CASES, moduleViewLabels, verifyModuleNavigation, walkMemoryMap, moduleReady, waitMemory, moduleResultProbe, readModuleResult, moduleViewAddressHolds } from "../../../scripts/ops/ui-walk.mjs";

const executable = process.env.OPEN_SCIENCE_MANAGED_BROWSER_TEST_CHROME;
const skip = !executable && "An explicit disposable Chromium executable is required; missing is not pass";

/** @type {import("playwright-core").Browser} */ let browser;
/** @type {import("playwright-core").Page} */ let page;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

const CSS = `
  *{box-sizing:border-box} body{margin:0;font:14px/20px sans-serif} main{height:945px;overflow-y:auto;position:relative}
  header{height:60px;padding:24px 296px 0} h1{margin:0;font-size:24px;line-height:32px;display:inline-block}
  [data-page-chrome]{position:sticky;top:0;background:#fff;margin:0 272px;padding:0 24px;z-index:2}
  [data-step-rail]{height:40px} [data-step-rail] ol{display:flex;gap:4px;margin:0;padding:0;list-style:none} [data-rail-step]{width:100px}
  [role=tablist]{display:flex;height:40px} [role=tab]{height:40px;border:0;background:none;width:100px}
  [data-toolbar]{height:28px;margin:8px 0 12px} [data-toolbar] button{height:28px}
  [data-page-body]{margin:0 296px;padding:24px 0}
  table{border-collapse:collapse;width:100%} td{height:36px;border-bottom:1px solid #ccc} section{margin:0 0 24px}
  canvas{display:block;width:100%;height:200px;background:#eee} .tall{height:var(--h)}
  [data-tag]{display:inline-flex;align-items:center;height:22px;padding:0 6px;border-radius:6px;font-size:12px;background:#eee}
  .tag-like{height:22px;padding:0 6px;border:0;border-radius:6px;font-size:12px;background:#eee}
  .bg-accent{background:#06c;color:#fff;height:32px;border:0}
  [data-chart-grid]{display:flex;flex-direction:column;gap:12px} [data-chart-row]{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;align-items:stretch}
  [data-chart-row]>div{min-width:0;height:160px;background:#ddd}
  [data-empty]{display:flex;flex-direction:column;align-items:center;padding:24px}
  @media (max-width:600px){header{padding:24px 16px 0} [data-page-chrome]{margin:0;padding:0 16px} [data-page-body]{margin:0 16px}}
`;

const rail = (count = 8) => `<nav data-step-rail aria-label="进度"><ol>${Array.from({ length: count }, (_, index) => `<li data-rail-step="s${index}" data-rail-state="todo"><a href="/step/${index}">第${index + 1}步<span class="text-caption">未开始</span></a></li>`).join("")}</ol></nav>`;
const tabs = (labels, { dots = false, label = "项目视图", zero = [] } = {}) => `<div role="tablist" aria-label="${label}">${labels.map((text, index) => `<button role="tab" aria-selected="${index === 0}">${text}${dots && index > 0 ? '<span data-tab-dot="done" aria-hidden="true"></span>' : ""}${zero.includes(text) ? "<span>0</span>" : ""}</button>`).join("")}</div>`;
const toolbar = (label = "筛选与操作", extra = '<button aria-label="查看：总览">总览</button>') => `<div data-toolbar role="group" aria-label="${label}"><button aria-pressed="false">引擎</button>${extra}</div>`;
const rows = (count, prefix = "行") => `<table>${Array.from({ length: count }, (_, index) => `<tr><td>${prefix}${index + 1}</td></tr>`).join("")}</table>`;
const TABS = ["总览", "可见度", "对照", "试验", "信源", "行动", "方案", "依据"];
/** A framework page: header, band, body. `band` and `body` are HTML; `wrap` wraps the band (to make it sticky in a parent as short as itself). */
const framed = ({ title = "测试页面", actions = "", band = rail() + tabs(TABS) + toolbar(), body, bandWrap = (html) => html }) => `<!doctype html><meta charset="utf-8"><style>${CSS}</style><main>
  <header data-page-header><h1>${title}</h1>${actions}</header>
  ${bandWrap(`<div data-page-chrome>${band}</div>`)}
  <div data-page-body role="tabpanel">${body}</div></main>`;
const section = (inner, title = "试验先例") => `<section><h2>${title}</h2>${inner}</section>`;
const LONG = '<div class="tall" style="--h:1600px"></div>';

/** The page read in Chromium, and judged as the page it stands for. */
async function compose(html, { name = "geo-plan", viewport = "desktop", hold = true } = {}) {
  await page.setViewportSize(viewport === "phone" ? { width: 390, height: 844 } : { width: 1512, height: 945 });
  await page.setContent(html);
  const facts = await page.evaluate(measureComposition, [{ hold }]);
  return { facts, findings: compositionFindings(name, viewport, facts).notices };
}
const rulesOf = (read) => [...new Set(read.findings.map((entry) => entry.rule))];
const textOf = (read, rule) => read.findings.filter((entry) => entry.rule === rule).map((entry) => entry.text);

test("a framework page that is right is read as one and has nothing to say", { skip }, async () => {
  const read = await compose(framed({ body: section(rows(4)) + LONG }));
  assert.deepEqual(read.findings, []);
  const { facts } = read;
  assert.deepEqual([facts.chrome.sticky, facts.chrome.position, facts.stepRail.count, facts.stepRail.inChrome], [true, "sticky", 8, true]);
  assert.equal(facts.chrome.held.scrolled > 100, true, "the page moved");
  assert.equal(facts.chrome.held.after, facts.chrome.held.scrollerTop, "and the band stayed where the scroll area starts");
  assert.deepEqual(facts.tablists.map((entry) => [entry.label, entry.tabs, entry.inChrome]), [["项目视图", 8, true]]);
  assert.deepEqual(facts.toolbars.map((entry) => [entry.label, entry.inChrome, entry.controls.pressed]), [["筛选与操作", true, 1]]);
  assert.deepEqual(facts.title.text, "测试页面");
  // The page is where the measure left it.
  assert.equal(await page.evaluate(() => globalThis.document.querySelector("main").scrollTop), 0);
});

test("control after content: a toolbar below the table it filters and a chip group below the chart it switches are named", { skip }, async () => {
  const below = await compose(framed({ band: rail() + tabs(TABS) + toolbar(), body: section(`${rows(5)}${toolbar("试验先例的检索")}`) }));
  assert.deepEqual(rulesOf(below), ["control-after-content", "toggle-layers"].filter((rule) => rule !== "toggle-layers"));
  assert.match(textOf(below, "control-after-content")[0], /^geo-plan@desktop: \[control-after-content\] “试验先例的检索” \(at \d+ px\) stands after the table it controls \(at \d+ px\)$/);
  const chips = await compose(framed({ body: section(`<canvas></canvas><div role="group" aria-label="地图的视图"><button aria-pressed="true">关系</button><button aria-pressed="false">主题</button></div>`) }));
  assert.match(textOf(chips, "control-after-content")[0], /“地图的视图” .* stands after the canvas it controls/);
  // A switch inside a row, a sort inside a header, and the same group above its chart are part of the content or before it.
  const fine = await compose(framed({ body: section(`<div role="group" aria-label="地图的视图"><button aria-pressed="true">关系</button></div><canvas></canvas><table><tr><td><button aria-pressed="false">置顶</button></td></tr><tr><td>b</td></tr></table>`) }));
  assert.deepEqual(textOf(fine, "control-after-content"), []);
  // A slider under the picture it plays is the same defect (记忆地图 in 18.1).
  const slider = await compose(framed({ body: section('<canvas></canvas><input type="range" aria-label="回放" style="display:block;width:300px">') }));
  assert.match(textOf(slider, "control-after-content")[0], /“回放” .* stands after the canvas/);
});

test("a toolbar that starts below the window is below the fold of what it filters", { skip }, async () => {
  const read = await compose(framed({ band: rail() + tabs(TABS), body: `<div class="tall" style="--h:1500px"></div>${toolbar("底部的工具条")}` }), { hold: false });
  assert.match(textOf(read, "toolbar-position")[0], /^geo-plan@desktop: \[toolbar-position\] the toolbar “底部的工具条” starts at \d{4,} px, below 1134 px \(1\.2 × the window\)$/);
});

test("toggle layers: two tab lists, two toolbars, or two view switches written as radios on a page are named", { skip }, async () => {
  const lists = await compose(framed({ band: rail() + tabs(TABS) + tabs(["全部", "未读"], { label: "消息视图" }) + toolbar(), body: section(rows(3)) + LONG }));
  assert.match(textOf(lists, "toggle-layers")[0], /^geo-plan@desktop: \[toggle-layers\] 2 tab lists on the page \(one\): “项目视图”、“消息视图”$/);
  const bars = await compose(framed({ body: toolbar("本页第二个") + section(rows(3)) + LONG }));
  assert.match(textOf(bars, "toggle-layers")[0], /^geo-plan@desktop: \[toggle-layers\] 2 toolbars on the page \(one in the band\): “筛选与操作 at \d+ px”、“本页第二个 at \d+ px”$/);
  const radios = await compose(framed({ body: '<div role="radiogroup" aria-label="图表视图"><button role="radio">甲</button></div><div role="radiogroup" aria-label="显示切换"><button role="radio">乙</button></div>' + section(rows(3)) + LONG }));
  assert.match(textOf(radios, "toggle-layers")[0], /2 view switches written as radio groups \(one\): “图表视图”、“显示切换”/);
  // A toolbar and a tab list inside a block belong to the block.
  const inner = await compose(framed({ body: section(toolbar("本节的筛选") + rows(3)) + section(tabs(["甲", "乙"], { label: "本节的视图" }) + rows(3), "第二节") + LONG }));
  assert.deepEqual(textOf(inner, "toggle-layers"), []);
});

test("the band: sticky in its parent and held when the page moves; a band that scrolls away, or one stuck in a parent as short as itself, is named", { skip }, async () => {
  const body = section(rows(4)) + LONG;
  const slid = await compose(framed({ body }).replace("[data-page-chrome]{position:sticky;", "[data-page-chrome]{position:relative;"));
  assert.match(textOf(slid, "chrome")[0], /^geo-plan@desktop: \[chrome\] the band \(\d+ px high\) is not sticky \(position relative\)$/);
  // `position: sticky` in a wrapper exactly as tall as the band computes as sticky, and goes with the page: the property is not the behaviour.
  const trapped = await compose(framed({ body, bandWrap: (html) => `<div style="height:124px">${html}</div>` }));
  assert.equal(trapped.facts.chrome.sticky, true);
  assert.match(textOf(trapped, "chrome")[0], /\[chrome\] the band is at -\d+ px after the page moved \d+ px; the scroll area starts at 0 px, where a band that holds stands$/);
  // The tab list outside the band scrolls away with the page.
  const loose = await compose(framed({ band: rail() + toolbar(), body: tabs(TABS) + section(rows(4)) + LONG }));
  assert.match(textOf(loose, "chrome")[0], /the tab list “项目视图” is outside the band, so it scrolls away/);
});

test("a module page without its steps is named; a rail on the page's own tab row of dots is steps", { skip }, async () => {
  const none = await compose(framed({ band: tabs(TABS) + toolbar(), body: section(rows(3)) }));
  assert.match(textOf(none, "step-rail")[0], /^geo-plan@desktop: \[step-rail\] the module must show all 8 workflow steps/);
  const dotted = await compose(framed({ band: tabs(["总览", "人群", "患者", "对照", "试验", "匹配", "数据"], { dots: true, label: "研究视图" }) + toolbar(), body: section(rows(3)) }), { name: "vcr-trial" });
  assert.ok(textOf(dotted, "step-rail").length > 0, "tabs cannot replace the seven visible steps");
  assert.deepEqual(dotted.facts.tablists.map((entry) => [entry.tabs, entry.dots]), [[7, 6]]);
  const folded = await compose(framed({ band: `<nav data-step-rail aria-label="进度"><button aria-label="进度：已完成 3/8 步">已完成 3/8 步</button></nav>${tabs(TABS)}${toolbar()}`, body: section(rows(3)) }), { viewport: "phone" });
  assert.deepEqual([folded.facts.stepRail.folded, folded.facts.stepRail.count], [true, 8], "a phone's folded rail still says how many steps there are");
});

test("an orphan sentence is a block of at least twelve Han characters that is no row, label, note, empty state or prose and has nothing to press in it", { skip }, async () => {
  const sentence = (text) => `<p>${text}</p>`;
  const one = await compose(framed({ body: section(rows(2) + sentence("这一轮还没有统计出回答的构成。")) }));
  assert.deepEqual(textOf(one, "orphan-sentence"), [], "one is allowed");
  assert.equal(one.facts.orphans.length, 1);
  const two = await compose(framed({ body: section(rows(2) + sentence("这一轮还没有统计出回答的构成。") + sentence("这一轮没有测到讲错我方的说法。")) }));
  assert.match(textOf(two, "orphan-sentence")[0], /^geo-plan@desktop: \[orphan-sentence\] 2 sentences stand alone, with no action in them and no number \(one is allowed\): “这一轮还没有统计出回答的构成。”、“这一轮没有测到讲错我方的说法。”$/);
  assert.deepEqual(two.facts.orphans.map((entry) => entry.tag), ["p", "p"]);
  // Everything that has an owner on the page is not an orphan: a row, a cell, a heading, a label, a note, an empty state, a document's prose,
  // a paragraph with a link or a button in it, a description a control names, a description beside its switch, a tag, a chart's text.
  const owned = await compose(framed({ body: section([
    "<ul><li>每个列表里的一行文字都有十二个汉字以上</li><li>另一行文字同样有十二个汉字以上的内容</li></ul>",
    "<table><tr><td>表格里的一个单元格也有十二个汉字以上的文字</td></tr></table>",
    "<h3>一个有十二个汉字以上的小标题文字在这里</h3><label>一个有十二个汉字以上的表单标签文字在这里<input></label>",
    '<p data-note="">资料还不够，十二个汉字以上的一句话。 <button>去补充</button></p><p data-note="">一句有十二个汉字以上和 3 个数字的结论。</p>',
    '<div data-empty=""><svg width="16" height="16"></svg><p>还没有十二个汉字以上的空状态标题</p><button>去添加</button></div>',
    '<div data-prose=""><p>这是一篇文档自己的正文，有十二个汉字以上。</p><p>第二段正文同样有十二个汉字以上的文字。</p></div>',
    '<p>一句带着链接的话有十二个汉字以上 <a href="/x">看一看</a></p>',
    '<p id="d1">这一句是它旁边控件的说明有十二个汉字以上</p><input aria-describedby="d1">',
    '<div style="height:48px"><div>前沿日报的名字和一句说明有十二个汉字以上</div><div>每天的医学前沿日报，发到收件箱十二个汉字以上</div><button role="switch" aria-checked="true" aria-label="前沿日报"></button></div>',
    '<span data-tag="">十二个汉字以上的标签文字在这里</span>', '<svg width="300" height="100"><text x="0" y="20">图里的坐标轴文字有十二个汉字以上</text></svg>',
  ].join("")) }));
  assert.deepEqual(owned.facts.orphans, [], JSON.stringify(owned.facts.orphans));
});

test("a tag is a label: a tag in a button, with a role or a pointer, and a button drawn as a tag are named", { skip }, async () => {
  const ok = await compose(framed({ actions: '<span data-tag="">第 1 周</span>', body: section(rows(2)) }));
  assert.deepEqual(textOf(ok, "tag-as-control"), []);
  const bad = await compose(framed({ body: section(rows(2) + [
    '<button><span data-tag="">药物</span></button>', '<span data-tag="" role="button">科目</span>', '<span data-tag="" style="cursor:pointer">病种</span>',
    '<button class="tag-like">仅看对照组</button>',
    // A tag in a row that opens something has the row's pointer by inheritance: the row is the control, not the tag.
    '<table><tr style="cursor:pointer"><td><span data-tag="">被 B 占优</span></td></tr><tr><td>b</td></tr></table>',
  ].join(""), "标签") }));
  assert.deepEqual(textOf(bad, "tag-as-control").map((line) => line.replace(/^geo-plan@desktop: \[tag-as-control\] /, "")), [
    "the tag “药物” is inside a button (a tag is a label)", "the tag “科目” has the role button", "the tag “病种” shows the pointer's cursor",
    "the button “仅看对照组” is drawn as a tag (the tag's height, corner and type size) and can be pressed",
  ]);
});

test("a word that is the name of a tab, written as plain text that looks pressable, is named; a heading or a table head with that word is not", { skip }, async () => {
  const bad = await compose(framed({ body: section('<div><span style="text-decoration:underline">对照</span> <span style="cursor:pointer">试验</span></div>' + rows(2)) }));
  assert.deepEqual(textOf(bad, "word-as-link").map((line) => line.split("] ")[1]), [
    "“对照” is plain text in a span that looks pressable, and is the name of a tab or a step", "“试验” is plain text in a span that looks pressable, and is the name of a tab or a step"]);
  const fine = await compose(framed({ body: section('<h3 style="text-decoration:underline">对照</h3><table><tr><th style="cursor:pointer">试验</th></tr></table><p><span>对照</span> 说的是别的</p>' + rows(2)) }));
  assert.deepEqual(textOf(fine, "word-as-link"), []);
});

test("the primary action stands on the header's row; one in an empty state, a recipe or a form is its own", { skip }, async () => {
  const header = await compose(framed({ actions: '<button class="bg-accent">新建研究</button>', body: section(rows(2)) }));
  assert.deepEqual(textOf(header, "primary-action"), []);
  const away = await compose(framed({ body: section(rows(2) + '<button class="bg-accent">新建研究</button>') }));
  assert.match(textOf(away, "primary-action")[0], /^geo-plan@desktop: \[primary-action\] the primary action “新建研究” is at \d+ px, below the header's row$/);
  const excused = await compose(framed({ body: section(rows(2)) + '<div data-empty=""><svg width="16" height="16"></svg><p>还没有</p><button class="bg-accent">去添加</button></div><form><button class="bg-accent">保存</button></form>' }));
  assert.deepEqual(textOf(excused, "primary-action"), []);
});

test("a tab or a chip whose trailing count is 0 is a switch to an empty place; a disabled one and a label that ends in 0 are not", { skip }, async () => {
  const bad = await compose(framed({ band: rail() + tabs(["总览", "可见度", "未读"], { zero: ["未读"] }) + toolbar(), body: section(rows(2)) }), { name: "geo-plan" });
  assert.deepEqual(textOf(bad, "zero-count"), ["geo-plan@desktop: [zero-count] the tab “未读0” counts 0: a switch to an empty place is hidden or disabled"]);
  const fine = await compose(framed({ band: rail() + tabs(["总览", "T0", "可见度"]) + toolbar('<button aria-pressed="false" disabled>已读<span>0</span></button><button aria-pressed="false">全部<span>10</span></button>'), body: section(rows(2)) }));
  assert.deepEqual(textOf(fine, "zero-count"), []);
});

test("a long page needs contents or a list read a page at a time; a reading page from six windows needs contents", { skip }, async () => {
  const long = (extra = "") => framed({ body: section(rows(3)) + `<div class="tall" style="--h:12600px"></div>${extra}` });
  const bad = await compose(long(), { hold: false });
  assert.match(textOf(bad, "long-page")[0], /^geo-plan@desktop: \[long-page\] \d+\.\d windows tall \(\d{5} px; more than 12\) with no contents \(\[data-outline\]\) and no 显示更多$/);
  assert.deepEqual(textOf(await compose(long('<div data-show-more=""><button>显示更多</button></div>'), { hold: false }), "long-page"), []);
  assert.deepEqual(textOf(await compose(long('<aside data-outline=""><a href="#a">一</a></aside>'), { hold: false }), "long-page"), []);
  const reader = (extra = "") => framed({ band: "", body: `<article data-prose=""><p>一篇文档。</p></article><div class="tall" style="--h:5800px"></div>${extra}` }).replace('<div data-page-chrome></div>', "");
  assert.match(textOf(await compose(reader(), { name: "frontier-evidence", hold: false }), "long-page")[0], /more than 6\) with no contents \(\[data-outline\]\)$/);
  assert.deepEqual(textOf(await compose(reader('<aside data-outline=""><a href="#a">一</a></aside>'), { name: "frontier-evidence", hold: false }), "long-page"), []);
  assert.match(textOf(await compose(reader('<div data-show-more=""><button>显示更多</button></div>'), { name: "frontier-evidence", hold: false }), "long-page")[0], /with no contents/, "a list read a page at a time is not contents for a document");
});

test("a grid of charts fills its box: a row of three beside a row of one leaves holes", { skip }, async () => {
  const cell = (n) => `<div>图${n}</div>`;
  const full = await compose(framed({ body: `<div data-chart-grid="">${["<div data-chart-row>" + [1, 2, 3].map(cell).join("") + "</div>", "<div data-chart-row>" + [4, 5, 6].map(cell).join("") + "</div>"].join("")}</div>` }));
  assert.deepEqual(textOf(full, "chart-grid"), []);
  assert.equal(full.facts.chartGrids[0].ratio > 0.92, true);
  const holes = await compose(framed({ body: `<div data-chart-grid="">${["<div data-chart-row>" + [1, 2, 3].map(cell).join("") + "</div>", "<div data-chart-row>" + cell(4) + "</div>"].join("")}</div>` }));
  assert.match(textOf(holes, "chart-grid")[0], /^geo-plan@desktop: \[chart-grid\] a grid of 4 charts in 2 row\(s\) fills \d+% of its box \(at least 92%\): a row is not full$/);
});

test("an empty state has a mark, a title and an action or the reason there is none", { skip }, async () => {
  const empty = (inner, reason = "") => `<div data-empty=""${reason}>${inner}</div>`;
  const icon = '<svg width="20" height="20"></svg>';
  const ok = await compose(framed({ body: empty(`${icon}<p>还没有人群定义</p><button>新建定义</button>`) + empty(`${icon}<p>没有可看的内容</p><div>这是一个读者不能做什么的原因</div>`, " data-reason") }));
  assert.deepEqual(textOf(ok, "empty-state"), []);
  const bad = await compose(framed({ body: empty("<p>暂无证据专区</p>") + empty(`${icon}<p>暂无热点</p>`) }));
  assert.deepEqual(textOf(bad, "empty-state").map((line) => line.split("] ")[1]), [
    "the empty state “暂无证据专区” has no a mark and no an action or the reason there is none", "the empty state “暂无热点” has no an action or the reason there is none"]);
});

test("a module's tabs read in the browser show the same steps at the same height, and a tab that differs is named by the family judge", { skip }, async () => {
  const tab = async (name, { count = 8, band = true } = {}) => {
    const html = framed({ band: rail(count) + tabs(TABS) + (band ? toolbar() : ""), body: section(rows(2)) });
    const { facts } = await compose(html, { name });
    return [`${name}@desktop`, { composition: facts }];
  };
  const same = Object.fromEntries([await tab("geo-overview"), await tab("geo-visibility"), await tab("geo-plan")]);
  assert.deepEqual(familyFindings(same), []);
  const fewer = Object.fromEntries([await tab("geo-overview"), await tab("geo-visibility", { count: 7 }), await tab("geo-plan")]);
  assert.equal(familyFindings(fewer)[0].text, "geo@desktop: the steps are not the same on every tab: geo-overview 8, geo-visibility 7, geo-plan 8");
  const lower = Object.fromEntries([await tab("geo-overview"), await tab("geo-visibility"), ["geo-plan@desktop", { composition: (await compose(framed({ band: rail() + tabs(TABS), body: section(rows(2)) }).replace("[data-step-rail]{height:40px}", "[data-step-rail]{height:88px}"), { name: "geo-plan" })).facts }]]);
  assert.match(familyFindings(lower).map((entry) => entry.text).join("\n"), /geo@desktop: the band is not the same height on every tab:/);
});

test("a page that scrolled itself on load is read from its top and put back where it was", { skip }, async () => {
  // A GEO answer brings its first wrong sentence up as it opens: read where it had moved to, its band stood 10 px above its tabs'.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(framed({ body: section(rows(3)) + LONG }));
  const atTop = await page.evaluate(measureComposition, [{ hold: true }]);
  await page.evaluate(() => { globalThis.document.querySelector("main").scrollTop = 10; });
  const moved = await page.evaluate(measureComposition, [{ hold: true }]);
  assert.equal(moved.tablists[0].top, atTop.tablists[0].top);
  assert.equal(moved.title.top, atTop.title.top);
  assert.equal(await page.evaluate(() => globalThis.document.querySelector("main").scrollTop), 10, "put back where it was");
});

test("the page's scroll area is found, measured and moved: the app scrolls inside a container, not the window", { skip }, async () => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await page.setContent(framed({ body: section(rows(3)) + LONG }));
  const shape = await page.evaluate(scrollPage, ["shape"]);
  assert.deepEqual([shape.viewportHeight, shape.clientHeight], [945, 945]);
  assert.ok(shape.scrollHeight > 1900, `the container holds ${shape.scrollHeight} px`);
  assert.deepEqual(await page.evaluate(scrollPage, ["to", 700]), { top: 700 });
  assert.equal(await page.evaluate(() => globalThis.document.querySelector("main").scrollTop), 700);
  assert.deepEqual(await page.evaluate(scrollPage, ["to", 0]), { top: 0 });
  // A small scroller inside the page (a table's) is not the page's.
  await page.setContent(framed({ body: `<div style="height:200px;overflow:auto"><div style="height:900px"></div></div>` + section(rows(2)) }));
  const short = await page.evaluate(scrollPage, ["shape"]);
  assert.ok(short.scrollHeight <= 1100, `${short.scrollHeight}: the table's own scroller is not the page`);
  // A page the window scrolls (no container) is the document's.
  await page.setContent('<!doctype html><body style="margin:0"><div style="height:3000px">x</div>');
  const plain = await page.evaluate(scrollPage, ["shape"]);
  assert.deepEqual([plain.clientHeight, plain.scrollHeight], [945, 3000]);
  assert.deepEqual(await page.evaluate(scrollPage, ["to", 500]), { top: 500 });
});

test("the project the app remembers is forgotten at the start of every document, and only that", { skip }, async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(forgetProjectChoice);
    const tab = await context.newPage();
    await tab.route("http://walk.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><title>x</title>" }));
    await tab.goto("http://walk.test/a");
    // The app's own words for it (apiClient.ts), as a click into a study sets them, and a setting of the app's that is not the project.
    await tab.evaluate(() => { const page = globalThis; page.sessionStorage.setItem("openScience.projectId", "p-study"); page.localStorage.setItem("openScience.projectId", "p-study"); page.localStorage.setItem("openScience.theme", "dark"); });
    await tab.goto("http://walk.test/b");
    assert.deepEqual(await tab.evaluate(() => { const page = globalThis; return [page.sessionStorage.getItem("openScience.projectId"), page.localStorage.getItem("openScience.projectId"), page.localStorage.getItem("openScience.theme")]; }), [null, null, "dark"]);
  } finally {
    await context.close();
  }
});


test("the compact workflow collector reads the progress menu and result selector", { skip }, async () => {
  for (const viewport of ["desktop", "phone"]) {
    const read = await compose(framed({ actions: '<button aria-label="进度，已完成 3/8 步">进度</button>', band: toolbar("查看", '<button aria-label="查看：总览">总览</button>'), body: section(rows(3)) + LONG }), { viewport });
    assert.deepEqual(read.facts.compactWorkflow, { count: 8, views: true, folded: false, inChrome: true });
    assert.ok(rulesOf(read).includes("step-rail"), "compact progress cannot replace the visible rail");
    if (viewport === "phone") {
      const folded = await compose(framed({ actions: '<button aria-label="进度，已完成 3/8 步">进度</button>', band: toolbar("查看", '<button aria-label="筛选，已选 1 项">筛选</button>'), body: section(rows(3)) + LONG }), { viewport });
      assert.deepEqual(folded.facts.compactWorkflow, { count: 8, views: false, folded: true, inChrome: true });
      assert.ok(rulesOf(folded).includes("chrome"), "a folded trigger alone does not certify its destinations");
    }
    const absent = await compose(framed({ actions: '<button aria-label="进度，已完成 3/8 步">进度</button>', band: toolbar("查看", ""), body: section(rows(3)) + LONG }), { viewport });
    assert.ok(rulesOf(absent).includes("chrome"));
  }
});


test("the folded workflow probe opens the menu, checks all destinations and closes it", { skip }, async () => {
  const labels = ["对话", "总览", "可见度", "准确与安全", "问题与回答", "信源", "行动", "方案", "依据"];
  const content = (choices) => framed({ band: `<button aria-label="筛选，已选 1 项" onclick="document.querySelector('[role=menu]').hidden=false">筛选</button><div hidden role="menu" aria-label="筛选">${choices.map((label) => `<button role="menuitemradio">${label}</button>`).join("")}</div>`, body: section(rows(3)) }) + `<script>document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('[role=menu]').hidden=true})</script>`;
  await page.setContent(content(labels));
  assert.equal(await verifyCompactWorkflowViews(page), true);
  assert.equal(await page.getByRole("menu", { name: "筛选" }).isVisible(), false);
  await page.setContent(content(labels.slice(0, -1)));
  page.setDefaultTimeout(200);
  await assert.rejects(verifyCompactWorkflowViews(page), /Timeout/);
  page.setDefaultTimeout(30_000);
  assert.equal(await page.getByRole("menu", { name: "筛选" }).isVisible(), false, "a failed destination check also restores the menu");
});

// These browser fixtures deliberately mount controls before data, as the real MemoryFrame does.
test("memory readiness waits for data, distinguishes errors, and requires the addressed controls", { skip }, async () => {
  await page.route("http://memory.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<main><div role="tablist" aria-label="记忆"><button role="tab" aria-selected="true">关于你</button></div><input type="search" aria-label="搜索记忆"><div data-page-body><div class="animate-pulse">Loading</div></div></main>' }));
  await page.goto("http://memory.walk/app/memory?tab=self");
  assert.equal(await page.evaluate(memoryReady, { map: false, selected: "关于你" }), false);
  await page.evaluate(() => { setTimeout(() => { globalThis.document.querySelector("[data-page-body]").innerHTML = '<ul><li><button data-row-title="A">A</button></li></ul>'; }, 50); });
  await page.waitForFunction(memoryReady, { map: false, selected: "关于你" });
  assert.equal(await page.evaluate(memoryReady, { map: true }), false);
  assert.equal(await page.evaluate(memoryReady, { map: false, selected: "项目" }), false);
  await page.evaluate(() => { globalThis.document.querySelector("input").setAttribute("aria-label", "搜索记忆地图"); });
  assert.equal(await page.evaluate(memoryReady, { map: false }), false);
  await page.evaluate(() => {
    globalThis.document.querySelector("input").setAttribute("aria-label", "搜索记忆");
    globalThis.document.querySelector("[data-page-body]").innerHTML = '<div role="alert">暂时读不到记忆。<button>重试</button></div>';
  });
  assert.equal(await page.evaluate(memoryReady, { map: false }), true, "error is terminal, not successful empty coverage");
  assert.equal(await page.locator("main [role=alert]").count(), 1);
  await assert.rejects(waitMemory(page, false), /memory data could not be read/);
  assert.equal(await page.locator("[data-row-title]").count(), 0);
  await page.unroute("http://memory.walk/**");
});

test("map addressed state checks query and view through Back and reload, and rejects parameter loss", { skip }, async () => {
  const content = '<main><div role="tablist" aria-label="记忆"><button role="tab" aria-selected="true">地图</button></div><div role="group" aria-label="地图的视图"><button aria-pressed="true">维度</button></div><input aria-label="搜索记忆地图" value="探针"><div data-page-body>Data</div></main>';
  await page.route("http://map.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: content }));
  await page.goto("http://map.walk/app/memory/map?view=dims&q=" + encodeURIComponent("探针"));
  await page.waitForFunction(memoryReady, { map: true, selected: "地图", query: "探针" });
  const first = await page.evaluate(addressProbe, ["memory-map"]);
  await page.goto("http://map.walk/app/capabilities");
  await page.goBack();
  const back = await page.evaluate(addressProbe, ["memory-map"]);
  await page.reload();
  const reload = await page.evaluate(addressProbe, ["memory-map"]);
  const chosen = ADDRESS_CASES.find((entry) => entry.page === "memory-map");
  const read = { pressed: [true], first, away: "/app/capabilities", back, reload };
  assert.deepEqual(addressStateFindings(chosen, read), { failures: [], notices: [] });
  assert.ok(addressStateFindings(chosen, { ...read, reload: { ...reload, search: "", query: "" } }).notices.length >= 2);
  await page.unroute("http://map.walk/**");
});

function moduleFixture(module, { programme = true, canonical = false, omit = "", duplicate = false, missingRail = false, collapsed = false } = {}) {
  const labels = moduleViewLabels(module, programme, canonical).filter((label) => label !== omit);
  const count = module === "geo" ? 8 : 7;
  const base = module === "geo" ? "/app/geo/study" : programme ? "/app/virtual-research/study" : "/app/capabilities/calculations/study";
  const resultKeys = Object.fromEntries((module === "geo" ? ["总览", "可见度", "准确与安全", "问题与回答", "信源", "行动", "方案", "依据"] : ["总览", "定义与证据", "人群", "虚拟患者", "对照", "试验", "匹配与招募"]).map((label, index) => [label, (module === "geo" ? ["overview", "visibility", "accuracy", "questions", "sources", "actions", "plan", "evidence"] : ["overview", "data", "population", "patients", "comparator", "trial", "matching"])[index]]));
  const visit = `<script>function visit(label){const from=new URL(location.href);const key=${JSON.stringify(resultKeys)}[label];const base=${JSON.stringify(base)};let target;if(${JSON.stringify(module)}==='vcr'){target=label==='对话'?'/app/virtual-research/study/chat':base+(key==='overview'?'':'/'+key)}else{const part=from.pathname.slice(base.length).split('/')[1];const previous=part==='chat'?from.searchParams.get('result')||'overview':part||'overview';if(label==='对话'){const params=new URLSearchParams(from.search);params.set('result',previous);target=base+'/chat/ses-canonical?'+params}else{const params=new URLSearchParams();params.set('session',from.searchParams.get('session')||'ses-canonical');if(from.searchParams.has('step'))params.set('step',from.searchParams.get('step'));if(key===previous&&from.searchParams.has('view'))params.set('view',from.searchParams.get('view'));target=base+(key==='overview'?'':'/'+key)+'?'+params}}history.pushState({},'',target)}</script>`;
  const railMarkup = !programme || missingRail ? "" : `<nav data-step-rail><ol style="display:flex;width:350px;overflow-x:auto">${Array.from({ length: count }, (_, i) => `<li data-rail-step="s${i}" data-rail-state="todo"><a style="display:block;min-width:140px" href="${base}?${module === "geo" ? "session=ses-canonical&" : ""}step=s${i}" onclick="event.preventDefault();history.pushState({},'',this.href);globalThis.document.querySelectorAll('[aria-current]').forEach(e=>e.removeAttribute('aria-current'));this.setAttribute('aria-current','step')">Step ${i}<span class="text-caption">未开始</span></a></li>`).join("")}</ol></nav>`;
  return `<main><div data-page-chrome>${railMarkup}<button aria-label="${collapsed ? "筛选" : "查看：总览"}" onclick="globalThis.document.querySelector('[role=menu]').hidden=false">查看</button>${duplicate ? '<button aria-label="查看：重复">重复</button>' : ""}<div hidden role="menu">${labels.map((label) => `<button role="menuitemradio" onclick="visit(this.textContent);globalThis.document.querySelector('button[aria-label]').setAttribute('aria-label','查看：'+this.textContent);this.parentElement.hidden=true">${label}</button>`).join("")}</div></div><div data-page-body><table><tr><td>Result</td></tr></table></div></main>${visit}`;
}

test("module navigation clicks every visible rail and programme result on desktop and a scrolling phone rail", { skip }, async () => {
  for (const module of ["geo", "vcr"]) for (const width of [1512, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.route("http://module.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: moduleFixture(module) }));
    await page.goto(`http://module.walk/app/${module === "geo" ? "geo" : "virtual-research"}/study`);
    const read = await verifyModuleNavigation(page, module);
    assert.equal(read.destinations.length, module === "geo" ? 8 : 7);
    assert.deepEqual(read.views.map((entry) => entry.label), moduleViewLabels(module));
    await page.unroute("http://module.walk/**");
  }
});

test("module navigation rejects missing rails, duplicate selectors and omitted programme destinations", { skip }, async () => {
  for (const defect of [{ missingRail: true }, { duplicate: true }, { collapsed: true }, { omit: "虚拟患者" }, { omit: "对照" }, { omit: "试验" }]) {
    await page.route("http://module.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: moduleFixture("vcr", defect) }));
    await page.goto("http://module.walk/app/virtual-research/study");
    await assert.rejects(verifyModuleNavigation(page, "vcr"), /distinct steps|unique pinned|omits or adds/);
    await page.unroute("http://module.walk/**");
  }
});

test("calculation result choices include conversation only with its canonical session", { skip }, async () => {
  for (const canonical of [false, true]) {
    await page.route("http://module.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: moduleFixture("vcr", { programme: false, canonical }) }));
    await page.goto("http://module.walk/app/capabilities/calculations/study");
    const read = await verifyModuleNavigation(page, "vcr", { programme: false, canonical });
    assert.deepEqual(read.views.map((entry) => entry.label), [...(canonical ? ["对话"] : []), "总览", "定义与证据", "人群", "匹配与招募"]);
    await page.unroute("http://module.walk/**");
  }
});


test("twelve unfiltered map marks retain exact drawer identity through reload, Back and Close; zero is not coverage", { skip }, async () => {
  const html = (count) => `<meta charset="utf-8"><main><div role="tablist" aria-label="记忆"><button role="tab" aria-selected="true">地图</button></div><input aria-label="搜索记忆地图"><div data-page-body><ul aria-label="标记">${Array.from({ length: count }, (_, i) => `<li><button data-row-title="Mark ${i}" onclick="history.pushState({},'', '?open=record:m${i}');render()">Mark ${i}</button></li>`).join("")}</ul></div><div id="drawer"></div></main><script>function render(){const host=globalThis.document.querySelector('#drawer');host.replaceChildren();if(new URLSearchParams(location.search).has('open')){const dialog=globalThis.document.createElement('div');dialog.setAttribute('role','dialog');const close=globalThis.document.createElement('button');close.textContent='关闭';close.onclick=()=>{history.replaceState({},'',location.pathname);render()};dialog.append(close);host.append(dialog)}}addEventListener('popstate',render);render()</script>`;
  for (const count of [12, 0]) {
    await page.route("http://marks.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html(count) }));
    const result = await walkMemoryMap(page, "http://marks.walk", "/app/memory/map");
    if (count) {
      assert.deepEqual(result.failures, []);
      assert.equal(result.read.rows, 12);
      assert.equal(result.read.opened.open, "record:m0");
      assert.equal(result.read.reload.open, "record:m0");
      assert.equal(result.read.reopened.open, "record:m0");
      assert.equal(result.read.back.address, false);
      assert.equal(result.read.closed.dialog, false);
    } else assert.ok(result.notices.some((entry) => entry.includes("not observable")));
    await page.unroute("http://marks.walk/**");
  }
});


test("module readiness ignores a running-status dot in chrome but waits for selected result skeletons", { skip }, async () => {
  await page.setContent('<main><div data-page-chrome><span data-forced-colors="preserve" class="animate-pulse">Running</span></div><div data-page-body><div class="animate-pulse">Loading result</div></div></main>');
  assert.equal(await page.evaluate(moduleReady), false);
  await page.evaluate(() => { globalThis.document.querySelector('[data-page-body]').textContent = 'Result'; });
  assert.equal(await page.evaluate(moduleReady), true);
});


test("a selected result error, including a late failure after loading, never becomes navigation coverage", { skip }, async () => {
  for (const late of [false, true]) {
    const fixture = moduleFixture("vcr", { programme: false }).replaceAll('this.parentElement.hidden=true', 'this.parentElement.hidden=true;changeResult(this.textContent)');
    const effect = `<script>function changeResult(label){if(label!=='人群')return;const body=globalThis.document.querySelector('[data-page-body]');body.innerHTML=${late ? "'<div class=animate-pulse>Loading</div>'" : "'<div role=alert>人群暂时无法读取。<button>重试</button></div>'"};${late ? "setTimeout(()=>{body.innerHTML='<div role=alert>人群暂时无法读取。<button>重试</button></div>'},70)" : ""}}</script>`;
    await page.route("http://result.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture + effect }));
    await page.goto("http://result.walk/app/capabilities/calculations/study");
    await assert.rejects(verifyModuleNavigation(page, "vcr", { programme: false }), /vcr view 人群: selected result could not be read/);
    await page.unroute("http://result.walk/**");
  }
});

test("empty and unobservable module results are terminal but explicitly lack positive content coverage", { skip }, async () => {
  for (const [body, status] of [['<div data-empty><p>还没有结果</p><button>开始</button></div>', 'empty'], ['', 'unobservable'], ['<table><tr><th>Column</th></tr></table>', 'unobservable']]) {
    const fixture = moduleFixture("vcr", { programme: false }).replace('<table><tr><td>Result</td></tr></table>', body);
    await page.route("http://result.walk/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture }));
    await page.goto("http://result.walk/app/capabilities/calculations/study");
    const read = await verifyModuleNavigation(page, "vcr", { programme: false });
    assert.ok(read.views.every((view) => view.result.status === status && view.result.coverage === false));
    assert.equal(read.notices.length, 4);
    await page.unroute("http://result.walk/**");
  }
});

test("retained partial scientific results survive a limited-source warning or failed refresh", { skip }, async () => {
  for (const retry of [false, true]) {
    await page.setContent(`<main><div data-page-body><div role="alert">${retry ? '这次没有读到最新的内容。<button>重试</button>' : '证据有限，请结合研究假设解释。'}</div><table><tr><td>Preserved estimate</td><td>1.3</td></tr></table></div></main>`);
    const result = await readModuleResult(page, "retained analysis");
    assert.equal(result.status, "partial");
    assert.equal(result.coverage, true);
    assert.equal(result.errors.length, retry ? 1 : 0);
  }
  await page.setContent('<main><div data-page-body><div data-state-screen role="alert"><div data-empty>读取失败</div></div></div></main>');
  await assert.rejects(readModuleResult(page, "whole-page failure"), /terminal page failure/);
  await page.setContent('<main><div data-page-body><div data-study-pane="conversation"><div data-frame-skeleton>正在打开</div></div></div></main>');
  const native = await page.evaluate(moduleResultProbe);
  assert.equal(native.status, "conversation");
  assert.equal(native.coverage, false);
  assert.match(native.boundary, /no runtime started/);
  await page.setContent('<main><div data-page-body><iframe title="Data viewer"></iframe><div role="alert">结果无法读取<button>重试</button></div></div></main>');
  await assert.rejects(readModuleResult(page, "unrelated viewer"), /selected result could not be read/);
});


test("a result selector cannot certify label-only navigation or sending every choice to the same result", { skip }, async () => {
  for (const action of ['', "history.pushState({},'', '/app/virtual-research/study/data');"]) {
    const fixture = moduleFixture("vcr").replaceAll('visit(this.textContent);', action);
    await page.route("http://destination.walk/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture }));
    await page.goto("http://destination.walk/app/virtual-research/study");
    await assert.rejects(verifyModuleNavigation(page, "vcr"), /selector label changed without reaching its canonical destination/);
    await page.unroute("http://destination.walk/**");
  }
});

test("module destination contracts retain GEO query context and addressed sessions, with supported overview aliases", { skip }, async () => {
  const initial = 'https://walk.test/app/geo/g1';
  const before = initial + '/accuracy?session=ses-a&step=diagnosis&view=claims';
  assert.equal(moduleViewAddressHolds('geo', '对话', initial, before, initial + '/chat/ses-a?session=ses-a&step=diagnosis&view=claims&result=accuracy'), true);
  assert.equal(moduleViewAddressHolds('geo', '对话', initial, before, initial + '/chat/ses-b?session=ses-a&step=diagnosis&view=claims&result=accuracy'), false);
  assert.equal(moduleViewAddressHolds('geo', '对话', initial, before, initial + '/chat/ses-a?result=accuracy'), false);
  assert.equal(moduleViewAddressHolds('geo', '问题与回答', initial, before, initial + '/questions?session=ses-a&step=diagnosis'), true);
  assert.equal(moduleViewAddressHolds('geo', '问题与回答', initial, before, initial + '/questions?session=ses-a'), false);
  assert.equal(moduleViewAddressHolds('geo', '总览', initial, before, initial + '/overview?session=ses-a&step=diagnosis'), true);
  const vcr = 'https://walk.test/app/virtual-research/s1';
  assert.equal(moduleViewAddressHolds('vcr', '总览', vcr, vcr + '/trial', vcr + '/overview'), true);
  assert.equal(moduleViewAddressHolds('vcr', '试验', vcr, vcr + '/trial', vcr + '/trial'), true, 'reselecting the actual current result is allowed');
  assert.equal(moduleViewAddressHolds('vcr', '对话', vcr, vcr, vcr + '/chat'), true);
});
