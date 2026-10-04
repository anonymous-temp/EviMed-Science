/**
 * One cheap, bounded question to a data source: does it accept this credential?
 *
 * Asked once, when a researcher saves a credential (`ConnectorCredentialStore.set`
 * through its injected `check`), so a typo or a revoked key shows beside the value
 * instead of surfacing three runs later as a source that answers nothing. It is
 * advice and never a gate: the credential is kept whatever the answer, because a
 * source that is down must not stop anyone saving and one that says no may be
 * wrong. The answer is one of
 *
 *   verified     the source answered the probe as an authenticated caller
 *   rejected     the source refused the credential itself (401/403, or the
 *                refusal its own answer carries)
 *   unreachable  no decisive answer: a timeout, a 5xx, a 429, a refusal that
 *                says nothing about the credential
 *   unchecked    this source has no trivial authenticated endpoint to ask
 *
 * and never carries the upstream's words — a vendor's error body can echo the
 * very key it rejected (NCBI does), so nothing the source says is read past the
 * one field that decides, and none of it is returned or logged.
 *
 * Each probe stays inside what the public-source gateway already approves for
 * the profile (host, path prefix) and authenticates exactly as the gateway does
 * (the profile's own header, scheme or query parameter), so a credential that
 * passes here is injected the same way when a run uses it. A source whose answer
 * to a bad credential is not known to be a refusal is left `unchecked` rather
 * than guessed: a false "verified" is worse than no verdict.
 */
import { PUBLIC_SOURCE_CREDENTIAL_PROFILES } from "./publicSourceGateway.mjs";

/** @typedef {"verified" | "rejected" | "unreachable" | "unchecked"} CredentialCheckState */

/** How long one probe may take. A check that waits longer is `unreachable`. */
export const CREDENTIAL_CHECK_TIMEOUT_MS = 5_000;

/** The most of a probe's body that is ever read, for the two that decide on it. */
const MAX_PROBE_BODY_BYTES = 64 * 1024;

/**
 * @typedef {object} Probe
 * @property {string} url the request, without its credential
 * @property {"GET" | "POST"} [method]
 * @property {Record<string, unknown>} [body] a JSON body, for a POST
 * @property {string} [query] the parameter the credential rides in, where the connector has no gateway profile
 * @property {readonly number[]} rejected the statuses that mean "this credential is not accepted"
 * @property {(body: any) => CredentialCheckState | null} [decide] a verdict read from the answer's body, where the status alone does not say
 */

/**
 * The cheap authenticated request of each connector that has one: shapes the
 * connectors' own tools already send in production, cut down to one record.
 * `decide` is only for the two that answer a refusal in a 200 body.
 * @type {ReadonlyMap<string, Probe>}
 */
const PROBES = new Map([
  // EviMed answers its own envelope: a 200 carries `code`, and a refused key is
  // `code: 401` or `403` there as well as in the status (`_evimed_post` reads it
  // the same way).
  ["evimed-evidence", {
    method: "POST",
    url: "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/literature",
    body: { query: "aspirin", count: 1 },
    rejected: [401, 403],
    decide: (body) => {
      const code = Number(body?.code);
      if (code === 200) return "verified";
      if (code === 401 || code === 403) return "rejected";
      return code ? "unreachable" : null;
    },
  }],
  ["semantic-scholar", { url: "https://api.semanticscholar.org/graph/v1/paper/search?query=aspirin&limit=1&fields=title", rejected: [401, 403] }],
  ["core", { url: "https://api.core.ac.uk/v3/search/works?q=aspirin&limit=1", rejected: [401, 403] }],
  // Unpaywall has no key: it identifies the caller by a contact address, and
  // refuses an address it will not accept (a placeholder domain) with 422.
  ["unpaywall", { url: "https://api.unpaywall.org/v2/10.1038/nature12373", rejected: [422] }],
  ["umls", { url: "https://uts-ws.nlm.nih.gov/rest/search/current?string=aspirin&pageSize=1", rejected: [401, 403] }],
  ["omim", { url: "https://api.omim.org/api/entry/search?search=cancer&limit=1&format=json", rejected: [401, 403] }],
  ["addgene", { url: "https://api.developers.addgene.org/catalog/plasmid/?name=GFP&page_size=1", rejected: [401, 403] }],
  ["opengwas", { url: "https://api.opengwas.io/api/gwasinfo?id=ieu-a-2", rejected: [401, 403] }],
  ["materials-project", { url: "https://api.materialsproject.org/materials/summary/?formula=Fe2O3&_limit=1&_fields=material_id", rejected: [401, 403] }],
  // The two rate-ceiling keys ride in `api_key` on a host that serves without
  // one, so they have no gateway profile. openFDA refuses a bad key with 403
  // (`API_KEY_INVALID`). NCBI's refusal is a 400, or an `error` field in the
  // answer; a key that only lifts a rate ceiling is still worth asking about,
  // because the gateway now sends it with every request.
  ["ncbi", {
    url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?db=pubmed&retmode=json",
    query: "api_key",
    rejected: [400, 401, 403],
    decide: (body) => (body && typeof body === "object" ? ("error" in body ? "rejected" : "verified") : null),
  }],
  ["openfda", { url: "https://api.fda.gov/drug/event.json?limit=1", query: "api_key", rejected: [401, 403] }],
  // BioGRID is deliberately absent: how its web service answers a bad access key
  // is not known to be a refusal, so it is `unchecked` rather than guessed.
]);

/** The connectors this module can ask about; every other one is `unchecked`. */
export const CHECKABLE_CONNECTORS = Object.freeze([...PROBES.keys()]);

/**
 * The probe a connector would send with a placeholder credential — for the
 * tests that hold each probe inside the gateway's approved surface.
 * @param {string} connector @param {string} [value]
 * @returns {{ url: URL, method: string, headers: Record<string, string>, body: string | undefined } | null}
 */
export function connectorProbeRequest(connector, value = "placeholder") {
  const probe = PROBES.get(connector);
  if (!probe) return null;
  const url = new URL(probe.url);
  /** @type {Record<string, string>} */
  const headers = { accept: "application/json", "user-agent": "EviMed-Research/1.2 (credential check)" };
  const profile = PUBLIC_SOURCE_CREDENTIAL_PROFILES.get(connector);
  if (profile?.header) headers[profile.header] = profile.scheme ? `${profile.scheme} ${value}` : value;
  else if (profile?.query ?? probe.query) url.searchParams.set(String(profile?.query ?? probe.query), value);
  if (probe.method === "POST") headers["content-type"] = "application/json";
  return { url, method: probe.method ?? "GET", headers, body: probe.body ? JSON.stringify(probe.body) : undefined };
}

/** @param {Response} response @returns {Promise<any>} the parsed body, or null when it is not bounded JSON */
async function boundedJson(response) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROBE_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Asks the connector's source whether it accepts the credential.
 *
 * Never throws and never returns anything the source said: the state is the
 * whole answer.
 * @param {string} connector a connector id
 * @param {string} value the credential, already shape-checked
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<CredentialCheckState>}
 */
export async function checkConnectorCredential(connector, value, { fetchImpl = globalThis.fetch, timeoutMs = CREDENTIAL_CHECK_TIMEOUT_MS } = {}) {
  const request = connectorProbeRequest(connector, value);
  if (!request || typeof fetchImpl !== "function") return "unchecked";
  const probe = /** @type {Probe} */ (PROBES.get(connector));
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
    });
    if (probe.decide && (response.ok || probe.rejected.includes(response.status))) {
      // The two sources that decide on their answer. A body that is not the
      // shape of a real answer decides nothing: a refusal status still says
      // no, and a 200 that is not their envelope is not a verification.
      const decided = probe.decide(await boundedJson(response));
      return decided ?? (probe.rejected.includes(response.status) ? "rejected" : "unreachable");
    }
    await response.body?.cancel().catch(() => {});
    if (probe.rejected.includes(response.status)) return "rejected";
    return response.ok ? "verified" : "unreachable";
  } catch {
    // A timeout, a refused connection, a redirect we do not follow: no answer.
    return "unreachable";
  }
}
