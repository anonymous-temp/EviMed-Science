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
import { compositionFindings, familyFindings, forgetProjectChoice, measureComposition, scrollPage } from "../../../scripts/ops/ui-walk.mjs";

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

const rail = (count = 8) => `<nav data-step-rail aria-label="进度"><ol>${Array.from({ length: count }, (_, index) => `<li data-rail-step="s${index}" data-rail-state="todo"><span>第${index + 1}步</span></li>`).join("")}</ol></nav>`;
const tabs = (labels, { dots = false, label = "项目视图", zero = [] } = {}) => `<div role="tablist" aria-label="${label}">${labels.map((text, index) => `<button role="tab" aria-selected="${index === 0}">${text}${dots && index > 0 ? '<span data-tab-dot="done" aria-hidden="true"></span>' : ""}${zero.includes(text) ? "<span>0</span>" : ""}</button>`).join("")}</div>`;
const toolbar = (label = "筛选与操作", extra = "") => `<div data-toolbar role="group" aria-label="${label}"><button aria-pressed="false">引擎</button>${extra}</div>`;
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
  const below = await compose(framed({ band: rail() + tabs(TABS), body: section(`${rows(5)}${toolbar("试验先例的检索")}`) }));
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
  assert.match(textOf(none, "step-rail")[0], /^geo-plan@desktop: \[step-rail\] a module page shows no steps/);
  const dotted = await compose(framed({ band: tabs(["总览", "人群", "患者", "对照", "试验", "匹配", "数据"], { dots: true, label: "研究视图" }) + toolbar(), body: section(rows(3)) }), { name: "vcr-trial" });
  assert.deepEqual(textOf(dotted, "step-rail"), []);
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
  assert.match(familyFindings(lower).map((entry) => entry.text).join("\n"), /geo@desktop: the tab row stands at a different height on some tabs: geo-overview \d+ px, geo-visibility \d+ px, geo-plan \d+ px/);
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
    await tab.route("http://walk.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>x</title>" }));
    await tab.goto("http://walk.test/a");
    // The app's own words for it (apiClient.ts), as a click into a study sets them, and a setting of the app's that is not the project.
    await tab.evaluate(() => { const page = globalThis; page.sessionStorage.setItem("openScience.projectId", "p-study"); page.localStorage.setItem("openScience.projectId", "p-study"); page.localStorage.setItem("openScience.theme", "dark"); });
    await tab.goto("http://walk.test/b");
    assert.deepEqual(await tab.evaluate(() => { const page = globalThis; return [page.sessionStorage.getItem("openScience.projectId"), page.localStorage.getItem("openScience.projectId"), page.localStorage.getItem("openScience.theme")]; }), [null, null, "dark"]);
  } finally {
    await context.close();
  }
});

