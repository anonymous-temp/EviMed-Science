// `/internal/geo/v1` against doubles over real HTTP: the runtime's token is
// the only credential and names the project, the module off or closed to the
// account reads `geo_disabled`, a conversation outside a GEO project reads
// `geo_no_project`, calls are bounded and validated by closed vocabularies,
// and a failure underneath reaches the run only as `geo_gateway_unavailable`.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { GEO_GATEWAY_PATH, GEO_GATEWAY_WINDOW_LIMITS, createGeoGatewayHandler, geoGatewayProviderUrl, geoGatewayRoutePattern } from "../src/geoGateway.mjs";
import { GEO_READ_MAX_ITEMS, geoAudienceAllows } from "../src/geoService.mjs";
import { HttpError } from "../src/security.mjs";

const TOKENS = { "token-alice": { userId: "alice", projectId: "p-geo" }, "token-plain": { userId: "alice", projectId: "p-plain" },
  "token-bob": { userId: "bob", projectId: "p-bob" } };
const runtimeManager = {
  assertActiveModelGatewayToken(/** @type {string} */ token) {
    const identity = /** @type {Record<string, any>} */ (TOKENS)[token];
    if (!identity) throw new Error("inactive");
    return identity;
  },
};

/** A geo module double whose store answers only alice's GEO project, and whose read enforces the real bound. */
function geoDouble(config, { failRead = null, social = null } = {}) {
  const calls = /** @type {any[]} */ ([]);
  const project = { id: "geo_1", userId: "alice", projectId: "p-geo", product: {}, engines: ["deepseek"] };
  return {
    calls,
    geo: {
      store: {
        async projectByControlProject(/** @type {string} */ userId, /** @type {string} */ projectId) {
          return userId === project.userId && projectId === project.projectId ? project : null;
        },
        async setStep(/** @type {string} */ id, /** @type {string} */ step, /** @type {any} */ fields) {
          calls.push(["setStep", id, step, fields.status]);
          return { ...project, steps: { [step]: fields } };
        },
      },
      service: {
        counters: { writes: 0, writeIssues: 0 },
        allows: (/** @type {any} */ user) => geoAudienceAllows(config, user),
        async runtimeRead(/** @type {any} */ target, /** @type {string} */ what, /** @type {any} */ filter) {
          if (failRead) throw failRead;
          if ((filter.limit ?? 20) > GEO_READ_MAX_ITEMS) throw new Error("a double must refuse what the real store refuses");
          calls.push(["read", target.id, what, filter]);
          return { items: [], more: false };
        },
      },
      social,
    },
  };
}

/** @param {any} handler */
async function serve(t, handler) {
  const server = http.createServer((req, res) => { void handler(req, res, (/** @type {any} */ failure) => failures.push(failure)); });
  const failures = /** @type {any[]} */ ([]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  /** @param {string} operation @param {unknown} body @param {string | null} [token] */
  const post = async (operation, body, token = "token-alice", method = "POST") => {
    const response = await fetch(`${base}${GEO_GATEWAY_PATH}/${operation}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { post, failures };
}

const on = { geoEnabled: true, geoAudience: "all", operatorUsers: [], geoPreviewUsers: [], geoSocialTimeoutMs: 2_000 };

test("the gateway address is the model gateway's server, and only when the module is on", () => {
  assert.equal(geoGatewayProviderUrl({ geoEnabled: true, modelGatewayInternalUrl: "http://open-science-web:8787/internal/model/v1" }),
    "http://open-science-web:8787/internal/geo/v1");
  assert.equal(geoGatewayProviderUrl({ geoEnabled: false, modelGatewayInternalUrl: "http://open-science-web:8787/internal/model/v1" }), "");
  assert.equal(geoGatewayProviderUrl({ geoEnabled: true, modelGatewayInternalUrl: "http://user:fake@host/internal/model/v1" }), "");
  assert.equal(geoGatewayRoutePattern("/internal/geo/v1/read"), "/internal/geo/v1/read");
  assert.equal(geoGatewayRoutePattern("/internal/geo/v1/anything-else"), "/internal/geo/v1/:operation", "a label is bounded");
});

test("the runtime's own token is the only way in, and it names the project", async (t) => {
  const { geo, calls } = geoDouble(on);
  const { post, failures } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo }));
  assert.deepEqual((await post("read", { what: "claims" }, null)).body.code, "geo_gateway_token_missing");
  assert.deepEqual((await post("read", { what: "claims" }, "token-stolen")).body.code, "geo_gateway_token_invalid");
  const plain = await post("read", { what: "claims" }, "token-plain");
  assert.deepEqual([plain.status, plain.body.code], [404, "geo_no_project"], "a conversation outside a GEO project");
  const read = await post("read", { what: "claims", filter: { engine: "deepseek", limit: 50 } });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, { what: "claims", items: [], more: false });
  assert.deepEqual(calls, [["read", "geo_1", "claims", { engine: "deepseek", limit: 50 }]]);
  assert.equal((await post("nothing", {})).status, 404);
  assert.equal((await post("read", null, "token-alice", "GET")).status, 404, "POST only");
  assert.ok(failures.some((failure) => failure.code === "geo_no_project"), "failures reach the platform's ledger");
});

test("off, or not open to the account, every operation says geo_disabled", async (t) => {
  const off = { ...on, geoEnabled: false };
  const { post } = await serve(t, createGeoGatewayHandler(off, runtimeManager, { geo: geoDouble(off).geo }));
  for (const operation of ["read", "write", "social"]) {
    const answer = await post(operation, {});
    assert.deepEqual([answer.status, answer.body.code], [503, "geo_disabled"], operation);
  }
  const { post: nothing } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo: null }));
  assert.equal((await nothing("read", { what: "claims" })).body.code, "geo_disabled", "not composed");
  const operators = { ...on, geoAudience: "operators", operatorUsers: ["bob"] };
  const { post: narrow } = await serve(t, createGeoGatewayHandler(operators, runtimeManager, { geo: geoDouble(operators).geo }));
  assert.equal((await narrow("read", { what: "claims" })).body.code, "geo_disabled", "alice is not an operator");
});

test("reads and writes are refused whole only when the call itself cannot be read", async (t) => {
  const { geo, calls } = geoDouble(on);
  const { post } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo }));
  const refused = async (/** @type {string} */ operation, /** @type {unknown} */ body, /** @type {string} */ code, status = 400) => {
    const answer = await post(operation, body);
    assert.deepEqual([answer.status, answer.body.code], [status, code], JSON.stringify(body));
  };
  await refused("read", { what: "passwords" }, "geo_read_what_invalid");
  await refused("read", { what: "claims", extra: 1 }, "geo_request_invalid");
  await refused("read", { what: "claims", filter: { engine: "bing" } }, "geo_read_filter_invalid");
  await refused("read", { what: "claims", filter: { pool: "P9" } }, "geo_read_filter_invalid");
  await refused("read", { what: "claims", filter: { limit: GEO_READ_MAX_ITEMS + 1 } }, "geo_read_filter_invalid");
  await refused("read", { what: "claims", filter: { round: "../../etc" } }, "geo_read_filter_invalid");
  await refused("read", { what: "claims", filter: { sql: "1" } }, "geo_read_filter_invalid");
  await refused("write", { what: "passwords" }, "geo_write_what_invalid");
  await refused("write", { what: "claims", items: [{}], data: {} }, "geo_write_payload_invalid");
  await refused("write", { what: "claims", data: {} }, "geo_write_payload_invalid");
  const huge = await post("write", { what: "claims", items: [{ claimKey: "x".repeat(400 * 1024) }] });
  assert.deepEqual([huge.status, huge.body.code], [413, "geo_request_too_large"]);
  // A write whose one item is wrong is a 200 that wrote nothing and says why.
  const step = await post("write", { what: "step", data: { step: "diagnosis", status: "done" } });
  assert.equal(step.status, 200);
  assert.equal(step.body.data.ok, false);
  assert.equal(step.body.data.issues[0].code, "refused");
  const good = await post("write", { what: "step", data: { step: "evidence", status: "running" } });
  assert.deepEqual([good.status, good.body.data.ok], [200, true]);
  assert.deepEqual(calls.filter((call) => call[0] === "setStep"), [["setStep", "geo_1", "evidence", "running"]]);
  assert.equal(geo.service.counters.writes, 2);
});

test("a round the project does not have is the filter being wrong; a failure underneath is only 'unavailable'", async (t) => {
  const reports = /** @type {string[]} */ ([]);
  const notFound = geoDouble(on, { failRead: new HttpError(404, "geo_round_not_found", "Round not found.") });
  const { post } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo: notFound.geo }));
  const answer = await post("read", { what: "diagnosis", filter: { round: "r-nope" } });
  assert.deepEqual([answer.status, answer.body.code], [400, "geo_read_filter_invalid"], "a route code never reaches a run");
  const broken = geoDouble(on, { failRead: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }) });
  const { post: down } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo: broken.geo, report: (code) => reports.push(code) }));
  const failed = await down("read", { what: "claims" });
  assert.deepEqual([failed.status, failed.body.code], [503, "geo_gateway_unavailable"]);
  assert.equal(JSON.stringify(failed.body).includes("10.0.0.5"), false, "an internal address never reaches the run");
  assert.deepEqual(reports, ["ECONNREFUSED"]);
});

test("each project has a per-minute ceiling per operation", async (t) => {
  const { geo } = geoDouble(on);
  const { post } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo }));
  for (let index = 0; index < GEO_GATEWAY_WINDOW_LIMITS.write; index += 1) {
    assert.equal((await post("write", { what: "step", data: { step: "journey", status: "running" } })).status, 200);
  }
  const limited = await post("write", { what: "step", data: { step: "journey", status: "running" } });
  assert.deepEqual([limited.status, limited.body.code], [429, "geo_gateway_rate_limited"]);
  assert.equal((await post("read", { what: "claims" })).status, 200, "reads have their own ceiling");
});

test("the social search needs a channel, validates its words, and answers within the channel's own time", async (t) => {
  const { geo: withoutChannel } = geoDouble(on);
  const { post: unconfigured } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo: withoutChannel }));
  const refused = await unconfigured("social", { query: "降糖药", platforms: ["xhs"] });
  assert.deepEqual([refused.status, refused.body.code], [503, "social_posts_unconfigured"]);

  const searched = /** @type {any[]} */ ([]);
  const social = {
    configured: true,
    async search(/** @type {any} */ request) {
      searched.push(request);
      return { status: "collected", platforms: [{ platform: "xhs", status: "collected", posts: 1 }], posts: [{ platform: "xhs", url: "https://x", postId: "1" }] };
    },
  };
  const { geo } = geoDouble(on, { social });
  const { post } = await serve(t, createGeoGatewayHandler(on, runtimeManager, { geo }));
  const answer = await post("social", { query: "  二甲双胍   饭前 ", platforms: ["xhs"], sort: "latest", limit: 5 });
  assert.equal(answer.status, 200);
  assert.deepEqual(searched, [{ query: "二甲双胍 饭前", platforms: ["xhs"], sort: "latest", limit: 5 }]);
  assert.equal(answer.body.data.status, "collected");
  // It reads no project data, so any conversation of an account the module is open to may ask.
  assert.equal((await post("social", { query: "降糖药", platforms: ["zhihu"] }, "token-plain")).status, 200);
  for (const [body, code] of [
    [{ query: "" }, "social_posts_query_invalid"], [{ query: "x".repeat(101) }, "social_posts_query_invalid"],
    [{ query: "q", platforms: ["tiktok"] }, "social_posts_platform_invalid"], [{ query: "q", platforms: ["xhs", "zhihu"] }, "social_posts_platform_invalid"],
    [{ query: "q" }, "social_posts_platform_invalid"],
    [{ query: "q", platforms: ["xhs"], sort: "random" }, "social_posts_sort_invalid"], [{ query: "q", platforms: ["xhs"], limit: 51 }, "social_posts_limit_invalid"],
  ]) {
    const bad = await post("social", body);
    assert.deepEqual([bad.status, bad.body.code], [400, code], JSON.stringify(body));
  }
  // A channel that hangs is cut at its own timeout plus the gateway's margin.
  const hanging = geoDouble(on, { social: { configured: true, search: () => new Promise(() => {}) } });
  const { post: slow } = await serve(t, createGeoGatewayHandler({ ...on, geoSocialTimeoutMs: 100 }, runtimeManager, { geo: hanging.geo, budgetMs: 200 }));
  const timedOut = await slow("social", { query: "q", platforms: ["xhs"] });
  assert.deepEqual([timedOut.status, timedOut.body.code], [504, "geo_gateway_timeout"]);
});
