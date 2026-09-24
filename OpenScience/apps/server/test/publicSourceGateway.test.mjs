import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicSourceGatewayHandler,
  PUBLIC_SOURCE_ALLOWED_ACCEPT_TYPES,
  PUBLIC_SOURCE_ALLOWED_HOSTS,
  PUBLIC_SOURCE_CREDENTIAL_PROFILES,
} from "../src/publicSourceGateway.mjs";

const connectorSources = ["public_sources.py", "science_connectors.py"].map((name) => {
  const file = path.resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../runtime/mcp/evimed-research",
    name,
  );
  return { name, text: fs.readFileSync(file, "utf8") };
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function runtimeManager() {
  return {
    assertActiveModelGatewayToken(token) {
      if (token !== "runtime-token") throw new Error("invalid token");
      return { userId: "alice", projectId: "paper-1" };
    },
  };
}

async function gatewayRequest(base, body, token = "runtime-token") {
  return fetch(`${base}/internal/sources/v1/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("open-access PDF requests carry only a DOI and the server picks the host", async (t) => {
  // The runtime must not be able to name a destination: open-access PDFs live
  // on the publisher's own domain, so no host allowlist can cover them and the
  // resolution has to happen here.
  const seen = [];
  const server = createServer(createPublicSourceGatewayHandler(
    { publicSourceCredentials: { unpaywall: "contact@example.test" } },
    runtimeManager(),
    {
      fetchImpl: async (url) => {
        seen.push(String(url));
        if (String(url).startsWith("https://api.unpaywall.org/")) {
          return Response.json({
            best_oa_location: { url_for_pdf: "http://publisher.example/a.pdf", host_type: "publisher" },
            oa_locations: [
              { url_for_pdf: "https://blocked.example/a.pdf", host_type: "repository" },
              { url_for_pdf: "https://repo.example/a.pdf", host_type: "repository", version: "publishedVersion", license: "cc-by" },
            ],
          });
        }
        if (String(url).startsWith("https://blocked.example/")) return new Response("denied", { status: 403 });
        return new Response(Buffer.from("%PDF-1.7 body"), { status: 200, headers: { "content-type": "application/pdf" } });
      },
      resolveImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    },
  ));
  t.after(() => close(server));
  const base = await listen(server);

  const response = await gatewayRequest(base, { openAccessPdfDoi: "10.1016/j.jclinepi.2021.03.001" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(decodeURIComponent(response.headers.get("x-evimed-oa-source")), "https://repo.example");
  assert.equal(decodeURIComponent(response.headers.get("x-evimed-oa-license")), "cc-by");
  // http was skipped, the refusing host was tried and abandoned, the next one served it.
  assert.ok(!seen.some((url) => url.startsWith("http://")), "a plain-http location must never be fetched");
  assert.ok(seen.some((url) => url.startsWith("https://blocked.example/")), "a refusing host must not end the search");
  assert.ok(seen.some((url) => url.startsWith("https://repo.example/")));
});

test("an open-access PDF request cannot be used to reach a private address", async (t) => {
  let resolved = 0;
  const server = createServer(createPublicSourceGatewayHandler(
    { publicSourceCredentials: { unpaywall: "contact@example.test" } },
    runtimeManager(),
    {
      fetchImpl: async (url) => {
        if (String(url).startsWith("https://api.unpaywall.org/")) {
          return Response.json({
            best_oa_location: { url_for_pdf: "https://127.0.0.1/internal.pdf", host_type: "repository" },
            oa_locations: [{ url_for_pdf: "https://169.254.169.254/latest/meta-data", host_type: "repository" }],
          });
        }
        throw new Error("a private address must never be fetched");
      },
      // Never consulted: a literal private address is refused by name, before
      // anything is resolved.
      resolveImpl: async () => { resolved += 1; return [{ address: "93.184.216.34", family: 4 }]; },
    },
  ));
  t.after(() => close(server));
  const base = await listen(server);

  const response = await gatewayRequest(base, { openAccessPdfDoi: "10.1234/private" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "public_source_pdf_not_open_access");
  assert.equal(resolved, 0);
});

test("an open-access PDF request rejects anything other than a DOI", async (t) => {
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async () => { throw new Error("must not reach upstream"); },
  }));
  t.after(() => close(server));
  const base = await listen(server);

  for (const body of [
    { openAccessPdfDoi: "not-a-doi" },
    { openAccessPdfDoi: "10.1234/ok", url: "https://api.crossref.org/works" },
  ]) {
    const response = await gatewayRequest(base, body);
    assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(body)}`);
  }
});

test("public-source gateway authenticates the runtime and forwards bounded official GET requests", async (t) => {
  let observed;
  const fetchImpl = async (url, options) => {
    observed = { url: String(url), method: options.method, redirect: options.redirect, accept: options.headers.accept };
    return new Response(JSON.stringify({ result: "traceable" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const server = createServer(createPublicSourceGatewayHandler({
    publicSourceGatewayTimeoutMs: 1_000,
    publicSourceGatewayMaxResponseBytes: 4096,
  }, runtimeManager(), { fetchImpl }));
  const base = await listen(server);
  t.after(() => close(server));

  const response = await gatewayRequest(base, {
    url: "https://api.crossref.org/works?query=observed",
    accept: ["application/json"],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "traceable" });
  assert.deepEqual(observed, {
    url: "https://api.crossref.org/works?query=observed",
    method: "GET",
    redirect: "error",
    accept: "application/json",
  });
  assert.equal(PUBLIC_SOURCE_ALLOWED_HOSTS.has("api.crossref.org"), true);
  for (const host of ["api.clinpgx.org", "api.materialsproject.org", "api.open-meteo.com", "fred.stlouisfed.org", "services.swpc.noaa.gov", "waterservices.usgs.gov"]) {
    assert.equal(PUBLIC_SOURCE_ALLOWED_HOSTS.has(host), true);
  }
});

test("an official source's refusal reaches the error ledger with its host and status, never its URL", async (t) => {
  // 2026-09-21: 202 `public_source_gateway_upstream_error` in twelve hours,
  // none of which said which source had refused or how.
  const failures = [];
  const handler = createPublicSourceGatewayHandler({ publicSourceGatewayTimeoutMs: 1_000 }, runtimeManager(), {
    fetchImpl: async () => new Response("busy", { status: 503, headers: { "content-type": "text/plain" } }),
  });
  const server = createServer((req, res) => handler(req, res, (failure) => failures.push(failure)));
  const base = await listen(server);
  t.after(() => close(server));
  const response = await gatewayRequest(base, { url: "https://api.crossref.org/works?query=observed&mailto=x", accept: ["application/json"] });
  assert.equal(response.status, 502);
  assert.deepEqual(failures.map((failure) => [failure.code, failure.upstream]),
    [["public_source_gateway_upstream_error", { host: "api.crossref.org", status: 503 }]]);
});

test("the API mode reads APIs only: web pages are the web-read mode's", async (t) => {
  // Until 2026-09-20 seventeen official hosts' HTML paths were fetched here as
  // raw HTML — unpaced, robots.txt unread, never rendered. Pages now go
  // through `{ webRead: { url } }` (webRead.test.mjs), and HTML is not a type
  // this mode will ask any upstream for.
  let fetchCalls = 0;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("<main><h1>Guideline</h1></main>", { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  for (const [url, accept, code] of [
    ["https://professional.heart.org/en/science-news/2024-aha-and-american-red-cross-guidelines-for-first-aid", ["text/html"], "public_source_gateway_url_forbidden"],
    ["https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json", ["text/html"], "public_source_gateway_accept_invalid"],
    ["https://www.nhs.uk/symptoms/chest-pain/", ["application/json"], "public_source_gateway_url_forbidden"],
    ["https://www.nice.org.uk/guidance/ng136", ["application/json"], "public_source_gateway_url_forbidden"],
  ]) {
    const response = await gatewayRequest(base, { url, accept });
    assert.equal((await response.json()).error.code, code, url);
  }
  assert.equal(PUBLIC_SOURCE_ALLOWED_ACCEPT_TYPES.has("text/html"), false);
  assert.equal(fetchCalls, 0);
});

test("public-source gateway permits only fixed read-only GraphQL operations", async (t) => {
  let observed;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async (url, options) => {
      observed = { url: String(url), method: options.method, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ data: { gene: { gene_id: "ENSG00000012048", symbol: "BRCA1" } } }), {
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const query = "query EviMedGnomad($symbol:String!){ gene(gene_symbol:$symbol, reference_genome:GRCh38){ gene_id symbol } }";
  const response = await gatewayRequest(base, {
    url: "https://gnomad.broadinstitute.org/api",
    accept: ["application/json"],
    method: "POST",
    body: { query, variables: { symbol: "BRCA1" } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(observed, {
    url: "https://gnomad.broadinstitute.org/api",
    method: "POST",
    body: { query, variables: { symbol: "BRCA1" } },
  });

  const rummageoQuery = "query EviMedRummaGeo($terms:[String]!, $first:Int!){ geneSetTermSearch(terms:$terms, first:$first, offset:0){ nodes { id term gse platform pmid publishedDate title geneSetById { nGeneIds species } } totalCount } }";
  const rummageo = await gatewayRequest(base, {
    url: "https://rummageo.com/graphql",
    accept: ["application/json"],
    method: "POST",
    body: { query: rummageoQuery, variables: { terms: ["kidney"], first: 2 } },
  });
  assert.equal(rummageo.status, 200);
  assert.deepEqual(observed, {
    url: "https://rummageo.com/graphql",
    method: "POST",
    body: { query: rummageoQuery, variables: { terms: ["kidney"], first: 2 } },
  });

  for (const body of [
    {
      url: "https://gnomad.broadinstitute.org/api",
      accept: ["application/json"], method: "POST",
      body: { query: "mutation { forbidden }", variables: { symbol: "BRCA1" } },
    },
    {
      url: "https://api.crossref.org/works",
      accept: ["application/json"], method: "POST",
      body: { query, variables: { symbol: "BRCA1" } },
    },
    {
      url: "https://gnomad.broadinstitute.org/api",
      accept: ["application/json"], method: "POST",
      body: { query, variables: { symbol: "BRCA1\nmutation" } },
    },
    {
      url: "https://rummageo.com/graphql",
      accept: ["application/json"], method: "POST",
      body: { query: rummageoQuery, variables: { terms: ["kidney"], first: 5000 } },
    },
    {
      url: "https://rummageo.com/graphql",
      accept: ["application/json"], method: "POST",
      body: { query: rummageoQuery, variables: { terms: ["kidney\nmutation"], first: 2 } },
    },
  ]) {
    const rejected = await gatewayRequest(base, body);
    assert.notEqual(rejected.status, 200);
  }
});

test("public-source gateway injects the server-held Materials Project key without accepting caller headers", async (t) => {
  let observedHeaders;
  const server = createServer(createPublicSourceGatewayHandler({
    materialsProjectApiKey: "mp-server-secret",
  }, runtimeManager(), {
    fetchImpl: async (_url, options) => {
      observedHeaders = options.headers;
      return new Response(JSON.stringify({ data: [{ material_id: "mp-149" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const response = await gatewayRequest(base, {
    url: "https://api.materialsproject.org/materials/summary/?material_ids=mp-149",
    accept: ["application/json"],
    credentialProfile: "materials-project",
  });
  assert.equal(response.status, 200);
  assert.equal(observedHeaders["x-api-key"], "mp-server-secret");

  // The host now requires the profile, so an unauthenticated Materials Project
  // call cannot slip past as one the gateway happens not to sign.
  const unprofiled = await gatewayRequest(base, {
    url: "https://api.materialsproject.org/materials/summary/?material_ids=mp-149",
    accept: ["application/json"],
  });
  assert.equal(unprofiled.status, 403);
});

test("public-source gateway injects source-specific credentials only into matching official endpoints", async (t) => {
  const observations = [];
  const credentials = {
    evimedEvidence: "evimed-secret",
    semanticScholar: "s2-secret",
    core: "core-secret",
    unpaywall: "researcher@example.org",
    umls: "umls-secret",
    omim: "omim-secret",
    addgene: "addgene-secret",
    biogrid: "biogrid-secret",
    opengwas: "opengwas-secret",
  };
  const server = createServer(createPublicSourceGatewayHandler({
    publicSourceCredentials: credentials,
    // Not a `publicSourceCredentials` entry: its profile names a first-party
    // config secret with `configValue`.
    materialsProjectApiKey: "mp-secret",
  }, runtimeManager(), {
    fetchImpl: async (url, options) => {
      observations.push({ url: new URL(url), headers: options.headers });
      return new Response(JSON.stringify({ result: "traceable" }), {
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const cases = [
    ["evimed-evidence", "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide", "POST", { query: "高血压", count: 3, language: "zh" }],
    ["semantic-scholar", "https://api.semanticscholar.org/graph/v1/paper/search?query=TP53"],
    ["core", "https://api.core.ac.uk/v3/search/works?q=TP53"],
    ["unpaywall", "https://api.unpaywall.org/v2/search?query=TP53"],
    ["umls", "https://uts-ws.nlm.nih.gov/rest/search/current?string=TP53"],
    ["omim", "https://api.omim.org/api/entry/search?search=TP53"],
    ["addgene", "https://api.developers.addgene.org/catalog/plasmid/?name=TP53"],
    ["biogrid", "https://webservice.thebiogrid.org/interactions?geneList=TP53"],
    ["opengwas", "https://api.opengwas.io/api/gwasinfo?id=ieu-a-2"],
    ["materials-project", "https://api.materialsproject.org/materials/summary/?formula=Fe2O3"],
  ];
  for (const [credentialProfile, url, method, body] of cases) {
    const response = await gatewayRequest(base, {
      url, accept: ["application/json"], credentialProfile,
      ...(method ? { method, body } : {}),
    });
    assert.equal(response.status, 200, credentialProfile);
  }

  // Derived, not counted. A profile added without a case here would otherwise
  // ship unexercised, and a count in this file says nothing about which one.
  assert.deepEqual(
    cases.map(([profile]) => profile).sort(),
    [...PUBLIC_SOURCE_CREDENTIAL_PROFILES.keys()].sort(),
    "every credential profile must be exercised against its own endpoint",
  );
  assert.equal(observations[0].headers.authorization, "Bearer evimed-secret");
  assert.equal(observations[1].headers["x-api-key"], "s2-secret");
  assert.equal(observations[2].headers.authorization, "Bearer core-secret");
  assert.equal(observations[3].url.searchParams.get("email"), "researcher@example.org");
  assert.equal(observations[4].url.searchParams.get("apiKey"), "umls-secret");
  assert.equal(observations[5].url.searchParams.get("apiKey"), "omim-secret");
  assert.equal(observations[6].headers.authorization, "Token addgene-secret");
  assert.equal(observations[7].url.searchParams.get("accesskey"), "biogrid-secret");
  assert.equal(observations[8].headers.authorization, "Bearer opengwas-secret");
  assert.equal(observations[9].headers["x-api-key"], "mp-secret");
});

test("EviMed evidence POST requests are fixed, read-only, and schema bounded", async (t) => {
  let observed;
  const server = createServer(createPublicSourceGatewayHandler({
    publicSourceCredentials: { evimedEvidence: "server-secret" },
  }, runtimeManager(), {
    fetchImpl: async (url, options) => {
      observed = { url: String(url), method: options.method, body: JSON.parse(options.body), authorization: options.headers.authorization };
      return new Response(JSON.stringify({ code: 200, data: { list: [] } }), {
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const accepted = await gatewayRequest(base, {
    url: "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide",
    accept: ["application/json"],
    method: "POST",
    credentialProfile: "evimed-evidence",
    body: { query: "高血压", count: 10, startYear: 2021, language: "zh" },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(observed, {
    url: "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide",
    method: "POST",
    body: { query: "高血压", count: 10, startYear: 2021, language: "zh" },
    authorization: "Bearer server-secret",
  });

  for (const body of [
    { query: "高血压", unexpected: true },
    { query: "高血压\nforbidden" },
    { query: "高血压", count: 1000 },
    { query: "高血压", language: "fr" },
  ]) {
    const rejected = await gatewayRequest(base, {
      url: "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide",
      accept: ["application/json"], method: "POST", credentialProfile: "evimed-evidence", body,
    });
    assert.equal(rejected.status, 400);
  }
});

test("EviMed evidence gateway registers every documented retrieval endpoint", async (t) => {
  const observed = [];
  const server = createServer(createPublicSourceGatewayHandler({
    publicSourceCredentials: { evimedEvidence: "server-secret" },
  }, runtimeManager(), {
    fetchImpl: async (url, options) => {
      observed.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ code: 200, data: { list: [] } }), {
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const cases = [
    ["instruction", { query: "阿司匹林", count: 200, source: ["nmpa", "fda"] }],
    ["literature", { query: "乌帕替尼", count: 100, articleTypes: ["随机对照试验"], hasPdf: true, minImpactFactor: 1 }],
    ["guide", { query: "高血压", count: 100, publishers: ["NCCN"], language: "zh" }],
    ["guide-block", { query: "高血压", publisher: "中华医学会", startYear: 2020, endYear: 2026 }],
    ["clinical-trial", { query: "aspirin", count: 100, registry: 2, source: "PubMed", minSampleSize: 0 }],
    ["patent", { query: "pembrolizumab", count: 100 }],
  ];
  for (const [name, body] of cases) {
    const response = await gatewayRequest(base, {
      url: `https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/${name}`,
      accept: ["application/json"],
      method: "POST",
      credentialProfile: "evimed-evidence",
      body,
    });
    assert.equal(response.status, 200, name);
  }
  assert.equal(observed.length, cases.length);

  const invalidInstruction = await gatewayRequest(base, {
    url: "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/instruction",
    accept: ["application/json"], method: "POST", credentialProfile: "evimed-evidence",
    body: { query: "aspirin", source: ["unknown"] },
  });
  assert.equal(invalidInstruction.status, 400);
  const crossEndpointInstruction = await gatewayRequest(base, {
    url: "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/instruction",
    accept: ["application/json"], method: "POST", credentialProfile: "evimed-evidence",
    body: { query: "aspirin", source: "PubMed" },
  });
  assert.equal(crossEndpointInstruction.status, 400);
  const crossEndpointTrial = await gatewayRequest(base, {
    url: "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/clinical-trial",
    accept: ["application/json"], method: "POST", credentialProfile: "evimed-evidence",
    body: { query: "aspirin", source: ["nmpa"] },
  });
  assert.equal(crossEndpointTrial.status, 400);
});

test("credential profiles fail closed when missing, caller-supplied, or used on another host", async (t) => {
  let fetchCalls = 0;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const missing = await gatewayRequest(base, {
    url: "https://uts-ws.nlm.nih.gov/rest/search/current?string=TP53",
    accept: ["application/json"], credentialProfile: "umls",
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, "public_source_umls_credential_missing");

  for (const body of [
    { url: "https://uts-ws.nlm.nih.gov/rest/search/current?string=TP53", accept: ["application/json"] },
    { url: "https://uts-ws.nlm.nih.gov/rest/search/current?string=TP53&apiKey=caller-secret", accept: ["application/json"], credentialProfile: "umls" },
    { url: "https://api.crossref.org/works?query=TP53", accept: ["application/json"], credentialProfile: "umls" },
  ]) {
    const rejected = await gatewayRequest(base, body);
    assert.notEqual(rejected.status, 200);
  }
  assert.equal(fetchCalls, 0);
});

test("public-source gateway rejects arbitrary hosts, plain HTTP, and inactive runtime tokens", async (t) => {
  let fetchCalls = 0;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  for (const [url, token, code] of [
    ["https://example.com/private", "runtime-token", "public_source_gateway_url_forbidden"],
    ["http://api.crossref.org/works", "runtime-token", "public_source_gateway_url_forbidden"],
    ["https://api.crossref.org/works", "inactive", "public_source_gateway_token_invalid"],
  ]) {
    const response = await gatewayRequest(base, { url, accept: ["application/json"] }, token);
    assert.notEqual(response.status, 200);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(fetchCalls, 0);
});

test("public-source gateway enforces response content type and size", async (t) => {
  const responses = [
    new Response("plain", { headers: { "content-type": "text/plain" } }),
    new Response("x".repeat(2048), { headers: { "content-type": "application/json" } }),
  ];
  const server = createServer(createPublicSourceGatewayHandler({
    publicSourceGatewayMaxResponseBytes: 1024,
  }, runtimeManager(), { fetchImpl: async () => responses.shift() }));
  const base = await listen(server);
  t.after(() => close(server));

  const unexpectedType = await gatewayRequest(base, {
    url: "https://api.crossref.org/works",
    accept: ["application/json"],
  });
  assert.equal((await unexpectedType.json()).error.code, "public_source_gateway_response_invalid");
  const tooLarge = await gatewayRequest(base, {
    url: "https://api.crossref.org/works",
    accept: ["application/json"],
  });
  assert.equal((await tooLarge.json()).error.code, "public_source_gateway_response_too_large");
});

test("public-source gateway stops reading an unbounded chunked response at the configured limit", async (t) => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(700));
    },
    cancel() {
      cancelled = true;
    },
  });
  const server = createServer(createPublicSourceGatewayHandler({
    publicSourceGatewayMaxResponseBytes: 1024,
  }, runtimeManager(), {
    fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const response = await gatewayRequest(base, {
    url: "https://api.crossref.org/works",
    accept: ["application/json"],
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "public_source_gateway_response_too_large");
  assert.equal(cancelled, true);
});

test("a rate-ceiling key is added when configured, and its absence is not an error", async (t) => {
  // NCBI answers without a key at 3 req/s and with one at 10; openFDA gives
  // 1,000 requests/day without and 120,000 with. Both are optional upstream,
  // so they are injected by host rather than through a credential profile —
  // a profiled host is *required* to carry one, and adding these two there
  // would have turned every PubMed and openFDA call the runtime already makes
  // into a 403.
  const seen = [];
  const make = (credentials) => createPublicSourceGatewayHandler(
    { publicSourceCredentials: credentials },
    runtimeManager(),
    {
      fetchImpl: async (url) => {
        seen.push(String(url));
        return Response.json({ ok: true });
      },
    },
  );

  const withKey = createServer(make({ ncbi: "ncbi-secret", openFda: "fda-secret" }));
  const base = await listen(withKey);
  t.after(() => close(withKey));

  const ncbi = await gatewayRequest(base, {
    url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=aspirin",
    accept: ["application/json"],
  });
  assert.equal(ncbi.status, 200);
  const fda = await gatewayRequest(base, {
    url: "https://api.fda.gov/drug/event.json?limit=1",
    accept: ["application/json"],
  });
  assert.equal(fda.status, 200);

  assert.ok(seen[0].includes("api_key=ncbi-secret"), `NCBI key must be added: ${seen[0]}`);
  assert.ok(seen[1].includes("api_key=fda-secret"), `openFDA key must be added: ${seen[1]}`);

  // The control that matters: with nothing configured the same calls must
  // still succeed, un-keyed. Making these mandatory would break working calls.
  const unconfigured = [];
  const withoutKey = createServer(createPublicSourceGatewayHandler(
    { publicSourceCredentials: {} },
    runtimeManager(),
    { fetchImpl: async (url) => { unconfigured.push(String(url)); return Response.json({ ok: true }); } },
  ));
  const bare = await listen(withoutKey);
  t.after(() => close(withoutKey));

  const noKey = await gatewayRequest(bare, {
    url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=aspirin",
    accept: ["application/json"],
  });
  assert.equal(noKey.status, 200, "an absent rate key must not fail the request");
  assert.ok(!unconfigured[0].includes("api_key="), "and must not append an empty key");
});

test("the runtime cannot supply, override, or read back a rate-ceiling key", async (t) => {
  // Same rule as the authorizing credentials: the container never holds one
  // and never gets to choose one. A runtime-supplied api_key would otherwise
  // ride through untouched and bill someone else's quota.
  const seen = [];
  const server = createServer(createPublicSourceGatewayHandler(
    { publicSourceCredentials: { ncbi: "server-key" } },
    runtimeManager(),
    { fetchImpl: async (url) => { seen.push(String(url)); return Response.json({ ok: true }); } },
  ));
  const base = await listen(server);
  t.after(() => close(server));

  const response = await gatewayRequest(base, {
    url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=x&api_key=runtime-forged",
    accept: ["application/json"],
  });
  const body = await response.text();

  assert.equal(response.status, 400, "a runtime-supplied api_key must be refused, not quietly ignored");
  assert.match(body, /credential_parameter_forbidden/);
  assert.deepEqual(seen, [], "and nothing must reach the upstream");
  assert.ok(!body.includes("server-key"), "the server key must never appear in a response to the runtime");
});

test("every host a shipped specialist agent calls is on the gateway allowlist", async () => {
  // These four were missing while the agents that call them shipped and ran:
  // the MR agent dials gwas.mrcieu.ac.uk, meta and the bibliometric agent dial
  // api.ror.org, drug-safety dials pmc.ncbi.nlm.nih.gov. They survived only
  // because those agents reach the network directly today; the moment their
  // egress is routed through this gateway, a delivered capability breaks.
  for (const host of [
    "gwas.mrcieu.ac.uk",
    "api.ror.org",
    "pmc.ncbi.nlm.nih.gov",
    "pubmed.ncbi.nlm.nih.gov",
  ]) {
    assert.ok(PUBLIC_SOURCE_ALLOWED_HOSTS.has(host), `${host} is called by a shipped agent and must be allowed`);
  }
});

test("the gateway accepts every content type the connectors ask it for", () => {
  // Read the asks back out of the connectors rather than restating them. The
  // two lists are in different languages in different trees, and when they
  // disagree the gateway refuses the call with a 400 before it reaches the
  // upstream -- so the connector looks broken and the upstream looks down.
  // `application/csv` was the live instance: the FRED connector was corrected
  // to accept what FRED actually serves and every call started failing.
  const asked = new Map();
  let tuples = 0;
  for (const { name, text } of connectorSources) {
    for (const match of text.matchAll(/accepted(?:=|\s*=\s*)?\(([^)]*)\)|_get_text\([^,]+,\s*\(([^)]*)\)/g)) {
      const body = match[1] ?? match[2];
      const types = [...body.matchAll(/"([a-z]+\/[a-z0-9.+-]+)"/g)].map((item) => item[1]);
      if (types.length === 0) continue;
      tuples += 1;
      for (const type of types) if (!asked.has(type)) asked.set(type, name);
    }
  }
  assert.ok(tuples >= 5, `the scan found ${tuples} accept lists; it is not reading the connectors`);
  assert.ok(asked.has("application/csv"), "the scan missed the FRED connector's accept list");
  for (const [type, source] of asked) {
    assert.ok(
      PUBLIC_SOURCE_ALLOWED_ACCEPT_TYPES.has(type),
      `${source} asks for ${type}; the gateway refuses it, so every such call is a 400`,
    );
  }
});

test("no connector names a credential profile the gateway does not define", () => {
  // Same failure in the other direction: `credential_profile="materials-project"`
  // named a profile that was never in the map, and the gateway answered 400 --
  // "the credential profile is invalid" -- to every `search_materials` call,
  // while the key it needed was already being injected by host.
  let named = 0;
  for (const { name, text } of connectorSources) {
    for (const match of text.matchAll(/credential_profile\s*=\s*"([a-z0-9-]+)"/g)) {
      named += 1;
      assert.ok(
        PUBLIC_SOURCE_CREDENTIAL_PROFILES.has(match[1]),
        `${name} asks for the ${match[1]} credential profile, which the gateway does not define`,
      );
    }
  }
  assert.ok(named >= 1, `the scan found ${named} credential-profile asks; it is not reading the connectors`);
});

test("a researcher's own credential fills a profile the deployment has not configured, and only theirs", async (t) => {
  // OpenGWAS is the standing case: its token belongs to a person and the
  // deployment has none. Alice saved hers; Bob did not. The deployment's
  // UMLS key wins over Alice's own, because a personal key fills a gap and
  // never overrides how a deployment reaches a source.
  const observations = [];
  const asked = [];
  const connectorCredentials = {
    async resolveOwn(userId, connector) {
      asked.push([userId, connector]);
      return userId === "alice" && connector === "opengwas" ? "alice-opengwas-jwt" : null;
    },
  };
  const manager = {
    assertActiveModelGatewayToken(token) {
      if (token === "alice-token") return { userId: "alice", projectId: "p" };
      if (token === "bob-token") return { userId: "bob", projectId: "p" };
      throw new Error("invalid token");
    },
  };
  const server = createServer(createPublicSourceGatewayHandler({
    publicSourceCredentials: { umls: "deployment-umls" },
  }, manager, {
    fetchImpl: async (url, options) => {
      observations.push({ url: new URL(url), headers: options.headers });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
    connectorCredentials,
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const opengwas = { url: "https://api.opengwas.io/api/gwasinfo?id=ieu-a-2", accept: ["application/json"], credentialProfile: "opengwas" };
  assert.equal((await gatewayRequest(base, opengwas, "alice-token")).status, 200);
  assert.equal(observations.at(-1).headers.authorization, "Bearer alice-opengwas-jwt");

  const refused = await gatewayRequest(base, opengwas, "bob-token");
  assert.equal(refused.status, 503);
  const body = await refused.json();
  assert.equal(body.error.code, "public_source_opengwas_credential_missing");
  assert.match(body.error.message, /设置 → 数据源/, "the refusal says where a credential can be added");

  const umls = { url: "https://uts-ws.nlm.nih.gov/rest/search/current?string=TP53", accept: ["application/json"], credentialProfile: "umls" };
  assert.equal((await gatewayRequest(base, umls, "alice-token")).status, 200);
  assert.equal(observations.at(-1).url.searchParams.get("apiKey"), "deployment-umls");
  // The store was never consulted for a profile the deployment serves.
  assert.deepEqual(asked, [["alice", "opengwas"], ["bob", "opengwas"]]);
});

test("an approved host that serves more than one API is bounded to the approved API", async (t) => {
  // `www.ncbi.nlm.nih.gov` is the whole of NCBI's web estate — every database
  // front end and every download path. Only PubTator3 on it is approved, and
  // only for reading, so allowing the host has to mean less than allowing the
  // host (2026-09-15: PubTator3 substance taken from `dsh-pubmed`).
  let fetchCalls = 0;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify([{ _id: "@CHEMICAL_Metformin", biotype: "chemical" }]), {
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const allowed = await gatewayRequest(base, {
    url: "https://www.ncbi.nlm.nih.gov/research/pubtator3-api/entity/autocomplete/?query=metformin&limit=3",
    accept: ["application/json"],
  });
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /@CHEMICAL_Metformin/);

  const elsewhere = await gatewayRequest(base, {
    url: "https://www.ncbi.nlm.nih.gov/books/NBK1/",
    accept: ["application/json"],
  });
  assert.equal(elsewhere.status, 403);
  assert.equal((await elsewhere.json()).error.code, "public_source_api_path_forbidden");

  const written = await gatewayRequest(base, {
    url: "https://www.ncbi.nlm.nih.gov/research/pubtator3-api/search/",
    accept: ["application/json"],
    method: "POST",
    body: { text: "anything" },
  });
  assert.equal(written.status, 403);
  // POST is refused on the host rule, before the approved-POST-endpoint list is
  // consulted, so the reason names the host rather than the endpoint.
  assert.equal((await written.json()).error.code, "public_source_api_request_forbidden");
  assert.equal(fetchCalls, 1);
});

test("a publisher host that resolves inside this network is refused after resolution", async (t) => {
  // The negative control for the name check: nothing in `pdfs.example.org`
  // is rejectable, and Unpaywall is an index, not an oracle. Only the
  // resolution says where it goes (2026-09-15, borrowed from `citeguard`).
  const fetched = [];
  const resolutions = new Map([
    // Looks like a publisher, answers with loopback.
    ["loopback.example.org", [{ address: "127.0.0.1", family: 4 }]],
    // One public address and one private one: the connection picks, not us.
    ["split.example.org", [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]],
    // IPv4 smuggled through an IPv6 answer, at the address that matters most.
    ["mapped.example.org", [{ address: "::ffff:169.254.169.254", family: 6 }]],
    // Unique-local IPv6.
    ["ula.example.org", [{ address: "fd00::1", family: 6 }]],
    ["good.example.org", [{ address: "93.184.216.34", family: 4 }]],
  ]);
  const server = createServer(createPublicSourceGatewayHandler(
    { publicSourceCredentials: { unpaywall: "contact@example.test" } },
    runtimeManager(),
    {
      fetchImpl: async (url) => {
        if (String(url).startsWith("https://api.unpaywall.org/")) {
          const inward = [
            { url_for_pdf: "https://loopback.example.org/a.pdf", host_type: "repository" },
            { url_for_pdf: "https://split.example.org/a.pdf", host_type: "repository" },
            { url_for_pdf: "https://mapped.example.org/a.pdf", host_type: "repository" },
          ];
          return Response.json({
            oa_locations: String(url).includes("nowhere")
              ? [{ url_for_pdf: "https://absent.example.org/a.pdf", host_type: "repository" }]
              : [...inward, { url_for_pdf: "https://good.example.org/a.pdf", host_type: "repository" }],
          });
        }
        fetched.push(new URL(String(url)).hostname);
        return new Response(Buffer.from("%PDF-1.7 body"), { status: 200, headers: { "content-type": "application/pdf" } });
      },
      resolveImpl: async (hostname) => {
        const record = resolutions.get(hostname);
        if (!record) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        return record;
      },
    },
  ));
  t.after(() => close(server));
  const base = await listen(server);

  const response = await gatewayRequest(base, { openAccessPdfDoi: "10.1234/resolves-inward" });
  assert.equal(response.status, 200);
  // The three inward-resolving hosts were never connected to; the fourth served it.
  assert.deepEqual(fetched, ["good.example.org"]);
  assert.equal(decodeURIComponent(response.headers.get("x-evimed-oa-source")), "https://good.example.org");

  // And when the only location resolves nowhere, the article is reported as
  // not retrievable rather than as forbidden: an unresolvable name is an
  // upstream condition, not an attempt to reach inward.
  const unresolvable = await gatewayRequest(base, { openAccessPdfDoi: "10.1234/nowhere" });
  assert.equal(unresolvable.status, 404);
  const failure = await unresolvable.json();
  assert.equal(failure.error.code, "public_source_pdf_not_open_access");
  assert.match(failure.error.message, /did not resolve/);
  assert.deepEqual(fetched, ["good.example.org"]);
});
