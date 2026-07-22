const gatewayPath = "/internal/sources/v1/fetch";

const allowedHosts = new Set([
  "api.crossref.org",
  "api.biorxiv.org",
  "api.core.ac.uk",
  "api.developers.addgene.org",
  "api.fda.gov",
  "api.genome.ucsc.edu",
  "api.gdc.cancer.gov",
  "api.monarchinitiative.org",
  "api.materialsproject.org",
  "api.open-meteo.com",
  "api.openalex.org",
  "api.omim.org",
  "api.opengwas.io",
  "api.platform.opentargets.org",
  "api.pharmgkb.org",
  "api.semanticscholar.org",
  "api.unpaywall.org",
  "alphafold.ebi.ac.uk",
  "bindingdb.org",
  "clinicaltrials.gov",
  "civicdb.org",
  "data.rcsb.org",
  "dgidb.org",
  "dailymed.nlm.nih.gov",
  "eutils.ncbi.nlm.nih.gov",
  "export.arxiv.org",
  "ghoapi.azureedge.net",
  "gtexportal.org",
  "gnomad.broadinstitute.org",
  "jaspar.elixir.no",
  "mygene.info",
  "myvariant.info",
  "openneuro.org",
  "pubchem.ncbi.nlm.nih.gov",
  "reactome.org",
  "rest.ensembl.org",
  "rest.uniprot.org",
  "rummageo.com",
  "fred.stlouisfed.org",
  "services.swpc.noaa.gov",
  "service.azul.data.humancellatlas.org",
  "maayanlab.cloud",
  "rxnav.nlm.nih.gov",
  "string-db.org",
  "uts-ws.nlm.nih.gov",
  "webservice.thebiogrid.org",
  "www.evimed.com",
  "sparql.wikipathways.org",
  "www.encodeproject.org",
  "www.guidetopharmacology.org",
  "www.isrctn.com",
  "www.metabolomicsworkbench.org",
  "www.mousemine.org",
  "www.proteinatlas.org",
  "www.cbioportal.org",
  "www.ebi.ac.uk",
  "www.cochrane.org",
  "www.acc.org",
  "professional.heart.org",
  "cpr.heart.org",
  "www.nhs.uk",
  "www.ccfdie.org",
  "mpa.hunan.gov.cn",
  "waterservices.usgs.gov",
]);

const officialDocumentPaths = new Map([
  ["www.cochrane.org", ["/evidence/", "/zh-hans/evidence/"]],
  ["www.acc.org", ["/latest-in-cardiology/"]],
  ["professional.heart.org", ["/en/science-news/"]],
  ["cpr.heart.org", ["/en/resuscitation-science/"]],
  ["www.nhs.uk", ["/symptoms/chest-pain/"]],
  ["www.ccfdie.org", ["/zryyxxw/"]],
  ["mpa.hunan.gov.cn", ["/mpa/"]],
]);

const credentialProfiles = new Map([
  ["evimed-evidence", { configKey: "evimedEvidence", host: "www.evimed.com", path: "/api-evimed/medicine-api/ai-api/", header: "authorization", scheme: "Bearer" }],
  ["semantic-scholar", { configKey: "semanticScholar", host: "api.semanticscholar.org", path: "/graph/v1/", header: "x-api-key" }],
  ["core", { configKey: "core", host: "api.core.ac.uk", path: "/v3/", header: "authorization", scheme: "Bearer" }],
  ["unpaywall", { configKey: "unpaywall", host: "api.unpaywall.org", path: "/v2/", query: "email" }],
  ["umls", { configKey: "umls", host: "uts-ws.nlm.nih.gov", path: "/rest/", query: "apiKey" }],
  ["omim", { configKey: "omim", host: "api.omim.org", path: "/api/", query: "apiKey" }],
  ["addgene", { configKey: "addgene", host: "api.developers.addgene.org", path: "/catalog/", header: "authorization", scheme: "Token" }],
  ["biogrid", { configKey: "biogrid", host: "webservice.thebiogrid.org", path: "/interactions", query: "accesskey" }],
  ["opengwas", { configKey: "opengwas", host: "api.opengwas.io", path: "/api/", header: "authorization", scheme: "Bearer" }],
]);
const credentialHosts = new Set([...credentialProfiles.values()].map((profile) => profile.host));

const allowedAcceptTypes = new Set([
  "application/atom+xml",
  "application/gzip",
  "application/json",
  "application/sparql-results+json",
  "application/xml",
  "text/json",
  "text/plain",
  "text/csv",
  "text/html",
  "text/xml",
]);

const openTargetsQuery = "query EviMedOpenTargets($q:String!){ search(queryString:$q){ hits { id name entity } } }";
const dgidbQuery = "query EviMedDgidb($names:[String!]!){ genes(names:$names){ nodes { name conceptId interactions { drug { name conceptId } interactionScore } } } }";
const gnomadQuery = "query EviMedGnomad($symbol:String!){ gene(gene_symbol:$symbol, reference_genome:GRCh38){ gene_id symbol } }";
const openNeuroQuery = "query EviMedOpenNeuro($id:ID!){ dataset(id:$id){ id name } }";
const civicQuery = "query EviMedCivic($symbol:String!){ gene(entrezSymbol:$symbol){ id name entrezId } }";
const rummageoQuery = "query EviMedRummaGeo($terms:[String]!, $first:Int!){ geneSetTermSearch(terms:$terms, first:$first, offset:0){ nodes { id term gse platform pmid publishedDate title geneSetById { nGeneIds species } } totalCount } }";

const graphQlOperations = new Map([
  [openTargetsQuery, { endpoint: "api.platform.opentargets.org/api/v4/graphql", variables: { q: "text" } }],
  [dgidbQuery, { endpoint: "dgidb.org/api/graphql", variables: { names: "gene-list" } }],
  [gnomadQuery, { endpoint: "gnomad.broadinstitute.org/api", variables: { symbol: "gene" } }],
  [openNeuroQuery, { endpoint: "openneuro.org/crn/graphql", variables: { id: "dataset" } }],
  [civicQuery, { endpoint: "civicdb.org/api/graphql", variables: { symbol: "gene" } }],
  [rummageoQuery, { endpoint: "rummageo.com/graphql", variables: { terms: "term-list", first: "limit" } }],
]);
const allowedPostEndpoints = new Set([...graphQlOperations.values()].map((item) => item.endpoint));

const evimedPostEndpoints = new Map([
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide", {
    fields: new Set(["query", "count", "startYear", "endYear", "publishers", "language"]),
    maxCount: 100,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide-block", {
    fields: new Set(["query", "language", "publisher", "startYear", "endYear"]),
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/instruction", {
    fields: new Set(["query", "count", "source"]),
    maxCount: 200,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/literature", {
    fields: new Set([
      "query", "count", "articleTypes", "startYear", "endYear", "hasPdf", "language",
      "minImpactFactor", "maxImpactFactor", "journalTiers",
    ]),
    maxCount: 100,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/clinical-trial", {
    fields: new Set([
      "query", "count", "registry", "startYear", "endYear", "status", "phase", "studyType",
      "hasArticles", "source", "minSampleSize", "maxSampleSize",
    ]),
    maxCount: 100,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/patent", {
    fields: new Set(["query", "count"]),
    maxCount: 100,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/search/api/evidence", {
    fields: new Set(["query"]),
  }],
]);
for (const endpoint of evimedPostEndpoints.keys()) allowedPostEndpoints.add(endpoint);

class PublicSourceGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function gatewayError(status, code, message) {
  return new PublicSourceGatewayError(status, code, message);
}

function sendError(res, error) {
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return;
  }
  const status = Number.isSafeInteger(error?.status) ? error.status : 502;
  const code = typeof error?.code === "string" ? error.code : "public_source_gateway_unavailable";
  const message = error instanceof PublicSourceGatewayError
    ? error.message
    : "The public-source gateway is temporarily unavailable.";
  const body = Buffer.from(JSON.stringify({ error: { code, message } }));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function bearerToken(req) {
  const value = req.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    throw gatewayError(401, "public_source_gateway_token_invalid", "Public-source gateway authentication failed.");
  }
  const token = value.slice(7);
  if (!token || token.length > 8 * 1024 || /[\r\n\0]/.test(token)) {
    throw gatewayError(401, "public_source_gateway_token_invalid", "Public-source gateway authentication failed.");
  }
  return token;
}

async function readJsonBody(req, limit) {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw gatewayError(415, "public_source_gateway_content_type_invalid", "Content-Type must be application/json.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw gatewayError(413, "public_source_gateway_body_too_large", "The public-source request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw gatewayError(400, "public_source_gateway_body_invalid", "The public-source request body is not valid JSON.");
  }
}

function validEvimedText(value, maxLength = 512) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !/[\r\n\0]/.test(value);
}

function validEvimedTextArray(value, { maxItems = 20, maxLength = 128 } = {}) {
  return Array.isArray(value) && value.length > 0 && value.length <= maxItems && value.every(
    (item) => validEvimedText(item, maxLength),
  );
}

function validEvimedEnumArray(value, allowed) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((item) => allowed.has(item));
}

function validatedRequest(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError(400, "public_source_gateway_body_invalid", "The public-source request must be an object.");
  }
  if (Object.keys(value).some((key) => !["url", "accept", "method", "body", "credentialProfile"].includes(key))) {
    throw gatewayError(400, "public_source_gateway_field_invalid", "The public-source request contains an unsupported field.");
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw gatewayError(400, "public_source_gateway_url_invalid", "The public-source URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw gatewayError(403, "public_source_gateway_url_forbidden", "The public-source URL is not an approved official endpoint.");
  }
  const method = value.method ?? "GET";
  if (!new Set(["GET", "POST"]).has(method)) {
    throw gatewayError(400, "public_source_gateway_method_invalid", "The public-source method is invalid.");
  }
  if (
    !Array.isArray(value.accept) ||
    value.accept.length < 1 ||
    value.accept.length > 8 ||
    value.accept.some((item) => typeof item !== "string" || !allowedAcceptTypes.has(item))
  ) {
    throw gatewayError(400, "public_source_gateway_accept_invalid", "The public-source accepted content types are invalid.");
  }
  const credentialProfile = value.credentialProfile ?? null;
  const profile = credentialProfile == null ? null : credentialProfiles.get(credentialProfile);
  if (credentialProfile != null && !profile) {
    throw gatewayError(400, "public_source_gateway_credential_profile_invalid", "The credential profile is invalid.");
  }
  const hostname = url.hostname.toLowerCase();
  const documentPrefixes = officialDocumentPaths.get(hostname);
  if (documentPrefixes && !documentPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    throw gatewayError(403, "public_source_document_path_forbidden", "The official-document path is not approved.");
  }
  if (documentPrefixes && (method !== "GET" || value.accept.length !== 1 || value.accept[0] !== "text/html")) {
    throw gatewayError(403, "public_source_document_request_forbidden", "Official-document sources permit only HTML GET requests.");
  }
  if (profile && (hostname !== profile.host || !url.pathname.startsWith(profile.path))) {
    throw gatewayError(403, "public_source_gateway_credential_profile_forbidden", "The credential profile does not match this official endpoint.");
  }
  if (credentialHosts.has(hostname) && !profile) {
    throw gatewayError(403, "public_source_gateway_credential_profile_required", "This official endpoint requires a server-managed credential profile.");
  }
  if (profile?.query && [...url.searchParams.keys()].some((key) => key.toLowerCase() === profile.query.toLowerCase())) {
    throw gatewayError(400, "public_source_gateway_credential_parameter_forbidden", "Credentials cannot be supplied by the runtime.");
  }
  if (method === "GET") {
    if (value.body !== undefined) {
      throw gatewayError(400, "public_source_gateway_body_invalid", "GET public-source requests cannot contain a body.");
    }
    return { url, accept: [...new Set(value.accept)], method, body: null, credentialProfile };
  }
  const endpoint = `${url.hostname.toLowerCase()}${url.pathname}`;
  if (url.search || !allowedPostEndpoints.has(endpoint)) {
    throw gatewayError(403, "public_source_gateway_url_forbidden", "POST is not approved for this official read-only endpoint.");
  }
  const body = value.body;
  const evimedSpec = evimedPostEndpoints.get(endpoint);
  if (evimedSpec) {
    if (
      credentialProfile !== "evimed-evidence" ||
      body == null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !evimedSpec.fields.has(key)) ||
      typeof body.query !== "string" ||
      body.query.trim().length < 1 ||
      body.query.length > 512 ||
      /[\r\n\0]/.test(body.query)
    ) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed evidence request is invalid.");
    }
    if (
      body.count !== undefined &&
      (!Number.isSafeInteger(body.count) || body.count < 1 || body.count > (evimedSpec.maxCount ?? 100))
    ) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed result count is invalid.");
    }
    for (const name of ["startYear", "endYear"]) {
      if (body[name] !== undefined && (!Number.isSafeInteger(body[name]) || body[name] < 1900 || body[name] > 2100)) {
        throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed year filter is invalid.");
      }
    }
    if (body.startYear !== undefined && body.endYear !== undefined && body.startYear > body.endYear) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed year range is invalid.");
    }
    if (body.language !== undefined && !new Set(["zh", "en"]).has(body.language)) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed language is invalid.");
    }
    if (body.publisher !== undefined && !validEvimedText(body.publisher, 128)) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed publisher filter is invalid.");
    }
    if (
      body.publishers !== undefined &&
      !validEvimedTextArray(body.publishers, { maxItems: 20, maxLength: 128 })
    ) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed publisher filter is invalid.");
    }
    const enumeratedArrays = {
      articleTypes: new Set([
        "系统综述/Meta分析", "指南/共识", "传统综述", "随机对照试验", "临床试验", "队列研究",
        "病例对照研究", "横断面研究", "病例系列", "病例报告", "经济学评价", "专家意见和评价",
        "动物实验", "体外实验", "其他",
      ]),
      journalTiers: new Set(["北大核心", "科技核心", "南大核心"]),
    };
    for (const [name, allowed] of Object.entries(enumeratedArrays)) {
      if (body[name] !== undefined && !validEvimedEnumArray(body[name], allowed)) {
        throw gatewayError(400, "public_source_gateway_evimed_request_invalid", `The EviMed ${name} filter is invalid.`);
      }
    }
    for (const name of ["status", "phase", "studyType"]) {
      if (body[name] !== undefined && !validEvimedTextArray(body[name], { maxItems: 20, maxLength: 128 })) {
        throw gatewayError(400, "public_source_gateway_evimed_request_invalid", `The EviMed ${name} filter is invalid.`);
      }
    }
    if (body.hasArticles !== undefined && (
      !Array.isArray(body.hasArticles) || body.hasArticles.length !== 1 || ![0, 1].includes(body.hasArticles[0])
    )) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed article-link filter is invalid.");
    }
    if (body.registry !== undefined && (!Number.isSafeInteger(body.registry) || ![0, 1, 2].includes(body.registry))) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed trial registry is invalid.");
    }
    if (body.source !== undefined) {
      const instructionEndpoint = endpoint.endsWith("/review/api/instruction");
      const trialEndpoint = endpoint.endsWith("/review/api/clinical-trial");
      const validInstructionSource = instructionEndpoint && validEvimedEnumArray(
        body.source,
        new Set(["nmpa", "fda", "ema", "pmda"]),
      );
      const validTrialSource = trialEndpoint && typeof body.source === "string" && new Set(
        ["PubMed", "Embase", "ICTRP", "CT.gov", "CINAHL"],
      ).has(body.source);
      if (!validInstructionSource && !validTrialSource) {
        throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed source filter is invalid for this endpoint.");
      }
    }
    for (const name of ["minSampleSize", "maxSampleSize"]) {
      if (body[name] !== undefined && (!Number.isSafeInteger(body[name]) || body[name] < 0 || body[name] > 10_000_000)) {
        throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed sample-size filter is invalid.");
      }
    }
    if (body.minSampleSize !== undefined && body.maxSampleSize !== undefined && body.minSampleSize > body.maxSampleSize) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed sample-size range is invalid.");
    }
    for (const name of ["minImpactFactor", "maxImpactFactor"]) {
      if (body[name] !== undefined && (typeof body[name] !== "number" || !Number.isFinite(body[name]) || body[name] < 0 || body[name] > 10_000)) {
        throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed impact-factor filter is invalid.");
      }
    }
    if (body.minImpactFactor !== undefined && body.maxImpactFactor !== undefined && body.minImpactFactor > body.maxImpactFactor) {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed impact-factor range is invalid.");
    }
    if (body.hasPdf !== undefined && typeof body.hasPdf !== "boolean") {
      throw gatewayError(400, "public_source_gateway_evimed_request_invalid", "The EviMed full-text filter is invalid.");
    }
    return { url, accept: [...new Set(value.accept)], method, body, credentialProfile };
  }
  if (body == null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["query", "variables"].includes(key))) {
    throw gatewayError(400, "public_source_gateway_body_invalid", "The GraphQL request body is invalid.");
  }
  const operation = graphQlOperations.get(body.query);
  if (!operation || operation.endpoint !== endpoint) {
    throw gatewayError(403, "public_source_gateway_graphql_forbidden", "The GraphQL operation is not an approved read-only query.");
  }
  const variables = body.variables;
  if (variables == null || typeof variables !== "object" || Array.isArray(variables) || Object.keys(variables).sort().join("\0") !== Object.keys(operation.variables).sort().join("\0")) {
    throw gatewayError(400, "public_source_gateway_variables_invalid", "The GraphQL variables are invalid.");
  }
  for (const [name, kind] of Object.entries(operation.variables)) {
    const variable = variables[name];
    if (kind === "gene-list") {
      if (!Array.isArray(variable) || variable.length !== 1 || typeof variable[0] !== "string" || !/^[A-Z0-9._-]{1,64}$/.test(variable[0])) {
        throw gatewayError(400, "public_source_gateway_variables_invalid", "The GraphQL gene list is invalid.");
      }
    } else if (kind === "term-list") {
      if (!Array.isArray(variable) || variable.length !== 1 || typeof variable[0] !== "string" || variable[0].length < 1 || variable[0].length > 256 || /[\r\n\0]/.test(variable[0])) {
        throw gatewayError(400, "public_source_gateway_variables_invalid", "The GraphQL term list is invalid.");
      }
    } else if (kind === "limit") {
      if (!Number.isSafeInteger(variable) || variable < 1 || variable > 50) {
        throw gatewayError(400, "public_source_gateway_variables_invalid", "The GraphQL result limit is invalid.");
      }
    } else if (typeof variable !== "string" || variable.length < 1 || variable.length > 512) {
      throw gatewayError(400, "public_source_gateway_variables_invalid", "A GraphQL variable is invalid.");
    } else if (kind === "gene" && !/^[A-Z0-9._-]{1,64}$/.test(variable)) {
      throw gatewayError(400, "public_source_gateway_variables_invalid", "The GraphQL gene symbol is invalid.");
    } else if (kind === "dataset" && !/^ds\d{6,}$/.test(variable)) {
      throw gatewayError(400, "public_source_gateway_variables_invalid", "The OpenNeuro dataset identifier is invalid.");
    }
  }
  return { url, accept: [...new Set(value.accept)], method, body, credentialProfile };
}

function mappedUpstreamStatus(status) {
  if (status === 404 || status === 429) return status;
  if (status >= 400 && status < 500) return 400;
  return 502;
}

async function readBoundedBody(body, maxBytes) {
  if (!body || typeof body.getReader !== "function") {
    throw gatewayError(502, "public_source_gateway_response_invalid", "The official public source returned no readable body.");
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw gatewayError(502, "public_source_gateway_response_too_large", "The official public-source response exceeded the gateway limit.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createPublicSourceGatewayHandler(config, runtimeManager, { fetchImpl = fetch } = {}) {
  return async function publicSourceGatewayHandler(req, res) {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
      sendError(res, gatewayError(404, "not_found", "Not found."));
      return;
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Number(config.publicSourceGatewayTimeoutMs) || 60_000);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Public-source gateway timed out.", "TimeoutError")),
      timeoutMs,
    );
    timeout.unref?.();
    try {
      const token = bearerToken(req);
      try {
        runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "public_source_gateway_token_invalid", "Public-source gateway authentication failed.");
      }
      const request = validatedRequest(await readJsonBody(req, 16 * 1024));
      let upstream;
      try {
        const upstreamHeaders = {
          accept: request.accept.join(", "),
          "user-agent": "EviMed-Research/1.2 (server public-source gateway)",
        };
        if (request.method === "POST") upstreamHeaders["content-type"] = "application/json";
        if (request.credentialProfile) {
          const profile = credentialProfiles.get(request.credentialProfile);
          const credential = String(config.publicSourceCredentials?.[profile.configKey] ?? "").trim();
          if (!credential || credential.length > 8 * 1024 || /[\r\n\0]/.test(credential)) {
            throw gatewayError(
              503,
              `public_source_${request.credentialProfile.replaceAll("-", "_")}_credential_missing`,
              `The server-managed ${request.credentialProfile} credential is unavailable.`,
            );
          }
          if (profile.header) {
            upstreamHeaders[profile.header] = profile.scheme ? `${profile.scheme} ${credential}` : credential;
          } else {
            request.url.searchParams.set(profile.query, credential);
          }
        }
        if (request.url.hostname.toLowerCase() === "api.materialsproject.org") {
          const apiKey = String(config.materialsProjectApiKey ?? "").trim();
          if (!apiKey) {
            throw gatewayError(503, "materials_project_api_key_missing", "The server-managed Materials Project key is unavailable.");
          }
          upstreamHeaders["x-api-key"] = apiKey;
        }
        upstream = await fetchImpl(request.url, {
          method: request.method,
          headers: upstreamHeaders,
          body: request.body ? JSON.stringify(request.body) : undefined,
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof PublicSourceGatewayError) throw error;
        if (controller.signal.reason?.name === "TimeoutError") {
          throw gatewayError(504, "public_source_gateway_timeout", "The official public source timed out.");
        }
        throw gatewayError(502, "public_source_gateway_upstream_unavailable", "The official public source is temporarily unavailable.");
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        throw gatewayError(
          mappedUpstreamStatus(upstream.status),
          upstream.status === 429 ? "public_source_gateway_rate_limited" : "public_source_gateway_upstream_error",
          `The official public source returned HTTP ${upstream.status}.`,
        );
      }
      const contentType = String(upstream.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      if (!request.accept.includes(contentType)) {
        await upstream.body?.cancel().catch(() => {});
        throw gatewayError(502, "public_source_gateway_response_invalid", "The official public source returned an unexpected content type.");
      }
      const maxBytes = Math.max(1024, Number(config.publicSourceGatewayMaxResponseBytes) || 16 * 1024 * 1024);
      const declared = Number(upstream.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await upstream.body?.cancel().catch(() => {});
        throw gatewayError(502, "public_source_gateway_response_too_large", "The official public-source response exceeded the gateway limit.");
      }
      const buffer = await readBoundedBody(upstream.body, maxBytes);
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": String(buffer.length),
        "cache-control": "no-store",
      });
      res.end(buffer);
    } catch (error) {
      sendError(res, error);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const PUBLIC_SOURCE_GATEWAY_PATH = gatewayPath;
export const PUBLIC_SOURCE_ALLOWED_HOSTS = allowedHosts;
export const PUBLIC_SOURCE_ALLOWED_POST_ENDPOINTS = allowedPostEndpoints;
export const PUBLIC_SOURCE_CREDENTIAL_PROFILES = credentialProfiles;
