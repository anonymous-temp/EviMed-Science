/**
 * Which pages are 「官方来源」 — a label, not a permission.
 *
 * Until 2026-09-20 this list (host plus path prefixes, then called the
 * official-document allowlist) decided whether a page could be read at all:
 * `official_page_fetch` refused everything else, which is why search hits
 * outside twenty-odd hosts could never be read. `web_read` reads any public
 * page; the list now only says whether the page comes from an authority —
 * a regulator, a government health body, a guideline or evidence-review body,
 * a trial registry — which is what an evidence grade needs to know about it.
 * The reader sees the label on the 「已阅读的网页」 card; nothing is refused by
 * it and nothing is admitted by it.
 *
 * Two kinds of row. Government domains are official by registration
 * (`.gov`, `.gov.cn`, `.gov.uk`, `.europa.eu`, …): only a government body can
 * hold one, so a suffix rule is exact. Everything else is named host by host,
 * because a `.org` says nothing.
 *
 * Kept in the control plane only: the runtime receives the label in the
 * gateway's receipt and the run record recomputes it from here, so a page
 * cannot label itself.
 *
 * @module webReadOfficial
 */

/** Registration-restricted government domains. */
const OFFICIAL_SUFFIXES = Object.freeze([
  "gov", "gov.cn", "gov.uk", "gov.au", "gov.sg", "gov.hk", "gov.tw", "go.jp", "go.kr", "gc.ca", "canada.ca",
  "europa.eu", "who.int", "nhs.uk", "nih.gov",
]);

/**
 * Named authorities outside those domains: host, and path prefixes when only
 * part of the site is guidance (none = the whole host). Every host of the
 * former allowlist is official here — by name below, or by suffix (www.gov.cn,
 * mpa.hunan.gov.cn, www.who.int, www.nhs.uk, www.fda.gov, dailymed,
 * www.ema.europa.eu); NMPA, NHC and ClinicalTrials.gov, which could not be on
 * that list because a plain client gets a challenge or a shell, are official
 * by suffix too.
 */
const OFFICIAL_HOSTS = new Map([
  ["www.cochrane.org", []],
  ["www.cochranelibrary.com", []],
  ["www.acc.org", []],
  ["professional.heart.org", []],
  ["cpr.heart.org", []],
  ["www.escardio.org", ["/Guidelines/"]],
  ["www.ccfdie.org", []],
  ["www.nice.org.uk", []],
  ["www.uspreventiveservicestaskforce.org", []],
  ["www.sign.ac.uk", []],
  ["kdigo.org", []],
  // China: the drug evaluation centre, the ADR monitoring centre, the CDC,
  // the clinical trial registry and the medical association's guidelines.
  ["www.cde.org.cn", []],
  ["www.cdr-adr.org.cn", []],
  ["www.chinacdc.cn", []],
  ["www.chictr.org.cn", []],
  ["www.cma.org.cn", []],
  // Trial registries outside the government domains.
  ["www.isrctn.com", []],
  ["euclinicaltrials.eu", []],
  ["www.anzctr.org.au", []],
]);

/** @param {string} host */
function suffixOfficial(host) {
  return OFFICIAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Whether a page's own address is an authority's.
 * @param {unknown} value an absolute URL
 * @returns {boolean}
 */
export function isOfficialWebSource(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const prefixes = OFFICIAL_HOSTS.get(host) ?? OFFICIAL_HOSTS.get(host.replace(/^www\./, ""));
  if (prefixes) return prefixes.length === 0 || prefixes.some((prefix) => url.pathname.startsWith(prefix));
  return suffixOfficial(host);
}

export const OFFICIAL_WEB_SOURCE_HOSTS = OFFICIAL_HOSTS;
export const OFFICIAL_WEB_SOURCE_SUFFIXES = OFFICIAL_SUFFIXES;
