/**
 * The shell stylesheet over what the bundles beside the kernel draw, in a real browser (R19.2). Opt-in, like the managed-browser
 * fixture: it needs a Chromium of its own, named by `EVIMED_FRAME_CSS_CHROME`. The pages are the recorded markup and sheets of
 * fixtures/pluginSurfaces.json, no network. Each case carries its control, the page without the shell's rules, so a pass says the
 * rules did it and not that the fixture could not fail.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { GEOMETRY_KERNEL_PIN, shellStylesheet } from '../src/runtimeUiShell.mjs';

const executablePath = process.env.EVIMED_FRAME_CSS_CHROME ?? '';
const enabled = Boolean(executablePath);
const surfaces = JSON.parse(readFileSync(new URL('./fixtures/pluginSurfaces.json', import.meta.url), 'utf8'));
const SKIP = !enabled && 'EVIMED_FRAME_CSS_CHROME names no Chromium';

/** @param {(page: any) => Promise<void>} body */
async function inBrowser(body) {
  const require = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
  const moduleId = 'playwright' + '-core';
  const { chromium } = require(moduleId);
  const browser = await chromium.launch({ headless: true, executablePath, env: { PATH: process.env.PATH }, args: ['--no-sandbox', '--disable-background-networking', '--no-first-run'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', (/** @type {any} */ route) => route.abort());
    await body(await context.newPage());
    await context.close();
  } finally { await browser.close(); }
}

/** @param {any} page @param {number} width @param {string} head @param {string} markup */
async function lay(page, width, head, markup) {
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(`<!doctype html><html><head><style>*{box-sizing:border-box}:root{--dsw-alias-border-l1:#ebebeb}body{margin:0;font:14px/20px sans-serif}</style>${head}</head><body>${markup}</body></html>`);
}

// The page-side measurements are source text for the page, not code of this package: they use the browser's own globals.
const MEASURE_MERMAID = `(() => {
  // A row is a centre line: the badge is 20 px high and the buttons 28, so their tops differ on one row.
  const box = (e) => { const b = e.getBoundingClientRect(); return { h: Math.round(b.height), top: Math.round(b.top + b.height / 2) }; };
  const bar = document.querySelector('.dsh-mmd-bar');
  const labels = [...document.querySelectorAll('.dsh-mmd-bar .dsh-mmd-badge, .dsh-mmd-bar .dsh-mmd-btn')].map(box);
  const viewer = [...document.querySelectorAll('.dsh-mmd-viewer-bar > *')].map(box);
  return { labels, rows: new Set(labels.map((l) => l.top)).size, tallest: Math.max(...labels.map((l) => l.h)), overflow: bar.scrollWidth > bar.clientWidth, viewerTallest: Math.max(...viewer.map((l) => l.h)), padding: getComputedStyle(document.querySelector('.dsh-mmd-bar .dsh-mmd-btn')).paddingLeft };
})()`;
const MEASURE_GOALBAR = `(() => {
  const panel = document.querySelector('section[aria-busy]');
  const dock = panel.parentElement;
  const card = document.querySelector('.card');
  const style = getComputedStyle(panel);
  return { edge: style.borderBottomWidth, radius: style.borderBottomLeftRadius, margin: getComputedStyle(dock).marginBottom, gap: Math.round((card.getBoundingClientRect().top - panel.getBoundingClientRect().bottom) * 10) / 10 };
})()`;
const MEASURE_MENU = `(() => {
  const row = (id) => {
    const option = document.getElementById(id);
    const name = option.querySelector('[class$="_itemName"]');
    const description = option.querySelector('[class$="_itemDescription"]');
    return { description: getComputedStyle(description).display, nameWidth: Math.round(name.getBoundingClientRect().width), nameTruncated: name.scrollWidth > name.clientWidth };
  };
  return { skill: row('dsh-slash-option-skill-0'), command: row('dsh-slash-option-command-1') };
})()`;

const withShell = () => `<style>${shellStylesheet(GEOMETRY_KERNEL_PIN)}</style>`;

test('Mermaid toolbars: one line per label at 390 px, the buttons and the name on one row, and the full-screen bar wraps as a whole', { skip: SKIP }, async () => {
  await inBrowser(async (page) => {
    const measure = () => page.evaluate(MEASURE_MERMAID);
    const card = `<div style="width:317px">${surfaces.mermaid.html}</div>${surfaces.mermaid.viewerHtml}`;
    // Control: the bundle alone breaks 「代码」 and 「flowchart」 over two lines.
    await lay(page, 390, `<style>${surfaces.mermaid.css}</style>`, card);
    const before = await measure();
    assert.ok(before.tallest > 36, `without the shell's rules a label breaks (tallest ${before.tallest})`);
    // With the rules.
    await lay(page, 390, `<style>${surfaces.mermaid.css}</style>${withShell()}`, card);
    const after = await measure();
    assert.ok(after.tallest <= 32, `every label is one line (tallest ${after.tallest})`);
    assert.equal(after.rows, 1, 'the name and the four buttons fit one row at 390 px');
    assert.equal(after.overflow, false);
    assert.ok(after.viewerTallest <= 32, 'the full-screen bar keeps its labels on one line too');
    // A frame too narrow for the row wraps it, never breaks a label.
    await lay(page, 320, `<style>${surfaces.mermaid.css}</style>${withShell()}`, `<div style="width:247px">${surfaces.mermaid.html}</div>`);
    const narrow = await measure();
    assert.ok(narrow.tallest <= 32 && narrow.rows === 2 && narrow.overflow === false, `a narrow frame wraps the row (rows ${narrow.rows}, tallest ${narrow.tallest})`);
    // At full width nothing changes shape: one row, the buttons keep their own padding.
    await lay(page, 1280, `<style>${surfaces.mermaid.css}</style>${withShell()}`, `<div style="width:817px">${surfaces.mermaid.html}</div>`);
    const wide = await measure();
    assert.equal(wide.rows, 1);
    assert.equal(wide.padding, '10px');
  });
});

test("LoopX's goal bar has its lower edge and clears the composer card, at 390 and 1280 px", { skip: SKIP }, async () => {
  await inBrowser(async (page) => {
    const stack = `<div style="display:flex;flex-direction:column;gap:6px;--dsh-composer-stack-gap:6px;--dsh-composer-dock-inset:8px;--dsh-composer-side-clearance:16px;--dsh-composer-card-max-width:984px;padding-top:40px">`
      + `<div data-slot="conversation.input.dock" style="display:contents">${surfaces.goalbar.html}</div>`
      + `<div class="card" style="height:98px;border:1px solid #ddd;border-radius:20px;position:relative"></div></div>`;
    const measure = () => page.evaluate(MEASURE_GOALBAR);
    for (const width of [390, 1280]) {
      await lay(page, width, `<style>${surfaces.goalbar.css}</style>`, stack);
      const before = await measure();
      assert.equal(before.edge, '0px', 'the bundle draws no lower edge');
      assert.ok(before.gap < 0, `and tucks the bar under the card (${before.gap} px)`);
      await lay(page, width, `<style>${surfaces.goalbar.css}</style>${withShell()}`, stack);
      const after = await measure();
      assert.equal(after.edge, '1px');
      assert.equal(after.radius, '12px');
      assert.equal(after.margin, '0px');
      assert.equal(after.gap, 6, 'the dock\'s own gap is all that separates the bar from the card');
    }
  });
});

test("the `/` menu: a skill row shows its name in the whole row and no description; a command row keeps its line", { skip: SKIP }, async () => {
  await inBrowser(async (page) => {
    const measure = () => page.evaluate(MEASURE_MENU);
    const menu = `<div style="width:350px">${surfaces.menu.html}</div>`;
    await lay(page, 390, `<style>${surfaces.menu.css}</style>`, menu);
    const before = await measure();
    assert.notEqual(before.skill.description, 'none');
    assert.equal(before.skill.nameTruncated, true, 'the English line leaves a long skill name 40% of the row');
    await lay(page, 390, `<style>${surfaces.menu.css}</style>${withShell()}`, menu);
    const after = await measure();
    assert.equal(after.skill.description, 'none');
    assert.equal(after.skill.nameTruncated, false);
    assert.notEqual(after.command.description, 'none', 'a command keeps its description');
    assert.equal(after.command.nameWidth, before.command.nameWidth, 'and its row is laid out as before');
  });
});
