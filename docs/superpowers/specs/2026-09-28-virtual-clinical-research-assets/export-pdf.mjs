// Renders ../2026-09-28-EviMed虚拟临研平台方案.md to a PDF beside it, with the design renders inline.
// Usage: node export-pdf.mjs   (micromark + micromark-extension-gfm from OpenScience/node_modules, as the frontier plan does)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "..");
const name = "2026-09-28-EviMed虚拟临研平台方案";
const store = path.resolve(dir, "..", "..", "..", "OpenScience", "node_modules", ".pnpm");
const find = (pkg) => { const d = fs.readdirSync(store).find((x) => x.startsWith(pkg + "@")); return pathToFileURL(path.join(store, d, "node_modules", pkg, "index.js")).href; };
const { micromark } = await import(find("micromark"));
const { gfm, gfmHtml } = await import(find("micromark-extension-gfm"));
const core = "/home/coder/workspace/EviMedScience/.evimed-local/toolchains/playwright-core/node_modules/playwright-core/index.mjs";
const exe = "/home/coder/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const { chromium } = await import(pathToFileURL(core).href);
const md = fs.readFileSync(path.join(dir, name + ".md"), "utf8");
const body = micromark(md, { extensions: [gfm()], htmlExtensions: [gfmHtml()], allowDangerousHtml: false });
const stray = (body.replace(/<code>[^<]*<\/code>/g, "").match(/\*\*/g) || []).length;
if (stray) console.warn("unparsed ** left:", stray);
const css = `@page{size:A4;margin:14mm 13mm}body{font-family:"Noto Sans CJK SC",sans-serif;font-size:10pt;line-height:1.7;color:#242628}
h1{font-size:20pt;margin:0 0 6pt}h2{font-size:14pt;margin:22pt 0 8pt;padding-bottom:4pt;border-bottom:1px solid #e9ebed;page-break-after:avoid}
h2:nth-of-type(n+4){page-break-before:always}h3{font-size:11.5pt;margin:14pt 0 6pt;page-break-after:avoid}p{orphans:3;widows:3}
table{border-collapse:collapse;width:100%;margin:8pt 0;font-size:9pt;page-break-inside:auto}th,td{border-bottom:1px solid #e9ebed;padding:5pt 6pt;vertical-align:top;text-align:left}
th{color:#767d81;font-weight:500}tr{page-break-inside:avoid}td{overflow-wrap:anywhere}td:first-child,th:first-child{white-space:nowrap}td:nth-child(2){min-width:6em}td:last-child{min-width:5em}
img{max-width:100%;display:block;margin:6pt auto;border:1px solid #e9ebed;border-radius:6px;page-break-inside:avoid}
code{font-family:"Noto Sans Mono CJK SC",monospace;font-size:8.5pt;background:#f0f1f2;padding:0 3px;border-radius:3px}
hr{border:0;margin:6pt 0}strong{color:#0a4da0}a{color:#0a5dc1;text-decoration:none}ul,ol{padding-left:18pt}li{margin:2pt 0}`;
const tmp = path.join(dir, name + ".tmp.html");
fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8"><title>EviMed 虚拟临研：虚拟临床研究平台方案（v2.0）</title><style>${css}</style>${body}`);
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--allow-file-access-from-files"] });
const page = await browser.newPage();
await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
const out = path.join(dir, name + ".pdf");
await page.pdf({ path: out, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>",
  footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#767d81"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
await browser.close(); fs.unlinkSync(tmp);
console.log(path.basename(out), Math.round(fs.statSync(out).size / 1024) + " KB");
