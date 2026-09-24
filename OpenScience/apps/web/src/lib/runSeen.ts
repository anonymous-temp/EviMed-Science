import { useEffect, useState } from "react";
import type { WebAgentRun } from "@/lib/apiClient";

/**
 * Which finished conversations this browser has opened since they finished —
 * the one state the sidebar row still shows besides "working" (2026-09-23 plan
 * §5.2: a finished, unopened conversation carries a small dot; delivered,
 * verified, failed and cancelled are not the list's business).
 *
 * Kept in this browser, not on the server: it is a reading mark, like a mail
 * client's before it syncs, and a second device showing a dot for something
 * already read elsewhere costs one glance. `since` starts the record the first
 * time this code runs, so an account does not open on a tree full of dots for
 * every conversation it ever had.
 */

const KEY = "evimed.runs.seen.v1";
const EVENT = "evimed:runs-seen";
/** Entries kept; the oldest go first. */
const LIMIT = 500;

interface SeenRecord {
  since: number;
  seen: Record<string, number>;
}

function read(): SeenRecord {
  if (typeof window === "undefined") return { since: 0, seen: {} };
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<SeenRecord> | null;
    if (value && typeof value.since === "number" && value.seen && typeof value.seen === "object") {
      return { since: value.since, seen: value.seen };
    }
  } catch {
    // An unreadable record starts over below.
  }
  const fresh = { since: Date.now(), seen: {} };
  write(fresh);
  return fresh;
}

function write(record: SeenRecord): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // A full or refused storage only costs the dots.
  }
}

function finishedAt(run: Pick<WebAgentRun, "finishedAt">): number {
  const at = Date.parse(run.finishedAt ?? "");
  return Number.isNaN(at) ? 0 : at;
}

/** A conversation that finished after the record began and was not opened since. */
export function isRunUnseen(run: Pick<WebAgentRun, "id" | "status" | "finishedAt">, record: SeenRecord = read()): boolean {
  if (run.status === "running") return false;
  const at = finishedAt(run);
  if (!at || at <= record.since) return false;
  return (record.seen[run.id] ?? 0) < at;
}

/** The conversation was opened: its dot goes, in every row that shows it. */
export function markRunSeen(run: Pick<WebAgentRun, "id" | "status" | "finishedAt">): void {
  if (typeof window === "undefined" || !isRunUnseen(run)) return;
  const record = read();
  record.seen[run.id] = finishedAt(run);
  const entries = Object.entries(record.seen);
  if (entries.length > LIMIT) {
    record.seen = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, LIMIT));
  }
  write(record);
  window.dispatchEvent(new Event(EVENT));
}

/** Re-renders when any row is marked, here or in another tab. */
export function useRunsSeenVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    const onStorage = (event: StorageEvent) => { if (event.key === KEY) bump(); };
    window.addEventListener(EVENT, bump);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return version;
}
