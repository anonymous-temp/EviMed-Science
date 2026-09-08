/**
 * Writing down what a run actually did, so a finished run is still readable
 * after its container is gone.
 *
 * Hidden knowledge: this is the smallest possible change and it is the one the
 * whole learning loop stands on. `onRunFinished` has always read the kernel
 * transcript while the container is still alive — it hands it to
 * `memoryIntelligence.recordRun` — and has always thrown it away afterwards.
 * The container exits, `sessionTranscript` starts answering
 * `runtime_not_running`, and the only durable trace of the run is the ledger's
 * counters. Nothing can be distilled from a counter.
 *
 * So: same read, one more consumer, a file per run.
 *
 * Three properties are load-bearing.
 *
 * **The child sessions are part of the run.** A capability run delegates, and
 * the delegate is where the work happened; a transcript with only the parent
 * records an orchestrator saying "delegate" and then "done". `subagents` on the
 * parent transcript names them, one hop at a time, and each is fetched.
 *
 * **Incompleteness is recorded, never inferred.** A partial transcript that
 * does not say it is partial teaches a lesson drawn from evidence the loop
 * cannot see, and the resulting method looks exactly like a correct one. Every
 * gap goes into `missing[]` with a reason, `completeness` degrades to `partial`
 * or `unavailable`, and the evaluation corpus refuses anything but `complete`.
 *
 * **The file is capped and the cap is a failure, not a truncation.** A silently
 * truncated transcript is the same defect wearing a different hat.
 *
 * @module runTranscripts
 */

import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { hasSensitiveText } from "@evimed/domain";
import { HttpError, readTextFileNoFollow, safeId, withProjectStorageMutation, writeFileAtomicNoFollow } from "./security.mjs";

/** Directory under a project's meta root that holds one file per finished run. */
export const TRANSCRIPT_DIR_NAME = "transcripts";

/** Schema version of the header line, so a reader can refuse a file it predates. */
export const TRANSCRIPT_SCHEMA_VERSION = 1;

/**
 * Ceiling for one run's transcript file.
 *
 * Chosen to sit an order of magnitude under the kernel's own 64 MiB page bound
 * rather than to match it: a transcript that large is a run that went wrong in
 * a way no distillation should learn from, and the honest record of it is
 * `partial(size_bound)` plus the counters, not eight megabytes of loop.
 */
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

/** How long a transcript is kept before the sweep removes it. */
export const TRANSCRIPT_RETENTION_DAYS = 90;

/** Every reason a session's messages are not all here. */
export const TRANSCRIPT_MISSING_REASONS = Object.freeze([
  "page_bound", "history_unavailable", "child_unreadable", "size_bound",
]);

/** Completeness of the record, in the order it degrades. */
export const TRANSCRIPT_COMPLETENESS = Object.freeze(["complete", "partial", "unavailable"]);

/**
 * @typedef {object} TranscriptSessionRecord
 * @property {string} sessionId
 * @property {string|null} parentSessionId
 * @property {string} label
 * @property {string|null} capability
 * @property {number} lastSeq
 * @property {number} throughSeq
 * @property {number} messages
 * @property {boolean} truncated
 */

/**
 * @typedef {object} TranscriptGap
 * @property {string} sessionId
 * @property {number} fromSeq
 * @property {string} reason
 */

/**
 * @typedef {object} TranscriptReceipt
 * @property {string} path        project-relative, so the ledger never carries an absolute path
 * @property {string} completeness
 * @property {number} bytes
 * @property {string} sha256
 * @property {number} messages
 * @property {TranscriptGap[]} missing
 */

/** @param {string} runId @returns {string} */
export function transcriptFileName(runId) {
  return `${safeId(runId, "run id")}.jsonl`;
}

/** @param {{ metaDir: string }} project @param {string} runId @returns {string} */
export function transcriptPath(project, runId) {
  return path.join(project.metaDir, TRANSCRIPT_DIR_NAME, transcriptFileName(runId));
}

/** The path as the ledger records it: relative to the project root, never absolute. */
function relativeTranscriptPath(project, runId) {
  return path.relative(project.rootDir, transcriptPath(project, runId));
}

/**
 * @typedef {object} CollectedSession
 * @property {string} sessionId
 * @property {string|null} parentSessionId
 * @property {string} label
 * @property {string|null} capability
 * @property {import("@evimed/domain").RunTranscript|null} transcript
 * @property {string|null} error
 */

/**
 * Read the run's own session and, one hop at a time, every subagent session it
 * announced.
 *
 * Depth is bounded by `maxSessions` rather than by nesting level: the pump
 * already discovers grandchildren by registering each child's own
 * `subagent/started`, and a bound on *count* is the one that protects the file
 * size this function's output is about to be written into.
 *
 * A child that cannot be read is a recorded gap, never an exception: the parent
 * transcript is worth keeping even when one delegate's session has already been
 * reaped.
 *
 * @param {{ sessionTranscript: (project: any, sessionId: string, options: any) => Promise<any> }} runtimeManager
 * @param {any} project
 * @param {{ sessionId: string }} run
 * @param {{ maxSessions?: number }} [options]
 * @returns {Promise<CollectedSession[]>}
 */
export async function collectRunTranscripts(runtimeManager, project, run, options = {}) {
  const maxSessions = options.maxSessions ?? 64;
  /** @type {CollectedSession[]} */
  const collected = [];
  /** @type {{ sessionId: string, parentSessionId: string|null, label: string, capability: string|null }[]} */
  const queue = [{ sessionId: run.sessionId, parentSessionId: null, label: "root", capability: null }];
  const seen = new Set();
  while (queue.length && collected.length < maxSessions) {
    const next = /** @type {{ sessionId: string, parentSessionId: string|null, label: string, capability: string|null }} */ (queue.shift());
    if (!next.sessionId || seen.has(next.sessionId)) continue;
    seen.add(next.sessionId);
    let transcript = null;
    let error = null;
    try {
      // `wake: false` throughout: waking a container to read a run that has
      // already finished would restart the very thing whose exit ended it.
      transcript = await runtimeManager.sessionTranscript(project, next.sessionId, { wake: false });
    } catch (err) {
      error = String(err?.code ?? err?.message ?? "unreadable");
    }
    collected.push({ ...next, transcript, error });
    for (const child of transcript?.subagents ?? []) {
      queue.push({
        sessionId: child.sessionId,
        parentSessionId: child.parentSessionId ?? next.sessionId,
        label: child.label ?? "subagent",
        capability: child.capability ?? null,
      });
    }
  }
  return collected;
}

/**
 * @param {CollectedSession} session
 * @returns {{ record: TranscriptSessionRecord, gaps: TranscriptGap[] }}
 */
function describeSession(session) {
  const transcript = session.transcript;
  if (!transcript) {
    return {
      record: {
        sessionId: session.sessionId,
        parentSessionId: session.parentSessionId,
        label: session.label,
        capability: session.capability,
        lastSeq: -1,
        throughSeq: -1,
        messages: 0,
        truncated: true,
      },
      gaps: [{
        sessionId: session.sessionId,
        fromSeq: 0,
        reason: session.parentSessionId ? "child_unreadable" : "history_unavailable",
      }],
    };
  }
  const messages = transcript.messages ?? [];
  const lastSeq = Number.isSafeInteger(transcript.lastSeq) ? transcript.lastSeq : -1;
  const throughSeq = messages.length ? Math.max(...messages.map((message) => message.seq)) : -1;
  // The kernel's own paging is what could have stopped early, and it says so by
  // handing back a highest sequence below the one the session claims to hold.
  const truncated = lastSeq >= 0 && throughSeq >= 0 && throughSeq < lastSeq;
  return {
    record: {
      sessionId: session.sessionId,
      parentSessionId: session.parentSessionId,
      label: session.label,
      capability: session.capability,
      lastSeq,
      throughSeq,
      messages: messages.length,
      truncated,
    },
    gaps: truncated ? [{ sessionId: session.sessionId, fromSeq: throughSeq + 1, reason: "page_bound" }] : [],
  };
}

/**
 * Serialize the collected sessions into the on-disk form.
 *
 * Separate from writing so a test can assert the bytes without a filesystem,
 * and so the size cap is applied to the thing that is actually stored.
 * @param {{ runId: string, capturedAt: string, sessions: CollectedSession[], maxBytes?: number }} input
 * @returns {{ text: string, header: any, messages: number }}
 */
export function serializeRunTranscript({ runId, capturedAt, sessions, maxBytes = TRANSCRIPT_MAX_BYTES }) {
  /** @type {TranscriptSessionRecord[]} */
  const records = [];
  /** @type {TranscriptGap[]} */
  const missing = [];
  /** @type {string[]} */
  const lines = [];
  let messages = 0;
  for (const session of sessions) {
    const described = describeSession(session);
    records.push(described.record);
    missing.push(...described.gaps);
    for (const message of session.transcript?.messages ?? []) {
      lines.push(JSON.stringify({ sessionId: session.sessionId, ...message }));
      messages += 1;
    }
  }
  // Applied to the serialized body, because the number that matters is the one
  // on disk. Dropping trailing sessions rather than trailing messages keeps
  // every session that is present whole; a half-read session is the state this
  // file exists to be able to describe, not to be in.
  let kept = lines.length;
  const headerFor = () => ({
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId,
    capturedAt,
    completeness: completenessOf(records, missing),
    sessions: records,
    missing,
  });
  let text = `${[JSON.stringify(headerFor()), ...lines].join("\n")}\n`;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    while (kept > 0 && Buffer.byteLength(text, "utf8") > maxBytes) {
      kept = Math.floor(kept * 0.8);
      const dropped = lines.slice(0, kept);
      missing.push({ sessionId: runId, fromSeq: kept, reason: "size_bound" });
      missing.splice(0, missing.length, ...dedupeGaps(missing));
      text = `${[JSON.stringify({ ...headerFor(), completeness: "partial" }), ...dropped].join("\n")}\n`;
    }
    messages = kept;
  }
  const header = JSON.parse(text.slice(0, text.indexOf("\n")));
  return { text, header, messages };
}

/** @param {TranscriptGap[]} gaps @returns {TranscriptGap[]} */
function dedupeGaps(gaps) {
  const seen = new Set();
  /** @type {TranscriptGap[]} */
  const out = [];
  for (const gap of gaps) {
    const key = `${gap.sessionId}:${gap.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

/**
 * `unavailable` is reserved for "we have nothing", not for "we have some of
 * it": a run whose root session could not be read teaches nothing, while a run
 * missing one delegate's tail is still evidence about everything else it did.
 * @param {TranscriptSessionRecord[]} records
 * @param {TranscriptGap[]} missing
 * @returns {string}
 */
function completenessOf(records, missing) {
  const root = records.find((record) => record.parentSessionId == null);
  if (!records.length || !root || root.messages === 0) return "unavailable";
  return missing.length ? "partial" : "complete";
}

/**
 * Write one run's transcript and return the receipt the ledger records.
 *
 * @param {{ project: any, run: { id: string, sessionId: string }, sessions: CollectedSession[], now?: Date, maxBytes?: number }} input
 * @returns {Promise<TranscriptReceipt>}
 */
export async function persistRunTranscript({ project, run, sessions, now = new Date(), maxBytes = TRANSCRIPT_MAX_BYTES }) {
  const { text, header, messages } = serializeRunTranscript({
    runId: run.id,
    capturedAt: now.toISOString(),
    sessions,
    maxBytes,
  });
  const relative = relativeTranscriptPath(project, run.id);
  await withProjectStorageMutation(project, async () => {
    // The scoped writer resolves its target against the process working
    // directory, so the project-relative path the receipt carries would land
    // outside the workspace and be refused as `path_forbidden`. It was, on
    // every finished run: `onRunFinished` swallows the throw into an audit
    // line, so the whole learning loop recorded nothing and said nothing.
    await writeFileAtomicNoFollow(project.rootDir, transcriptPath(project, run.id), text, { encoding: "utf8", mode: 0o600 });
  });
  return {
    path: relative,
    completeness: header.completeness,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    messages,
    missing: header.missing,
  };
}

/**
 * Read a persisted transcript back.
 *
 * Returns `null` rather than throwing when the file is gone: a run older than
 * the retention window is an ordinary state, and the distiller must be able to
 * skip it without an error path.
 * @param {any} project
 * @param {string} runId
 * @returns {Promise<{ header: any, messages: any[] } | null>}
 */
export async function readRunTranscript(project, runId) {
  const text = await readTextFileNoFollow(project.rootDir, transcriptPath(project, runId), "");
  if (!text) return null;
  const lines = text.split("\n").filter(Boolean);
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new HttpError(500, "run_transcript_corrupt", "The stored run transcript has no readable header.");
  }
  if (header?.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) {
    throw new HttpError(500, "run_transcript_corrupt", "The stored run transcript is of an unsupported version.");
  }
  /** @type {any[]} */
  const messages = [];
  for (const line of lines.slice(1)) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A single unreadable line is a gap in evidence, not a reason to lose the
      // rest of the run. It is counted where the header can be trusted.
      header.missing = [...(header.missing ?? []), { sessionId: header.runId, fromSeq: messages.length, reason: "size_bound" }];
    }
  }
  return { header, messages };
}

/**
 * Remove transcripts older than the retention window.
 *
 * Deliberately independent of the ledger's own 1,000-run cap: the ledger keeps
 * counters, which are small, and this keeps conversations, which are not.
 * @param {any} project
 * @param {{ retentionDays?: number, now?: Date }} [options]
 * @returns {Promise<{ removed: string[] }>}
 */
export async function pruneRunTranscripts(project, options = {}) {
  const retentionDays = options.retentionDays ?? TRANSCRIPT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const directory = path.join(project.metaDir, TRANSCRIPT_DIR_NAME);
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const full = path.join(directory, entry);
    try {
      const info = await stat(full);
      if (now.getTime() - info.mtimeMs <= retentionDays * 86_400_000) continue;
      await rm(full, { force: true });
      removed.push(entry);
    } catch {
      // isolated: evimed_run_transcript_prune_failed_total
    }
  }
  return { removed };
}

/**
 * The excerpt a distillation run is allowed to see.
 *
 * Two filters, both of which are the reason this lives here rather than in the
 * distiller: a message carrying a credential or a patient identifier is dropped
 * whole rather than redacted, and the excerpt is bounded by message count so a
 * pathological run cannot fill the model's context with its own loop. What is
 * dropped is counted, because an excerpt that silently lost the decisive
 * message produces a confident method about something that did not happen.
 * @param {any[]} messages
 * @param {{ sessionId?: string, fromSeq?: number, toSeq?: number, limit?: number }} range
 * @returns {{ messages: any[], dropped: { sensitive: number, bounded: number } }}
 */
export function transcriptExcerpt(messages, range = {}) {
  const limit = range.limit ?? 80;
  const from = range.fromSeq ?? Number.NEGATIVE_INFINITY;
  const to = range.toSeq ?? Number.POSITIVE_INFINITY;
  let sensitive = 0;
  const inRange = (messages ?? []).filter((message) => {
    if (range.sessionId && message.sessionId !== range.sessionId) return false;
    return message.seq >= from && message.seq <= to;
  });
  const clean = inRange.filter((message) => {
    const text = JSON.stringify(message.parts ?? "");
    if (hasSensitiveText(text)) { sensitive += 1; return false; }
    return true;
  });
  const bounded = Math.max(0, clean.length - limit);
  return { messages: clean.slice(-limit), dropped: { sensitive, bounded } };
}
