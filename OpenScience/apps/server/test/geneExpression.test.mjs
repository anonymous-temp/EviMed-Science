import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http, { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { GENE_EXPRESSION_LIMITS, GENE_EXPRESSION_LIMIT_NAMES } from "@evimed/domain";
import { loadConfig } from "../src/config.mjs";
import { geneExpressionMetricFamilies, resetGeneExpressionMetrics } from "../src/geneExpressionMetrics.mjs";
import { createPublicSourceGatewayHandler, PUBLIC_SOURCE_ALLOWED_HOSTS } from "../src/publicSourceGateway.mjs";

// The NCBI Gene Expression Omnibus workflow's seams on the control plane: the three named downloads and their exact address
// shapes, the two byte limits the gateway enforces and counts, the observation the runtime's tool reports for the four it
// enforces, and the six config keys that reach the runtime. (The public data resource; nothing here touches 循证 GEO.)

const mcpDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../runtime/mcp/evimed-research");

const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (token !== "runtime-token") throw new Error("invalid token");
    return { userId: "alice", projectId: "paper-1" };
  },
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function serve(t, config, options) {
  const failures = [];
  const handler = createPublicSourceGatewayHandler(config, runtimeManager, options);
  const server = createServer((req, res) => handler(req, res, (failure) => { if (failure.code !== "not_found") failures.push(failure); }));
  const base = await listen(server);
  t.after(async () => { server.closeAllConnections?.(); server.close(); await once(server, "close"); });
  return { base, failures };
}

const post = (base, body, token = "runtime-token") => fetch(`${base}/internal/sources/v1/fetch`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});

function rawPost(base, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/internal/sources/v1/fetch`, { method: "POST", headers: { authorization: "Bearer runtime-token", "content-type": "application/json" } }, (response) => {
      const chunks = [];
      let aborted = false;
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("aborted", () => { aborted = true; });
      response.on("error", () => { aborted = true; });
      response.on("close", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), complete: response.complete && !aborted }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

const counts = () => Object.fromEntries(geneExpressionMetricFamilies().flatMap((family) => family.series.map((row) => [`${family.name}{${Object.entries(row.labels).map(([key, value]) => `${key}=${value}`).join(",")}}`, row.value])));

test("the matrix and the two records are downloaded from exactly the addresses GEO's file layout names", async (t) => {
  resetGeneExpressionMetrics();
  const seen = [];
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 2_000, geneExpressionMaxMatrixBytes: 4096, geneExpressionMaxAnnotationBytes: 4096 }, {
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), accept: options.headers.accept, redirect: options.redirect });
      const type = String(url).includes("series_matrix") ? "application/x-gzip" : "geo/text";
      return new Response(Buffer.from("abc"), { status: 200, headers: { "content-type": type, "content-length": "3" } });
    },
  });
  const asked = [
    [{ kind: "ncbi-gene-expression-series-matrix", accession: "GSE5583" }, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE5nnn/GSE5583/matrix/GSE5583_series_matrix.txt.gz"],
    [{ kind: "ncbi-gene-expression-series-matrix", accession: "GSE123" }, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE123/matrix/GSE123_series_matrix.txt.gz"],
    [{ kind: "ncbi-gene-expression-series-matrix", accession: "GSE123456", platform: "GPL96" }, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE123nnn/GSE123456/matrix/GSE123456-GPL96_series_matrix.txt.gz"],
    [{ kind: "ncbi-gene-expression-series-record", accession: "GSE5583" }, "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE5583&targ=self&form=text&view=brief"],
    [{ kind: "ncbi-gene-expression-platform-record", accession: "GPL81" }, "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GPL81&targ=self&form=text&view=full"],
  ];
  for (const [download, url] of asked) {
    const result = await rawPost(base, { download });
    assert.equal(result.status, 200, JSON.stringify(download));
    assert.equal(result.body.toString(), "abc");
    assert.equal(seen.at(-1).url, url);
    assert.equal(seen.at(-1).redirect, "error");
  }
  assert.equal(counts()["open_science_gene_expression_downloads_total{kind=ncbi-gene-expression-series-matrix,outcome=served}"], 3);
  assert.equal(counts()["open_science_gene_expression_downloads_total{kind=ncbi-gene-expression-platform-record,outcome=served}"], 1);
});

test("a download request that is not an accession of the kind it names is refused before any fetch", async (t) => {
  let fetches = 0;
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, { fetchImpl: async () => { fetches += 1; return new Response("x"); } });
  for (const download of [
    { kind: "ncbi-gene-expression-series-matrix", accession: "GSE0" },
    { kind: "ncbi-gene-expression-series-matrix", accession: "gse5583" },
    { kind: "ncbi-gene-expression-series-matrix", accession: "GPL81" },
    { kind: "ncbi-gene-expression-series-matrix", accession: "GSE5583", platform: "GSE5583" },
    { kind: "ncbi-gene-expression-series-matrix", accession: "GSE5583/../../genomes" },
    { kind: "ncbi-gene-expression-series-matrix", accession: "GSE5583", url: "https://ftp.ncbi.nlm.nih.gov/genomes/" },
    { kind: "ncbi-gene-expression-series-record", accession: "GPL81" },
    { kind: "ncbi-gene-expression-series-record", accession: "GSE5583", view: "full" },
    { kind: "ncbi-gene-expression-platform-record", accession: "GSE5583" },
    { kind: "ncbi-gene-expression-platform-record" },
  ]) {
    const response = await post(base, { download });
    assert.equal(response.status, 400, JSON.stringify(download));
    assert.equal((await response.json()).error.code, "public_source_gateway_field_invalid");
  }
  assert.equal(fetches, 0);
});

test("the NCBI download host is reachable by a named download and by nothing else", async (t) => {
  assert.ok(PUBLIC_SOURCE_ALLOWED_HOSTS.has("ftp.ncbi.nlm.nih.gov"));
  let fetches = 0;
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, { fetchImpl: async () => { fetches += 1; return new Response("x"); } });
  for (const url of [
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE5nnn/GSE5583/matrix/GSE5583_series_matrix.txt.gz",
    "https://ftp.ncbi.nlm.nih.gov/genomes/refseq/",
    "https://ftp.ncbi.nlm.nih.gov/",
  ]) {
    const response = await post(base, { url, accept: ["application/gzip"] });
    assert.equal(response.status, 403, url);
    assert.equal((await response.json()).error.code, "public_source_api_path_forbidden");
  }
  // www.ncbi.nlm.nih.gov stays PubTator3 only for a buffered fetch: acc.cgi is reached through its download kinds, not by address.
  const acc = await post(base, { url: "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GPL81&targ=self&form=text&view=full", accept: ["text/plain"] });
  assert.equal(acc.status, 403);
  assert.equal((await acc.json()).error.code, "public_source_api_path_forbidden");
  assert.equal(fetches, 0);
});

test("the matrix and annotation byte limits are their own config keys, cut on the wire and counted", async (t) => {
  resetGeneExpressionMetrics();
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 2_000, geneExpressionMaxMatrixBytes: 2048, geneExpressionMaxAnnotationBytes: 8192, publicSourceGatewayMaxResponseBytes: 1_000_000 }, {
    fetchImpl: async (url) => new Response(Buffer.alloc(String(url).includes("series_matrix") ? 4096 : 4096, 7), {
      status: 200, headers: { "content-type": String(url).includes("series_matrix") ? "application/x-gzip" : "geo/text", "content-length": "4096" },
    }),
  });
  const matrix = await post(base, { download: { kind: "ncbi-gene-expression-series-matrix", accession: "GSE5583" } });
  assert.equal(matrix.status, 502);
  assert.equal((await matrix.json()).error.code, "public_source_gateway_response_too_large");
  // The platform record has its own, larger key: the same 4096 bytes are within it.
  const platform = await rawPost(base, { download: { kind: "ncbi-gene-expression-platform-record", accession: "GPL81" } });
  assert.equal(platform.status, 200);
  assert.equal(platform.body.length, 4096);
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=matrix_bytes,action=refused}"], 1);
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=annotation_bytes,action=refused}"], 0);
  assert.equal(counts()["open_science_gene_expression_downloads_total{kind=ncbi-gene-expression-series-matrix,outcome=over_limit}"], 1);
});

test("a streamed record with no declared length is cut at the annotation limit and counted as that", async (t) => {
  resetGeneExpressionMetrics();
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 2_000, geneExpressionMaxAnnotationBytes: 4096 }, {
    fetchImpl: async () => {
      let sent = 0;
      return new Response(new ReadableStream({ pull(controller) { if (sent >= 4) { controller.close(); return; } sent += 1; controller.enqueue(Buffer.alloc(3000, 1)); } }), { status: 200, headers: { "content-type": "geo/text" } });
    },
  });
  const result = await rawPost(base, { download: { kind: "ncbi-gene-expression-platform-record", accession: "GPL570" } });
  assert.equal(result.complete, false, "a body past the limit ends without its terminator");
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=annotation_bytes,action=refused}"], 1);
});

test("the runtime reports a limit it refused on, and the report only moves a counter", async (t) => {
  resetGeneExpressionMetrics();
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, { fetchImpl: async () => { throw new Error("no fetch for an observation"); } });
  for (const limit of ["samples", "probes", "memory", "wall_clock"]) {
    const response = await post(base, { geneExpressionLimit: { limit, action: "refused" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=samples,action=refused}"], 1);
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=wall_clock,action=refused}"], 1);
  for (const body of [
    { geneExpressionLimit: { limit: "disk", action: "refused" } },
    { geneExpressionLimit: { limit: "samples", action: "allowed" } },
    { geneExpressionLimit: { limit: "samples", action: "refused", extra: 1 } },
    { geneExpressionLimit: { limit: "samples", action: "refused" }, url: "https://api.fda.gov/" },
    { geneExpressionLimit: "samples" },
  ]) assert.equal((await post(base, body)).status, 400, JSON.stringify(body));
  assert.equal((await post(base, { geneExpressionLimit: { limit: "samples", action: "refused" } }, "not-the-token")).status, 401, "an observation is as authenticated as any gateway call");
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=samples,action=refused}"], 1);
});

test("every limit has a counter from the start, so the first refusal is an increase", () => {
  resetGeneExpressionMetrics();
  const limits = geneExpressionMetricFamilies().find((family) => family.name === "open_science_gene_expression_limits_total");
  assert.equal(limits.type, "counter");
  assert.deepEqual(limits.series.map((row) => row.labels.limit).sort(), [...GENE_EXPRESSION_LIMIT_NAMES].sort());
  assert.ok(limits.series.every((row) => row.value === 0));
});

test("the six limits are config keys with the domain's defaults and bounds, and a value out of bounds is refused by name", () => {
  const config = loadConfig({});
  for (const spec of Object.values(GENE_EXPRESSION_LIMITS)) {
    assert.equal(config[spec.configKey], spec.default, spec.configKey);
    assert.throws(() => loadConfig({ [spec.configKey]: spec.max + 1 }), new RegExp(`OPEN_SCIENCE_${spec.env}`));
    assert.throws(() => loadConfig({ [spec.configKey]: spec.min - 1 }), new RegExp(`OPEN_SCIENCE_${spec.env}`));
    assert.equal(loadConfig({ [spec.configKey]: spec.min })[spec.configKey], spec.min);
  }
  const previous = process.env.OPEN_SCIENCE_GENE_EXPRESSION_MAX_SAMPLES;
  process.env.OPEN_SCIENCE_GENE_EXPRESSION_MAX_SAMPLES = "50";
  try { assert.equal(loadConfig({}).geneExpressionMaxSamples, 50); } finally {
    if (previous === undefined) delete process.env.OPEN_SCIENCE_GENE_EXPRESSION_MAX_SAMPLES; else process.env.OPEN_SCIENCE_GENE_EXPRESSION_MAX_SAMPLES = previous;
  }
});

test("the runtime's own defaults and variable names are the control plane's", () => {
  const python = JSON.parse(execFileSync("python3", ["-c", [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(mcpDirectory)})`,
    "import gene_expression as e",
    "print(json.dumps({'defaults': e.LIMIT_DEFAULTS, 'env': e.LIMIT_ENV, 'units': e.LIMIT_UNITS}))",
  ].join("\n")], { encoding: "utf8" }));
  for (const spec of Object.values(GENE_EXPRESSION_LIMITS)) {
    assert.equal(python.defaults[spec.limit], spec.default, spec.limit);
    assert.equal(python.env[spec.limit], `EVIMED_${spec.env}`, spec.limit);
    assert.equal(python.units[spec.limit], spec.unit, spec.limit);
  }
  assert.deepEqual(Object.keys(python.defaults).sort(), [...GENE_EXPRESSION_LIMIT_NAMES].sort());
});

// ---------------------------------------------------------------- the runtime's tools through this gateway

const run = promisify(execFile);
const fixtures = path.join(mcpDirectory, "test", "fixtures", "gene_expression");
const matrixFixture = fs.readFileSync(path.join(fixtures, "GSE5583_series_matrix.txt.gz"));
const platformFixture = zlib.gunzipSync(fs.readFileSync(path.join(fixtures, "GPL81_reduced.txt.gz")));

/** GEO as the gateway's fetch sees it: the recorded matrix (with its length) and the platform record (streamed, no length). */
const geo = (seen) => async (url) => {
  seen.push(String(url));
  if (String(url).includes("series_matrix")) return new Response(matrixFixture, { status: 200, headers: { "content-type": "application/x-gzip", "content-length": String(matrixFixture.length) } });
  if (String(url).includes("view=full")) {
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) { if (sent) { controller.close(); return; } sent = true; controller.enqueue(platformFixture); } }), { status: 200, headers: { "content-type": "geo/text" } });
  }
  return new Response("not asked for", { status: 404 });
};

/** Runs the two tools in a child Python exactly as the MCP server calls them, with the gateway as its only way out. */
async function runTools(t, gatewayBase, environment = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gene-expression-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "workspace"));
  fs.writeFileSync(path.join(directory, "token"), "runtime-token\n", { mode: 0o600 });
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(mcpDirectory)})`,
    "import gene_expression_tools as tools",
    "first = tools.call('gene_expression_series', {'accession': 'GSE5583'})",
    "second = None",
    "if first.get('status') in ('success', 'warning'):",
    "    groups = [{'label': 'wild type', 'samples': ['GSM130365', 'GSM130366', 'GSM130367']}, {'label': 'knock out', 'samples': ['GSM130368', 'GSM130369', 'GSM130370']}]",
    "    second = tools.call('gene_expression_differential', {'captureDir': first['data']['captureDir'], 'outputDir': 'deliverables/hdac1', 'groups': groups, 'topN': 5})",
    "print(json.dumps({'series': first, 'differential': second}))",
  ].join("\n");
  const { stdout } = await run("python3", ["-c", script], {
    cwd: directory, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? directory, TMPDIR: directory, OPEN_SCIENCE_WORKSPACE_DIR: path.join(directory, "workspace"),
      EVIMED_PUBLIC_SOURCE_GATEWAY_URL: `${gatewayBase}/internal/sources/v1/fetch`, EVIMED_MODEL_GATEWAY_TOKEN_FILE: path.join(directory, "token"), ...environment },
  });
  return { ...JSON.parse(stdout), workspace: path.join(directory, "workspace") };
}

test("the runtime's two tools work through the gateway: the kinds, their parameters and their content types agree", async (t) => {
  resetGeneExpressionMetrics();
  const seen = [];
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 20_000, publicSourceDownloadTimeoutMs: 60_000, geneExpressionMaxMatrixBytes: 64 * 1024 * 1024, geneExpressionMaxAnnotationBytes: 128 * 1024 * 1024 }, { fetchImpl: geo(seen) });
  const result = await runTools(t, base);
  assert.equal(result.series.status === "error", false, JSON.stringify(result.series).slice(0, 400));
  assert.deepEqual(seen, [
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE5nnn/GSE5583/matrix/GSE5583_series_matrix.txt.gz",
    "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GPL81&targ=self&form=text&view=full",
  ]);
  assert.equal(result.series.data.computationReady, true);
  assert.equal(result.series.data.matrix.sha256, "bca34f9908a6f5ad4ef5b1b3fa5e0f017704dcfbd2bffea80d76abf42001e220", "the hash is of the bytes the gateway relayed, which are GEO's");
  assert.equal(result.differential.status === "error", false, JSON.stringify(result.differential).slice(0, 400));
  const results = JSON.parse(fs.readFileSync(path.join(result.workspace, result.differential.data.resultsPath), "utf8"));
  assert.equal(results.top[0].probe, "101451_at", "the top probe is the one base R finds");
  assert.deepEqual(results.top[0].geneSymbols.length, 1);
  assert.equal(counts()["open_science_gene_expression_downloads_total{kind=ncbi-gene-expression-series-matrix,outcome=served}"], 1);
  assert.equal(counts()["open_science_gene_expression_downloads_total{kind=ncbi-gene-expression-platform-record,outcome=served}"], 1);
});

test("a byte limit the gateway enforces is refused for that computation, and counted once", async (t) => {
  resetGeneExpressionMetrics();
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 20_000, publicSourceDownloadTimeoutMs: 60_000, geneExpressionMaxMatrixBytes: 100_000 }, { fetchImpl: geo([]) });
  const result = await runTools(t, base);
  assert.equal(result.series.error.code, "gene_expression_input_over_limit");
  assert.equal(result.series.data.limit, "matrix_bytes");
  assert.equal(result.differential, null, "nothing was computed");
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=matrix_bytes,action=refused}"], 1, "the gateway counted it and the runtime did not count it again");
});

test("a limit only the runtime can see is reported to the gateway's counter, and a refused series leaves nothing preserved", async (t) => {
  resetGeneExpressionMetrics();
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 20_000, publicSourceDownloadTimeoutMs: 60_000 }, { fetchImpl: geo([]) });
  const result = await runTools(t, base, { EVIMED_GENE_EXPRESSION_MAX_SAMPLES: "5" });
  assert.equal(result.series.error.code, "gene_expression_input_over_limit");
  assert.deepEqual([result.series.data.limit, result.series.data.observed, result.series.data.allowed], ["samples", 6, 5]);
  assert.equal(counts()["open_science_gene_expression_limits_total{limit=samples,action=refused}"], 1);
  assert.equal(fs.existsSync(path.join(result.workspace, ".evimed-sources")), false);
});
