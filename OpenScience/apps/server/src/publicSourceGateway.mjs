import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { connectorCredentialSpec, connectorMissingCode } from "@evimed/domain";
import { headerValue, nodeWebTransport, privateIpv4Address, privateIpv6Address, WebReadError } from "./webReadNetwork.mjs";

const gatewayPath = "/internal/sources/v1/fetch";

const allowedHosts = new Set([
  "alliancemine.alliancegenome.org",
  "alphafold.ebi.ac.uk",
  "api.biorxiv.org",
  "api.cellxgene.cziscience.com",
  "api.clinpgx.org",
  "api.core.ac.uk",
  "api.cpicpgx.org",
  "api.crossref.org",
  "api.developers.addgene.org",
  "api.epistemonikos.org",
  "api.fda.gov",
  "api.gdc.cancer.gov",
  "api.genome.ucsc.edu",
  "api.labs.crossref.org",
  "api.materialsproject.org",
  "api.monarchinitiative.org",
  "api.omim.org",
  "api.open-meteo.com",
  "api.openalex.org",
  "api.opengwas.io",
  "api.platform.opentargets.org",
  "api.ror.org",
  "api.semanticscholar.org",
  "api.unpaywall.org",
  "bindingdb.org",
  "civicdb.org",
  "clinicaltrials.gov",
  "dailymed.nlm.nih.gov",
  "data.rcsb.org",
  "dgidb.org",
  "euclinicaltrials.eu",
  "eutils.ncbi.nlm.nih.gov",
  "export.arxiv.org",
  "fred.stlouisfed.org",
  "ghoapi.azureedge.net",
  "gnomad.broadinstitute.org",
  "gtexportal.org",
  "gwas.mrcieu.ac.uk",
  "jaspar.elixir.no",
  "maayanlab.cloud",
  "mygene.info",
  "myvariant.info",
  "openneuro.org",
  "pmc.ncbi.nlm.nih.gov",
  "pubchem.ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "r12.finngen.fi",
  "reactome.org",
  "rest.ensembl.org",
  "rest.uniprot.org",
  "rummageo.com",
  "rxnav.nlm.nih.gov",
  "seer.cancer.gov",
  "service.azul.data.humancellatlas.org",
  "services.swpc.noaa.gov",
  "singlecell.broadinstitute.org",
  "sparql.wikipathways.org",
  "string-db.org",
  "uts-ws.nlm.nih.gov",
  "waterservices.usgs.gov",
  "webservice.thebiogrid.org",
  "www.cbioportal.org",
  "www.deciphergenomics.org",
  "www.ebi.ac.uk",
  "www.encodeproject.org",
  "www.eqtlgen.org",
  "www.evimed.com",
  "www.guidetopharmacology.org",
  "www.isrctn.com",
  "www.metabolomicsworkbench.org",
  "www.ncbi.nlm.nih.gov",
  "www.proteinatlas.org",
  "wwwn.cdc.gov",
]);

// Tier 1 is APIs only. Web pages — an authority's guideline, a regulator's
// notice, any page a search found — are read by the web-read mode below
// (`webRead.mjs`): paced per site, robots.txt honoured, rendered when the page
// is drawn in script. Until 2026-09-20 this list also carried the HTML paths of
// seventeen official hosts, fetched here as raw HTML with none of that; those
// hosts left the allowlist with the official-page tool, and "official" is now a
// label on what `web_read` returns (`webReadOfficial.mjs`), not an admission.
//
// Hosts approved for one API surface rather than for themselves.
// `www.ncbi.nlm.nih.gov` serves the whole of NCBI's web estate — every database
// front end, every download path, every redirect into the rest of the NIH —
// and the only thing approved on it is PubTator3. DailyMed serves the JSON API
// the connector searches; its label pages are read through `web_read`.
const apiPathPrefixes = new Map([
  ["www.ncbi.nlm.nih.gov", ["/research/pubtator3-api/"]],
  ["dailymed.nlm.nih.gov", ["/dailymed/services/v2/"]],
  // The EU Clinical Trials Information System's public portal API: the trial
  // search (a POST, below) and one trial's record (a GET), and nothing else the
  // portal serves.
  ["euclinicaltrials.eu", ["/ctis-public-api/"]],
]);
/** The one path on `euclinicaltrials.eu` a GET may read: a trial by its EU CT number. */
const ctisRetrievePath = /^\/ctis-public-api\/retrieve\/\d{4}-\d{6}-\d{2}-\d{2}$/;

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
  // Materials Project's key is a first-party config secret rather than a
  // `publicSourceCredentials` entry, so this profile names it with
  // `configValue`. It is a profile at all because the runtime already asks for
  // one by that name: the MCP's own `CREDENTIAL_PROFILES` has carried
  // `materials-project` since the connector shipped, and with no entry here
  // every `search_materials` call was refused as an invalid credential profile
  // -- a 400 that never left the building, reported as "the source returned
  // HTTP 400". Injecting the same key by host in a branch of its own is what
  // let the two sides disagree without either looking wrong.
  ["materials-project", { configValue: "materialsProjectApiKey", host: "api.materialsproject.org", path: "/materials/", header: "x-api-key" }],
]);
const credentialHosts = new Set([...credentialProfiles.values()].map((profile) => profile.host));

/**
 * The profiles whose upstream serves without a key, only slower — read from
 * the domain's connector registry (`keyless`), the one place that says so.
 *
 * With none configured, such a request goes upstream anonymously. The
 * registry, the account page and `check-evidence-connectors.mjs` all said
 * Semantic Scholar was keyless, while this gateway refused it with
 * `public_source_semantic_scholar_credential_missing` whenever no key was
 * set (36 refusals in a week, 2026-09-26 audit I1-3): the one path a hosted
 * run takes. A configured key is still sent, and a configured key that is
 * malformed is still refused — anonymous is the answer to "none", not to
 * "broken".
 * @param {string} profile @returns {boolean}
 */
function keylessProfile(profile) {
  return connectorCredentialSpec(profile)?.keyless === true;
}

/**
 * What a refused request tells the runtime, in the words the tool result will
 * carry to the model: which source, that the researcher can add it themselves,
 * and where. The title is the registry's, so the sentence is the same wherever
 * a profile is named. 设置 → 数据源 is the page's own name.
 * @param {string} profile
 */
function credentialMissingMessage(profile) {
  const title = connectorCredentialSpec(profile)?.title ?? profile;
  return `${title} is not configured for this deployment or this account; the user can add their own credential under 设置 → 数据源.`;
}

/**
 * Requests refused because a credential was missing, by source and why:
 * `absent` (the deployment and the account have none) or `unusable` (the
 * deployment configured one that could not be read — a file with the wrong
 * mode, a symlink, an unreadable path).
 *
 * The EviMed evidence key's file lost its group bit on 2026-09-22 and every
 * literature search fell back to PubMed for three days: 325 refusals, readiness
 * green (the credential check is informational), no alert, found by an audit
 * (I1-4). Module-level like `providerRefusals.mjs`: one process, one table,
 * read by `/api/ops/metrics`. Every profile's two series exist from the start
 * at zero, so the first refusal is an increase `increase()` can see.
 * @type {Map<string, Map<string, number>>}
 */
const credentialMissingCounts = new Map([...credentialProfiles.keys()].map((profile) => [profile, new Map([["absent", 0], ["unusable", 0]])]));

/**
 * @param {string} profile a credential profile of this gateway
 * @param {any} config
 * @returns {"absent" | "unusable"}
 */
function recordCredentialMissing(profile, config) {
  const spec = credentialProfiles.get(profile);
  const loadError = spec?.configValue ? config?.[`${spec.configValue}Error`] : config?.publicSourceCredentialErrors?.[spec?.configKey ?? ""];
  const reason = loadError ? "unusable" : "absent";
  const bySource = credentialMissingCounts.get(profile);
  if (bySource) bySource.set(reason, (bySource.get(reason) ?? 0) + 1);
  return reason;
}

/**
 * The counts as the operator's metric family (alerts
 * `PublicSourceCredentialUnusable`, `EvimedEvidenceRefused`).
 * @returns {{ name: string, help: string, type: "counter", series: Array<{ value: number, labels: Record<string, string> }> }}
 */
export function publicSourceCredentialMissingMetricFamily() {
  return {
    name: "open_science_public_source_credential_missing_total",
    help: "Public-source requests refused for a missing credential, by source and reason: absent (none configured for the deployment or the account) or unusable (the deployment configured one that could not be read).",
    type: "counter",
    series: [...credentialMissingCounts].flatMap(([source, byReason]) => [...byReason]
      .map(([reason, value]) => ({ value, labels: { source, reason } }))),
  };
}

/**
 * Credentials that raise a rate ceiling rather than grant access.
 *
 * NCBI E-utilities answers without a key at 3 requests/second and with one at
 * 10; openFDA gives 1,000 requests/day per IP without a key and 120,000 with.
 * Both are optional by the upstream's own design, so they must NOT go in
 * `credentialProfiles`: a host listed there is *required* to carry a profile
 * (see `credentialHosts` below), and adding these two would have turned every
 * PubMed and openFDA call the runtime already makes into a 403.
 *
 * Injected by host, only when configured, and never announced to the runtime —
 * which is what keeps a rate-limit key out of the container the same way an
 * authorizing one is.
 * `connector` is the registry id the researcher saves their own key under: the
 * deployment's key goes first, and where it has none the requesting
 * researcher's own is sent — a value they saved that nothing used until
 * 2026-10-04.
 * @type {Map<string, { configKey: string, connector: string, query: string }>}
 */
const optionalRateCredentials = new Map([
  ["eutils.ncbi.nlm.nih.gov", { configKey: "ncbi", connector: "ncbi", query: "api_key" }],
  ["api.fda.gov", { configKey: "openFda", connector: "openfda", query: "api_key" }],
]);


// Every content type a connector may ask for. The set is here and the asks are
// in `public_sources.py` and `science_connectors.py`, so a connector that
// learns a new one and this set that does not are a 400 on every call --
// `application/csv` was exactly that: the FRED connector was corrected to
// accept what FRED actually serves, and every `get_fred_series` call was
// refused by this list before it reached FRED at all.
// `test/publicSourceGateway.test.mjs` reads the asks back out of the connectors
// and requires them to be covered.
const allowedAcceptTypes = new Set([
  "application/atom+xml",
  "application/csv",
  "application/gzip",
  "application/json",
  "application/sparql-results+json",
  "application/xml",
  "text/json",
  "text/plain",
  "text/csv",
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
  // v2. Verified live against the deployment's own key on 2026-08-27, all five
  // shapes returning real records. v1 still answers and is kept: nothing is
  // gained by breaking a working path, and the two coexist upstream.
  //
  // What v2 adds is not convenience. `literature-guide` returns a guide's
  // `fullText` and, with `searchBlock`, its text blocks -- the first source of
  // guideline prose this deployment can quote verbatim instead of citing as an
  // index record. `instruction` returns NMPA label text directly, where the
  // public site answers 412 behind a WAF. `clinical-trial` reaches ChiCTR
  // (registry 0), which refuses direct scraping with 405, and Cochrane CENTRAL
  // (registry 2), which is otherwise a paid subscription answering 403.
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/v2/literature-guide", {
    fields: new Set([
      "query", "type", "useLlm", "searchBlock", "count", "startYear", "endYear",
      "articleTypes", "hasPdf", "language", "minImpactFactor", "maxImpactFactor",
      "journalTiers", "publishers",
    ]),
    maxCount: 100,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/v2/instruction", {
    fields: new Set(["query", "useLlm", "count", "source"]),
    maxCount: 200,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/review/api/v2/clinical-trial", {
    fields: new Set([
      "query", "count", "registry", "startYear", "endYear", "status", "phase",
      "studyType", "hasArticles", "source", "minSampleSize", "maxSampleSize",
    ]),
    maxCount: 100,
  }],
  ["www.evimed.com/api-evimed/medicine-api/ai-api/search/api/evidence", {
    fields: new Set(["query"]),
  }],
]);
for (const endpoint of evimedPostEndpoints.keys()) allowedPostEndpoints.add(endpoint);

/**
 * The EU CTIS trial search, the one POST approved on `euclinicaltrials.eu`: a
 * read of a public register whose body is data (a page, a sort and criteria),
 * never a command. The shape is the one the portal's own search page sends
 * (recorded 2026-10-04); a field it does not know is refused here rather than
 * passed on, because the portal answers a body it does not understand with a
 * `200` and no rows.
 */
const ctisPostEndpoints = new Set(["euclinicaltrials.eu/ctis-public-api/search"]);
for (const endpoint of ctisPostEndpoints) allowedPostEndpoints.add(endpoint);
const CTIS_TEXT_CRITERIA = Object.freeze([
  "containAll", "containAny", "containNot", "title", "number", "medicalCondition", "sponsor", "productName", "endPoint", "eudraCtCode",
]);
const CTIS_CODE_CRITERIA = Object.freeze(["status", "trialPhaseCode", "ageGroupCode", "therapeuticAreaCode", "sponsorTypeCode", "msc"]);
const CTIS_BOOLEAN_CRITERIA = Object.freeze(["hasStudyResults", "hasClinicalStudyReport", "isLowIntervention"]);

/** @param {unknown} body */
function validCtisSearchBody(body) {
  const value = /** @type {Record<string, any>} */ (body);
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !["pagination", "sort", "searchCriteria"].includes(key))) return false;
  const pagination = value.pagination;
  if (pagination == null || typeof pagination !== "object" || Array.isArray(pagination)
    || Object.keys(pagination).some((key) => !["page", "size"].includes(key))
    || !Number.isSafeInteger(pagination.page) || pagination.page < 1 || pagination.page > 10_000
    || !Number.isSafeInteger(pagination.size) || pagination.size < 1 || pagination.size > 100) return false;
  const sort = value.sort;
  if (sort !== undefined && (sort == null || typeof sort !== "object" || Array.isArray(sort)
    || Object.keys(sort).some((key) => !["property", "direction"].includes(key))
    || !["decisionDate", "ctStatus", "endDate"].includes(sort.property) || !["ASC", "DESC"].includes(sort.direction))) return false;
  const criteria = value.searchCriteria;
  if (criteria == null || typeof criteria !== "object" || Array.isArray(criteria)) return false;
  for (const [key, entry] of Object.entries(criteria)) {
    if (CTIS_TEXT_CRITERIA.includes(key)) {
      if (typeof entry !== "string" || entry.length > 512 || /[\r\n\0]/.test(entry)) return false;
    } else if (CTIS_CODE_CRITERIA.includes(key)) {
      if (!Array.isArray(entry) || entry.length > 20 || entry.some((code) => !Number.isSafeInteger(code) || code < 0 || code > 100_000)) return false;
    } else if (CTIS_BOOLEAN_CRITERIA.includes(key)) {
      if (typeof entry !== "boolean") return false;
    } else return false;
  }
  return true;
}

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

function sendError(res, error, onFailure) {
  const status = Number.isSafeInteger(error?.status) ? error.status : 502;
  const code = typeof error?.code === "string" ? error.code : "public_source_gateway_unavailable";
  // See the note in modelGateway.sendError: report before answering, so that a
  // wave of upstream 502s leaves a trace on this side and not only in the
  // container that asked.
  if (typeof onFailure === "function") {
    onFailure({ code, status, truncated: res.headersSent && !res.writableEnded, upstream: error?.upstream ?? null });
  }
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) {
      // Part of a body is already on its way. End the connection after what was
      // written has been sent and without the response's terminator, so the
      // reader sees a body that stops early rather than one that ended; a plain
      // destroy() would also discard the part that was written.
      const socket = res.socket;
      if (socket && !socket.destroyed) socket.end();
      else res.destroy();
    }
    return;
  }
  const message = error instanceof PublicSourceGatewayError
    ? error.message
    : "The public-source gateway is temporarily unavailable.";
  // What the runtime needs to act on a refusal it did not cause: how long the
  // source asked it to wait, and the status the source itself answered. Both
  // are numbers the gateway read off a response; neither is the source's text.
  const retryAfter = Number.isSafeInteger(error?.retryAfterSeconds) ? error.retryAfterSeconds : null;
  const upstreamStatus = Number.isSafeInteger(error?.upstream?.status) ? error.upstream.status : null;
  const body = Buffer.from(JSON.stringify({
    error: {
      code, message,
      ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}),
      ...(upstreamStatus !== null ? { upstreamStatus } : {}),
    },
  }));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    ...(retryAfter !== null ? { "retry-after": String(retryAfter) } : {}),
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


/**
 * The closed vocabularies the EviMed evidence API accepts for its array
 * filters, in its own (Chinese) labels. `literature_search` offers exactly these
 * as enums (evimedMcp.test.mjs holds the two equal): when the tool took any
 * string, a model asked for "Randomized Controlled Trial", the API refused the
 * whole search as malformed and the tool fell back to another endpoint.
 */
export const EVIMED_ENUMERATED_FILTERS = Object.freeze({
  articleTypes: Object.freeze([
    "系统综述/Meta分析", "指南/共识", "传统综述", "随机对照试验", "临床试验", "队列研究",
    "病例对照研究", "横断面研究", "病例系列", "病例报告", "经济学评价", "专家意见和评价",
    "动物实验", "体外实验", "其他",
  ]),
  journalTiers: Object.freeze(["北大核心", "科技核心", "南大核心"]),
});

function validEvimedEnumArray(value, allowed) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((item) => allowed.has(item));
}

const doiPattern = /^10\.\d{4,9}\/[\x21-\x7e]{1,180}$/;

// Open-access PDFs sit on the publisher's own domain — a sample of twelve
// open-access papers resolved to twelve different hosts — so no host allowlist
// can reach them. The runtime therefore never names a host for these: it sends
// a DOI, and the server resolves it against Unpaywall and fetches whatever
// Unpaywall vouches for. Arbitrary egress stays impossible because the runtime
// cannot choose the destination.
function validatedOpenAccessPdfRequest(value) {
  if (Object.keys(value).some((key) => key !== "openAccessPdfDoi" && key !== "parse") || (value.parse !== undefined && typeof value.parse !== "boolean")) {
    throw gatewayError(
      400,
      "public_source_gateway_field_invalid",
      "An open-access PDF request carries only a DOI and, optionally, parse: true.",
    );
  }
  const doi = String(value.openAccessPdfDoi ?? "").trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "");
  if (!doiPattern.test(doi)) {
    throw gatewayError(400, "public_source_gateway_doi_invalid", "The open-access DOI is invalid.");
  }
  return { mode: "open-access-pdf", doi, parse: value.parse === true };
}

/** Reject anything that is not a routable public name before we fetch it.
 *
 * Unpaywall is trusted to name a publisher, not to be an oracle: a poisoned
 * record naming localhost or a link-local address would otherwise turn this
 * into a request forgery against the server's own network. */
function assertPublicHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  const privateName = !host
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host.endsWith(".arpa")
    || !host.includes(".");
  if (privateName || privateIpv4Address(host) || host.includes(":")) {
    throw gatewayError(403, "public_source_pdf_host_forbidden", "The open-access PDF host is not publicly routable.");
  }
}

/** And the same question of the addresses the name actually resolved to.
 *
 * A name is not an address. `assertPublicHostname` reads a string, and a string
 * that looks like a publisher is exactly what a record pointing at 127.0.0.1 or
 * at this network's metadata service looks like — there is nothing in
 * `pdfs.example.org` to reject. Every resolved address must be public, not just
 * the first: a name that answers with one public address and one private one is
 * the ordinary shape of this attack, and whichever the connection picks is not
 * ours to choose.
 *
 * This is the early refusal, which names the location in the attempt list.
 * What makes it binding is the fetch: the PDF is read through the pinned web
 * transport (`webReadNetwork.mjs`), whose socket resolves the name again at
 * connect time, refuses the connection if any answer is private, and connects
 * to exactly the addresses it checked — so a name that answers "public" here
 * and "127.0.0.1" to the socket (DNS rebinding) reaches nothing. */
async function assertPublicAddresses(hostname, resolveImpl) {
  let records;
  try {
    records = await resolveImpl(hostname, { all: true });
  } catch {
    throw gatewayError(502, "public_source_pdf_host_unresolved", "The open-access PDF host did not resolve.");
  }
  const addresses = (Array.isArray(records) ? records : [records])
    .map((record) => String(record?.address ?? "").trim())
    .filter(Boolean);
  if (addresses.length === 0) {
    throw gatewayError(502, "public_source_pdf_host_unresolved", "The open-access PDF host did not resolve.");
  }
  for (const address of addresses) {
    const isPrivate = address.includes(":") ? privateIpv6Address(address) : privateIpv4Address(address);
    if (isPrivate) {
      throw gatewayError(403, "public_source_pdf_host_forbidden", "The open-access PDF host resolves inside this network.");
    }
  }
}

/**
 * A web read: one public page, any site. Nothing but the address crosses the
 * boundary; how it is fetched — robots, pacing, redirects, rendering, the
 * parser — is the gateway's (`webRead.mjs`).
 * @param {Record<string, unknown>} value
 */
function validatedWebReadRequest(value) {
  const read = /** @type {Record<string, unknown>} */ (value.webRead);
  if (
    Object.keys(value).some((key) => key !== "webRead")
    || read == null || typeof read !== "object" || Array.isArray(read)
    || Object.keys(read).some((key) => key !== "url")
    || typeof read.url !== "string"
  ) {
    throw gatewayError(400, "public_source_gateway_field_invalid", "A web-read request carries only { webRead: { url } }.");
  }
  return { mode: "web-read", url: read.url };
}

/**
 * Named downloads: a file a run needs whole that the buffered fetch cannot give
 * it, because the source builds it slowly or it is bigger than a JSON answer.
 *
 * Europe PMC assembles a paper's supplementary files into a zip as it streams
 * them — measured 2026-10-04: 33 s to the first byte and 136 s for 3.5 MB — and
 * DailyMed serves an older label version only as a zip. The runtime names the
 * kind and its identifiers, never a host or a path, the same rule as the
 * open-access PDF: it cannot use this to reach anywhere it chooses. The body
 * is relayed as it arrives, inside this gateway's one deadline and its byte
 * bound, and a stream that ends at either is cut short on the wire, so the
 * runtime reads a body that ends early instead of a short file that looks whole.
 *
 * `types` is what the source may answer with: `stream` is relayed, `small` is
 * read whole (bounded) and relayed as is. Europe PMC answers "not an open
 * access article" and "no supplementary files" as small XML with status 200,
 * and the runtime, which knows that wire, is the one that reads them.
 */
const SMALL_DOWNLOAD_BYTES = 64 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const downloadKinds = new Map([
  ["epmc-supplements", {
    params: { pmcid: (/** @type {unknown} */ value) => typeof value === "string" && /^PMC\d{3,12}$/.test(value) },
    url: (/** @type {Record<string, any>} */ { pmcid }) => new URL(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/supplementaryFiles`),
    types: new Map([["application/zip", "stream"], ["application/xml", "small"]]),
  }],
  ["dailymed-spl-zip", {
    params: {
      setid: (/** @type {unknown} */ value) => typeof value === "string" && uuidPattern.test(value),
      version: (/** @type {unknown} */ value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 1 && /** @type {number} */ (value) <= 100_000,
    },
    url: (/** @type {Record<string, any>} */ { setid, version }) => {
      const url = new URL("https://dailymed.nlm.nih.gov/dailymed/getFile.cfm");
      url.searchParams.set("setid", setid.toLowerCase());
      url.searchParams.set("type", "zip");
      url.searchParams.set("version", String(version));
      return url;
    },
    types: new Map([["application/zip", "stream"]]),
  }],
]);

/** @param {Record<string, unknown>} value */
function validatedDownloadRequest(value) {
  const download = /** @type {Record<string, any>} */ (value.download);
  const kind = download && typeof download === "object" && !Array.isArray(download) ? downloadKinds.get(download.kind) : undefined;
  if (
    Object.keys(value).some((key) => key !== "download")
    || !kind
    || Object.keys(download).some((key) => key !== "kind" && !(key in kind.params))
    || Object.keys(kind.params).some((key) => !kind.params[key](download[key]))
  ) {
    throw gatewayError(400, "public_source_gateway_field_invalid", "A download request names a known kind and exactly its identifiers.");
  }
  const params = Object.fromEntries(Object.keys(kind.params).map((key) => [key, download[key]]));
  const url = kind.url(params);
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw gatewayError(403, "public_source_gateway_url_forbidden", "The public-source URL is not an approved official endpoint.");
  }
  return { mode: "download", kind: download.kind, types: kind.types, url };
}

/**
 * A hand-off of preserved files to source intake (`sourceIntakeHandoff.mjs`):
 * a preserved path per file and one group label, never a destination.
 * @param {Record<string, unknown>} value
 */
function validatedSourceIntakeRequest(value) {
  const intake = /** @type {Record<string, any>} */ (value.sourceIntake);
  if (
    Object.keys(value).some((key) => key !== "sourceIntake")
    || intake == null || typeof intake !== "object" || Array.isArray(intake)
    || Object.keys(intake).some((key) => key !== "group" && key !== "files")
    || typeof intake.group !== "string" || !Array.isArray(intake.files)
  ) {
    throw gatewayError(400, "public_source_gateway_field_invalid", "A source-intake request carries only { sourceIntake: { group, files } }.");
  }
  return { mode: "source-intake", group: intake.group, files: intake.files };
}

function validatedRequest(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError(400, "public_source_gateway_body_invalid", "The public-source request must be an object.");
  }
  if (value.sourceIntake !== undefined) return validatedSourceIntakeRequest(value);
  if (value.openAccessPdfDoi !== undefined) return validatedOpenAccessPdfRequest(value);
  if (value.webRead !== undefined) return validatedWebReadRequest(value);
  if (value.download !== undefined) return validatedDownloadRequest(value);
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
  const apiPrefixes = apiPathPrefixes.get(hostname);
  if (apiPrefixes) {
    if (!apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      throw gatewayError(403, "public_source_api_path_forbidden", "The API path is not approved on this host.");
    }
    if (method !== "GET" && !ctisPostEndpoints.has(`${hostname}${url.pathname}`)) {
      throw gatewayError(403, "public_source_api_request_forbidden", "This host is approved for read-only API requests.");
    }
    if (method === "GET" && hostname === "euclinicaltrials.eu" && !ctisRetrievePath.test(url.pathname)) {
      throw gatewayError(403, "public_source_api_path_forbidden", "Only a trial's record, by its EU CT number, is approved on this host.");
    }
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
  // The same rule for the rate-ceiling keys. Skipping injection when the
  // runtime already supplied one would have let a forged `api_key` ride
  // through untouched and bill someone else's quota -- the runtime does not
  // choose a credential here any more than it does above.
  const rateCredentialSpec = optionalRateCredentials.get(hostname);
  if (rateCredentialSpec && [...url.searchParams.keys()].some((key) => key.toLowerCase() === rateCredentialSpec.query.toLowerCase())) {
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
  if (ctisPostEndpoints.has(endpoint)) {
    if (!validCtisSearchBody(body)) {
      throw gatewayError(400, "public_source_gateway_body_invalid", "The EU CTIS search request is invalid.");
    }
    return { url, accept: [...new Set(value.accept)], method, body, credentialProfile };
  }
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
    for (const [name, values] of Object.entries(EVIMED_ENUMERATED_FILTERS)) {
      if (body[name] !== undefined && !validEvimedEnumArray(body[name], new Set(values))) {
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

/**
 * The whole seconds a source's Retry-After asks for (a number of seconds or an
 * HTTP date), bounded to an hour; null when it sent nothing a client can use.
 * Passed to the runtime so it can wait inside its own deadline, or stop and say
 * how long the source asked for, instead of retrying into a refusal.
 * @param {string | null | undefined} value @param {number} [now]
 * @returns {number | null}
 */
export function retryAfterSecondsOf(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Math.min(Number(text), 3600);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.min(Math.max(Math.ceil((at - now) / 1000), 0), 3600) : null;
}

/**
 * An upstream that answered with a refusal, as the gateway's error: a source
 * that said no to this caller (401 or 403) is `public_source_gateway_upstream_denied`
 * (retrying cannot help), one that rate limits is `..._rate_limited`, and the
 * rest are `..._upstream_error`. The HTTP status the runtime sees is unchanged
 * (`mappedUpstreamStatus`); the code is what names the three apart.
 * @param {{ status: number, headers: Headers }} upstream @param {string} host
 */
function upstreamRefusal(upstream, host) {
  const denied = upstream.status === 401 || upstream.status === 403;
  const retryAfter = retryAfterSecondsOf(upstream.headers?.get?.("retry-after"));
  return Object.assign(gatewayError(
    mappedUpstreamStatus(upstream.status),
    upstream.status === 429 ? "public_source_gateway_rate_limited"
      : denied ? "public_source_gateway_upstream_denied" : "public_source_gateway_upstream_error",
    denied
      ? `The official public source refused this request (HTTP ${upstream.status}).`
      : `The official public source returned HTTP ${upstream.status}.`,
  ), { upstream: { host, status: upstream.status }, ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}) });
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

/** Resolve a DOI to its open-access PDF and stream it back.
 *
 * Europe PMC only serves full text for the PMC subset, which is why syntheses
 * kept ending with more eligible records than readable ones. Unpaywall knows
 * where the rest are, but on the publisher's own domain, so the resolution has
 * to happen here rather than in the runtime. */
async function serveOpenAccessPdf(request, {
  config, res, fetchImpl, resolveImpl, pdfTransport, signal, documentParser, capturePdf = null, userId = null, connectorCredentials = null,
}) {
  let email = String(config.publicSourceCredentials?.unpaywall ?? "").trim();
  // The deployment's address first, like every other source; where it has none,
  // the researcher's own — the one they saved under 设置 → 数据源, which this
  // path never read.
  if (!email && connectorCredentials && typeof userId === "string" && userId) {
    email = String(await connectorCredentials.resolveOwn(userId, "unpaywall") ?? "").trim();
  }
  if (!email || email.length > 8 * 1024 || /[\r\n\0]/.test(email)) {
    recordCredentialMissing("unpaywall", config);
    throw gatewayError(503, "public_source_unpaywall_credential_missing", credentialMissingMessage("unpaywall"));
  }
  const lookup = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(request.doi)}`);
  lookup.searchParams.set("email", email);

  let record;
  try {
    const response = await fetchImpl(lookup, {
      headers: { accept: "application/json", "user-agent": "EviMed-Research/1.2 (server public-source gateway)" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      throw Object.assign(gatewayError(
        mappedUpstreamStatus(response.status),
        response.status === 404 ? "public_source_pdf_not_open_access" : "public_source_gateway_upstream_error",
        `Unpaywall returned HTTP ${response.status} for this DOI.`,
      ), { upstream: { host: lookup.hostname, status: response.status } });
    }
    record = JSON.parse(new TextDecoder().decode(await readBoundedBody(response.body, 2 * 1024 * 1024)));
  } catch (error) {
    if (error instanceof PublicSourceGatewayError) throw error;
    throw gatewayError(502, "public_source_gateway_upstream_unavailable", "The open-access index is temporarily unavailable.");
  }

  // Unpaywall usually lists the same article in several places, and the first
  // one is routinely unusable: publishers are recorded over plain http and many
  // answer a non-browser request with 403. Repository copies are https and
  // serve the file, so try every location rather than judging the article by
  // whichever one happens to be listed first.
  const candidates = [record?.best_oa_location, ...(Array.isArray(record?.oa_locations) ? record.oa_locations : [])]
    .filter((location) => typeof location?.url_for_pdf === "string" && location.url_for_pdf.startsWith("https://"))
    .sort((left, right) => Number(right.host_type === "repository") - Number(left.host_type === "repository"));
  const seen = new Set();
  const attempts = [];
  const maxBytes = Math.max(1024, Number(config.publicSourceGatewayMaxResponseBytes) || 16 * 1024 * 1024);

  for (const candidate of candidates) {
    if (seen.has(candidate.url_for_pdf) || seen.size >= 4) continue;
    seen.add(candidate.url_for_pdf);
    let target;
    try {
      target = new URL(candidate.url_for_pdf);
    } catch {
      attempts.push("unusable location");
      continue;
    }
    if (target.username || target.password || target.port) {
      attempts.push(`${target.hostname}: not an approved URL`);
      continue;
    }
    try {
      assertPublicHostname(target.hostname);
      await assertPublicAddresses(target.hostname, resolveImpl);
    } catch (error) {
      attempts.push(`${target.hostname}: ${
        error?.code === "public_source_pdf_host_unresolved" ? "did not resolve" : "not publicly routable"
      }`);
      continue;
    }
    // Through the pinned transport, like every hop of a web read: the socket
    // connects only to addresses checked at connect time, never follows a
    // redirect, and stops reading at the size limit.
    let upstream;
    try {
      upstream = await pdfTransport({
        url: target,
        headers: { accept: "application/pdf", "user-agent": "EviMed-Research/1.2 (server public-source gateway)" },
        signal,
        maxBytes,
      });
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code === "web_read_response_too_large") {
        throw gatewayError(502, "public_source_gateway_response_too_large", "The official public-source response exceeded the gateway limit.");
      }
      attempts.push(`${target.hostname}: ${
        code === "web_read_host_forbidden" ? "not publicly routable"
          : code === "web_read_host_unresolved" ? "did not resolve"
            : "unreachable"
      }`);
      continue;
    }
    if (upstream.status < 200 || upstream.status > 299) {
      attempts.push(`${target.hostname}: HTTP ${upstream.status}`);
      continue;
    }
    const contentType = headerValue(upstream.headers, "content-type").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/pdf") {
      // A login wall or cookie interstitial answers with HTML and HTTP 200.
      attempts.push(`${target.hostname}: served ${contentType || "no"} content`);
      continue;
    }
    const buffer = upstream.body;
    const provenance = { doi: request.doi, origin: target.origin, version: String(candidate.version ?? ""), license: String(candidate.license ?? "") };
    const resource = capturePdf ? await capturePdf(buffer, provenance) : null;
    if (resource?.resourceId) res.setHeader("x-evimed-document-resource", resource.resourceId);
    if (request.parse) {
      await sendParsedPdf(res, buffer, provenance, documentParser, resource);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": String(buffer.length),
      "cache-control": "no-store",
      "x-evimed-oa-source": encodeURIComponent(target.origin),
      "x-evimed-oa-version": encodeURIComponent(String(candidate.version ?? "")),
      "x-evimed-oa-license": encodeURIComponent(String(candidate.license ?? "")),
    });
    res.end(buffer);
    return;
  }

  // Name every location that was tried, so an empty evidence base is a
  // reported outcome rather than a silent one.
  const detail = attempts.length ? ` Tried: ${attempts.join("; ")}.` : "";
  throw gatewayError(
    404,
    "public_source_pdf_not_open_access",
    `No open-access PDF could be retrieved for this DOI.${detail}`,
  );
}

/**
 * The "via parse" mode for an open-access PDF (plan §2.3): the bytes the
 * gateway just fetched go to the document parser, and the runtime receives the
 * text with the PDF beside it — so the runtime still holds no parser key and
 * names no host, and its pypdf text layer becomes the fallback for a
 * deployment (or a moment) without a parser rather than the only reader.
 *
 * A parser failure is not a gateway failure: the PDF was retrieved, and the
 * caller gets it with the parser's named reason so it can read the text layer
 * itself (principle 19).
 *
 * @param {import("node:http").ServerResponse} res @param {Buffer} buffer
 * @param {{ doi: string, origin: string, version: string, license: string }} provenance
 * @param {any} documentParser
 */
async function sendParsedPdf(res, buffer, provenance, documentParser, resource = null) {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  let parsed = null;
  let parseError = null;
  if (typeof documentParser?.parseBytes === "function") {
    try {
      const result = await documentParser.parseBytes({
        bytes: buffer,
        filename: `${provenance.doi.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96) || "open-access-article"}.pdf`,
        mediaType: "application/pdf",
        sha256,
      });
      parsed = {
        text: String(result?.text ?? ""),
        extractor: result?.extractor ?? null,
        ...(Array.isArray(result?.pageMap) ? { pageMap: result.pageMap } : {}),
        ...(result?.metadata && typeof result.metadata === "object" ? { metadata: result.metadata } : {}),
      };
    } catch (error) {
      const code = typeof error?.code === "string" && /^source_[a-z_]+$/.test(error.code) ? error.code : "source_parser_failed";
      parseError = { code, message: code === "source_parser_failed" ? "The document parser failed on this PDF." : String(error.message ?? code) };
    }
  } else {
    parseError = { code: "source_parser_unavailable", message: "This deployment has no document parser configured." };
  }
  const body = Buffer.from(JSON.stringify({
    pdf: { base64: buffer.toString("base64"), sha256, bytes: buffer.length, ...provenance, ...(resource ?? {}) },
    parsed,
    parseError,
  }));
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Write one chunk, waiting for the socket to drain; returns false when the
 * caller has gone, so the loop stops reading a body nobody is receiving.
 * @param {import("node:http").ServerResponse} res @param {Uint8Array} chunk
 */
async function relayChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  return new Promise((resolve) => {
    const finish = (/** @type {boolean} */ more) => { res.off("drain", onDrain); res.off("close", onClose); resolve(more); };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/**
 * Serve a named download: the upstream's body relayed as it arrives, inside the
 * request's deadline and `maxBytes`. The deadline is the AbortController's, armed
 * by the caller; a body that outlives it, or passes the bound, ends the response
 * on the wire without its terminator (see `sendError`), which the runtime reads
 * as a body cut short.
 * @param {{ kind: string, types: Map<string, string>, url: URL }} request
 * @param {{ res: import("node:http").ServerResponse, fetchImpl: typeof fetch, signal: AbortSignal, maxBytes: number }} context
 */
async function serveDownload(request, { res, fetchImpl, signal, maxBytes }) {
  const timedOut = () => signal.reason?.name === "TimeoutError";
  let upstream;
  try {
    upstream = await fetchImpl(request.url, {
      headers: { accept: [...request.types.keys()].join(", "), "user-agent": "EviMed-Research/1.2 (server public-source gateway)" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error instanceof PublicSourceGatewayError) throw error;
    if (timedOut()) throw gatewayError(504, "public_source_gateway_timeout", "The official public source timed out.");
    throw gatewayError(502, "public_source_gateway_upstream_unavailable", "The official public source is temporarily unavailable.");
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    throw upstreamRefusal(upstream, request.url.hostname);
  }
  const contentType = String(upstream.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const mode = request.types.get(contentType);
  if (!mode) {
    await upstream.body?.cancel().catch(() => {});
    throw gatewayError(502, "public_source_gateway_response_invalid", "The official public source returned an unexpected content type.");
  }
  const declared = Number(upstream.headers.get("content-length") ?? NaN);
  if (mode === "small") {
    let buffer;
    try {
      buffer = await readBoundedBody(upstream.body, SMALL_DOWNLOAD_BYTES);
    } catch (error) {
      if (!(error instanceof PublicSourceGatewayError) && timedOut()) {
        throw gatewayError(504, "public_source_gateway_timeout", "The official public source stopped sending its answer in time.");
      }
      throw error;
    }
    res.writeHead(200, { "content-type": contentType, "content-length": String(buffer.length), "cache-control": "no-store" });
    res.end(buffer);
    return;
  }
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel().catch(() => {});
    throw gatewayError(502, "public_source_gateway_response_too_large", "The official public-source response exceeded the gateway limit.");
  }
  if (!upstream.body) throw gatewayError(502, "public_source_gateway_response_invalid", "The official public source returned no readable body.");
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-evimed-download-kind": request.kind,
    // The source's own length, when it gives one, lets the runtime tell a body
    // that ended early from one that is whole.
    ...(Number.isFinite(declared) ? { "content-length": String(declared) } : {}),
  });
  const reader = upstream.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw gatewayError(502, "public_source_gateway_response_too_large", "The official public-source response exceeded the gateway limit.");
      }
      if (!(await relayChunk(res, value))) {
        // The caller left; the handler's close listener has aborted the fetch.
        await reader.cancel().catch(() => {});
        return;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    if (!(error instanceof PublicSourceGatewayError) && timedOut()) {
      throw gatewayError(504, "public_source_gateway_timeout", "The official public source stopped sending its answer in time.");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  res.end();
}

/**
 * @param {any} config
 * @param {any} runtimeManager
 * `pdfTransport` is how an open-access PDF is fetched: the deployment's web
 * transport (`webReadTransportFor`), or by default the pinned one resolving
 * through `resolveImpl` — never a plain fetch, whose socket resolves the name
 * again unchecked.
 * @param {{ fetchImpl?: typeof fetch, resolveImpl?: any, connectorCredentials?: any,
 *   webReader?: { read: (url: string, options: { signal?: AbortSignal, runtime?: { userId: string, projectId: string } }) => Promise<any> } | null,
 *   documentParser?: any, pdfTransport?: import("./webReadNetwork.mjs").WebTransport | null, capturePdf?: any, preparePdfCapture?: any,
 *   sourceIntake?: ((request: { identity: any, group: string, files: string[] }) => Promise<any>) | null }} [options]
 */
export function createPublicSourceGatewayHandler(config, runtimeManager, {
  fetchImpl = fetch, resolveImpl = dnsLookup, connectorCredentials = null, webReader = null, documentParser = null,
  pdfTransport = null, capturePdf = null, preparePdfCapture = null, sourceIntake = null,
} = {}) {
  const openAccessTransport = pdfTransport ?? nodeWebTransport({ resolveImpl });
  return async function publicSourceGatewayHandler(req, res, onFailure) {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
      sendError(res, gatewayError(404, "not_found", "Not found."), onFailure);
      return;
    }
    const controller = new AbortController();
    // A caller that hung up — its tool call given up, its run cancelled, its
    // runtime stopped — is owed nothing more, so what it started stops. A web
    // read otherwise held its slots for the rest of its 150 s budget with
    // nobody left to answer.
    res.once("close", () => {
      if (!res.writableFinished) controller.abort(new DOMException("The caller closed the request.", "AbortError"));
    });
    const timeoutMs = Math.max(1_000, Number(config.publicSourceGatewayTimeoutMs) || 60_000);
    const arm = (/** @type {number} */ ms) => {
      const timer = setTimeout(
        () => controller.abort(new DOMException("Public-source gateway timed out.", "TimeoutError")),
        ms,
      );
      timer.unref?.();
      return timer;
    };
    let timeout = arm(timeoutMs);
    try {
      const token = bearerToken(req);
      let identity;
      try {
        identity = runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "public_source_gateway_token_invalid", "Public-source gateway authentication failed.");
      }
      const request = validatedRequest(await readJsonBody(req, 16 * 1024));
      if (request.mode === "open-access-pdf") {
        const captureContext = preparePdfCapture ? await preparePdfCapture(identity) : null;
        await serveOpenAccessPdf(request, {
          config, res, fetchImpl, resolveImpl, pdfTransport: openAccessTransport, signal: controller.signal, documentParser,
          userId: typeof identity?.userId === "string" ? identity.userId : null, connectorCredentials,
          capturePdf: capturePdf ? (bytes, provenance) => {
            const current = runtimeManager.assertActiveModelGatewayToken(token);
            if (current.userId !== identity.userId || current.projectId !== identity.projectId) throw gatewayError(401, "public_source_gateway_token_invalid", "Public-source gateway authentication changed.");
            return preparePdfCapture && !captureContext ? null : capturePdf(current, bytes, provenance, captureContext,
              () => runtimeManager.assertActiveModelGatewayToken(token));
          } : null,
        });
        return;
      }
      if (request.mode === "source-intake") {
        if (typeof sourceIntake !== "function") {
          throw gatewayError(503, "public_source_gateway_unavailable", "Source intake is not available in this deployment.");
        }
        let answered;
        try {
          answered = await sourceIntake({ identity, group: request.group, files: request.files });
        } catch (error) {
          // The hand-off refuses what it cannot take by a status of its own
          // (a bad group or file list, a project that is not a library); the
          // gateway words that as a malformed request, never as a source failure.
          const status = Number.isSafeInteger(/** @type {any} */ (error)?.status) ? /** @type {any} */ (error).status : 500;
          if (status >= 400 && status < 500) throw gatewayError(400, "public_source_gateway_field_invalid", String(/** @type {any} */ (error).message ?? "The hand-off was refused."));
          throw gatewayError(503, "public_source_gateway_unavailable", "Source intake is temporarily unavailable.");
        }
        const body = Buffer.from(JSON.stringify(answered));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (request.mode === "download") {
        // A named download gets the budget of one whole tool call minus the
        // margin (config.mjs), not the buffered fetch's minute: that is the
        // difference between a slow source answering and a timeout every time.
        clearTimeout(timeout);
        timeout = arm(Math.max(1_000, Number(config.publicSourceDownloadTimeoutMs) || 150_000));
        await serveDownload(/** @type {{ kind: string, types: Map<string, string>, url: URL }} */ (request), {
          res, fetchImpl, signal: controller.signal,
          maxBytes: Math.max(1024, Number(config.publicSourceGatewayMaxResponseBytes) || 16 * 1024 * 1024),
        });
        return;
      }
      if (request.mode === "web-read") {
        if (config.webReadEnabled === false) {
          throw gatewayError(403, "web_read_disabled", "Web reading is switched off in this deployment.");
        }
        if (!webReader) throw gatewayError(503, "web_read_unavailable", "Web reading is not available in this deployment.");
        // A read may render a page and parse a PDF, so it gets its own budget —
        // one that still ends before the MCP tool call does (config.mjs).
        clearTimeout(timeout);
        timeout = arm(Math.max(1_000, Number(config.webReadTimeoutMs) || 150_000));
        let result;
        try {
          result = await webReader.read(request.url, {
            signal: controller.signal,
            runtime: { userId: String(identity?.userId ?? ""), projectId: String(identity?.projectId ?? "") },
          });
        } catch (error) {
          if (controller.signal.reason?.name === "TimeoutError") {
            throw gatewayError(504, "web_read_timeout", "The web page could not be read in time; try another source or retry later.");
          }
          if (error instanceof WebReadError) throw gatewayError(error.status === 499 ? 504 : error.status, error.code, error.message);
          throw gatewayError(502, "web_read_failed", "The web page could not be read.");
        }
        const body = Buffer.from(JSON.stringify(result));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(body.length),
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      let upstream;
      /**
       * How the credential profile was served, told back to the runtime so a
       * connector can say which tier answered (`x-evimed-credential-mode`):
       * `managed` with a key, `anonymous` on a keyless source's public tier.
       * @type {"managed" | "anonymous" | null}
       */
      let credentialMode = null;
      try {
        const upstreamHeaders = {
          accept: request.accept.join(", "),
          "user-agent": "EviMed-Research/1.2 (server public-source gateway)",
        };
        if (request.method === "POST") upstreamHeaders["content-type"] = "application/json";
        if (request.credentialProfile) {
          const profile = credentialProfiles.get(request.credentialProfile);
          let credential = String((profile.configValue
            ? config[profile.configValue]
            : config.publicSourceCredentials?.[profile.configKey]) ?? "").trim();
          // The deployment has none: the researcher's own, if they saved one.
          // Deployment first, always — a personal key fills a gap, it does not
          // override a deployment's decision about how a source is reached.
          if (!credential && connectorCredentials && typeof identity?.userId === "string") {
            credential = String(await connectorCredentials.resolveOwn(identity.userId, request.credentialProfile) ?? "").trim();
          }
          const anonymous = !credential && keylessProfile(request.credentialProfile)
            && !config.publicSourceCredentialErrors?.[profile.configKey ?? ""];
          if (!anonymous && (!credential || credential.length > 8 * 1024 || /[\r\n\0]/.test(credential))) {
            recordCredentialMissing(request.credentialProfile, config);
            throw gatewayError(
              503,
              connectorMissingCode(request.credentialProfile),
              credentialMissingMessage(request.credentialProfile),
            );
          }
          credentialMode = anonymous ? "anonymous" : "managed";
          if (anonymous) {
            // The upstream's public tier: nothing injected, its shared rate
            // limit applies (a 429 comes back as rate_limited, by name).
          } else if (profile.header) {
            upstreamHeaders[profile.header] = profile.scheme ? `${profile.scheme} ${credential}` : credential;
          } else {
            request.url.searchParams.set(profile.query, credential);
          }
        }
        const rateCredential = optionalRateCredentials.get(request.url.hostname.toLowerCase());
        /** Whether the key on this request is the researcher's own, which the upstream may refuse. */
        let ownRateKey = false;
        if (rateCredential) {
          let value = String(config.publicSourceCredentials?.[rateCredential.configKey] ?? "").trim();
          // The deployment has none: the researcher's own, if they saved one.
          // The key only lifts a rate ceiling, so a store that cannot be read
          // is the anonymous tier and never a failed request.
          if (!value && connectorCredentials && typeof identity?.userId === "string") {
            try {
              value = String(await connectorCredentials.resolveOwn(identity.userId, rateCredential.connector) ?? "").trim();
              ownRateKey = value !== "";
            } catch {
              value = "";
            }
          }
          // Absent is normal: these upstreams serve without a key, just slower.
          // A malformed one is not passed on -- a header-splitting value here
          // would travel to the upstream, and "we had no key" is the safe read.
          if (value && value.length <= 8 * 1024 && !/[\r\n\0]/.test(value)) {
            request.url.searchParams.set(rateCredential.query, value);
          } else {
            ownRateKey = false;
          }
        }
        const send = () => fetchImpl(request.url, {
          method: request.method,
          headers: upstreamHeaders,
          body: request.body ? JSON.stringify(request.body) : undefined,
          redirect: "error",
          signal: controller.signal,
        });
        upstream = await send();
        // A rate-ceiling key is optional by the upstream's own design, so a
        // researcher's mistyped one must not turn a request that works
        // anonymously into a failure — which, now that their saved key is sent,
        // it would. One retry without it; the deployment's own key is the
        // operator's to get right and is never retried around.
        if (ownRateKey && rateCredential && [400, 401, 403].includes(upstream.status)) {
          await upstream.body?.cancel().catch(() => {});
          request.url.searchParams.delete(rateCredential.query);
          upstream = await send();
        }
      } catch (error) {
        if (error instanceof PublicSourceGatewayError) throw error;
        if (controller.signal.reason?.name === "TimeoutError") {
          throw gatewayError(504, "public_source_gateway_timeout", "The official public source timed out.");
        }
        throw gatewayError(502, "public_source_gateway_upstream_unavailable", "The official public source is temporarily unavailable.");
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        // Which source said no, and how: 202 of these in twelve hours on
        // 2026-09-21 read only 「upstream_error」, which named neither. The
        // host and the status, never the URL — a credential can ride in its
        // query string.
        throw upstreamRefusal(upstream, request.url.hostname);
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
      let buffer;
      try {
        buffer = await readBoundedBody(upstream.body, maxBytes);
      } catch (error) {
        // The one deadline covers the body as well as the wait for it: a source
        // that answered and then stalled is a timeout (504), the same as one
        // that never answered, and not the generic 502 "unavailable".
        if (!(error instanceof PublicSourceGatewayError) && controller.signal.reason?.name === "TimeoutError") {
          throw gatewayError(504, "public_source_gateway_timeout", "The official public source stopped sending its answer in time.");
        }
        throw error;
      }
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": String(buffer.length),
        "cache-control": "no-store",
        ...(credentialMode ? { "x-evimed-credential-mode": credentialMode } : {}),
      });
      res.end(buffer);
    } catch (error) {
      sendError(res, error, onFailure);
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Which server-held public-source credentials this deployment has, for
 * `/api/ready`: configured or not, and from where — never the value.
 *
 * Informational by design. Every connector with a keyless tier still answers
 * without its key, so an absent credential is a fact about reach, not a reason
 * to refuse traffic, and this never fails readiness. It is here because one
 * absence was invisible and expensive: with no Unpaywall contact address the
 * gateway answers `public_source_unpaywall_credential_missing` before any
 * lookup, so a DOI with no Europe PMC copy can never be read at full text and
 * so can never carry a claim — and nothing an operator looks at said so
 * (review 2026-09-18, P0-7). `fullTextRoutes` states that consequence directly.
 *
 * @param {any} config
 * @returns {{ informational: true, credentials: Record<string, { configured: boolean, source: string, error?: string }>, unconfigured: string[], fullTextRoutes: string[] }}
 */
export function publicSourceCredentialReadiness(config) {
  const values = config?.publicSourceCredentials && typeof config.publicSourceCredentials === "object" ? config.publicSourceCredentials : {};
  const sources = config?.publicSourceCredentialSources ?? {};
  const errors = config?.publicSourceCredentialErrors ?? {};
  /** @type {Record<string, { configured: boolean, source: string, error?: string }>} */
  const credentials = {};
  for (const profile of Object.keys(values).sort()) {
    const configured = String(values[profile] ?? "").trim().length > 0;
    credentials[profile] = {
      configured,
      source: configured ? String(sources[profile] ?? "none") : "none",
      // A file that exists and could not be used (permissions, a symlink) is
      // the one case where "unconfigured" would mislead: someone tried.
      ...(errors[profile] ? { error: String(errors[profile]) } : {}),
    };
  }
  return {
    informational: true,
    credentials,
    unconfigured: Object.keys(credentials).filter((profile) => !credentials[profile].configured),
    fullTextRoutes: credentials.unpaywall?.configured ? ["europe-pmc", "unpaywall-open-access-pdf"] : ["europe-pmc"],
  };
}

export const PUBLIC_SOURCE_GATEWAY_PATH = gatewayPath;
export const PUBLIC_SOURCE_ALLOWED_HOSTS = allowedHosts;
export const PUBLIC_SOURCE_ALLOWED_POST_ENDPOINTS = allowedPostEndpoints;
export const PUBLIC_SOURCE_CREDENTIAL_PROFILES = credentialProfiles;
export const PUBLIC_SOURCE_ALLOWED_ACCEPT_TYPES = allowedAcceptTypes;
/** The named downloads the runtime may ask for; `source_transport.py` names the same kinds, and a test holds the two equal. */
export const PUBLIC_SOURCE_DOWNLOAD_KINDS = Object.freeze([...downloadKinds.keys()]);
