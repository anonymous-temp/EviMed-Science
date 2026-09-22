// Renders ../../2026-09-21-frontier-feed-medical-aihot-plan.md (assembled by build-doc.py) to a PDF beside it.
// Usage: node export-pdf.mjs   (needs micromark + micromark-extension-gfm from OpenScience/node_modules)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const specs = path.resolve(here, "..", "..");
const name = "2026-09-21-frontier-feed-medical-aihot-plan";
const store = process.env.PNPM_STORE ?? path.resolve(specs, "..", "..", "..", "OpenScience", "node_modules", ".pnpm");
const find = (pkg) => { const dir = fs.readdirSync(store).find((d) => d.startsWith(pkg + "@")); return pathToFileURL(path.join(store, dir, "node_modules", pkg, "index.js")).href; };
const { micromark } = await import(find("micromark"));
const { gfm, gfmHtml } = await import(find("micromark-extension-gfm"));
const core = process.env.PLAYWRIGHT_CORE ?? "/home/coder/workspace/EviMedScience/.evimed-local/toolchains/playwright-core/node_modules/playwright-core/index.mjs";
const exe = process.env.CHROMIUM ?? "/home/coder/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell";
const { chromium } = await import(pathToFileURL(core).href);
const md = fs.readFileSync(path.join(specs, name + ".md"), "utf8");
const body = micromark(md, { extensions: [gfm()], htmlExtensions: [gfmHtml()], allowDangerousHtml: false });
const css = `@page{size:A4;margin:16mm 14mm}body{font-family:"Noto Sans CJK SC",sans-serif;font-size:10.5pt;line-height:1.65;color:#17201e}
h1{font-size:19pt;margin:22pt 0 8pt;color:#00756b;page-break-before:always}h1:first-of-type{page-break-before:avoid;font-size:22pt;color:#17201e}h1:nth-of-type(2){page-break-before:avoid}
h2{font-size:13.5pt;margin:18pt 0 6pt;border-bottom:1px solid #e2e8e6;padding-bottom:3pt;page-break-after:avoid}h3{font-size:11.5pt;margin:12pt 0 4pt;page-break-after:avoid}p{orphans:3;widows:3}
table{border-collapse:collapse;width:100%;margin:8pt 0;font-size:9.5pt;page-break-inside:auto}th,td{border:1px solid #dfe5e3;padding:4pt 6pt;vertical-align:top;text-align:left}
th{background:#f0fbf9}td:first-child,th:first-child{min-width:4.2em}tr{page-break-inside:avoid}img{max-width:100%;max-height:232mm;display:block;margin:6pt auto;border-radius:6px;page-break-inside:avoid}code{font-family:"Noto Sans Mono CJK SC",monospace;font-size:9pt;background:#f3f6f5;padding:0 3px;border-radius:3px}
pre{background:#f6f8f8;border:1px solid #e2e8e6;border-radius:6px;padding:8pt;font-size:8.5pt;line-height:1.45;white-space:pre-wrap;page-break-inside:avoid}pre code{background:none;padding:0}
hr{border:0;border-top:1px solid #e2e8e6;margin:14pt 0}blockquote{margin:6pt 0;padding:2pt 10pt;border-left:3px solid #c3ece6;color:#44514e}strong{color:#0b2f2b}td code{word-break:break-all;font-size:8pt}td{overflow-wrap:anywhere}`;
const tmp = path.join(specs, name + ".tmp.html");
fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
const out = path.join(specs, name + ".pdf");
await page.pdf({ path: out, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>",
  footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#7b8784"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
await browser.close(); fs.unlinkSync(tmp);
console.log(path.basename(out), Math.round(fs.statSync(out).size / 1024) + " KB");
