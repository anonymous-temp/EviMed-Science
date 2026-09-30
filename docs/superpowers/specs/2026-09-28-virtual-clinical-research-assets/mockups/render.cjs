// Render mockup HTML files to PNG at 1512 x 945 (the owner's screen), DPR 2. Usage: node render.cjs [prefix...]
// A file may set <meta name="shot" content="full"> for a full-page capture, or content="WxH" for a custom viewport.
const fs = require('fs'); const path = require('path');
const pw = require('/home/coder/workspace/EviMedScience/.evimed-local/toolchains/playwright-core/node_modules/playwright-core');
const dir = __dirname; const only = process.argv.slice(2);
(async () => {
  const b = await pw.chromium.launch({ headless: true, executablePath: '/home/coder/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', args: ['--no-sandbox', '--allow-file-access-from-files', '--font-render-hinting=none'] });
  for (const f of fs.readdirSync(dir).filter((n) => /^v\d.*\.html$/.test(n)).sort()) {
    if (only.length && !only.some((o) => f.startsWith(o))) continue;
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const shot = (html.match(/<meta name="shot" content="([^"]+)"/) || [])[1] || '';
    const size = /^(\d+)x(\d+)$/.exec(shot);
    const ctx = await b.newContext({ viewport: size ? { width: +size[1], height: +size[2] } : { width: 1512, height: 945 }, deviceScaleFactor: 2, locale: 'zh-CN' });
    const p = await ctx.newPage();
    const warns = []; p.on('console', (m) => warns.push(m.text()));
    await p.goto('file://' + path.join(dir, f));
    await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(250);
    await p.screenshot({ path: path.join(dir, f.replace('.html', '.png')), fullPage: shot === 'full' });
    console.log('rendered', f, warns.length ? 'WARN ' + warns.join(' | ') : '');
    await ctx.close();
  }
  await b.close();
})();
