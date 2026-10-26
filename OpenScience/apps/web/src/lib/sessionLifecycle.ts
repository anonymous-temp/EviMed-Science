/** Local lifecycle fence; it grants no authority and never replaces server authentication. */
export const WEB_SESSION_ENDED_EVENT = "open-science:web-session-ended";
export const WEB_SESSION_STARTED_EVENT = "open-science:web-session-started";
let generation = 0;
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
function invalidate() { generation++; listeners.forEach(listener => listener()); }
if (typeof window !== "undefined") {
  window.addEventListener(WEB_SESSION_ENDED_EVENT, invalidate);
  window.addEventListener(WEB_SESSION_STARTED_EVENT, invalidate);
}
