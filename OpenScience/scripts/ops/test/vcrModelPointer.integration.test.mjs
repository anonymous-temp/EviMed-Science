/* global window, document, getComputedStyle */
/** Pointer hit testing of the real saved-model component and production CSS. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const requireWeb = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const browserModule = process.env.OPEN_SCIENCE_PLAYWRIGHT_CORE;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { VcrModelsPanel } from '/src/components/vcr/VcrModelsPanel.tsx';
import { useProjectStore } from '/src/lib/projects.ts';
import '/src/index.css';
useProjectStore.setState({ currentId: 'default', select: async (_id, land) => land?.() });
function Probe() { const location = useLocation(); React.useEffect(() => { window.__pointerState = { path: location.pathname, state: location.state }; }, [location]); return null; }
createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter, null, React.createElement(VcrModelsPanel), React.createElement(Probe)));
</script></body></html>`;

test('saved-model details and both draft actions remain real pointer targets at desktop and phone widths', { skip: !browserModule, timeout: 60_000 }, async () => {
  const { createServer } = await import(new URL('./dist/node/index.js', pathToFileURL(requireWeb.resolve('vite/package.json'))));
  const previousCwd = process.cwd(); process.chdir(webRoot);
  const server = await createServer({ root: webRoot, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
    define: { 'import.meta.env.VITE_OPEN_SCIENCE_API_URL': JSON.stringify('/api') },
    plugins: [{ name: 'vcr-pointer-fixture', configureServer(dev) {
      dev.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__vcr-model-pointer.html') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await dev.transformIndexHtml('/__vcr-model-pointer.html', html));
      });
    } }],
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const { chromium } = requireWeb(browserModule);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.OPEN_SCIENCE_WALK_CHROMIUM ? { executablePath: process.env.OPEN_SCIENCE_WALK_CHROMIUM } : {}) });
    for (const width of [1512, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 982 } });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/vcr/models', route => route.fulfill({ json: { data: { methods: [], models: [{
        id: 'model_exact', version: '2.1.0', name: '保存的文献模型', tier: 'literature', risk: 'unassessed', useCeiling: 'design_support',
        revisionCard: { parameterBindings: [{ field: 'truth.controlRate', value: 30, mappedValue: 0.3, unit: '%', quote: 'Preserved source passage', sourceId: 'src_test', textSha256: 'a'.repeat(64), quoteStart: 0, quoteEnd: 24 }] },
      }] } } }));
      for (const actionName of ['在对话中使用', '在对话中补充来源']) {
        await page.goto(`http://127.0.0.1:${address.port}/__vcr-model-pointer.html`);
        const title = page.getByRole('button', { name: '保存的文献模型', exact: true });
        await title.waitFor({ state: 'visible', timeout: 7000 }).catch(async () => { throw new Error(JSON.stringify({ errors, body: await page.locator('body').textContent() })); });
        assert.equal(await title.evaluate(element => getComputedStyle(element, '::after').position), 'absolute');
        await title.click(); assert.equal(await title.getAttribute('aria-expanded'), 'true');
        const source = page.getByRole('link', { name: 'Preserved source passage' });
        await source.scrollIntoViewIfNeeded();
        const sourceBox = await source.boundingBox(); assert.ok(sourceBox);
        assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.textContent, { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }), 'Preserved source passage');
        await source.click();
        await page.waitForFunction(() => window.__pointerState?.path.startsWith('/app/files/src_test'));
        const action = page.getByRole('button', { name: actionName, exact: true });
        await action.scrollIntoViewIfNeeded();
        const box = await action.boundingBox(); assert.ok(box);
        assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent, { x: box.x + box.width / 2, y: box.y + box.height / 2 }), actionName);
        await action.click();
        await page.waitForFunction(() => window.__pointerState?.state?.runtimeUiIntent?.vcrReference);
        const intent = await page.evaluate(() => window.__pointerState.state.runtimeUiIntent);
        assert.deepEqual(intent.vcrReference, { kind: 'model', objectId: 'model_exact', version: '2.1.0' });
        assert.equal(intent.projectId, 'default'); assert.doesNotMatch(intent.draft, /model_exact/);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser?.close(); await server.close(); process.chdir(previousCwd); }
});
