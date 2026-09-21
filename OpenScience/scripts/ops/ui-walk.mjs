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
 * Read-only: it logs in, reads pages and logs out. It opens the chat page only
 * when asked (`OPEN_SCIENCE_WALK_CHAT=1`), because a frame bound to a live
 * session starts the account's default runtime — and it should be asked after
 * every release: on 2026-09-21 every page here walked clean while no
 * conversation of the acceptance account could load at all (its kernel frame
 * fetched a plugin bundle from a runtime that had not composed it, a 404, and
 * stopped at 「对话界面 60 秒内没有载入完成」). With it the walk waits for the
 * frame's composer, fails on any 4xx for a kernel application file, and
 * records whether the kernel's session statistics line is on screen.
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
 *   [OPEN_SCIENCE_WALK_CHAT=1] \
 *   node scripts/ops/ui-walk.mjs
 *
 * Exit 0 when every assertion holds, 1 when one does not (the report names
 * which), 2 when the walk could not run at all.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const ROUTES = [
  ["runs", "/app/runs"],
  // 知识库 and 记忆胶囊 are one page each since 2026-09-20 — the six memory tabs
  // and the two knowledge tabs were the places the implementation kept things,
  // not things a researcher wants — so there is one shot of each to take.
  ["files", "/app/files"],
  ["memory", "/app/memory"],
  ["autopilot", "/app/autopilot"], ["inbox", "/app/inbox"],
  ["capabilities", "/app/capabilities"], ["account", "/app/account"], ["account-settings", "/app/account?tab=settings"],
  ["account-connectors", "/app/account?tab=connectors"], ["not-found", "/app/does-not-exist"],
];
const VIEWPORTS = [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]];
const LEAKS = [
  /\brun_[0-9a-f]{32}\b/, /\bses_[A-Za-z0-9]{8,}/, /deepseek\//i,
  /\bundefined\b/, /\bNaN\b/, /\[object /, /<!--\s*claim/i,
];

/**
 * A capability id printed as a SHOUTED key, from the deployment's own catalogue.
 *
 * This was `/\b[A-Z][A-Z-]{9,}\b/`, an open pattern over page text, and on
 * 2026-09-17 it failed the inbox for naming the EMPA-KIDNEY trial — a run's own
 * question, in a product whose subject matter is trials with acronyms like
 * that. What it was written to catch is a closed vocabulary (the 2026-09-16
 * walk found `CLINICAL-EVIDENCE-SYNTHESIS` used as a title), so it is asked of
 * the catalogue instead of guessed from the shape of a word.
 * @param {string[]} ids @returns {RegExp[]}
 */
function shoutedCapabilityKeys(ids) {
  return ids
    .filter((id) => /^[a-z][a-z0-9-]{3,}$/.test(id))
    .map((id) => new RegExp(`\\b${id.toUpperCase().replace(/-/g, "[-_ ]")}\\b`));
}

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
    // A control wrapped in its label is named by it — `<label>分享个人背景<input
    // type="checkbox"></label>` is how this codebase writes checkboxes and file
    // inputs, and reading only `for=` called three named controls unnamed
    // (2026-09-20 walk).
    const wrapped = el.closest("label")?.textContent?.trim();
    return !name && !labelled && !wrapped && !el.getAttribute("aria-labelledby");
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
    // The catalogue the leak check is derived from. An unreadable catalogue
    // fails the walk: silently checking against no ids would pass every page.
    const catalogue = await context.request.get(`${base}/api/agents`);
    const agents = catalogue.ok() ? (await catalogue.json())?.data : null;
    const ids = Array.isArray(agents) ? agents.map((agent) => String(agent?.id ?? "")).filter(Boolean) : [];
    if (ids.length < 5) {
      console.error(`the capability catalogue answered ${catalogue.status()} with ${ids.length} ids; nothing was walked.`);
      return 2;
    }
    const leaks = [...LEAKS, ...shoutedCapabilityKeys([...ids, "open-domain-answer"])];
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
          const measured = await page.evaluate(measure, leaks.map((re) => [re.source, re.flags]));
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
    if (process.env.OPEN_SCIENCE_WALK_CHAT === "1") {
      current = "chat@desktop";
      await page.setViewportSize(VIEWPORTS[0][1]);
      const kernelMisses = [];
      page.on("response", (response) => {
        if (response.status() >= 400 && /\/__evimed\/[ka]\//.test(new URL(response.url()).pathname)) {
          kernelMisses.push(`${response.status()} ${new URL(response.url()).pathname.slice(0, 60)}`);
        }
      });
      const chat = await walkChat(page, base).catch((error) => ({ loaded: false, error: String(error).slice(0, 160) }));
      await page.screenshot({ path: path.join(out, `${current}.png`) }).catch(() => {});
      report.pages[current] = { route: "/app/chat", ...chat, kernelMisses, consoleErrors: consoleErrors[current] ?? [] };
      if (!chat.loaded) failures.push(`${current}: the conversation frame did not load (${chat.error ?? chat.state ?? "no composer"})`);
      if (kernelMisses.length) failures.push(`${current}: kernel application files answered ${kernelMisses.join(", ")}`);
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

/**
 * Open the conversation page and wait for the kernel frame's composer.
 * @param {any} page @param {string} base
 */
async function walkChat(page, base) {
  await page.goto(`${base}/app/chat`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    for (const frame of page.frames()) {
      if (!frame.url().includes("/__evimed/f/")) continue;
      const seen = await frame.evaluate(() => ({
        composer: document.querySelectorAll("textarea, [contenteditable='true']").length > 0,
        stats: [...document.querySelectorAll("[data-composer-stats]")].map((node) => node.textContent?.trim() ?? ""),
      })).catch(() => null);
      if (seen?.composer) return { loaded: true, statsLine: seen.stats.join(" | ") || null };
    }
    const shell = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (/秒内没有载入完成|无法载入|载入失败/.test(shell)) return { loaded: false, state: shell.split("\n").find((line) => /载入/.test(line))?.slice(0, 80) };
  }
  return { loaded: false, state: "no composer within two minutes" };
}

main().then((code) => process.exit(code), (error) => {
  console.error(`walk failed: ${String(error).slice(0, 300)}`);
  process.exit(2);
});
