/**
 * Main text out of a web page, and whether the page is text at all.
 *
 * Hidden knowledge: why not a readability library. The five pages the plan
 * measured are a ClinicalTrials.gov record, a NICE guideline and three Chinese
 * regulators' notice lists. Mozilla-style readability scores paragraphs and
 * penalises link density, which is right for a news article and wrong for a
 * regulator's list page — there the content *is* a list of linked titles and
 * dates, and a link-density filter throws it away. The rule this replaces
 * (`official_pages.py`, 2026-09-18) kept block text inside `main`/`article`
 * and fell back to the body without navigation; on the pages it served that
 * was adequate, so it is kept, ported, and given what it lacked: a
 * spec-compliant parser (parse5, so broken markup and entities read the way a
 * browser reads them), tables as rows, list items as items, the page's links
 * returned beside the text (a list page is useless without them), and GBK
 * pages decoded as GBK.
 *
 * Whether a page needs rendering is decided here from closed facts only
 * (principle 5): the HTTP status, how much visible text there is, and a short
 * list of challenge vendors' own script markers. No prose is pattern-matched.
 *
 * @module webReadExtract
 */

import { parse } from "parse5";

/** Written into every receipt, so a snapshot says which rules produced it. */
export const HTML_EXTRACTOR = Object.freeze({ name: "evimed-html", version: "1.0.0" });

/**
 * Below this much visible text a page is an application shell, not a
 * document. Measured 2026-09-19: the ClinicalTrials.gov study page shows 175
 * characters before its script runs and 3,700+ after; the shortest real
 * regulator list page rendered to about 3,600; NICE's guideline page is 4,400
 * plain. A true short page that falls under this is merely rendered once more.
 */
export const SHELL_VISIBLE_CHARS = 300;

/** Statuses that WAFs and JavaScript challenges answer a plain client with
 *  (NMPA and NHC 412, CDE 403 and 202, measured 2026-09-19). A 404 or 500 is
 *  not one of them — a browser would get the same answer — and neither is a
 *  bare 429 or 503: "slow down" and "down" are not helped by one more request
 *  from a browser. With a vendor's marker in the body any status renders. */
const CHALLENGE_STATUSES = new Set([202, 403, 412]);

/**
 * Challenge vendors' own markers, as they appear in the challenge page's
 * script. A closed set of product fingerprints, not prose.
 */
const CHALLENGE_MARKERS = Object.freeze([
  ["ruishu", "$_ts=window['$_ts']"],            // 瑞数: NMPA, NHC (recorded 2026-09-19)
  ["cloudflare", "/cdn-cgi/challenge-platform/h/"],
  ["cloudflare", "cf-chl-"],
  ["aliyun-waf", "acw_sc__v2"],
  ["imperva", "_Incapsula_Resource"],
  ["datadome", "captcha-delivery.com"],
  ["sucuri", "sucuri_cloudproxy_js"],
]);

/** The most text one read returns; protects the gateway and the runtime's
 *  context from a page that is a data dump. */
export const MAX_EXTRACTED_CHARS = 2_000_000;
/** Links returned with one page; a list page needs its links, a portal's
 *  thousand navigation links are noise. */
const MAX_LINKS = 200;

const SKIPPED = new Set([
  "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "frame", "frameset",
  "object", "embed", "video", "audio", "picture", "img", "input", "select", "option", "optgroup",
  "textarea", "button", "datalist", "dialog", "head", "link", "meta", "base", "map", "area", "source",
  "track", "param",
]);
const BOILERPLATE = new Set(["nav", "header", "footer", "aside"]);
const BOILERPLATE_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "header", "hgroup", "hr", "html", "legend", "li", "main",
  "nav", "ol", "p", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** @param {any} node @param {string} name */
function attr(node, name) {
  const found = node?.attrs?.find((/** @type {any} */ item) => item.name === name);
  return found ? String(found.value) : null;
}

/** @param {any} node */
function hidden(node) {
  if (attr(node, "hidden") != null) return true;
  if (String(attr(node, "aria-hidden") ?? "").toLowerCase() === "true") return true;
  const style = String(attr(node, "style") ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** @param {any} node */
function boilerplate(node) {
  return BOILERPLATE.has(node.nodeName) || BOILERPLATE_ROLES.has(String(attr(node, "role") ?? "").toLowerCase());
}

/** @param {any} node */
function primary(node) {
  return node.nodeName === "main" || node.nodeName === "article" || String(attr(node, "role") ?? "").toLowerCase() === "main";
}

/** @param {string} value */
function collapsed(value) {
  return value.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** @param {any} root @param {(node: any) => boolean} predicate @returns {any[]} */
function findAll(root, predicate) {
  /** @type {any[]} */
  const found = [];
  /** @param {any} node */
  const walk = (node) => {
    for (const child of node?.childNodes ?? []) {
      if (child.nodeName === "#text" || child.nodeName === "#comment") continue;
      if (predicate(child)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** Visible characters under a node, by the same skipping rules as extraction. */
function visibleLength(node) {
  let total = 0;
  /** @param {any} current */
  const walk = (current) => {
    for (const child of current?.childNodes ?? []) {
      if (child.nodeName === "#text") total += String(child.value).replace(/\s+/g, "").length;
      else if (child.nodeName !== "#comment" && !SKIPPED.has(child.nodeName) && !hidden(child)) walk(child);
    }
  };
  walk(node);
  return total;
}

/**
 * The encoding a page's bytes are in: a BOM, then the Content-Type header,
 * then a `<meta charset>` in the first 4 KiB, then UTF-8. Chinese government
 * sites still serve GBK and say so only in the meta tag.
 * @param {Buffer} bytes @param {string} contentType @returns {string}
 */
export function pageCharset(bytes, contentType) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const supported = (/** @type {string | undefined} */ label) => {
    if (!label) return null;
    try {
      return new TextDecoder(label).encoding;
    } catch {
      return null;
    }
  };
  const declared = supported(/charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType ?? ""))?.[1]);
  if (declared) return declared;
  const head = bytes.subarray(0, 4096).toString("latin1");
  const meta = supported(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1]);
  return meta ?? "utf-8";
}

/** @param {Buffer} bytes @param {string} contentType @returns {string} */
export function decodePage(bytes, contentType) {
  return new TextDecoder(pageCharset(bytes, contentType)).decode(bytes);
}

/**
 * @typedef {object} ExtractedPage
 * @property {string} title
 * @property {string} text Markdown-shaped: `#` headings, `- ` items, `| a | b |` rows
 * @property {Array<{ text: string, url: string }>} links
 * @property {number} visibleChars
 * @property {boolean} truncated
 * @property {string | null} refreshUrl a `<meta http-equiv="refresh">` target, absolute
 */

/**
 * @param {string} html
 * @param {{ baseUrl: string | URL }} options
 * @returns {ExtractedPage}
 */
export function extractHtml(html, { baseUrl }) {
  /** @type {any} */
  const document = parse(String(html ?? ""));
  /** @type {any} */
  const htmlNode = document.childNodes.find((/** @type {any} */ node) => node.nodeName === "html");
  const head = htmlNode?.childNodes?.find((/** @type {any} */ node) => node.nodeName === "head");
  const body = htmlNode?.childNodes?.find((/** @type {any} */ node) => node.nodeName === "body") ?? htmlNode;

  let base;
  try {
    const declared = findAll(head, (node) => node.nodeName === "base")[0];
    base = new URL(attr(declared, "href") ?? "", baseUrl);
  } catch {
    base = new URL(String(baseUrl));
  }

  const titleNode = findAll(head, (node) => node.nodeName === "title")[0];
  let title = collapsed(titleNode?.childNodes?.map((/** @type {any} */ node) => node.value ?? "").join("") ?? "");
  if (!title) {
    const og = findAll(head, (node) => node.nodeName === "meta" && attr(node, "property") === "og:title")[0];
    title = collapsed(attr(og, "content") ?? "");
  }

  let refreshUrl = null;
  const refresh = findAll(head, (node) => node.nodeName === "meta" && String(attr(node, "http-equiv") ?? "").toLowerCase() === "refresh")[0];
  const refreshTarget = /url\s*=\s*['"]?([^'";]+)/i.exec(String(attr(refresh, "content") ?? ""))?.[1];
  if (refreshTarget) {
    try {
      refreshUrl = new URL(refreshTarget.trim(), base).href;
    } catch { /* an unparseable refresh is no redirect */ }
  }

  // The page's primary regions, outermost only, when they carry the text;
  // otherwise the body without its navigation furniture.
  const regions = findAll(body, primary).filter((node) => {
    for (let parent = node.parentNode; parent; parent = parent.parentNode) if (primary(parent)) return false;
    return true;
  });
  const regionText = regions.reduce((sum, node) => sum + visibleLength(node), 0);
  const roots = regionText >= 200 ? regions : [body];
  const skipFurniture = roots[0] === body;

  /** @type {Array<{ kind: string, text: string }>} */
  const blocks = [];
  /** @type {string[]} */
  let buffer = [];
  /** @type {Map<string, string>} */
  const links = new Map();

  /** @param {string} kind */
  const flush = (kind) => {
    const text = kind === "pre" ? buffer.join("").replace(/^\n+|\s+$/g, "") : collapsed(buffer.join(""));
    buffer = [];
    if (text) blocks.push({ kind, text });
  };

  /** Inline text of a table cell, blocks inside it joined by spaces. */
  const cellText = (/** @type {any} */ cell) => {
    const saved = buffer;
    buffer = [];
    visitChildren(cell, "cell", true);
    const text = collapsed(buffer.join(" ")).replace(/\n/g, " ").replace(/\|/g, "\\|");
    buffer = saved;
    return text;
  };

  /** @param {any} node @param {string} kind @param {boolean} inCell */
  function visitChildren(node, kind, inCell) {
    for (const child of node?.childNodes ?? []) visit(child, kind, inCell);
  }

  /** @param {any} node @param {string} kind the enclosing block's kind @param {boolean} inCell */
  function visit(node, kind, inCell) {
    if (node.nodeName === "#text") {
      // Source whitespace is a space, newlines included: only `<br>` breaks a
      // line, as in a browser. `pre` keeps its text as written.
      buffer.push(kind === "pre" ? String(node.value) : String(node.value).replace(/\s+/g, " "));
      return;
    }
    if (node.nodeName === "#comment" || SKIPPED.has(node.nodeName) || hidden(node)) return;
    if (skipFurniture && boilerplate(node)) return;
    const name = node.nodeName;
    if (name === "br") {
      buffer.push("\n");
      return;
    }
    if (name === "a") {
      const start = buffer.length;
      visitChildren(node, kind, inCell);
      const href = attr(node, "href");
      if (href && links.size < MAX_LINKS) {
        try {
          const target = new URL(href.trim(), base);
          target.hash = "";
          const text = collapsed(buffer.slice(start).join("")).replace(/\n/g, " ").slice(0, 160);
          if ((target.protocol === "https:" || target.protocol === "http:") && text && !links.has(target.href)) {
            links.set(target.href, text);
          }
        } catch { /* an unparseable href is no link */ }
      }
      return;
    }
    if (inCell) {
      // Inside a table cell every block is inline: a cell is one value.
      if (BLOCKS.has(name) || HEADINGS.has(name)) buffer.push(" ");
      visitChildren(node, kind, true);
      if (BLOCKS.has(name) || HEADINGS.has(name)) buffer.push(" ");
      return;
    }
    if (name === "tr") {
      flush(kind);
      const cells = (node.childNodes ?? [])
        .filter((/** @type {any} */ child) => (child.nodeName === "td" || child.nodeName === "th") && !hidden(child))
        .map(cellText);
      if (cells.some(Boolean)) blocks.push({ kind: "row", text: `| ${cells.join(" | ")} |` });
      return;
    }
    if (name === "pre") {
      flush(kind);
      visitChildren(node, "pre", false);
      flush("pre");
      return;
    }
    if (HEADINGS.has(name)) {
      flush(kind);
      visitChildren(node, name, false);
      flush(name);
      return;
    }
    if (name === "li" || name === "dt" || name === "dd") {
      flush(kind);
      visitChildren(node, "li", false);
      flush("li");
      return;
    }
    if (BLOCKS.has(name)) {
      flush(kind);
      visitChildren(node, "p", false);
      flush("p");
      return;
    }
    visitChildren(node, kind, false);
  }

  for (const root of roots) {
    visitChildren(root, "p", false);
    flush("p");
  }

  if (!title) title = blocks.find((block) => block.kind === "h1")?.text ?? "";

  /** @type {string[]} */
  const parts = [];
  let previous = null;
  let visibleChars = 0;
  for (const block of blocks) {
    const rendered = HEADINGS.has(block.kind)
      ? `${"#".repeat(Number(block.kind[1]))} ${block.text}`
      : block.kind === "li" ? `- ${block.text}` : block.text;
    // Consecutive repeats only: a table of dates legitimately repeats a value,
    // a template printing the same banner twice does not.
    if (previous && previous.rendered === rendered) continue;
    const tight = previous && (previous.kind === block.kind) && (block.kind === "li" || block.kind === "row");
    parts.push(previous ? (tight ? "\n" : "\n\n") : "", rendered);
    visibleChars += block.text.replace(/\s+/g, "").length;
    previous = { kind: block.kind, rendered };
  }
  let text = parts.join("");
  const truncated = text.length > MAX_EXTRACTED_CHARS;
  if (truncated) text = text.slice(0, MAX_EXTRACTED_CHARS);

  return {
    title: title.slice(0, 300),
    text,
    links: [...links.entries()].map(([url, linkText]) => ({ text: linkText, url })),
    visibleChars,
    truncated,
    refreshUrl,
  };
}

/** @param {string} html @returns {string | null} the vendor, when a challenge marker is present */
export function challengeVendor(html) {
  const head = String(html ?? "").slice(0, 256 * 1024);
  return CHALLENGE_MARKERS.find(([, marker]) => head.includes(marker))?.[0] ?? null;
}

/**
 * Whether a fetched HTML page needs a browser before it can be read, and why.
 *
 * - `challenge`: a vendor's JavaScript challenge (or a refusal status carrying
 *   one) — a browser that runs the script usually gets the page;
 * - `blocked`: a WAF status with no marker — what a plain client gets from a
 *   site that serves browsers (CDE's 403, 2026-09-19);
 * - `shell`: HTTP 200 but almost no visible text — an application that draws
 *   the document in script (ClinicalTrials.gov).
 *
 * A 2xx page with real text is never sent to a browser whatever scripts it
 * carries: Cloudflare injects its detection script into ordinary pages too.
 *
 * @param {{ status: number, html: string, visibleChars: number }} page
 * @returns {null | { kind: "challenge" | "blocked" | "shell", vendor: string | null }}
 */
export function renderReason({ status, html, visibleChars }) {
  const vendor = challengeVendor(html);
  if (status >= 200 && status < 300) {
    if (visibleChars >= SHELL_VISIBLE_CHARS) return null;
    return { kind: vendor ? "challenge" : "shell", vendor };
  }
  if (vendor) return { kind: "challenge", vendor };
  if (CHALLENGE_STATUSES.has(status)) return { kind: "blocked", vendor: null };
  return null;
}
