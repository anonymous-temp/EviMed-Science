import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  createPublicSourceGatewayHandler,
  PUBLIC_SOURCE_ALLOWED_HOSTS,
  PUBLIC_SOURCE_CREDENTIAL_PROFILES,
} from "../src/publicSourceGateway.mjs";

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
  for (const host of ["api.materialsproject.org", "api.open-meteo.com", "fred.stlouisfed.org", "services.swpc.noaa.gov", "waterservices.usgs.gov"]) {
    assert.equal(PUBLIC_SOURCE_ALLOWED_HOSTS.has(host), true);
  }
});

test("public-source gateway permits bounded HTML only on approved official-document paths", async (t) => {
  let fetchCalls = 0;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("<main><h1>Guideline</h1><p>Verified official content.</p></main>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => close(server));

  const allowed = await gatewayRequest(base, {
    url: "https://professional.heart.org/en/science-news/2024-aha-and-american-red-cross-guidelines-for-first-aid",
    accept: ["text/html"],
  });
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /Verified official content/);

  const wrongPath = await gatewayRequest(base, {
    url: "https://professional.heart.org/unreviewed/path",
    accept: ["text/html"],
  });
  assert.equal(wrongPath.status, 403);
  assert.equal((await wrongPath.json()).error.code, "public_source_document_path_forbidden");
  assert.equal(fetchCalls, 1);
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
  });
  assert.equal(response.status, 200);
  assert.equal(observedHeaders["x-api-key"], "mp-server-secret");
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
  const server = createServer(createPublicSourceGatewayHandler({ publicSourceCredentials: credentials }, runtimeManager(), {
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
  ];
  for (const [credentialProfile, url, method, body] of cases) {
    const response = await gatewayRequest(base, {
      url, accept: ["application/json"], credentialProfile,
      ...(method ? { method, body } : {}),
    });
    assert.equal(response.status, 200, credentialProfile);
  }

  assert.equal(PUBLIC_SOURCE_CREDENTIAL_PROFILES.size, 9);
  assert.equal(observations[0].headers.authorization, "Bearer evimed-secret");
  assert.equal(observations[1].headers["x-api-key"], "s2-secret");
  assert.equal(observations[2].headers.authorization, "Bearer core-secret");
  assert.equal(observations[3].url.searchParams.get("email"), "researcher@example.org");
  assert.equal(observations[4].url.searchParams.get("apiKey"), "umls-secret");
  assert.equal(observations[5].url.searchParams.get("apiKey"), "omim-secret");
  assert.equal(observations[6].headers.authorization, "Token addgene-secret");
  assert.equal(observations[7].url.searchParams.get("accesskey"), "biogrid-secret");
  assert.equal(observations[8].headers.authorization, "Bearer opengwas-secret");
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
