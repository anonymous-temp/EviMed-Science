#!/usr/bin/env node
/**
 * A read-only walk of a live deployment's pages, at a desktop width and a phone
 * width, that fails when a page regresses on what the 2026-09-15/16 walks
 * found by hand (review appendix C: "fix the walk into scripts/ops").
 *
 * What it asserts, per page and viewport:
 *   - no runtime vocabulary in the visible text (run/session ids, provider
 *     model ids, SHOUTED capability keys, `undefined`, `NaN`, `[object …]`,
 *     leftover `<!-- claim:… -->` markers);
 *   - every visible control has a name;
 *   - the page has its own title (not the bare product name);
 *   - at 390 px nothing overflows horizontally.
 * It also records, without failing on them, small click targets, decorative
 * SVGs without aria-hidden, console errors and HTTP errors — the things that
 * need a person to judge.
 *
 * Read-only: it logs in, reads pages and logs out. It never opens the chat
 * page, because a frame bound to a live session would start a runtime.
 *
 * Nothing is added to package.json: a browser automation dependency would
 * change the lockfile, and a changed lockfile makes the next release a full
 * runtime image rebuild. Point it at an installed playwright-core instead.
 *
 *   OPEN_SCIENCE_WALK_BASE_URL=https://evimed.example.org \
 *   OPEN_SCIENCE_WALK_USER=cdss-access \
 *   OPEN_SCIENCE_WALK_PASSWORD_FILE=/path/to/password \
 *   OPEN_SCIENCE_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
 *   [OPEN_SCIENCE_WALK_CHROMIUM=/path/to/chrome] \
 *   [OPEN_SCIENCE_WALK_OUT=/tmp/ui-walk] \
 *   node scripts/ops/ui-walk.mjs
 *
 * Exit 0 when every assertion holds, 1 when one does not (the report names
 * which), 2 when the walk could not run at all.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const ROUTES = [
  ["runs", "/app/runs"], ["files", "/app/files"], ["files-sources", "/app/files?tab=sources"],
  ["files-notebooks", "/app/files?tab=notebooks"], ["memory", "/app/memory"], ["memory-capsules", "/app/memory?tab=capsules"],
  ["memory-methods", "/app/memory?tab=methods"], ["autopilot", "/app/autopilot"], ["inbox", "/app/inbox"],
  ["capabilities", "/app/capabilities"], ["account", "/app/account"], ["account-settings", "/app/account?tab=settings"],
  ["account-connectors", "/app/account?tab=connectors"], ["not-found", "/app/does-not-exist"],
];
const VIEWPORTS = [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]];
const LEAKS = [
  /\brun_[0-9a-f]{32}\b/, /\bses_[A-Za-z0-9]{8,}/, /deepseek\//i, /\b[A-Z][A-Z-]{9,}\b/,
  /\bundefined\b/, /\bNaN\b/, /\[object /, /<!--\s*claim/i,
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required; see the header of scripts/ops/ui-walk.mjs.`);
    process.exit(2);
  }
  return value;
}

/** What one page shows, measured in the page. */
function measure(leakSources) {
  const leaks = leakSources.map(([source, flags]) => new RegExp(source, flags));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const text = document.body.innerText || "";
  const controls = [...document.querySelectorAll("button, a, [role='button'], input, select, textarea")].filter(visible);
  const unnamed = controls.filter((el) => {
    const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("placeholder") || "").trim();
    const labelled = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return !name && !labelled && !el.getAttribute("aria-labelledby");
  });
  return {
    title: document.title,
    leakHits: leaks.map((re) => text.match(re)?.[0]?.slice(0, 60)).filter(Boolean),
    unnamedControls: unnamed.map((el) => el.outerHTML.slice(0, 90)),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    smallTargets: controls.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).length,
    decorativeSvgs: [...document.querySelectorAll("svg")].filter((s) => visible(s) && !s.getAttribute("aria-hidden") && !s.getAttribute("role") && !s.getAttribute("aria-label")).length,
  };
}

async function main() {
  const base = required("OPEN_SCIENCE_WALK_BASE_URL").replace(/\/+$/, "");
  const username = required("OPEN_SCIENCE_WALK_USER");
  // Read from a file and never printed: the password is not an argument, an
  // environment value or a log line.
  const password = (await readFile(required("OPEN_SCIENCE_WALK_PASSWORD_FILE"), "utf8")).trim();
  const require = createRequire(import.meta.url);
  const playwright = require(required("OPEN_SCIENCE_PLAYWRIGHT_CORE"));
  const out = process.env.OPEN_SCIENCE_WALK_OUT?.trim() || "/tmp/evimed-ui-walk";
  await mkdir(out, { recursive: true });

  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.OPEN_SCIENCE_WALK_CHROMIUM ? { executablePath: process.env.OPEN_SCIENCE_WALK_CHROMIUM } : {}),
    args: ["--no-sandbox"],
  });
  const failures = [];
  const report = { base, startedAt: new Date().toISOString(), pages: {} };
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const login = await context.request.post(`${base}/api/auth/login`, {
      data: { username, password }, headers: { "content-type": "application/json" },
    });
    if (login.status() !== 200) {
      console.error(`login answered ${login.status()}; nothing was walked.`);
      return 2;
    }
    const page = await context.newPage();
    let current = "";
    const consoleErrors = {};
    const httpErrors = {};
    page.on("console", (message) => { if (message.type() === "error") (consoleErrors[current] ||= []).push(message.text().slice(0, 160)); });
    page.on("response", (response) => { if (response.status() >= 400) (httpErrors[current] ||= []).push(`${response.status()} ${new URL(response.url()).pathname.slice(0, 60)}`); });
    for (const [viewportName, viewport] of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const [name, route] of ROUTES) {
        current = `${name}@${viewportName}`;
        try {
          await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForTimeout(3_000);
          await page.screenshot({ path: path.join(out, `${current}.png`) });
          const measured = await page.evaluate(measure, LEAKS.map((re) => [re.source, re.flags]));
          report.pages[current] = { route, ...measured, consoleErrors: consoleErrors[current] ?? [], httpErrors: httpErrors[current] ?? [] };
          if (measured.leakHits.length) failures.push(`${current}: runtime vocabulary on the page: ${measured.leakHits.join(", ")}`);
          if (measured.unnamedControls.length) failures.push(`${current}: ${measured.unnamedControls.length} control(s) without a name`);
          if (!measured.title || measured.title.trim() === "EviMed") failures.push(`${current}: the page has no title of its own`);
          if (viewportName === "phone" && measured.overflowX) failures.push(`${current}: the page overflows horizontally at 390 px`);
        } catch (error) {
          failures.push(`${current}: did not load (${String(error).slice(0, 120)})`);
        }
      }
    }
    await context.request.post(`${base}/api/auth/logout`).catch(() => {});
  } finally {
    await browser.close();
  }
  report.failures = failures;
  await writeFile(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`${Object.keys(report.pages).length} page views walked, ${failures.length} failure(s); report and screenshots in ${out}`);
  return failures.length ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`walk failed: ${String(error).slice(0, 300)}`);
  process.exit(2);
});
