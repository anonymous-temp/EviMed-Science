#!/usr/bin/env node
/**
 * A read-only walk of a live deployment's pages, at the owner's desktop width
 * and a phone width, that fails when a page regresses on what the
 * 2026-09-15/16/23 walks found by hand (review appendix C: "fix the walk into
 * scripts/ops"; 2026-09-23 plan §7 gate 3: "上线后走查带预算").
 *
 * What it asserts, per page and viewport:
 *   - no runtime vocabulary in the visible text (run/session ids, provider
 *     model ids, SHOUTED capability keys, `undefined`, `NaN`, `[object …]`,
 *     leftover `<!-- claim:… -->` markers), and none of the back office the
 *     2026-09-23 plan took off the pages (已交付, 核对 N 条, 用过 N 次,
 *     起生效, token, 缓存命中, tok/s, feed and API names — a feed's name,
 *     「openFDA 药品召回（enforcement）API」, not the data source 「openFDA」
 *     a researcher sets a key for in 设置 → 数据源);
 *   - every visible control has a name;
 *   - the page has its own title (not the bare product name), and its header
 *     carries no subtitle;
 *   - at 390 px nothing overflows horizontally;
 *   - at the desktop width, the style budget of §7: at most 8 kinds of
 *     control, 5 text colours (8 on the frontier feed, which adds the safety
 *     red and the rank colours) and 3 kinds of border; the title and the page
 *     body's blocks start on one left edge; within a list, every row's title
 *     (`[data-row-title]`) starts on one left edge;
 *   - no page is replaced by the router's English error page, and a lazy page
 *     whose chunk is gone (the state an open tab is in after a release) keeps
 *     the sidebar and says so in Chinese.
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

/**
 * The pages, by the name the report uses. 知识库 and 记忆胶囊 are one page each
 * since 2026-09-20; 设置 is walked section by section. The frontier feed's
 * views are walked only where the account is offered the feed.
 */
const ROUTES = [
  ["frontier", "/app/frontier"],
  ["frontier-hot", "/app/frontier?view=hot"],
  ["frontier-daily", "/app/frontier?view=daily"],
  ["frontier-all", "/app/frontier?view=all"],
  ["capabilities", "/app/capabilities"],
  ["files", "/app/files"],
  ["memory", "/app/memory"],
  ["autopilot", "/app/autopilot"],
  ["inbox", "/app/inbox"],
  ["account", "/app/account"],
  ["account-usage", "/app/account?tab=usage"],
  ["account-connectors", "/app/account?tab=connectors"],
  ["account-projects", "/app/account?tab=projects"],
  ["not-found", "/app/does-not-exist"],
];
// 1512 is the owner's screen (2026-09-23 plan §3: measured at that width).
const VIEWPORTS = [["desktop", { width: 1512, height: 945 }], ["phone", { width: 390, height: 844 }]];
const LEAKS = [
  /\brun_[0-9a-f]{32}\b/, /\bses_[A-Za-z0-9]{8,}/, /deepseek\//i,
  /\bundefined\b/, /\bNaN\b/, /\[object /, /<!--\s*claim/i,
];

/**
 * The back office a page no longer describes (2026-09-23 plan §4, checklist
 * item 8). A closed list of the product's own phrases, not a pattern over
 * open prose: each is something this code base used to print.
 */
const BACK_OFFICE = [
  /已交付/, /核对\s*\d+\s*条/, /已核对\s*\d+\s*[\/／]/, /用过\s*\d+\s*次/, /\d+月\d+日\s*起生效/, /缓存命中/, /tok\/s/,
  /\b\d[\d,.]*[KMk]?\s*tok(en)?s?\b/, /（[^）]*\bAPI）/, /openFDA (药品召回|Drugs@FDA|器械)/, /理解遗漏/, /处理第\s*\d+\s*代/, /Unexpected Application Error/, /dynamically imported module/,
];

/**
 * The style budget per page (2026-09-23 plan §7 gate 3). The frontier feed may
 * spend three more text colours: the safety red and the rank colours.
 */
const BUDGET = { controls: 8, colors: 5, borders: 3 };
const BUDGET_BY_PAGE = { frontier: { colors: 8 }, "frontier-hot": { colors: 8 }, "frontier-daily": { colors: 8 }, "frontier-all": { colors: 8 } };

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
function measure([leakSources, backOfficeSources]) {
  const leaks = leakSources.map(([source, flags]) => new RegExp(source, flags));
  const backOffice = backOfficeSources.map(([source, flags]) => new RegExp(source, flags));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const text = document.body.innerText || "";
  const kinds = (values) => new Set(values).size;

  // The style inventory of the 2026-09-23 walk (the plan's §3 numbers were
  // taken with it): distinct control looks, text colours and borders.
  const all = [...document.querySelectorAll("body *")].filter(visible);
  const borders = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(cs[`border${side}Width`]) > 0
      && cs[`border${side}Style`] !== "none" && cs[`border${side}Color`] !== "rgba(0, 0, 0, 0)");
    if (!sides.length) continue;
    const side = sides[0];
    borders.push(`${sides.length === 4 ? "box" : sides.join("+").toLowerCase()} ${cs[`border${side}Width`]} ${cs[`border${side}Color`]}`);
  }
  const texty = all.filter((el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()));
  const colors = texty.map((el) => getComputedStyle(el).color);
  const controlLooks = all.filter((el) => el.matches("button, a, [role='button'], [role='tab'], select, input, summary")).map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const framed = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
    const filled = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "rgb(255, 255, 255)";
    return `${Math.round(r.height)}h ${cs.fontSize}/${cs.fontWeight}${framed ? " framed" : ""}${filled ? " filled" : ""} r${cs.borderTopLeftRadius}`;
  });

  // One left edge: the title and the page body's top-level blocks, and within
  // a list every row's title.
  const title = document.querySelector("main h1, h1");
  const header = title?.closest("header") ?? null;
  const column = header?.parentElement ?? null;
  const body = column ? [...column.children].find((child) => child !== header) : null;
  const blocks = [title, ...(body ? [...body.children] : [])].filter((el) => el && visible(el));
  const pageLefts = [...new Set(blocks.map((el) => Math.round(el.getBoundingClientRect().left)))];
  const rowTitleLefts = [];
  for (const list of document.querySelectorAll("ul, ol")) {
    const titles = [...list.querySelectorAll(":scope > li [data-row-title]")].filter(visible);
    if (titles.length >= 2) rowTitleLefts.push([...new Set(titles.map((el) => Math.round(el.getBoundingClientRect().left)))]);
  }
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
    controlKinds: kinds(controlLooks),
    colorKinds: kinds(colors),
    borderKinds: kinds(borders),
    pageLefts,
    rowTitleLefts,
    subtitle: header ? [...header.querySelectorAll("p")].filter(visible).map((el) => el.textContent.trim().slice(0, 60)) : [],
    backOfficeHits: backOffice.map((re) => text.match(re)?.[0]?.slice(0, 60)).filter(Boolean),
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
    // An open tab after a release asks for a page chunk the new image no
    // longer has (2026-09-23 plan §2.1). Played here by refusing the inbox's
    // chunk to a fresh page and navigating to it in place: the sidebar must
    // stay and the words must be Chinese — never the router's English page.
    // First, before the phone width folds the sidebar away (its state is kept
    // per browser), and by the router's own history, not by a sidebar click.
    {
      current = "stale-chunk@desktop";
      const probe = await context.newPage();
      await probe.setViewportSize(VIEWPORTS[0][1]);
      try {
        await probe.goto(`${base}/app/capabilities`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await probe.waitForTimeout(3_000);
        await probe.route(/\/assets\/InboxPage-[^/]+\.js$/, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "" }));
        await probe.evaluate(() => {
          window.history.pushState({}, "", "/app/inbox");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await probe.waitForTimeout(8_000);
        const state = await probe.evaluate(() => ({
          english: /Unexpected Application Error|dynamically imported module|Failed to fetch/.test(document.body.innerText),
          sidebar: Boolean(document.querySelector("aside a[href='/app/chat']")),
          text: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
        }));
        await probe.screenshot({ path: path.join(out, `${current}.png`) }).catch(() => {});
        report.pages[current] = { route: "/app/inbox (chunk refused)", ...state };
        if (state.english) failures.push(`${current}: a missing page chunk shows the router's English error page`);
        if (!state.sidebar) failures.push(`${current}: a missing page chunk takes the sidebar with it`);
      } catch (error) {
        failures.push(`${current}: the probe could not run (${String(error).slice(0, 120)})`);
      } finally {
        await probe.close().catch(() => {});
      }
    }
    for (const [viewportName, viewport] of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const [name, route] of ROUTES) {
        current = `${name}@${viewportName}`;
        try {
          await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForTimeout(3_000);
          await page.screenshot({ path: path.join(out, `${current}.png`) });
          const measured = await page.evaluate(measure, [leaks.map((re) => [re.source, re.flags]), BACK_OFFICE.map((re) => [re.source, re.flags])]);
          report.pages[current] = { route, ...measured, consoleErrors: consoleErrors[current] ?? [], httpErrors: httpErrors[current] ?? [] };
          if (measured.leakHits.length) failures.push(`${current}: runtime vocabulary on the page: ${measured.leakHits.join(", ")}`);
          if (measured.backOfficeHits.length) failures.push(`${current}: the back office on the page: ${measured.backOfficeHits.join(", ")}`);
          if (measured.unnamedControls.length) failures.push(`${current}: ${measured.unnamedControls.length} control(s) without a name`);
          if (!measured.title || measured.title.trim() === "EviMed") failures.push(`${current}: the page has no title of its own`);
          if (measured.subtitle.length) failures.push(`${current}: the page header has a subtitle: ${measured.subtitle.join(" / ")}`);
          if (viewportName === "phone" && measured.overflowX) failures.push(`${current}: the page overflows horizontally at 390 px`);
          if (viewportName === "desktop") {
            const budget = { ...BUDGET, ...(BUDGET_BY_PAGE[name] ?? {}) };
            if (measured.controlKinds > budget.controls) failures.push(`${current}: ${measured.controlKinds} kinds of control (budget ${budget.controls})`);
            if (measured.colorKinds > budget.colors) failures.push(`${current}: ${measured.colorKinds} text colours (budget ${budget.colors})`);
            if (measured.borderKinds > budget.borders) failures.push(`${current}: ${measured.borderKinds} kinds of border (budget ${budget.borders})`);
            if (measured.pageLefts.length > 1) failures.push(`${current}: the page's blocks start on ${measured.pageLefts.length} left edges (${measured.pageLefts.join(", ")})`);
            for (const lefts of measured.rowTitleLefts) {
              if (lefts.length > 1) failures.push(`${current}: a list's row titles start on ${lefts.length} left edges (${lefts.join(", ")})`);
            }
          }
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
    // Log out for real: the request needs the shell's origin and the
    // session's CSRF token (under `data` in /api/me), and without them the
    // logout answered 403 and left a seven-day session behind after every
    // walk. Checked, not assumed — /api/me must answer 401 afterwards.
    const me = await context.request.get(`${base}/api/me`).catch(() => null);
    const csrf = me?.ok() ? (await me.json().catch(() => ({})))?.data?.csrfToken : undefined;
    const logout = await context.request.post(`${base}/api/auth/logout`, {
      headers: { origin: base, ...(csrf ? { "x-open-science-csrf": String(csrf) } : {}) },
    }).catch(() => null);
    const after = await context.request.get(`${base}/api/me`).catch(() => null);
    report.logout = { status: logout?.status() ?? null, meAfter: after?.status() ?? null };
    if (after?.status() !== 401) failures.push(`logout: /api/me still answers ${after?.status() ?? "nothing"} after logging out — the walk's session is alive`);
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
    if (/秒内没有载入完成|无法载入|载入失败|打开超时|暂时无法打开|无法连接/.test(shell)) return { loaded: false, state: shell.split("\n").find((line) => /载入|超时|无法/.test(line))?.slice(0, 80) };
  }
  return { loaded: false, state: "no composer within two minutes" };
}

main().then((code) => process.exit(code), (error) => {
  console.error(`walk failed: ${String(error).slice(0, 300)}`);
  process.exit(2);
});
