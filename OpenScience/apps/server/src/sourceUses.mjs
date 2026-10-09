/**
 * Which conversations used a document (N-16, design reference §13.1 「用过它的对话」).
 *
 * The knowledge base never knew. A run consults a document in two ways and neither left a record against it:
 *
 *  - **A search hit.** `kb_search` answers with passages, each naming the document it came from. Only when the library is
 *    large enough to search: a small one is answered with the files to read, which is the second way.
 *  - **A direct read.** A run opens the document's parsed text itself — `read`, `grep` or a shell command on
 *    `.evimed-knowledge/.evimed-derived/<source id>/…` (a project's document) or `library/<source id>/…` (the personal
 *    library's copy). This is what every run over a small library does, and no gateway sees it.
 *
 * Both are read off the run's own transcript at the moment the run finishes, from the same collected sessions the
 * transcript file, the pages-read list and the method counters are written from. The gateway cannot do it alone: its token
 * names an account and a project, not a conversation, so a hit it returns cannot be attached to the run that asked.
 * The record is the transcript's account of what the run did — which is also why it can be re-derived from a stored
 * transcript (`sourceUsesFromMessages`) and why recording it twice is the same as recording it once.
 *
 * What is NOT counted, on purpose: a source listed in a small-library answer (a list of files is an offer, not a use), a
 * directory listing, and a `grep -r` over the whole knowledge-base directory (it names no document). A document a run read
 * but whose path never named it is missed; the page says what it has, never that nothing used the document.
 *
 * @module sourceUses
 */

import { mcpToolBaseName } from "@evimed/domain";

/** How a document was used: a passage of it came back from a search, or a run read it. */
export const SOURCE_USE_KINDS = Object.freeze(["search", "read"]);

/** What most one document's page lists, newest conversation first. */
export const SOURCE_USES_LIST_LIMIT = 20;

const SOURCE_ID = "src_[a-f0-9]{32}";
const SOURCE_ID_EXACT = new RegExp(`^${SOURCE_ID}$`);
/**
 * The two places a run reads a document's text, as the path names the document: a project's parsed copy under the
 * synced knowledge directory, and the personal library's copy. A closed format (a source id after a fixed directory), not a
 * judgement about language.
 */
const READ_PATHS = [
  new RegExp(`(?:^|[^A-Za-z0-9_])\\.evimed-derived/(${SOURCE_ID})(?![A-Za-z0-9_])`, "g"),
  new RegExp(`(?:^|[^A-Za-z0-9_.-])library/(${SOURCE_ID})(?![A-Za-z0-9_])`, "g"),
];
/** The native tools whose inputs name a file or run a command: what a run reads a document with. */
const READ_TOOLS = new Set(["read", "grep", "bash"]);

/** @param {unknown} output @returns {Record<string, any> | null} an MCP tool's output as the transcript holds it: bare JSON text, or already an object */
function parsedResult(output) {
  if (output && typeof output === "object") return /** @type {Record<string, any>} */ (output);
  if (typeof output !== "string") return null;
  const text = output.trim();
  if (!text.startsWith("{")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** The source ids a text names by a read path. @param {unknown} text @returns {string[]} */
export function sourceIdsInReadPaths(text) {
  if (typeof text !== "string" || !text) return [];
  /** @type {Set<string>} */
  const found = new Set();
  for (const pattern of READ_PATHS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** @param {any} part @param {any} message @param {number} fallback epoch ms */
function usedAt(part, message, fallback) {
  const completed = Number(part?.completedAt);
  if (Number.isFinite(completed) && completed > 0) return completed;
  const recorded = Number(message?.time);
  return Number.isFinite(recorded) && recorded > 0 ? recorded : fallback;
}

/**
 * Every document a list of transcript messages used, once per document and kind: when it was first and last used, and how
 * many calls used it. Works on the messages of a collected session and of a stored transcript alike (the same
 * `{ parts: [{ type: "tool", tool, status, input, output }] }` shape).
 *
 * @param {readonly any[]} messages
 * @param {number} [fallbackAt] epoch ms for a call that carries no time of its own
 * @returns {{ sourceId: string, kind: "search" | "read", firstUsedAt: number, lastUsedAt: number, count: number }[]}
 */
export function sourceUsesFromMessages(messages, fallbackAt = Date.now()) {
  /** @type {Map<string, { sourceId: string, kind: "search" | "read", firstUsedAt: number, lastUsedAt: number, count: number }>} */
  const uses = new Map();
  /** @param {string} sourceId @param {"search" | "read"} kind @param {number} at */
  const note = (sourceId, kind, at) => {
    const key = `${sourceId}\u0000${kind}`;
    const entry = uses.get(key) ?? { sourceId, kind, firstUsedAt: at, lastUsedAt: at, count: 0 };
    entry.firstUsedAt = Math.min(entry.firstUsedAt, at);
    entry.lastUsedAt = Math.max(entry.lastUsedAt, at);
    entry.count += 1;
    uses.set(key, entry);
  };
  for (const message of messages ?? []) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool" || part?.status !== "completed") continue;
      const at = usedAt(part, message, fallbackAt);
      const tool = String(part.tool ?? "");
      if (mcpToolBaseName(tool) === "kb_search") {
        // The hits a search returned: each names its document. A small-library answer has `hits: []` and a list of `files`,
        // which are not hits.
        const hits = parsedResult(part.output)?.data?.hits;
        const named = new Set();
        for (const hit of Array.isArray(hits) ? hits : []) {
          const id = typeof hit?.sourceId === "string" ? hit.sourceId : "";
          if (SOURCE_ID_EXACT.test(id)) named.add(id);
        }
        for (const id of named) note(id, "search", at);
        continue;
      }
      if (!READ_TOOLS.has(tool)) continue;
      const input = part.input ?? {};
      const target = tool === "bash" ? input.command ?? input.cmd : input.file_path ?? input.path ?? input.filePath;
      for (const id of sourceIdsInReadPaths(target)) note(id, "read", at);
    }
  }
  return [...uses.values()];
}

/**
 * The uses of every session of a finished run, the way `collectRunTranscripts` hands them over (children included: a
 * delegate that read the document is the run having used it).
 * @param {readonly { transcript?: { messages?: readonly any[] } | null }[]} sessions
 * @param {number} [fallbackAt]
 */
export function sourceUsesFromSessions(sessions, fallbackAt = Date.now()) {
  return sourceUsesFromMessages((sessions ?? []).flatMap((session) => session?.transcript?.messages ?? []), fallbackAt);
}

/**
 * What a finished run's hook does with its transcript: record the documents it used, unless it was background work (a
 * document being read, an evaluation cell — the platform working, not a conversation that used the document), and never
 * let a failure to record be the run's failure: the transcript and everything else the hook writes are not made to wait on
 * it, and the failure is reported to whoever audits it.
 * @param {{ sourceUses: SourceUses | null, project: { userId: string, id: string }, run: { id: string, sessionId: string, finishedAt?: string | null },
 *   sessions: readonly any[], skip?: boolean, onError?: (error: any) => unknown }} input
 * @returns {Promise<number>} how many rows were written
 */
export async function recordSourceUsesOfRun({ sourceUses, project, run, sessions, skip = false, onError = () => {} }) {
  if (!sourceUses || skip) return 0;
  try {
    const uses = sourceUsesFromSessions(sessions, Date.parse(String(run.finishedAt ?? "")) || Date.now());
    if (!uses.length) return 0;
    return await sourceUses.record({ userId: project.userId, projectId: project.id, runId: run.id, sessionId: run.sessionId, uses });
  } catch (error) {
    try { await onError(error); } catch { /* reporting is best effort too */ }
    return 0;
  }
}

/**
 * The conversations of a document's uses, with the name each is known by: the title of the conversation's run in its
 * project's ledger, else the question that began it. A conversation the researcher deleted is left out (there is nothing to
 * send them to); one the ledger no longer holds stays, untitled — its session may still be there to open.
 * @param {readonly { sessionId: string, projectId: string }[]} rows
 * @param {ReadonlyMap<string, readonly any[]>} ledgers each project's runs
 */
export function nameConversations(rows, ledgers) {
  return rows.flatMap((row) => {
    const runs = (ledgers.get(row.projectId) ?? []).filter((run) => run?.sessionId === row.sessionId);
    if (runs.length > 0 && runs.every((run) => run.deleted)) return [];
    const titled = runs.find((run) => typeof run.title === "string" && run.title.trim());
    // The ledger lists newest first: the question that began the conversation is the oldest run's.
    const asked = [...runs].reverse().find((run) => typeof run.question === "string" && run.question.trim());
    const title = String(titled?.title ?? asked?.question ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
    return [{ ...row, title }];
  });
}

/**
 * The durable record: one row per document, run and kind, in the product database. Recording is idempotent — a run's
 * uses are derived from its transcript, so recording the same run again moves nothing — and monotone: a later, fuller
 * read of the transcript can widen the span and raise the count, never narrow them.
 */
export class SourceUses {
  /** @param {{ database: any }} options */
  constructor({ database }) {
    if (!database) throw new TypeError("Source uses need the product database.");
    this.database = database;
  }

  /**
   * Record what one run used. Only documents this account holds are recorded: a path in a transcript is text the model
   * wrote, and a document is a use only if it is the account's own.
   * @param {{ userId: string, projectId: string, runId: string, sessionId: string,
   *   uses: readonly { sourceId: string, kind: "search" | "read", firstUsedAt: number, lastUsedAt: number, count: number }[] }} input
   * @returns {Promise<number>} how many rows were written
   */
  async record({ userId, projectId, runId, sessionId, uses }) {
    if (!userId || !projectId || !runId || !sessionId || !uses?.length) return 0;
    const owned = new Set((await this.database.query(`SELECT id FROM evimed_product.documents
      WHERE user_id=$1 AND kind='source' AND deleted_at IS NULL AND id=ANY($2::text[])`, [userId, [...new Set(uses.map((use) => use.sourceId))]]))
      .rows.map((/** @type {{ id: string }} */ row) => row.id));
    // One row per document and kind, whatever the caller hands over: a statement that names a row twice cannot be applied.
    /** @type {Map<string, (typeof uses)[number]>} */
    const merged = new Map();
    for (const use of uses) {
      if (!owned.has(use.sourceId) || !SOURCE_USE_KINDS.includes(use.kind)) continue;
      const key = `${use.sourceId}\u0000${use.kind}`;
      const before = merged.get(key);
      merged.set(key, before ? { ...before, count: before.count + use.count, firstUsedAt: Math.min(before.firstUsedAt, use.firstUsedAt),
        lastUsedAt: Math.max(before.lastUsedAt, use.lastUsedAt) } : use);
    }
    const rows = [...merged.values()];
    if (!rows.length) return 0;
    await this.database.query(`INSERT INTO evimed_product.source_uses(user_id,project_id,source_id,run_id,session_id,kind,uses,first_used_at,last_used_at)
      SELECT $1,$2,x.source_id,$3,$4,x.kind,x.uses,to_timestamp(x.first_ms/1000.0),to_timestamp(x.last_ms/1000.0)
      FROM unnest($5::text[],$6::text[],$7::integer[],$8::bigint[],$9::bigint[]) AS x(source_id,kind,uses,first_ms,last_ms)
      ON CONFLICT (user_id,source_id,run_id,kind) DO UPDATE SET
        uses=GREATEST(evimed_product.source_uses.uses,EXCLUDED.uses),
        first_used_at=LEAST(evimed_product.source_uses.first_used_at,EXCLUDED.first_used_at),
        last_used_at=GREATEST(evimed_product.source_uses.last_used_at,EXCLUDED.last_used_at)`,
    [userId, projectId, runId, sessionId, rows.map((use) => use.sourceId), rows.map((use) => use.kind), rows.map((use) => Math.max(1, use.count)),
      rows.map((use) => Math.round(use.firstUsedAt)), rows.map((use) => Math.round(Math.max(use.lastUsedAt, use.firstUsedAt)))]);
    return rows.length;
  }

  /**
   * The conversations that used one document, newest first — the caller's own and nobody else's: every row is the
   * account's, and the document is asked for by the account that holds it.
   * One entry per conversation (session): the runs of one conversation are one conversation, and its kinds are what it did.
   * @param {string} userId @param {string} sourceId @param {{ limit?: number }} [options]
   * @returns {Promise<{ sessionId: string, projectId: string, runId: string, kinds: string[], uses: number, firstUsedAt: string, lastUsedAt: string }[]>}
   */
  async list(userId, sourceId, { limit = SOURCE_USES_LIST_LIMIT } = {}) {
    const bounded = Math.min(Math.max(Math.trunc(Number(limit)) || SOURCE_USES_LIST_LIMIT, 1), 100);
    const rows = (await this.database.query(`SELECT session_id, project_id,
        (array_agg(run_id ORDER BY last_used_at DESC, run_id DESC))[1] AS run_id,
        array_agg(DISTINCT kind ORDER BY kind) AS kinds, sum(uses)::integer AS uses,
        min(first_used_at) AS first_used_at, max(last_used_at) AS last_used_at
      FROM evimed_product.source_uses WHERE user_id=$1 AND source_id=$2
      GROUP BY session_id, project_id ORDER BY max(last_used_at) DESC, session_id DESC LIMIT $3`, [userId, sourceId, bounded])).rows;
    return rows.map((/** @type {any} */ row) => ({ sessionId: row.session_id, projectId: row.project_id, runId: row.run_id, kinds: row.kinds, uses: row.uses,
      firstUsedAt: new Date(row.first_used_at).toISOString(), lastUsedAt: new Date(row.last_used_at).toISOString() }));
  }

  /** What a document's own deletion takes with it. @param {string} userId @param {string} sourceId @param {any} [client] */
  async forget(userId, sourceId, client = this.database) {
    await client.query("DELETE FROM evimed_product.source_uses WHERE user_id=$1 AND source_id=$2", [userId, sourceId]);
  }
}
