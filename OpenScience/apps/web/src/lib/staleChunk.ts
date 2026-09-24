/**
 * A page of this tab whose code a release has since replaced.
 *
 * Every workbench page is its own chunk, fetched the first time it is opened
 * (`router.tsx`), and a release renames every chunk. A tab opened before the
 * release asks for names the server no longer has — it answers 404
 * (`serveStatic`) — and the page's import fails. Until 2026-09-23 React
 * Router then replaced the whole shell with its English error page, which is
 * what the owner read as 「乱码」 (UI plan §2.1). The new release is one reload
 * away, so the tab reloads — once: a chunk still failing a minute after a
 * reload is not a stale tab but a broken one, and a reload loop would hide it.
 */

/** When this tab last reloaded to pick up a release (epoch ms, per tab). */
const RELOADED_AT_KEY = "evimed.release-reload-at";

/**
 * The guard's window. A reload that fetched the new release has finished long
 * before a minute; a chunk failing again inside it failed after the reload.
 */
const RELOAD_GUARD_MS = 60_000;

/**
 * What a failed chunk says, in each engine's words: Chromium, Firefox and
 * WebKit word a failed `import()` differently, a module served with the wrong
 * type has its own sentence, and Vite's CSS preload names the stylesheet.
 */
const STALE_CHUNK = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Expected a JavaScript(?:-or-Wasm)? module script|is not a valid JavaScript MIME type/i;

let reloading = false;

/** Whether an error is a page's code that could not be fetched. Read, never shown. */
export function isStaleChunkError(error: unknown): boolean {
  const message = typeof error === "string" ? error : (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && STALE_CHUNK.test(message);
}

/** A reload the reader asked for, which no guard refuses. */
export function reloadPage(): void {
  window.location.reload();
}

/**
 * Reload to pick up the release that replaced this tab's code, unless this
 * tab already did so within the last minute.
 *
 * @returns whether a reload is under way. `false` means the guard refused (or
 *   the tab cannot remember a reload, so cannot tell the next load from this
 *   one): the failure is left for the page's error element to say.
 */
export function reloadForNewRelease(reload: () => void = reloadPage): boolean {
  if (reloading) return true;
  // Offline is not stale: a reload would trade the shell for the browser's
  // own offline page. The error element offers the reload by hand instead.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const now = Date.now();
  try {
    const elapsed = now - Number(window.sessionStorage.getItem(RELOADED_AT_KEY) ?? 0);
    // A negative span is a clock that moved back, not a recent reload.
    if (elapsed >= 0 && elapsed < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOADED_AT_KEY, String(now));
  } catch {
    return false;
  }
  reloading = true;
  reload();
  return true;
}

/** Whether this tab is already reloading for a new release. */
export function reloadingForNewRelease(): boolean {
  return reloading;
}

/**
 * Vite's own signal that a chunk failed to load (`vite:preloadError`, see
 * https://vite.dev/guide/build.html#load-error-handling), answered with the
 * guarded reload. Cancelled only when the reload goes ahead: when the guard
 * refuses, the error continues to the route's error element, which says so
 * and offers the reload by hand.
 *
 * @returns the function that removes the listener
 */
export function installStaleChunkReload(target: Window = window, reload: () => void = reloadPage): () => void {
  const onPreloadError = (event: Event) => {
    if (reloadForNewRelease(reload)) event.preventDefault();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
