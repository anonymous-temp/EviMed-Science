/**
 * Whether this shell is running as a sub-application inside the EviMed Vue
 * shell (fusion plan §9.4, audit F-G6).
 *
 * The Vue shell mounts a Science page with `?embed=1` on its entry address
 * (`scienceSubAppUrl` in its `api/science.js`) and draws its own sidebar
 * around it; a second sidebar and project rail inside the first is two
 * products in one window. So an embedded shell renders its content area and
 * nothing else.
 *
 * The flag is read from the address the shell was entered with and kept for
 * as long as the shell stays mounted: a link inside an embedded page drops the
 * query string, and the page it opens is still inside the Vue shell. `embed=0`
 * turns it off. The sub-application container (wujie) also announces itself
 * with `window.__POWERED_BY_WUJIE__`, which counts the same.
 *
 * Nothing here loosens a header: `X-Frame-Options` and `frame-ancestors` are
 * the server's and stay as they are (audit G6 leaves the iframe fallback a
 * separate decision).
 */
export const EMBED_PARAM = "embed";

/** Read one address's query string: `embed=1` or `embed=true` asks for it. */
export function embedRequested(search: string): boolean | null {
  const value = new URLSearchParams(search).get(EMBED_PARAM);
  if (value === null) return null;
  return value === "1" || value === "true";
}

/**
 * The shell's decision, from the router's first location and the page's own
 * address (they differ once the router has redirected).
 */
export function isEmbeddedShell(routerSearch: string, target: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  const asked = embedRequested(routerSearch) ?? (target ? embedRequested(target.location.search) : null);
  if (asked !== null) return asked;
  return Boolean(target && (target as Window & { __POWERED_BY_WUJIE__?: boolean }).__POWERED_BY_WUJIE__);
}
