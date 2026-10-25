/**
 * A script the person's own work keeps coming back to, found in their runs and offered to the distillation as a lesson of its own kind.
 *
 * Hidden knowledge: the loop learned what the person *says* (a correction, a standing preference) and what shape their deliverables take (a routine),
 * and nothing of the code the assistant writes for them again and again — the cleaning script for the weekly export, the plot function for the same
 * kind of table. EvoDS's ASA turns a procedure that recurs into a tool (synthesize, verify, cache once it has been seen τ = 3 times), and ours had every
 * part but the first: the validators for a code skill's three files (`methodSkill.mjs`), the mount that puts `scripts/` in a run's room
 * (`learnedMethodMount.mjs`), the disposable executor that runs a script's own test (`codeSkillVerification.mjs`) — and nothing that noticed a script
 * recurring, so a method never carried one (audit 2026-10-23, A2). This is the noticing; the writing is the distillation's, and the proving is the
 * executor's.
 *
 * What counts as the same script is code, never a reading of what it says. A snippet is taken out of a tool call by its *format* — the body of a shell
 * heredoc that feeds `python`, the program of `python -c`, a file written to a `.py` path — and normalised by Python's own parser (`NORMALISE_PROGRAM`):
 * every name the script binds becomes a position, every string and number a placeholder, the imports their module, the docstrings go. Two scripts that
 * differ only in a file name, a column and a variable are one script; two that call different things are two. The hash of the tree is the script's
 * identity. The parser runs where Python already runs for the control plane — the runtime controller's disposable container, no network, one batch of
 * snippets in, one JSON line out (`controller.execVerify`) — so the web image gains no interpreter. Executor unavailable is counted and the run is not
 * recorded: no hash is ever guessed in Node.
 *
 * The same hash in three runs of two conversations of one account within ninety days queues one `script` lesson (`SCRIPT_RUNS`, `SCRIPT_CONVERSATIONS`;
 * provisional, as every threshold of the loop is until it has a distribution), once for that hash. Only a run the researcher left alone
 * (`LearningEvidence.settle`, after every refusal of the loop: the researcher's own attended work, not paused, not clinical, not a trial, not automated)
 * counts, and a snippet that carries a credential or an identifier is dropped before it is stored. The occurrences are kept in `evimed_learning.script_uses`,
 * with the source of each (bounded), so that the distillation is shown the variants and not only the one that completed the count; they are kept for the
 * window and no longer (each write drops the account's older rows), a project's deletion and a memory reset take them, an account's deletion too, and they
 * are in the account's export.
 *
 * Nothing here gates anything. A script that never reaches a method costs the researcher nothing, and a run's own work was done long before.
 *
 * Deletable when the kernel hands the learning loop a typed account of the programs a turn ran.
 *
 * @module scriptLessons
 */

import { createHash } from "node:crypto";

import { identifierShapesIn } from "@evimed/domain";

import { CONVERSATION_SCOPE, learningScopeOf } from "./learningTriggers.mjs";
import { readRunTranscript } from "./runTranscripts.mjs";

/** The three runs of two conversations, within ninety days, that make a script recur; the weight of a script worth proposing; what one run may contribute. */
export const SCRIPT_RUNS = 3;
export const SCRIPT_CONVERSATIONS = 2;
export const SCRIPT_WINDOW_DAYS = 90;
export const SCRIPT_MIN_STATEMENTS = 5;
export const SCRIPT_LIMITS = Object.freeze({ snippetsPerRun: 12, snippetChars: 16_000, exemplars: 3, occurrences: 6 });

/** What the detector counts, as a closed vocabulary. */
export const SCRIPT_OUTCOMES = Object.freeze(["snippets", "normalised", "unparsable", "too_small", "sensitive", "recorded", "lesson_queued", "executor_unavailable", "no_transcript"]);

/** The tools whose input may hold a program: the shell's `command`, and a file written to a `.py` path. A closed list of the kernel's own tool names. */
const SHELL_TOOLS = new Set(["bash", "shell", "evimed_exec"]);
const WRITE_TOOLS = new Set(["write", "write_file"]);

/** Python source from a shell command, by the shell's own syntax: a heredoc that feeds `python`, `python -c '…'`, and a heredoc that writes a `.py` file (`cat > x.py <<'EOF'`). */
const HEREDOC = /\bpython[0-9.]*\b[^\n<|;&]*<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/g;
const WRITING_HEREDOC = /\b(?:cat|tee)\b[^\n<]*?\S+\.py\b[^\n<]*<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/g;
const DASH_C = /\bpython[0-9.]*\b(?:[ \t]+-[A-Za-z]+)*[ \t]+-c[ \t]+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g;

/** @param {string} text @returns {string} what a double-quoted shell word holds: `\"`, `\\`, `\$` and the backtick are the only escapes */
const unquoteDouble = (text) => text.replace(/\\(["\\$`])/g, "$1");

/**
 * The Python programs one tool call's input holds, by format.
 * @param {string} tool @param {any} input
 * @returns {string[]}
 */
export function pythonSnippetsOfCall(tool, input) {
  /** @type {string[]} */
  const found = [];
  if (SHELL_TOOLS.has(tool)) {
    const command = String(input?.command ?? input?.cmd ?? "");
    if (!command.includes("python") && !command.includes(".py")) return found;
    for (const match of command.matchAll(HEREDOC)) found.push(match[3]);
    for (const match of command.matchAll(WRITING_HEREDOC)) found.push(match[3]);
    for (const match of command.matchAll(DASH_C)) found.push(match[1] ?? unquoteDouble(match[2] ?? ""));
  } else if (WRITE_TOOLS.has(tool)) {
    const target = String(input?.file_path ?? input?.filePath ?? input?.path ?? "");
    const content = input?.content ?? input?.contents;
    if (/\.py$/i.test(target) && typeof content === "string") found.push(content);
  }
  return found;
}

/**
 * Every Python program a run's tool calls carried, in the order they were made: across the run's sessions, a snippet once however often it was run.
 * @param {{ messages?: readonly any[] } | null | undefined} transcript
 * @returns {string[]}
 */
export function pythonSnippetsOf(transcript) {
  /** @type {string[]} */
  const snippets = [];
  const seen = new Set();
  for (const message of transcript?.messages ?? []) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool") continue;
      for (const source of pythonSnippetsOfCall(String(part.tool ?? ""), part.input)) {
        const key = createHash("sha256").update(source).digest("hex");
        if (seen.has(key) || !source.trim()) continue;
        seen.add(key);
        snippets.push(source);
      }
    }
  }
  return snippets;
}

/**
 * Whether a program carries a credential or an identifier by shape (`identifierShapesIn`): such a snippet is dropped before anything is stored.
 * Not by word: a keyword pattern (`token`, `secret`, `password`) refused every script that merely named one of them, and a program is code, whose
 * words are not a sentence to read for what it is about (2026-10-25).
 * @param {string} source
 */
export const sensitiveSource = (source) => identifierShapesIn(source).length > 0;

/**
 * The program Python runs to normalise a batch of snippets (stdin `{snippets: [{id, source}]}`, stdout's last line `{results: [...]}`).
 *
 * Names the script binds (variables, functions, classes, arguments, `except … as`, `global`) become `v0`, `v1`, … in the order they first appear; names
 * it imports become the module or the symbol imported, whatever alias it chose; builtins stay; attribute names and keyword names stay (they are the API
 * a script calls); every string, bytes and number becomes a placeholder of its type; booleans, `None` and `...` stay; docstrings go. The identity is the
 * sha256 of `ast.dump` of that tree.
 */
export const NORMALISE_PROGRAM = String.raw`
import ast, builtins, hashlib, json, sys
BUILTINS = set(dir(builtins))
class Canon(ast.NodeTransformer):
    def __init__(self):
        self.names = {}
        self.imported = {}
    def bind(self, name):
        if name not in self.names:
            self.names[name] = 'v%d' % len(self.names)
        return self.names[name]
    def visit_Import(self, node):
        names = []
        for alias in node.names:
            self.imported[alias.asname or alias.name.split('.')[0]] = alias.name if alias.asname else alias.name.split('.')[0]
            names.append(ast.alias(name=alias.name, asname=None))
        return ast.copy_location(ast.Import(names=names), node)
    def visit_ImportFrom(self, node):
        names = []
        for alias in node.names:
            self.imported[alias.asname or alias.name] = alias.name
            names.append(ast.alias(name=alias.name, asname=None))
        return ast.copy_location(ast.ImportFrom(module=node.module, names=names, level=node.level), node)
    def visit_Name(self, node):
        if node.id in self.imported:
            return ast.copy_location(ast.Name(id=self.imported[node.id], ctx=node.ctx), node)
        if node.id in BUILTINS and node.id not in self.names:
            return node
        return ast.copy_location(ast.Name(id=self.bind(node.id), ctx=node.ctx), node)
    def visit_arg(self, node):
        node.arg = self.bind(node.arg)
        node.annotation = None
        return node
    def visit_FunctionDef(self, node):
        node.name = self.bind(node.name)
        node.returns = None
        node.body = self.strip_docstring(node.body)
        self.generic_visit(node)
        return node
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_ClassDef(self, node):
        node.name = self.bind(node.name)
        node.body = self.strip_docstring(node.body)
        self.generic_visit(node)
        return node
    def visit_ExceptHandler(self, node):
        if node.name:
            node.name = self.bind(node.name)
        self.generic_visit(node)
        return node
    def visit_Global(self, node):
        node.names = [self.bind(n) for n in node.names]
        return node
    visit_Nonlocal = visit_Global
    def visit_AnnAssign(self, node):
        self.generic_visit(node)
        return ast.copy_location(ast.Assign(targets=[node.target], value=node.value or ast.Constant(value=None)), node)
    def visit_Constant(self, node):
        value = node.value
        if isinstance(value, bool) or value is None or value is Ellipsis:
            return node
        if isinstance(value, str):
            return ast.copy_location(ast.Constant(value=''), node)
        if isinstance(value, bytes):
            return ast.copy_location(ast.Constant(value=b''), node)
        return ast.copy_location(ast.Constant(value=0), node)
    def strip_docstring(self, body):
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
            body = body[1:]
        return body or [ast.Pass()]
def normalise(source):
    tree = ast.parse(source)
    tree.body = Canon().strip_docstring(tree.body) if tree.body else tree.body
    canon = Canon()
    tree = canon.visit(tree)
    ast.fix_missing_locations(tree)
    nodes = list(ast.walk(tree))
    return {
        'hash': hashlib.sha256(ast.dump(tree).encode('utf-8')).hexdigest()[:32],
        'statements': sum(1 for n in nodes if isinstance(n, ast.stmt)),
        'nodes': len(nodes),
    }
results = []
for snippet in json.load(sys.stdin).get('snippets', []):
    try:
        results.append(dict(id=snippet['id'], **normalise(snippet['source'])))
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        results.append({'id': snippet['id'], 'error': 'unparsable'})
print(json.dumps({'results': results}))
`;

/** What one normalisation said of one snippet, read from the program's answer and refused when it is not the shape the program prints. @param {unknown} entry */
function normalisedEntry(entry) {
  const row = /** @type {any} */ (entry);
  if (typeof row?.id !== "string") return null;
  if (row.error === "unparsable") return { id: row.id, error: "unparsable" };
  if (!/^[a-f0-9]{32}$/.test(String(row.hash ?? ""))) return null;
  return { id: row.id, hash: String(row.hash), statements: Math.max(0, Math.trunc(Number(row.statements) || 0)), nodes: Math.max(0, Math.trunc(Number(row.nodes) || 0)) };
}

/**
 * Normalise a batch of snippets in the disposable executor.
 * @param {(body: any, options?: any) => Promise<any>} execute `controller.execVerify`
 * @param {readonly string[]} sources @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<({ id: string, hash: string, statements: number, nodes: number } | { id: string, error: string })[]>}
 * @throws when the executor did not run the program to the end: nothing is guessed in its place
 */
export async function normaliseSnippets(execute, sources, { signal = undefined } = {}) {
  if (!sources.length) return [];
  const snippets = sources.map((source, index) => ({ id: String(index), source }));
  const result = await execute({ files: {}, code: NORMALISE_PROGRAM, input: { snippets } }, { signal });
  if (result?.ok !== true || result?.joined === false) throw Object.assign(new Error("The snippet normaliser did not complete."), { code: "script_normaliser_unavailable" });
  const last = String(result.output ?? result.stdout ?? "").trim().split("\n").at(-1) ?? "";
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(last); } catch { throw Object.assign(new Error("The snippet normaliser answered nothing readable."), { code: "script_normaliser_unreadable" }); }
  const rows = (Array.isArray(parsed?.results) ? parsed.results : []).map(normalisedEntry).filter(Boolean);
  return /** @type {any} */ (rows.filter((row) => snippets.some((snippet) => snippet.id === row.id)));
}

const SQL = `
CREATE SCHEMA IF NOT EXISTS evimed_learning;
CREATE TABLE IF NOT EXISTS evimed_learning.script_uses (
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 script_hash text NOT NULL CHECK (script_hash ~ '^[a-f0-9]{32}$'),
 run_id text NOT NULL,
 session_id text NOT NULL,
 project_id text,
 scope text NOT NULL,
 occurred_at timestamptz(3) NOT NULL,
 source text NOT NULL CHECK (length(source) <= 20000),
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (user_id, script_hash, run_id),
 FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS script_uses_window_idx ON evimed_learning.script_uses(user_id, script_hash, occurred_at DESC);
`;
const migrations = new WeakMap();

/** The table of script occurrences, created by this module's own idempotent migration (a feature of the learning loop owns its tables, as the share links do). @param {any} database */
export async function migrateScriptUses(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-script-uses-v1'))");
    await client.query(SQL);
  });
  migrations.set(database, attempt);
  try { await attempt; } catch (error) { migrations.delete(database); throw error; }
}

/** Every occurrence of a script one account has: one row per script and run. */
export class ScriptUses {
  /** @param {{ database: any, now?: () => Date, windowDays?: number }} options */
  constructor({ database, now = () => new Date(), windowDays = SCRIPT_WINDOW_DAYS }) {
    this.database = database;
    this.now = now;
    this.windowMs = windowDays * 86_400_000;
  }

  /**
   * One run's occurrences. Recording the same script of the same run again records it once.
   * @param {string} userId @param {{ runId: string, sessionId: string, projectId: string | null, scope: string, at: Date, scripts: readonly { hash: string, source: string }[] }} run
   * @returns {Promise<number>} how many were new
   */
  async record(userId, { runId, sessionId, projectId, scope, at, scripts }) {
    if (!scripts.length) return 0;
    await migrateScriptUses(this.database);
    let added = 0;
    for (const script of scripts) {
      const inserted = await this.database.query(`INSERT INTO evimed_learning.script_uses(user_id,script_hash,run_id,session_id,project_id,scope,occurred_at,source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id,script_hash,run_id) DO NOTHING`,
      [userId, script.hash, runId, sessionId, projectId, scope, at.toISOString(), script.source.slice(0, SCRIPT_LIMITS.snippetChars)]);
      added += Number(inserted.rowCount ?? 0);
    }
    // What is older than the window counts for nothing and is not kept: a program of the person's is held for ninety days and no longer.
    await this.database.query("DELETE FROM evimed_learning.script_uses WHERE user_id=$1 AND occurred_at < $2",
      [userId, new Date(this.now().getTime() - this.windowMs).toISOString()]);
    return added;
  }

  /**
   * How often a script recurred in the window: the runs and the conversations they were in.
   * @param {string} userId @param {string} hash
   * @returns {Promise<{ runs: number, conversations: number, scope: string | null, occurrences: { runId: string, projectId: string | null, sessionId: string, at: string }[] }>}
   */
  async recurrence(userId, hash) {
    await migrateScriptUses(this.database);
    const since = new Date(this.now().getTime() - this.windowMs).toISOString();
    const { rows } = await this.database.query(`SELECT run_id, project_id, session_id, scope, occurred_at FROM evimed_learning.script_uses
      WHERE user_id=$1 AND script_hash=$2 AND occurred_at >= $3 ORDER BY occurred_at DESC, run_id`, [userId, hash, since]);
    const conversations = new Set(rows.map((/** @type {any} */ row) => `${row.project_id ?? ""}\u0000${row.session_id}`));
    return {
      runs: rows.length, conversations: conversations.size, scope: rows[0]?.scope ?? null,
      occurrences: rows.slice(0, SCRIPT_LIMITS.occurrences).map((/** @type {any} */ row) => ({ runId: row.run_id, projectId: row.project_id ?? null, sessionId: row.session_id, at: new Date(row.occurred_at).toISOString() })),
    };
  }

  /**
   * The sources the distillation is shown: the newest occurrence of each of up to three runs, so it sees what varies between them.
   * @param {string} userId @param {string} hash
   * @returns {Promise<{ runId: string, at: string, source: string }[]>}
   */
  async exemplars(userId, hash) {
    await migrateScriptUses(this.database);
    const { rows } = await this.database.query(`SELECT run_id, occurred_at, source FROM evimed_learning.script_uses WHERE user_id=$1 AND script_hash=$2
      ORDER BY occurred_at DESC, run_id LIMIT $3`, [userId, hash, SCRIPT_LIMITS.exemplars]);
    return rows.map((/** @type {any} */ row) => ({ runId: row.run_id, at: new Date(row.occurred_at).toISOString(), source: String(row.source) }));
  }

  /** Forget every occurrence an account has (a memory reset: what the researcher asked to forget teaches nothing). @param {string} userId @returns {Promise<number>} */
  async clear(userId) {
    await migrateScriptUses(this.database);
    const removed = await this.database.query("DELETE FROM evimed_learning.script_uses WHERE user_id=$1", [userId]);
    return Number(removed.rowCount ?? 0);
  }
}

/**
 * The lesson a script that has recurred is, or null: the same program in `SCRIPT_RUNS` runs of `SCRIPT_CONVERSATIONS` conversations. One lesson per script
 * of an account (the key names the hash), because a script seen a fourth time is not new evidence for a method that was written, or refused, at the third.
 * Pure.
 * @param {{ hash: string, run: any, recurrence: { runs: number, conversations: number, scope: string | null, occurrences: readonly any[] } }} input
 * @returns {{ trigger: string, idempotencyKey: string, payload: Record<string, any> } | null}
 */
export function scriptLessonFor({ hash, run, recurrence }) {
  if (!run?.id || recurrence.runs < SCRIPT_RUNS || recurrence.conversations < SCRIPT_CONVERSATIONS) return null;
  const scope = recurrence.scope ?? CONVERSATION_SCOPE;
  return {
    trigger: "script",
    idempotencyKey: `distill:script:${hash}`,
    payload: {
      runId: run.id, trigger: "script", scope, capabilityId: scope === CONVERSATION_SCOPE ? null : scope, scriptHash: hash,
      // Two scripts that complete their count in one run are two lessons, and neither adopts the other's bounded run (`distillationDispatchId`).
      dispatchKey: hash,
      runs: recurrence.runs, conversations: recurrence.conversations,
      // By run and project: a run id names a transcript only inside its own project.
      occurrences: recurrence.occurrences.map((entry) => ({ runId: entry.runId, projectId: entry.projectId, sessionId: entry.sessionId, at: entry.at })),
    },
  };
}

export class ScriptLessons {
  /**
   * `execute` is the disposable executor (`RuntimeControllerClient.execVerify`); `uses` the occurrences; `queue(project, run, lesson)` is the loop's own queue
   * (`LearningTriggers.queue`, given late because it holds the evidence that holds this). `onOutcome(outcome, times)` counts (`SCRIPT_OUTCOMES`), told and never asked.
   * @param {{ uses: ScriptUses, execute: ((body: any, options?: any) => Promise<any>) | null, queue: () => ((project: any, run: any, lesson: any) => Promise<boolean>) | null,
   *   readTranscript?: typeof readRunTranscript, onOutcome?: ((outcome: string, times?: number) => void) | null, now?: () => Date }} dependencies
   */
  constructor({ uses, execute, queue, readTranscript = readRunTranscript, onOutcome = null, now = () => new Date() }) {
    if (!uses) throw new TypeError("Script lessons need the occurrence ledger.");
    this.uses = uses;
    this.execute = execute;
    this.queue = queue;
    this.readTranscript = readTranscript;
    this.onOutcome = onOutcome;
    this.now = now;
  }

  /** @param {string} outcome @param {number} [times] */
  #count(outcome, times = 1) {
    if (times <= 0) return;
    try { this.onOutcome?.(outcome, times); } catch { /* a counter never decides what is learned */ }
  }

  /**
   * A run the researcher left alone, read for the scripts it ran. The caller has passed it through every refusal of the loop. Never a throw: a
   * run whose scripts could not be read is one the loop did not learn a script from.
   * @param {any} project @param {any} run
   * @returns {Promise<{ recorded: number, queued: string[] }>}
   */
  async afterSettle(project, run) {
    const none = { recorded: 0, queued: /** @type {string[]} */ ([]) };
    try {
      if (!this.execute) return none;
      const transcript = await this.readTranscript(project, run.id).catch(() => null);
      if (!transcript) { this.#count("no_transcript"); return none; }
      const found = pythonSnippetsOf(transcript).slice(0, SCRIPT_LIMITS.snippetsPerRun);
      this.#count("snippets", found.length);
      const sources = found.filter((source) => {
        if (source.length > SCRIPT_LIMITS.snippetChars) return false;
        if (sensitiveSource(source)) { this.#count("sensitive"); return false; }
        return true;
      });
      if (!sources.length) return none;
      /** @type {Awaited<ReturnType<typeof normaliseSnippets>>} */
      let normalised;
      try {
        normalised = await normaliseSnippets(this.execute, sources);
      } catch {
        this.#count("executor_unavailable");
        return none;
      }
      /** @type {Map<string, { hash: string, source: string }>} one occurrence per script and run */
      const scripts = new Map();
      for (const entry of normalised) {
        if ("error" in entry) { this.#count("unparsable"); continue; }
        if (entry.statements < SCRIPT_MIN_STATEMENTS) { this.#count("too_small"); continue; }
        this.#count("normalised");
        const source = sources[Number(entry.id)];
        if (source !== undefined && !scripts.has(entry.hash)) scripts.set(entry.hash, { hash: entry.hash, source });
      }
      if (!scripts.size) return none;
      const recorded = await this.uses.record(project.userId, {
        runId: run.id, sessionId: String(run.sessionId ?? run.id), projectId: project.id ?? null, scope: learningScopeOf(run),
        at: new Date(Date.parse(String(run.finishedAt ?? "")) || this.now().getTime()), scripts: [...scripts.values()],
      });
      this.#count("recorded", recorded);
      const queue = this.queue?.();
      /** @type {string[]} */
      const queued = [];
      for (const hash of scripts.keys()) {
        const lesson = scriptLessonFor({ hash, run, recurrence: await this.uses.recurrence(project.userId, hash) });
        if (lesson && queue && await queue(project, run, lesson)) { queued.push(hash); this.#count("lesson_queued"); }
      }
      return { recorded, queued };
    } catch {
      return none;
    }
  }
}

