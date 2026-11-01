import { listRuntimeUiPreload, warmWebRuntime } from "@/lib/apiClient";
import { geoIdFromChatPath } from "@/lib/geoLocation";
import { holdStaleChunkReload } from "@/lib/staleChunk";

/**
 * What the shell asks for ahead of the first click, so that a page or the conversation is not what starts the download.
 *
 * A release renames every chunk, so the first visit to each page after one pays for its chunks (the owner's first 前沿动态 of
 * 2026-10-31: 35 chunks, about five seconds, over a line to Beijing that drops packets), and the kernel's application file (1.83 MB
 * gzipped) was not even asked for until the runtime had started, because its address is in the kernel's own document.
 *
 * Quiet by design: never on a connection that asked to save data, one thing at a time and only when the page is idle, and a failure
 * means the file is fetched when it is needed, as it always was.
 */

/** The pages the sidebar opens, most used first. Their imports are the router's own, so a page already fetched costs nothing. */
const PAGES: ReadonlyArray<() => Promise<unknown>> = [
  () => import("@/app/routes/FrontierPage"),
  () => import("@/app/routes/CapabilitiesPage"),
  () => import("@/app/routes/KnowledgePage"),
  () => import("@/app/routes/MemoryHubPage"),
  () => import("@/app/virtual-research/VcrHomePage"),
  () => import("@/app/routes/GeoHomePage"),
  () => import("@/app/routes/AutopilotPage"),
];

type ConnectionHints = { saveData?: boolean; effectiveType?: string };

/** Whether this connection asked not to be used for anything it did not ask for. */
export function preloadAllowed(connection: ConnectionHints | undefined = (navigator as Navigator & { connection?: ConnectionHints }).connection): boolean {
  return !connection?.saveData && !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
}

const whenIdle = () => new Promise<void>((resolve) => {
  if ("requestIdleCallback" in window) window.requestIdleCallback(() => resolve(), { timeout: 3_000 });
  else setTimeout(resolve, 500);
});

/**
 * The kernel's application files, from the list the control plane has already served to someone, on the conversation's origin. A plain
 * no-cors fetch: its answer cannot be read and need not be, because what is kept is the browser's cached copy the frame then finds
 * (same site, immutable; `connect-src` already names this origin).
 */
export async function preloadConversationAssets(): Promise<void> {
  if (!preloadAllowed()) return;
  const { origin, paths } = await listRuntimeUiPreload().catch(() => ({ origin: "", paths: [] }));
  if (!origin) return;
  for (const path of paths) {
    await fetch(`${origin}${path}`, { mode: "no-cors", credentials: "include" }).catch(() => undefined);
  }
}

/**
 * The sidebar's pages, one at a time and only when idle. A chunk a release has since replaced is not this call's to act on:
 * reloading a tab someone is reading because of a guess would be the opposite of the point (`holdStaleChunkReload`).
 */
export async function preloadWorkbenchPages(): Promise<void> {
  if (!preloadAllowed()) return;
  for (const page of PAGES) {
    await whenIdle();
    const release = holdStaleChunkReload();
    await page().catch(() => undefined);
    release();
  }
}

let started = false;

/**
 * Once a tab, as soon as sign-in is known: the runtime's start and the downloads begin here, not once the sidebar and the page's chunk
 * have loaded (five seconds of the owner's opening over a slow line, 2026-10-31). The start is speculative, because this project is only
 * the last one used: it stops nothing, and the frame's own opening joins it. A module's conversation starts its own runtime.
 * A head start, never a precondition: nothing here may reach the caller.
 *
 * @returns whether this call started it
 */
export function startShellHeadStart(): boolean {
  if (started) return false;
  try {
    started = true;
    if (!geoIdFromChatPath(window.location.pathname)) warmWebRuntime(undefined, { speculative: true });
    void preloadConversationAssets().catch(() => undefined);
    void preloadWorkbenchPages().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** A new tab, for the tests. */
export function resetShellHeadStartForTests() { started = false; }
