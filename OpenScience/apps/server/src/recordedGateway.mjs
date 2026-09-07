import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Replaying the outside world, so an evaluation measures the change and not the
 * weather.
 *
 * Hidden knowledge: a paired evaluation compares a baseline arm against a
 * candidate arm on the same tasks. If both arms reach live PubMed, they do not
 * see the same PubMed — an index updates, a rate limit fires, a DOI resolves on
 * one attempt and not the next — and the difference between the arms silently
 * includes the difference between two moments. Every run in an arm has to see
 * byte-identical upstream answers, and that is what this is.
 *
 * Three rules, and the first is the one that matters:
 *
 *  1. **A missing fixture is a failure, never a fall-through.** The tempting
 *     behaviour is "replay if we have it, otherwise fetch" — and that produces
 *     an evaluation that is mostly reproducible, which is worse than one that
 *     is not, because nobody can tell which parts were. A miss answers 599
 *     `fixture_missing` and the run reports it.
 *  2. **The key is the request, not the call site.** `sha256(method \n url \n
 *     body)`, so the same upstream request made by the control-plane gateway
 *     and by the MCP server in the container resolves to the same fixture. The
 *     MCP server implements this same derivation in Python; the two are held
 *     equal by a test that hashes the same triple on both sides.
 *  3. **Recording is a separate mode.** A run that records is a run that
 *     touched the network and must not be scored.
 *
 * @module recordedGateway
 */

/** Status used for a request no fixture covers. Outside the 5xx range the
 *  upstream code space uses, so it cannot be confused with a real failure. */
export const FIXTURE_MISSING_STATUS = 599;

/** Error code the runtime sees for a miss. */
export const FIXTURE_MISSING_CODE = "fixture_missing";

/**
 * The fixture key for one upstream request.
 *
 * Deliberately not the URL alone: two POSTs to the same endpoint with different
 * bodies are different requests, and a key that could not tell them apart would
 * replay the first answer for the second and look like a working fixture set.
 * @param {string} method
 * @param {string} url
 * @param {string} [body]
 * @returns {string}
 */
export function fixtureKey(method, url, body = "") {
  return createHash("sha256")
    .update(`${String(method ?? "GET").toUpperCase()}\n${String(url ?? "")}\n${String(body ?? "")}`, "utf8")
    .digest("hex");
}

/** @param {any} input @param {any} init @returns {{method: string, url: string, body: string}} */
function describeRequest(input, init) {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
  const raw = init?.body ?? null;
  const body = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  return { method, url, body };
}

/**
 * @typedef {object} FixtureRecord
 * @property {string} key
 * @property {string} method
 * @property {string} url
 * @property {number} status
 * @property {Record<string, string>} headers
 * @property {string} body
 * @property {string} [encoding]  "base64" for a binary body
 */

/**
 * A `fetch` that answers only from a fixture directory.
 *
 * @param {{fixturesDir?: string, recordDir?: string, fetchImpl?: typeof fetch, onMiss?: (request: {method: string, url: string}) => void}} options
 * @returns {typeof fetch}
 */
export function createRecordedFetch(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { fixturesDir, recordDir } = options;
  if (!fixturesDir && !recordDir) return fetchImpl;

  /** @type {typeof fetch} */
  const recorded = async (input, init) => {
    const request = describeRequest(input, init);
    const key = fixtureKey(request.method, request.url, request.body);

    if (fixturesDir) {
      let text;
      try {
        text = await readFile(path.join(fixturesDir, `${key}.json`), "utf8");
      } catch {
        options.onMiss?.(request);
        // Not a throw: the caller is a gateway that maps upstream status codes
        // to error codes, and it must see this as an upstream answer so the run
        // reports it the way it reports any other unavailable source.
        return new Response(JSON.stringify({
          error: FIXTURE_MISSING_CODE,
          message: `No recorded response for ${request.method} ${request.url}.`,
          key,
        }), { status: FIXTURE_MISSING_STATUS, headers: { "content-type": "application/json" } });
      }
      /** @type {FixtureRecord} */
      const record = JSON.parse(text);
      const body = record.encoding === "base64" ? Buffer.from(record.body, "base64") : record.body;
      return new Response(body, { status: record.status, headers: record.headers ?? {} });
    }

    const response = await fetchImpl(input, init);
    const buffer = Buffer.from(await response.clone().arrayBuffer());
    const headers = /** @type {Record<string, string>} */ ({});
    for (const [name, value] of response.headers) headers[name] = value;
    const contentType = String(headers["content-type"] ?? "");
    const binary = !/^(?:text\/|application\/(?:json|xml|xhtml))/i.test(contentType);
    /** @type {FixtureRecord} */
    const record = {
      key,
      method: request.method,
      url: request.url,
      status: response.status,
      headers,
      body: binary ? buffer.toString("base64") : buffer.toString("utf8"),
      ...(binary ? { encoding: "base64" } : {}),
    };
    await mkdir(/** @type {string} */ (recordDir), { recursive: true });
    await writeFile(path.join(/** @type {string} */ (recordDir), `${key}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return response;
  };
  return recorded;
}

/**
 * Read the two environment knobs and build the fetch the gateway should use.
 *
 * Both set at once is refused rather than resolved: "replay, and record what
 * you had to fetch" is precisely the fall-through rule 1 exists to forbid, and
 * an operator who sets both means one of the two.
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof fetch} [fetchImpl]
 * @returns {typeof fetch}
 */
export function resolveGatewayFetch(env = process.env, fetchImpl = fetch) {
  const fixturesDir = String(env.OPEN_SCIENCE_GATEWAY_FIXTURES ?? "").trim();
  const recordDir = String(env.OPEN_SCIENCE_GATEWAY_RECORD ?? "").trim();
  if (fixturesDir && recordDir) {
    throw new TypeError("Set OPEN_SCIENCE_GATEWAY_FIXTURES or OPEN_SCIENCE_GATEWAY_RECORD, never both: replaying while recording is the fall-through that makes an evaluation only partly reproducible.");
  }
  return createRecordedFetch({
    ...(fixturesDir ? { fixturesDir } : {}),
    ...(recordDir ? { recordDir } : {}),
    fetchImpl,
  });
}
