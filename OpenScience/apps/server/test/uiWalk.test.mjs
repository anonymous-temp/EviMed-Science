// scripts/ops/ui-walk.mjs: its budgets name the pages it walks, it walks every
// GEO tab, it starts no runtime, and a font-pair count is a notice.
//
// The walk drives a real browser against a live deployment. Its verdict and
// budget tables are imported directly; its control flow is run against a
// scripted stand-in for playwright-core that records what the walk asked of
// the browser (2026-09-26 fusion audit, F-G2, F-G14 and F-G20).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BUDGET_BY_PAGE, GEO_TABS, ROUTES, TYPE_PAIR_NOTICE, pageFindings } from "../../../scripts/ops/ui-walk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A page that measures clean, as `measure` would report it. */
function clean(overrides = {}) {
  return {
    title: "知识库 · EviMed", controlKinds: 5, colorKinds: 4, borderKinds: 2, sizeWeightPairs: ["14px/400", "24px/600"],
    pageLefts: [240], rowTitleLefts: [], subtitle: [], backOfficeHits: [], leakHits: [], unnamedControls: [],
    overflowX: false, smallTargets: 0, decorativeSvgs: 0, ...overrides,
  };
}

test("every page the budget table names is a page the walk visits", () => {
  // The table said `knowledge`; the route is `files`, so the knowledge base
  // kept the reading budget and failed on its ninth control.
  const walked = new Set([...ROUTES.map(([name]) => name), ...GEO_TABS.map(([name]) => name)]);
  for (const name of Object.keys(BUDGET_BY_PAGE)) assert.ok(walked.has(name), `the budget names ${name}, which no route walks`);
  assert.deepEqual(pageFindings("files", "desktop", clean({ controlKinds: 9 }), []).failures, []);
  assert.equal(pageFindings("files", "desktop", clean({ controlKinds: 11 }), []).failures.length, 1);
});

test("the walk covers every tab a GEO project has", async () => {
  const tabs = await readFile(path.join(repoRoot, "apps/web/src/components/geo/geoTabs.ts"), "utf8");
  const list = tabs.slice(tabs.indexOf("GEO_TABS"), tabs.indexOf("];", tabs.indexOf("GEO_TABS")));
  const keys = [...list.matchAll(/key: "([a-z]+)"/g)].map((match) => match[1]);
  assert.equal(keys.length, 7, `read the app's GEO tabs (${keys.join(", ")})`);
  assert.deepEqual(GEO_TABS.map(([, segment]) => segment), keys.map((key) => (key === "overview" ? "" : `/${key}`)));
  for (const [name] of GEO_TABS) assert.ok(BUDGET_BY_PAGE[name], `${name} has the GEO budget`);
});

test("a GEO tab may spend the six kinds of border it was measured at, not a seventh", () => {
  assert.deepEqual(pageFindings("geo-overview", "desktop", clean({ borderKinds: 6 }), []).failures, []);
  assert.deepEqual(pageFindings("geo-overview", "desktop", clean({ borderKinds: 7 }), []).failures, ["geo-overview@desktop: 7 kinds of border (budget 6)"]);
  // The knowledge base is a data page but not a GEO page: its borders stay three.
  assert.equal(pageFindings("files", "desktop", clean({ borderKinds: 4 }), []).failures.length, 1);
});

test("more than four font-size × weight pairs is a notice, never a failure", () => {
  const pairs = ["12px/400", "13px/400", "14px/400", "14px/500", "24px/600"];
  const verdict = pageFindings("memory", "desktop", clean({ sizeWeightPairs: pairs }), []);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.notices.length, 1);
  assert.match(verdict.notices[0], new RegExp(`memory@desktop: 5 font-size × weight pairs \\(rule ${TYPE_PAIR_NOTICE}\\)`));
  assert.deepEqual(pageFindings("memory", "desktop", clean({ sizeWeightPairs: pairs.slice(0, 4) }), []).notices, []);
  // Measured at the desktop width only, like the rest of the style budget.
  assert.deepEqual(pageFindings("memory", "phone", clean({ sizeWeightPairs: pairs }), []).notices, []);
});

/**
 * A stand-in for playwright-core: every page load fires the shell's runtime
 * warm-up through the context's routes, and everything the walk did is
 * written to a log the test reads.
 */
const FAKE_PLAYWRIGHT = String.raw`
const fs = require("fs");
const log = (entry) => fs.appendFileSync(process.env.FAKE_PLAYWRIGHT_LOG, JSON.stringify(entry) + "\n");
const json = (status, body) => ({ status: () => status, ok: () => status < 400, json: async () => body });
let loggedIn = false;
function context() {
  const routes = [];
  const fire = async (url) => {
    for (const [pattern, handler] of routes) {
      if (!pattern.test(url)) continue;
      await handler({ abort: async () => log({ start: url, verdict: "aborted" }), continue: async () => log({ start: url, verdict: "allowed" }), fulfill: async () => {} });
    }
  };
  const newPage = async () => {
    let url = "";
    return {
      on() {}, async setViewportSize() {}, async route() {}, async close() {}, async screenshot() {}, async waitForTimeout() {},
      frames: () => [{ url: () => "https://evimed.example.org/__evimed/f/x", evaluate: async () => ({ composer: true, stats: [] }) }],
      async goto(target) { url = target; log({ goto: target }); await fire(new URL("/api/commands/start_runtime", target).href); },
      async evaluate(fn) {
        if (typeof fn === "function" && fn.name === "measure") {
          return { title: "页面 · EviMed", controlKinds: 3, colorKinds: 3, borderKinds: 1, sizeWeightPairs: ["12px/400", "13px/400", "14px/400", "14px/500", "24px/600"],
            pageLefts: [240], rowTitleLefts: [], subtitle: [], backOfficeHits: [], leakHits: [], unnamedControls: [], overflowX: false, smallTargets: 0, decorativeSvgs: 0 };
        }
        return { english: false, sidebar: true, text: "" };
      },
    };
  };
  return {
    async route(pattern, handler) { routes.push([pattern, handler]); },
    newPage,
    request: {
      async post(url) { if (url.endsWith("/api/auth/login")) { loggedIn = true; return json(200, {}); } loggedIn = false; return json(200, {}); },
      async get(url) {
        if (url.endsWith("/api/agents")) return json(200, { data: ["a1", "a2", "a3", "a4", "a5"].map((id) => ({ id: "capability-" + id })) });
        if (url.endsWith("/api/geo/projects")) return json(200, { data: { projects: [{ id: "geo_1" }] } });
        if (url.endsWith("/api/me")) return loggedIn ? json(200, { data: { csrfToken: "t" } }) : json(401, {});
        return json(404, {});
      },
    },
  };
}
module.exports = { chromium: { launch: async () => ({ newContext: async () => context(), close: async () => {} }) } };
`;

async function walk(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-walk-"));
  await mkdir(path.join(dir, "playwright-core"));
  await writeFile(path.join(dir, "playwright-core", "index.js"), FAKE_PLAYWRIGHT);
  await writeFile(path.join(dir, "password"), "not-a-real-password\n");
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(repoRoot, "scripts/ops/ui-walk.mjs")], {
      env: {
        ...process.env,
        OPEN_SCIENCE_WALK_BASE_URL: "https://evimed.example.org",
        OPEN_SCIENCE_WALK_USER: "cdss-access",
        OPEN_SCIENCE_WALK_PASSWORD_FILE: path.join(dir, "password"),
        OPEN_SCIENCE_PLAYWRIGHT_CORE: path.join(dir, "playwright-core"),
        OPEN_SCIENCE_WALK_OUT: path.join(dir, "out"),
        OPEN_SCIENCE_WALK_CHAT: "",
        FAKE_PLAYWRIGHT_LOG: path.join(dir, "log.jsonl"),
        ...env,
      },
      timeout: 60_000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const log = (await readFile(path.join(dir, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const report = JSON.parse(await readFile(path.join(dir, "out", "report.json"), "utf8"));
  await rm(dir, { recursive: true, force: true });
  return { ...result, log, report };
}

test("the walk refuses every runtime start a page makes, and says how many", async () => {
  const { code, stdout, stderr, log, report } = await walk();
  assert.equal(code, 0, stdout + stderr);
  const starts = log.filter((entry) => entry.start);
  assert.ok(starts.length > 30, `the shell's warm-up fired on every page (${starts.length})`);
  assert.deepEqual([...new Set(starts.map((entry) => entry.verdict))], ["aborted"]);
  assert.equal(report.runtimeStartsRefused, starts.length);
  // All seven tabs of the account's first GEO project were walked.
  const visited = log.filter((entry) => entry.goto).map((entry) => new URL(entry.goto).pathname);
  for (const [, segment] of GEO_TABS) assert.ok(visited.includes(`/app/geo/geo_1${segment}`), `walked /app/geo/geo_1${segment}`);
  // The font pairs are a notice: printed, in the report, and the walk passed.
  assert.match(stdout, /NOTICE files@desktop: 5 font-size × weight pairs/);
  assert.ok(report.notices.length > 0);
  assert.deepEqual(report.failures, []);
});

test("the chat page, when asked for, is the one page allowed to start the runtime", async () => {
  const { code, stdout, stderr, log } = await walk({ OPEN_SCIENCE_WALK_CHAT: "1" });
  assert.equal(code, 0, stdout + stderr);
  const chatAt = log.findIndex((entry) => entry.goto?.endsWith("/app/chat"));
  assert.ok(chatAt > 0, "the chat page was opened");
  assert.deepEqual([...new Set(log.slice(0, chatAt).filter((entry) => entry.start).map((entry) => entry.verdict))], ["aborted"]);
  assert.deepEqual(log.slice(chatAt).filter((entry) => entry.start).map((entry) => entry.verdict), ["allowed"]);
});
