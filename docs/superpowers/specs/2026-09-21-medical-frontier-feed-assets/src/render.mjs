// Renders every NN-*.html in this folder to ../NN-*.png (element #shot, 2x).
// Usage: node render.mjs   (paths below are this machine's toolchain; override with env)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const core = process.env.PLAYWRIGHT_CORE ?? "/home/coder/workspace/EviMedScience/.evimed-local/toolchains/playwright-core/node_modules/playwright-core/index.mjs";
const exe = process.env.CHROMIUM ?? "/home/coder/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell";
const { chromium } = await import(pathToFileURL(core).href);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const only = process.argv[2];
for (const file of fs.readdirSync(here).filter((f) => /^\d\d-.*\.html$/.test(f) && (!only || f.startsWith(only))).sort()) {
  await page.goto(pathToFileURL(path.join(here, file)).href); await page.waitForTimeout(150);
  const out = path.join(here, "..", file.replace(/\.html$/, ".png"));
  await page.locator("#shot").screenshot({ path: out }); console.log(path.basename(out), Math.round(fs.statSync(out).size / 1024) + " KB");
}
await browser.close();
