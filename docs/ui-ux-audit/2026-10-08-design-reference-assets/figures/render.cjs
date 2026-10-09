// Render the v1.1 schematic figures (fig-*.html) to PNG. Usage: node render.cjs [prefix...]
// A file may set <meta name="shot" content="WxH"> for its viewport (default 1512 x 945). Design renders, not screenshots.
const fs = require('fs');
const path = require('path');
const pw = require('/home/coder/workspace/EviMedScience/.evimed-local/toolchains/playwright-core/node_modules/playwright-core');
const dir = __dirname;
const only = process.argv.slice(2);
(async () => {
  const browser = await pw.chromium.launch({
    headless: true,
    executablePath: '/home/coder/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--font-render-hinting=none'],
  });
  for (const file of fs.readdirSync(dir).filter((name) => /^fig-\d\d-.*\.html$/.test(name)).sort()) {
    if (only.length && !only.some((prefix) => file.startsWith(prefix))) continue;
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const shot = (html.match(/<meta name="shot" content="(\d+)x(\d+)">/) || []);
    const viewport = shot.length ? { width: +shot[1], height: +shot[2] } : { width: 1512, height: 945 };
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1.5, locale: 'zh-CN' });
    const page = await context.newPage();
    const warnings = [];
    page.on('console', (message) => warnings.push(message.text()));
    await page.goto('file://' + path.join(dir, file));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(dir, file.replace(/\.html$/, '.png')) });
    console.log('rendered', file, warnings.length ? 'WARN ' + warnings.join(' | ') : '');
    await context.close();
  }
  await browser.close();
})();
