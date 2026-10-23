#!/usr/bin/env node
/**
 * What each memory commit of one native account did, read from the engine's own retained archives.
 *
 * A commit that wrote no file looks the same from the memory page whether the extraction model proposed nothing (the templates
 * and the conversation) or the engine refused what it proposed (a policy). The engine keeps both answers: every archive holds
 * a `memory_diff.json` (`operations`, `skipped_operations[].reason_code`, `summary`) and the commit's task result says what was
 * extracted per category and which memory types were allowed. This prints them per commit, for one account:
 *
 *   node scripts/ops/native-commit-report.mjs --user <id> [--limit 30] [--since 2026-10-19] [--text]
 *   node scripts/ops/native-commit-report.mjs --user <id> --backfill        # also write what was read onto ledger rows that lack it
 *
 * The archives are listed from the engine (every `sessions/<s>/history/archive_N`), not from the ledger, so an idle commit the
 * control plane never saw is in it too; each is matched to its ledger row when there is one (origin, state, task id). The
 * task is read only when the diff is empty and the ledger knows its id — the engine keeps task records a day, so an older
 * commit's task is `unavailable` and the diff's own account stands.
 *
 * Prints counts, ids, reason codes and file paths below the account's memory root, never a memory's text or a message's.
 * Read-only unless `--backfill` is given; `--backfill` only fills a ledger row whose extraction is empty and is idempotent.
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The archives this reads for one report, so that an account with a very long history cannot make it unbounded. */
const MAX_ARCHIVES = 300;

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { user: "", limit: 30, since: /** @type {string | null} */ (null), text: false, backfill: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--text") { options.text = true; continue; }
    if (argument === "--backfill") { options.backfill = true; continue; }
    const field = { "--user": "user", "--limit": "limit", "--since": "since" }[argument];
    if (!field) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    if (field === "limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit is a whole number from 1 to 500");
      options.limit = limit;
    } else if (field === "since") {
      if (!Number.isFinite(Date.parse(value))) throw new Error("--since is a date or a timestamp");
      options.since = new Date(value).toISOString();
    } else {
      options.user = value;
    }
    index += 1;
  }
  if (!options.user) throw new Error("give --user <id>");
  return options;
}

/**
 * How the messages of an archive were spread, without a word of them. @param {string | null} raw `messages.jsonl`
 * @returns {{ total: number, user: number, assistant: number, userCharacters: number } | null}
 */
export function messageShape(raw) {
  if (raw === null) return null;
  const shape = { total: 0, user: 0, assistant: 0, userCharacters: 0 };
  for (const line of String(raw).split("\n")) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    shape.total += 1;
    const text = typeof message?.content === "string" ? message.content
      : Array.isArray(message?.parts) ? message.parts.filter((/** @type {any} */ part) => part?.type === "text").map((/** @type {any} */ part) => String(part.text ?? "")).join("\n") : "";
    if (message?.role === "user") { shape.user += 1; shape.userCharacters += text.length; }
    else if (message?.role === "assistant") shape.assistant += 1;
  }
  return shape;
}

/**
 * The verdict one commit's facts come to. @param {{ state: string, failed: boolean, diff: boolean, operations: number, skipped: number }} facts
 * @returns {"wrote" | "wrote_and_skipped" | "only_skipped" | "proposed_nothing" | "failed" | "no_diff_yet"}
 */
export function verdictOf({ state, failed, diff, operations, skipped }) {
  if (!diff) return failed || state === "failed" || state === "abandoned" || state === "replayed" ? "failed" : "no_diff_yet";
  if (operations > 0) return skipped > 0 ? "wrote_and_skipped" : "wrote";
  return skipped > 0 ? "only_skipped" : "proposed_nothing";
}

/**
 * The report itself, over injected collaborators so it can be run against a test database and a stub engine.
 * @param {{ overlay: any, sessions: any, extractionFacts: (diff: any, task?: any) => any, parseArchiveUri: (uri: string) => any, nativeMemoryFile: (uri: string, root: string) => any }} deps
 * @param {{ user: string, limit?: number, since?: string | null, backfill?: boolean }} options
 */
export async function commitReport(deps, options) {
  const { overlay, sessions, extractionFacts, parseArchiveUri, nativeMemoryFile } = deps;
  const userId = options.user;
  const root = sessions.memoryRoot(userId);
  const ledger = new Map((await overlay.commitsOf(userId, { limit: 500 })).map((/** @type {any} */ row) => [row.archiveUri, row]));
  const nodes = await sessions.tree(userId, `${sessions.userRoot(userId)}/sessions`, { levelLimit: 4, showHidden: true });
  /** @type {Map<string, { session: string, failed: boolean, diff: boolean }>} */
  const archives = new Map();
  for (const node of nodes) {
    const parsed = parseArchiveUri(node.uri);
    if (!parsed) continue;
    const entry = archives.get(parsed.archiveUri) ?? { session: parsed.session, failed: false, diff: false };
    if (parsed.rest === ".failed.json") entry.failed = true;
    if (parsed.rest === "memory_diff.json") entry.diff = true;
    archives.set(parsed.archiveUri, entry);
  }
  // A ledger row whose archive the engine no longer lists is still a commit that happened.
  for (const [archiveUri, row] of ledger) if (!archives.has(archiveUri)) archives.set(archiveUri, { session: row.engineSession, failed: false, diff: false });
  const truncated = archives.size > MAX_ARCHIVES;
  const commits = [];
  for (const [archiveUri, entry] of [...archives].slice(0, MAX_ARCHIVES)) {
    const row = ledger.get(archiveUri) ?? null;
    let diff = null;
    if (entry.diff) {
      const text = await sessions.read(userId, `${archiveUri}/memory_diff.json`).catch(() => null);
      try { diff = text ? JSON.parse(text) : null; } catch { diff = null; }
    }
    const lists = diff?.operations ?? {};
    const files = [];
    for (const [list, change] of /** @type {const} */ ([["adds", "added"], ["updates", "updated"], ["deletes", "deleted"]])) {
      for (const operation of Array.isArray(lists[list]) ? lists[list] : []) {
        const file = nativeMemoryFile(String(operation?.uri ?? ""), root);
        files.push({ change, type: file?.type ?? String(operation?.memory_type ?? "other"), file: file?.relPath ?? null });
      }
    }
    const operations = files.length;
    let task = null;
    /** @type {"read" | "unavailable" | "not_needed" | "no_task_id"} */
    let taskState = "not_needed";
    if (diff && operations === 0) {
      if (!row?.taskId) taskState = "no_task_id";
      else {
        task = await sessions.task(userId, row.taskId).catch(() => null);
        taskState = task ? "read" : "unavailable";
      }
    }
    const facts = extractionFacts(diff ?? {}, task);
    const at = typeof diff?.extracted_at === "string" && Number.isFinite(Date.parse(diff.extracted_at)) ? new Date(diff.extracted_at).toISOString() : (row?.createdAt ?? null);
    if (options.since && (!at || at < options.since)) continue;
    const verdict = verdictOf({ state: row?.state ?? "unknown", failed: entry.failed, diff: Boolean(diff), operations, skipped: facts.skipped });
    const shape = messageShape(await sessions.read(userId, `${archiveUri}/messages.jsonl`).catch(() => null));
    const stored = row && row.extraction && Object.keys(row.extraction).length ? row.extraction : null;
    let backfilled = false;
    if (options.backfill && row && !stored && diff && row.state === "completed") {
      backfilled = await overlay.setExtraction(userId, archiveUri, facts);
    }
    commits.push({
      archive: archiveUri.slice(archiveUri.indexOf("/sessions/") + 1), session: entry.session, at, verdict,
      ledger: row ? { origin: row.origin, state: row.state, operations: row.operations, project: row.projectId, taskId: row.taskId, attempts: row.attempts, error: row.error || undefined, recorded: Boolean(stored) } : null,
      operations, files, skipped: facts.skipped, skipReasons: facts.skipReasons, extracted: facts.extracted, memoryTypes: facts.memoryTypes,
      task: taskState, messages: shape, ...(backfilled ? { backfilled: true } : {}),
    });
  }
  commits.sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
  const shown = commits.slice(0, options.limit ?? 30);
  /** @type {Record<string, number>} */
  const totals = {};
  for (const commit of commits) totals[commit.verdict] = (totals[commit.verdict] ?? 0) + 1;
  return { user: userId, archives: archives.size, truncated, considered: commits.length, totals, commits: shown };
}

/** One line per commit, for a person reading a terminal. @param {Awaited<ReturnType<typeof commitReport>>} report */
export function renderText(report) {
  const lines = [`account ${report.user}: ${report.considered} commit(s) read of ${report.archives} archive(s)${report.truncated ? " (truncated)" : ""}; ${Object.entries(report.totals).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`];
  for (const commit of report.commits) {
    const reasons = Object.entries(commit.skipReasons).map(([code, count]) => `${code}×${count}`).join(" ");
    const messages = commit.messages ? `${commit.messages.user} user / ${commit.messages.assistant} assistant message(s), ${commit.messages.userCharacters} characters from the person` : "messages not kept";
    lines.push(`${commit.at ?? "?"}  ${commit.verdict.padEnd(17)} ${commit.archive}  ops ${commit.operations}  skipped ${commit.skipped}${reasons ? ` (${reasons})` : ""}  ${messages}  origin ${commit.ledger?.origin ?? "engine"}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { OpenVikingClient }, sessionsModule, { NativeMemoryOverlay }, { extractionFacts }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/openVikingClient.mjs"),
    import("../../apps/server/src/openVikingSessions.mjs"),
    import("../../apps/server/src/nativeMemoryOverlay.mjs"),
    import("../../apps/server/src/nativeMemoryWorker.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const sessions = new sessionsModule.OpenVikingSessions(new OpenVikingClient(config), { timeoutMs: 30_000, fastTimeoutMs: 10_000 });
    if (!sessions.configured) throw new Error("the memory engine is not configured here (OPEN_SCIENCE_OPENVIKING_URL and its key)");
    const overlay = new NativeMemoryOverlay({ database });
    const report = await commitReport({ overlay, sessions, extractionFacts, parseArchiveUri: sessionsModule.parseArchiveUri, nativeMemoryFile: sessionsModule.nativeMemoryFile }, options);
    process.stdout.write(options.text ? `${renderText(report)}\n` : `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`native_commit_report_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
