import { sessionGeneration, subscribeSessionBoundary } from "./sessionLifecycle";
import { useEffect, useState } from "react";

export interface AnnouncementOptions {
  sessionGeneration?: number;
  eventId: string;
  entityId: string;
  /** Assertive is reserved for urgent safety or session-interruption events. */
  politeness?: "polite" | "assertive";
  dedupMs?: number;
}
interface Announcement { message: string; politeness: "polite" | "assertive" }
const queue: Announcement[] = [];
const seen = new Map<string, number>();
const listeners = new Set<() => void>();
const resetListeners = new Set<() => void>();
subscribeSessionBoundary(() => { queue.length = 0; seen.clear(); resetListeners.forEach(reset => reset()); });

/** Queue a semantic event once per entity within the default five-second window. */
export function announce(message: string, options: AnnouncementOptions): void {
  if (!message.trim() || options.sessionGeneration !== undefined && options.sessionGeneration !== sessionGeneration()) return;
  const now = Date.now();
  for (const [key, time] of seen) if (now >= time) seen.delete(key);
  const normalized = message.replace(/\s+/g, " ").trim();
  const key = JSON.stringify([options.eventId, options.entityId, normalized, options.politeness ?? "polite"]);
  if (seen.has(key)) return;
  seen.set(key, now + (options.dedupMs ?? 5000));
  queue.push({ message, politeness: options.politeness ?? "polite" });
  listeners.forEach((listener) => listener());
}

/** Mount once at the shell before any feedback is produced; each queued event receives its own update. */
export function Announcer() {
  const [current, setCurrent] = useState<Announcement | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (timer || !queue.length) return;
      setCurrent(null);
      timer = setTimeout(() => {
        setCurrent(queue.shift() ?? null);
        timer = setTimeout(() => { timer = undefined; next(); }, 1000);
      }, 50);
    };
    const reset = () => { clearTimeout(timer); timer = undefined; setCurrent(null); };
    resetListeners.add(reset);
    listeners.add(next); next();
    return () => { listeners.delete(next); resetListeners.delete(reset); clearTimeout(timer); };
  }, []);
  return <><div className="sr-only" data-announcer="polite" aria-live="polite" aria-atomic="true">{current?.politeness === "polite" ? current.message : ""}</div><div className="sr-only" data-announcer="assertive" aria-live="assertive" aria-atomic="true">{current?.politeness === "assertive" ? current.message : ""}</div></>;
}
