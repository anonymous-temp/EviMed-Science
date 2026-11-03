/** Local lifecycle fence; it grants no authority and never replaces server authentication. */
export const WEB_SESSION_SYNC_STORAGE_KEY = "open-science:web-session-sync";
export const WEB_SESSION_EXTERNAL_EVENT = "open-science:web-session-external";
export const WEB_SESSION_ENDED_EVENT = "open-science:web-session-ended";
export const WEB_SESSION_STARTED_EVENT = "open-science:web-session-started";
/** An empty token disables history intents when secure randomness is unavailable. */
export function newSessionOwner(source: Pick<Crypto, "randomUUID" | "getRandomValues"> | undefined = globalThis.crypto): string {
  try {
    if (typeof source?.randomUUID === "function") return source.randomUUID();
    if (typeof source?.getRandomValues === "function") {
      const bytes = source.getRandomValues(new Uint8Array(32));
      return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch { /* Do not reuse an owner when secure randomness fails. */ }
  return "";
}
let generation = 0;
let owner = newSessionOwner();
export const sessionOwner = () => owner;
const listeners = new Set<() => void>();
export class StaleSessionError extends Error {
  constructor() { super("The operation belongs to a session that has ended."); this.name = "StaleSessionError"; }
}
export const sessionGeneration = () => generation;
export function assertSessionGeneration(expected: number): void {
  if (expected !== generation) throw new StaleSessionError();
}
export function subscribeSessionBoundary(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function invalidate() {
  generation++;
  owner = newSessionOwner();
  // Pending database request IDs contain no credentials. Clear them at either account boundary even if their page was never loaded.
  try {
    const storage = window.sessionStorage;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith("evimed.research-db.")) storage.removeItem(key);
    }
  } catch { /* Session storage may be unavailable. */ }
  listeners.forEach(listener => listener());
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== WEB_SESSION_SYNC_STORAGE_KEY && event.key !== null) return;
    if (event.key !== null && event.newValue === null) return;
    let kind: "started" | "ended" | "unknown" = "unknown";
    try {
      const value: unknown = event.newValue === null ? null : JSON.parse(event.newValue);
      if (value && typeof value === "object" && "kind" in value && (value.kind === "started" || value.kind === "ended")) kind = value.kind;
    } catch { /* Unknown signals still require a safe identity recheck. */ }
    invalidate();
    window.dispatchEvent(new CustomEvent(WEB_SESSION_EXTERNAL_EVENT, { detail: { kind } }));
  });
  window.addEventListener(WEB_SESSION_ENDED_EVENT, invalidate);
  window.addEventListener(WEB_SESSION_STARTED_EVENT, invalidate);
}
