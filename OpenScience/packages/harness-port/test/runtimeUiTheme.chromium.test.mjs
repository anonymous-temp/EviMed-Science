/** Field focus in Chromium: owned theme lifecycle over representative native controls, no network. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { BODY } from '../src/runtimeUiTheme.mjs';
import { kernelThemeTokens } from '@evimed/design-tokens/kernel';

const executablePath = process.env.EVIMED_FRAME_CSS_CHROME ?? '';

test('native field ink focus preserves action focus, invalid borders and theme-off behavior', { skip: !executablePath && 'EVIMED_FRAME_CSS_CHROME names no Chromium' }, async () => {
  const require = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
  const { chromium } = require('playwright' + '-core');
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (/** @type {any} */ route) => route.abort());
    const tokens = kernelThemeTokens();
    for (const scheme of /** @type {const} */ (['light', 'dark'])) {
      const ink = tokens['--dsw-specific-brand-ink'][scheme];
      await page.setContent(`<!doctype html><style>
        body{--dsw-specific-brand-ink:${ink};--action:#a34427;background:${scheme === 'light' ? '#fbf8f2' : '#171512'}}
        input,select,textarea,[contenteditable]{border:2px solid var(--action)}
        :focus-visible{outline:1px solid var(--action);outline-offset:0}
        [aria-invalid=true]{border-color:#c0362c;box-shadow:inset 0 0 0 1px #c0362c}
      </style><input id="field"><input id="invalid" aria-invalid="true"><select id="select"><option>Choice</option></select><textarea id="text"></textarea><div id="editable" contenteditable="plaintext-only">Edit</div><button id="button">Action</button><input id="check" type="checkbox">`);
      // Run the exact body serialization, with its optional native services and effect cleanup.
      await page.evaluate(`(() => {${BODY.parts.map((part) => part.toString()).join('\n')}
        const disposers=[];
        const scope={theme:{overrideTokens(){return ()=>{}},setTheme(){}},effect(fn){const dispose=fn();if(typeof dispose==='function')disposers.push(dispose)},on(){return ()=>{}}};
        const kit={ours:true,vocabulary:{themeTokens:{}},withServices(names,fn){fn(scope)},hub:{getState(){return {}},on(){return ()=>{}}}};
        apply(scope,{},window,undefined,kit);
        window.unloadTheme=()=>{for(const dispose of disposers.reverse())dispose()};})()`);
      /** @param {string} id */
      const measure = async (id) => {
        await page.locator(`#${id}`).focus();
        return page.evaluate(`(() => {
          const node = document.getElementById(${JSON.stringify(id)});
          const css = getComputedStyle(node);
          return { outline: css.outlineColor, width: css.outlineWidth, offset: css.outlineOffset, border: css.borderTopColor, shadow: css.boxShadow };
        })()`);
      };
      /** @param {string} hex */
      const rgb = (hex) => `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
      for (const id of ['field', 'invalid', 'select', 'text', 'editable']) {
        const style = await measure(id);
        assert.equal(style.outline, rgb(ink), `${scheme} ${id}`);
        assert.equal(style.width, '2px');
        assert.equal(style.offset, '2px');
      }
      const invalid = await measure('invalid');
      assert.equal(invalid.border, 'rgb(192, 54, 44)');
      assert.match(invalid.shadow, /rgb\(192, 54, 44\)/);
      for (const id of ['button', 'check']) assert.equal((await measure(id)).outline, 'rgb(163, 68, 39)');
      await page.emulateMedia({ forcedColors: 'active' });
      const forced = await measure('field');
      assert.equal(forced.width, '2px');
      assert.equal(forced.outline, await page.evaluate(`(() => { const node = document.createElement('span'); node.style.color = 'Highlight'; document.body.append(node); const color = getComputedStyle(node).color; node.remove(); return color; })()`));
      await page.emulateMedia({ forcedColors: 'none' });
      await page.evaluate('window.unloadTheme()');
      assert.equal(await page.locator('[data-evimed-field-focus]').count(), 0);
      assert.equal((await measure('field')).outline, 'rgb(163, 68, 39)');
      assert.equal((await measure('field')).width, '1px');
    }
  } finally { await browser.close(); }
});
