// The only way the public evidence pages put a value into HTML (flywheel F08, 2026-10-06).
//
// The pages are built by plain functions, with no template dependency, so what keeps a researcher's zone title or a source's address
// from becoming markup has to be structural rather than a habit: `html` is a tagged template that escapes every interpolated value
// unless the value is the result of another `html` call (or `raw`, which only this package's constants use), so a string that
// reaches a page without passing through here cannot be written by mistake — there is no other way to write it.
//
// Links are held to the same rule: `safeHref` admits an address only when it is an http or https URL without credentials, so a source
// whose address is `javascript:` renders as its title with no link at all.

/** @type {Record<string, string>} */
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text, safe both as an element's content and as a quoted attribute's value. @param {unknown} value */
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character]);

/** A fragment that is already HTML. */
export class SafeHtml {
  /** @param {string} value */
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/** Markup written by this package, never by a reader or an author. @param {string} value */
export const raw = (value) => new SafeHtml(value);

/** @param {unknown} value @returns {string} */
function render(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false || value === true) return "";
  return escapeHtml(value);
}

/**
 * Every `${}` is escaped unless it is a `SafeHtml` (or a list of them). A falsy `false`, `null` or `undefined` renders as nothing, so
 * `${cond && html`...`}` needs no ternary.
 * @param {TemplateStringsArray} strings @param {unknown[]} values
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let index = 0; index < values.length; index += 1) out += render(values[index]) + strings[index + 1];
  return new SafeHtml(out);
}

/**
 * The address a link may carry: http or https, no credentials, a bounded length — else null.
 * @param {unknown} value @returns {string | null}
 */
export function safeHref(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 2000) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href;
}

/**
 * A link to another page of ours: a path that starts with a single slash. Anything else is not a link.
 * @param {string} path @param {unknown} label @param {string} [className]
 */
export function pathLink(path, label, className = "") {
  return html`<a href="${path}"${className ? raw(` class="${escapeHtml(className)}"`) : ""}>${label}</a>`;
}

/**
 * A link to somewhere else: its address passes `safeHref` or the label stands alone. The reader's own words and the author's sources
 * are not endorsed by the platform, so the link says so to a search engine (`nofollow`).
 * @param {unknown} address @param {unknown} label
 */
export function externalLink(address, label) {
  const href = safeHref(address);
  return href ? html`<a href="${href}" rel="nofollow noopener noreferrer" target="_blank">${label}</a>` : html`${label}`;
}

/**
 * A day, as the platform's readers read it, from an instant in any form `Date` takes. An unreadable value is an empty string.
 * @param {unknown} value
 */
export function dayText(value) {
  if (!value) return "";
  const date = new Date(/** @type {any} */ (value));
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return parts;
}

/** `<time>` with the machine value in its attribute. @param {unknown} value */
export function timeTag(value) {
  const day = dayText(value);
  if (!day) return html``;
  return html`<time datetime="${new Date(/** @type {any} */ (value)).toISOString()}">${day}</time>`;
}
