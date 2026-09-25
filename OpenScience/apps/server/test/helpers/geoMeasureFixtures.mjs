// Fakes for the measurement package's integration tests: a probe host that
// speaks the upstream contract over real HTTP (GET /providers, POST /ask,
// GET /screenshots/<name>), a model that answers the judge from a script, and
// the rows of a GEO project seeded straight into the evimed_geo tables.
import http from "node:http";

/** A tiny PNG: the signature and a tail, which is all the store checks. */
export const FAKE_PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("fake-screenshot")]);

/**
 * @typedef {{ status?: number, answer?: string, rawStatus?: string, searchResults?: any[], screenshot?: string | null, delayMs?: number, error?: string }} FakeReply
 */

/**
 * Start a fake probe host on 127.0.0.1.
 * @param {{ ask: (request: { question: string, engine: string, nth: number }) => FakeReply, providers?: () => Record<string, string> }} script
 *   `nth` counts the asks of that question on that engine, from 1.
 */
export async function startFakeProbe(script) {
  /** @type {Array<{ question: string, engine: string, body: any }>} */
  const asks = [];
  const providerCalls = { count: 0 };
  const screenshotCalls = { count: 0 };
  /** @type {Map<string, number>} */
  const perPair = new Map();
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (/** @type {number} */ status, /** @type {unknown} */ payload) => {
      const body = Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
    };
    if (req.method === "GET" && url.pathname === "/providers") {
      providerCalls.count += 1;
      send(200, { providers: script.providers ? script.providers() : { deepseek: "tab_found", doubao: "tab_found" } });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/screenshots/")) {
      screenshotCalls.count += 1;
      res.writeHead(200, { "content-type": "image/png", "content-length": String(FAKE_PNG.length) });
      res.end(FAKE_PNG);
      return;
    }
    if (req.method === "POST" && url.pathname === "/ask") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const engine = String(body.providers?.[0] ?? body.provider);
      const key = `${body.question}\u0000${engine}`;
      const nth = (perPair.get(key) ?? 0) + 1;
      perPair.set(key, nth);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      asks.push({ question: body.question, engine, body });
      const reply = script.ask({ question: body.question, engine, nth });
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      inFlight -= 1;
      if (reply.status && reply.status !== 200) {
        send(reply.status, { error: "busy" });
        return;
      }
      send(200, { results: [{
        provider: engine,
        status: reply.rawStatus ?? "ok",
        answer: reply.answer ?? "",
        search_results: reply.searchResults ?? [],
        screenshot_url: reply.screenshot === null ? "" : `http://127.0.0.1/screenshots/${reply.screenshot ?? "shot-1.png"}`,
        latency_ms: 1200,
        ...(reply.error ? { error: reply.error } : {}),
      }] });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}/`,
    asks,
    providerCalls,
    screenshotCalls,
    get maxInFlight() { return maxInFlight; },
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/** The project block and the answer the judge was sent. @param {any} call */
export function judgeCallParts(call) {
  const content = String(call.body.messages[1].content);
  const [prefix, item] = content.split("\n\n【问题与回答】\n");
  const project = JSON.parse(prefix.replace("【项目】\n", ""));
  return { project, item: JSON.parse(item) };
}

/**
 * A `callModel` double: answers the judge with `judge({ answer, question, claimAlias })`
 * and records every call. `claimAlias(key-text)` finds a claim's C-number by
 * a fragment of its quote.
 * @param {(input: { answer: string, question: string, claimAlias: (fragment: string) => string | null }) => Record<string, unknown>} judge
 */
export function fakeModel(judge) {
  /** @type {any[]} */
  const calls = [];
  /** @param {any} _deps @param {any} call */
  const callModel = async (_deps, call) => {
    calls.push(call);
    const { project, item } = judgeCallParts(call);
    const claimAlias = (/** @type {string} */ fragment) => project.claims.find((/** @type {any} */ claim) => claim.quote.includes(fragment))?.id ?? null;
    const answer = judge({ answer: item.answer, question: item.question, claimAlias });
    return { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { completion_tokens: 10 } };
  };
  return { callModel, calls };
}

export const GEO_TABLES_FOR_TESTS = ["metrics", "errors", "facts", "snapshots", "probe_jobs", "rounds", "questions", "question_groups", "question_sets",
  "claims", "journeys", "sources", "articles", "orders", "projects"];

/**
 * Seed one GEO project with its questions, claims, owned sources and journey.
 * @param {{ query: Function }} db
 * @param {{ id: string, userId: string, projectId: string, engines: string[], product?: any, competitors?: any[],
 *   groups: Array<{ id: string, pool: string, isControl?: boolean, weight?: number, journeyStage?: string }>,
 *   questions: Array<{ id: string, groupId: string, text: string }>,
 *   claims?: Array<{ key: string, statement: string, quote: string }>, ownedDomains?: string[], careNodes?: any[] }} seed
 */
export async function seedGeoProject(db, seed) {
  await db.query(`INSERT INTO evimed_geo.projects (id, user_id, project_id, product, competitors, engines) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[])`,
    [seed.id, seed.userId, seed.projectId, JSON.stringify(seed.product ?? { brandName: "玛仕度肽", aliases: ["信尔美"], genericName: "玛仕度肽注射液" }),
      JSON.stringify(seed.competitors ?? [{ brandName: "诺和泰", genericName: "司美格鲁肽" }]), seed.engines]);
  await db.query(`INSERT INTO evimed_geo.question_sets (geo_project_id, version, user_id, locked_at, measured_count) VALUES ($1, 1, $2, now(), $3)`,
    [seed.id, seed.userId, seed.questions.length]);
  for (const group of seed.groups) {
    await db.query(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, set_version, pool, name, journey_stage, weight, is_control)
      VALUES ($1, $2, $3, 1, $4, $1, $5, $6, $7)`, [group.id, seed.userId, seed.id, group.pool, group.journeyStage ?? null, group.weight ?? 1, Boolean(group.isControl)]);
  }
  for (const question of seed.questions) {
    const group = seed.groups.find((entry) => entry.id === question.groupId);
    await db.query(`INSERT INTO evimed_geo.questions (id, user_id, geo_project_id, group_id, set_version, text, kind, pool, is_measured)
      VALUES ($1, $2, $3, $4, 1, $5, 'typical', $6, true)`, [question.id, seed.userId, seed.id, question.groupId, question.text, group?.pool ?? null]);
  }
  for (const [index, claim] of (seed.claims ?? []).entries()) {
    await db.query(`INSERT INTO evimed_geo.claims (id, user_id, geo_project_id, claim_key, statement, quote, source_ref, source_kind, in_label)
      VALUES ($1, $2, $3, $4, $5, $6, 'label:2026', 'label', true)`, [`${seed.id}_claim_${index}`, seed.userId, seed.id, claim.key, claim.statement, claim.quote]);
  }
  for (const domain of seed.ownedDomains ?? []) {
    await db.query(`INSERT INTO evimed_geo.sources (id, user_id, geo_project_id, domain, name, layer) VALUES ($1, $2, $3, $4, $4, 'owned')`,
      [`${seed.id}_src_${domain}`, seed.userId, seed.id, domain]);
  }
  if (seed.careNodes) {
    await db.query(`INSERT INTO evimed_geo.journeys (geo_project_id, version, user_id, data) VALUES ($1, 1, $2, $3::jsonb)`,
      [seed.id, seed.userId, JSON.stringify({ careNodes: seed.careNodes })]);
  }
}

/** A mutable clock for a test: `now()` reads it, `advance(ms)` moves it. @param {string} iso */
export function testClock(iso) {
  let at = new Date(iso).getTime();
  return {
    now: () => new Date(at),
    advance: (/** @type {number} */ ms) => { at += ms; },
    set: (/** @type {string} */ value) => { at = new Date(value).getTime(); },
  };
}
