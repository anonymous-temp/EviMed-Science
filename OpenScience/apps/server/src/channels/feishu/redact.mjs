/**
 * Keeping a bot's secret out of every line this module writes.
 *
 * Hidden knowledge: the SDK's own error logging is not safe to pass through.
 * Its `formatErrors` keeps an axios error's `config.data`, and the request
 * that fetches a tenant access token carries `{ app_id, app_secret }` in
 * exactly that field — so the default console logger prints the App Secret on
 * any failed token fetch. Vendor SDKs echoing credentials is not hypothetical
 * here: AgentBay's printed a rejected key into a session on 2026-09-19, and a
 * shape regex missed it because the key's shape was one nobody had seen.
 *
 * So two rules, both deliberately blunt: only picked fields of an error are
 * ever written (a code, a status, the provider's own code and message), and
 * every known secret is then replaced by its exact value, never by a pattern.
 *
 * @module channels/feishu/redact
 */

const REDACTED = "[redacted]";

/** Exact-value scrubbing for the secrets this process currently holds. */
export class SecretScrubber {
  constructor() {
    /** @type {Set<string>} */
    this.secrets = new Set();
  }

  /** @param {unknown} value */
  add(value) {
    // Anything shorter would redact ordinary words out of messages; no secret
    // this module holds (an App Secret is 32 characters) is that short.
    if (typeof value === "string" && value.length >= 12) this.secrets.add(value);
  }

  /** @param {unknown} value */
  delete(value) {
    if (typeof value === "string") this.secrets.delete(value);
  }

  /** @param {unknown} text @returns {string} */
  scrub(text) {
    let out = String(text ?? "");
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    return out;
  }
}

/**
 * One error as one bounded line: our code, the HTTP status, the provider's
 * code and message. Never the request, never the config, never a body.
 * @param {any} error @param {SecretScrubber} [scrubber]
 * @returns {string}
 */
export function describeError(error, scrubber) {
  const parts = [];
  if (typeof error === "string") parts.push(error);
  else if (error && typeof error === "object") {
    if (typeof error.code === "string" || typeof error.code === "number") parts.push(`code=${error.code}`);
    const status = error.response?.status ?? error.status;
    if (Number.isFinite(Number(status))) parts.push(`status=${Number(status)}`);
    const body = error.response?.data;
    if (body && typeof body === "object") {
      if (body.code != null) parts.push(`provider=${body.code}`);
      if (typeof body.msg === "string") parts.push(`msg=${body.msg}`);
    }
    if (typeof error.providerCode === "number") parts.push(`provider=${error.providerCode}`);
    if (typeof error.description === "string") parts.push(`description=${error.description}`);
    if (!parts.length && typeof error.message === "string") parts.push(error.message);
  }
  const line = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
  return scrubber ? scrubber.scrub(line) : line;
}

/**
 * The logger handed to the SDK. It receives the SDK's argument arrays and
 * writes only what `describeError` would, at warn and error level; the rest
 * is dropped because info and debug lines carry event bodies (message text)
 * the operator's log has no business holding.
 * @param {SecretScrubber} scrubber
 * @param {(line: string) => void} [write]
 */
export function sdkLogger(scrubber, write = (line) => { process.stderr.write(line); }) {
  const emit = (/** @type {string} */ level, /** @type {unknown} */ args) => {
    const items = Array.isArray(args) ? args.flat(2) : [args];
    const text = items.map((item) => (typeof item === "string" ? item : describeError(item, scrubber)))
      .join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
    if (text) write(`feishu sdk ${level}: ${scrubber.scrub(text)}\n`);
  };
  const quiet = () => {};
  return {
    error: (/** @type {unknown} */ args) => emit("error", args),
    warn: (/** @type {unknown} */ args) => emit("warn", args),
    info: quiet,
    debug: quiet,
    trace: quiet,
  };
}
