/**
 * robots.txt for web reading, read the way RFC 9309 says, with one deliberate
 * deviation.
 *
 * The deviation: RFC 9309 §2.3.1.4 asks a crawler that gets a server error, or
 * no answer at all, for robots.txt to assume complete disallow. Here those
 * outcomes allow the read. A `web_read` call is one page a researcher's run
 * asked for — what a person's browser would fetch — not a crawl, and the sites
 * that matter most answer every non-browser request, robots.txt included, with
 * a WAF page: on 2026-09-19 NMPA and NHC answered a plain GET with 412 and CDE
 * with 403. Failing closed on those would make the three most important Chinese
 * regulators unreadable for a reason that says nothing about what they want.
 * A robots.txt that was fetched and disallows the path is honoured, always;
 * 4xx means "no rules" exactly as the RFC says. Unreachable outcomes are cached
 * briefly so a failing robots.txt is not re-asked on every page.
 *
 * A robots.txt is written by whoever owns the site a run was steered to, so
 * its patterns are hostile input evaluated on the event loop. They used to be
 * compiled into backtracking RegExps (`*` → `.*`): `Disallow: /*a*a*a*a*b`
 * against a 220-character path held the loop for 16 s, and a few more
 * wildcards never finished (the 2026-09-20 release's security review).
 * Patterns are now matched in time linear in the path plus the pattern
 * whatever they contain, and the caps below bound how many of them one
 * verdict weighs.
 *
 * @module webReadRobots
 */

import { headerValue, validatedWebUrl, WEB_READ_MAX_URL_LENGTH, WebReadError } from "./webReadNetwork.mjs";

/** The product token robots.txt groups are matched against (RFC 9309 §2.2.1). */
export const WEB_READ_PRODUCT_TOKEN = "EviMedBot";

/** How long a fetched robots.txt is trusted. RFC 9309 §2.4 caps it at 24 h. */
const ROBOTS_TTL_MS = 60 * 60 * 1000;
/** How long an unreachable robots.txt is remembered as "no rules". */
const ROBOTS_ERROR_TTL_MS = 10 * 60 * 1000;
/** Origins remembered at once; bounds the cache's memory, oldest evicted first. */
const ROBOTS_MAX_ENTRIES = 2_000;
/** RFC 9309 §2.5 asks a parser to read at least 500 KiB; the parser reads no more. */
const ROBOTS_MAX_BYTES = 512 * 1024;
/**
 * Rules one group keeps, and the most one verdict weighs once the groups that
 * name us are combined (RFC 9309 §2.2.1) — so repeating `User-agent: *` does
 * not multiply the work either. Real files stay well below it: among the
 * longest in use, eBay's holds 953 rules for all its groups together, WHO's
 * 527, Wikipedia's 464 (fetched 2026-09-19). Rules past it are ignored, as the
 * RFC lets a parser ignore content past its size limit.
 */
const ROBOTS_MAX_RULES = 2_000;
/** A rule longer than any URL web reading accepts could match one only by
 *  padding itself with wildcards — the shape of an attack on the matcher, not
 *  of a site's rules — so it is ignored. */
const ROBOTS_MAX_PATTERN_LENGTH = WEB_READ_MAX_URL_LENGTH;
/** One robots.txt answer; it is small and on the page's own host. */
const ROBOTS_TIMEOUT_MS = 5_000;
/** RFC 9309 §2.3.1.2: follow at least five redirects. */
const ROBOTS_MAX_REDIRECTS = 5;
/** A Crawl-delay longer than this is capped rather than obeyed: one page read
 *  must still finish inside the tool's time budget. */
const MAX_CRAWL_DELAY_MS = 10_000;

/**
 * @typedef {object} RobotsRule
 * @property {boolean} allow
 * @property {string} pattern normalised: non-ASCII percent-encoded, escapes upper-cased
 */

/**
 * @typedef {object} RobotsGroup
 * @property {string[]} agents lower-cased user-agent values
 * @property {RobotsRule[]} rules
 * @property {number | null} crawlDelaySeconds
 */

/** @param {string} value */
function normalizedPath(value) {
  return String(value)
    .replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character))
    .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

/**
 * Groups and rules of a robots.txt body. Lines before any user-agent belong to
 * no group and are ignored; consecutive user-agent lines share one group.
 * @param {string} text
 * @returns {{ groups: RobotsGroup[] }}
 */
export function parseRobotsTxt(text) {
  /** @type {RobotsGroup[]} */
  const groups = [];
  /** @type {RobotsGroup | null} */
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? "").slice(0, ROBOTS_MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow is the conventional "everything is allowed", which
      // is what having no rule means.
      const pattern = value ? normalizedPath(value) : "";
      if (pattern && pattern.length <= ROBOTS_MAX_PATTERN_LENGTH && current.rules.length < ROBOTS_MAX_RULES) {
        current.rules.push({ allow: key === "allow", pattern });
      }
    } else if (key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return { groups };
}

/**
 * Where `piece` first occurs in `text` at or after `from`, or -1, by
 * Knuth–Morris–Pratt: linear in both lengths whatever characters they hold.
 * @param {string} text @param {string} piece @param {number} from
 */
function indexOfPiece(text, piece, from) {
  if (!piece) return from;
  const fallback = new Int32Array(piece.length);
  for (let index = 1, matched = 0; index < piece.length; index += 1) {
    while (matched > 0 && piece[index] !== piece[matched]) matched = fallback[matched - 1];
    if (piece[index] === piece[matched]) matched += 1;
    fallback[index] = matched;
  }
  for (let index = from, matched = 0; index < text.length; index += 1) {
    while (matched > 0 && text[index] !== piece[matched]) matched = fallback[matched - 1];
    if (text[index] === piece[matched]) matched += 1;
    if (matched === piece.length) return index - matched + 1;
  }
  return -1;
}

/**
 * RFC 9309 §2.2.3 matching: `*` is any run of characters, a final `$` anchors
 * the end, and otherwise a pattern matches as a prefix. The literal pieces
 * between wildcards are found left to right, each at its first place after the
 * one before — the earliest placement leaves the most room for the rest, so
 * this finds a match whenever one exists — and each search resumes where the
 * last one stopped, so the whole match costs O(path + pattern).
 * @param {string} pattern @param {string} path
 */
function patternMatches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = pieces[0];
  if (pieces.length === 1) return anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let position = first.length;
  for (let index = 1; index < pieces.length - 1; index += 1) {
    const found = indexOfPiece(path, pieces[index], position);
    if (found < 0) return false;
    position = found + pieces[index].length;
  }
  const last = pieces[pieces.length - 1];
  return anchored
    ? path.length - last.length >= position && path.endsWith(last)
    : indexOfPiece(path, last, position) >= 0;
}

/**
 * Whether one path may be read, by RFC 9309's matching: the groups naming our
 * product token (combined), else the `*` groups; the longest matching pattern
 * wins, and on a tie the allow — the least restrictive rule.
 *
 * @param {{ groups: RobotsGroup[] }} parsed
 * @param {{ path: string, productToken?: string }} target
 * @returns {{ allowed: boolean, crawlDelayMs: number | null }}
 */
export function robotsVerdict(parsed, { path, productToken = WEB_READ_PRODUCT_TOKEN }) {
  const token = productToken.toLowerCase();
  let groups = parsed.groups.filter((group) => group.agents.some((agent) => agent === token || agent.startsWith(`${token}/`)));
  if (groups.length === 0) groups = parsed.groups.filter((group) => group.agents.includes("*"));
  const delays = groups.map((group) => group.crawlDelaySeconds).filter((value) => value != null);
  const crawlDelayMs = delays.length ? Math.min(MAX_CRAWL_DELAY_MS, Math.max(...delays) * 1000) : null;
  const target = normalizedPath(path || "/");
  if (target === "/robots.txt") return { allowed: true, crawlDelayMs };
  /** @type {{ allow: boolean, length: number } | null} */
  let best = null;
  for (const rule of groups.flatMap((group) => group.rules).slice(0, ROBOTS_MAX_RULES)) {
    if (!patternMatches(rule.pattern, target)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return { allowed: best ? best.allow : true, crawlDelayMs };
}

/**
 * @typedef {object} RobotsCheck
 * @property {boolean} allowed
 * @property {number | null} crawlDelayMs
 * @property {"rules" | "none" | "unreachable"} source what the verdict rests on
 */

/**
 * Per-origin robots.txt, fetched through the same pinned transport as the page
 * itself (a robots.txt can redirect too), cached, with concurrent checks of one
 * origin sharing one fetch.
 */
export class RobotsPolicy {
  /**
   * @param {{ transport: import("./webReadNetwork.mjs").WebTransport, userAgent: string, now?: () => number,
   *   productToken?: string }} options
   */
  constructor({ transport, userAgent, now = Date.now, productToken = WEB_READ_PRODUCT_TOKEN }) {
    this.transport = transport;
    this.userAgent = userAgent;
    this.now = now;
    this.productToken = productToken;
    /** @type {Map<string, { expiresAt: number, parsed: { groups: RobotsGroup[] } | null, source: "rules" | "none" | "unreachable" }>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<{ parsed: { groups: RobotsGroup[] } | null, source: "rules" | "none" | "unreachable" }>>} */
    this.inflight = new Map();
    this.counts = { fetched: 0, unreachable: 0, disallowed: 0 };
  }

  /**
   * @param {URL} url
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<RobotsCheck>}
   */
  async check(url, { signal } = {}) {
    const origin = url.origin;
    let entry = this.entries.get(origin);
    if (!entry || entry.expiresAt <= this.now()) {
      let pending = this.inflight.get(origin);
      if (!pending) {
        pending = this.fetchRules(origin, signal).finally(() => this.inflight.delete(origin));
        this.inflight.set(origin, pending);
      }
      const fetched = await pending;
      entry = {
        ...fetched,
        expiresAt: this.now() + (fetched.source === "unreachable" ? ROBOTS_ERROR_TTL_MS : ROBOTS_TTL_MS),
      };
      this.entries.delete(origin);
      this.entries.set(origin, entry);
      while (this.entries.size > ROBOTS_MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
    }
    if (!entry.parsed) return { allowed: true, crawlDelayMs: null, source: entry.source };
    const verdict = robotsVerdict(entry.parsed, { path: `${url.pathname}${url.search}`, productToken: this.productToken });
    if (!verdict.allowed) this.counts.disallowed += 1;
    return { ...verdict, source: entry.source };
  }

  /**
   * @param {string} origin
   * @param {AbortSignal} [outer]
   * @returns {Promise<{ parsed: { groups: RobotsGroup[] } | null, source: "rules" | "none" | "unreachable" }>}
   */
  async fetchRules(origin, outer) {
    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(ROBOTS_TIMEOUT_MS)]) : AbortSignal.timeout(ROBOTS_TIMEOUT_MS);
    let target = new URL("/robots.txt", origin);
    try {
      for (let hop = 0; hop <= ROBOTS_MAX_REDIRECTS; hop += 1) {
        target = validatedWebUrl(target);
        const response = await this.transport({
          url: target,
          headers: { accept: "text/plain, */*;q=0.1", "user-agent": this.userAgent },
          signal,
          maxBytes: ROBOTS_MAX_BYTES,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = headerValue(response.headers, "location");
          if (!location) break;
          target = new URL(location, target);
          continue;
        }
        this.counts.fetched += 1;
        if (response.status >= 200 && response.status < 300) {
          const parsed = parseRobotsTxt(response.body.toString("utf8"));
          return { parsed, source: parsed.groups.length ? "rules" : "none" };
        }
        if (response.status >= 400 && response.status < 500) return { parsed: null, source: "none" };
        break;
      }
    } catch (error) {
      // A robots.txt the caller abandoned is not a verdict about the site.
      if (outer?.aborted) throw error;
      if (!(error instanceof WebReadError) && !(error?.name === "TimeoutError" || error?.name === "AbortError")) throw error;
    }
    this.counts.unreachable += 1;
    return { parsed: null, source: "unreachable" };
  }
}
