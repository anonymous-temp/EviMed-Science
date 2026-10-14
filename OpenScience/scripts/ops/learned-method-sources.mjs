#!/usr/bin/env node
/**
 * Which runs an account's learned methods (「做法」) were learnt from — and whether any of those runs was the platform's own
 * re-check of a scheduled task's claim (a verification run) or a repair of the delivery gate. Report only: it retires nothing.
 *
 *   node scripts/ops/learned-method-sources.mjs --user <userId>                  # every method, its source runs, the counts
 *   node scripts/ops/learned-method-sources.mjs --user <userId> --only-flagged   # only the methods with at least one such source
 *
 * Why: on 2026-10-14 the owner's ledger held 14 verification runs beside 5 executions, and they carried no `automated` mark and no
 * `autopilot:` reason, so the learning loop could read them as the researcher's work (`isResearcherOwnedWork`, fixed the same day).
 * What was already learnt from them is a decision for the person who runs this on production — this only lists it.
 *
 * What it reads: the method ledger (`LearningService.sourceLessons`: the run each revision of a method was learnt from and the trigger
 * that queued it) and each run's record in its project's ledger (the route reason the control plane wrote at dispatch; a project that
 * was deleted is read through the lesson's own preserved copy). What it prints: ids, route reasons, triggers and counts — never a
 * method's text, a title, a question or a conversation.
 *
 * A source run is
 *  - `verification`: its route reason is a verification's (`isVerificationRun`);
 *  - `gate-repair`: the lesson was queued as `repair_accepted`, or the run records a repair round of the delivery gate;
 *  - `unresolved`: the run could not be found (its project or ledger is gone);
 *  - `other`: anything else — the researcher's own conversation, or a scheduled execution.
 * A method made by the consolidation pass has no run of its own (`consolidated: true`); the methods it merged are listed as theirs.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

import { isVerificationRun } from "@evimed/domain";

/** The kinds a source run is told apart by, in the order the counts are printed. */
export const SOURCE_KINDS = Object.freeze(["verification", "gate-repair", "unresolved", "other"]);

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { user: "", onlyFlagged: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--only-flagged") { options.onlyFlagged = true; continue; }
    if (argument !== "--user") throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--user needs a value");
    options.user = value;
    index += 1;
  }
  if (!options.user) throw new Error("give --user <id>");
  return options;
}

/**
 * What one source run was, from its record and the trigger that queued the lesson.
 * @param {any} run the run as the ledger holds it, or null when it could not be found
 * @param {string | null} trigger
 * @returns {"verification" | "gate-repair" | "unresolved" | "other"}
 */
export function sourceKind(run, trigger) {
  if (!run) return "unresolved";
  if (isVerificationRun(run)) return "verification";
  const rounds = Number(run.repairRounds?.content ?? 0) + Number(run.repairRounds?.structural ?? 0);
  if (trigger === "repair_accepted" || rounds > 0) return "gate-repair";
  return "other";
}

/**
 * @param {{ learning: any, resolveRun: (userId: string, projectId: string, runId: string) => Promise<any>, userId: string, onlyFlagged?: boolean }} input
 *   `learning` is the method ledger (`LearningService`); `resolveRun` finds a run by project and id, or null.
 */
export async function learnedMethodSources({ learning, resolveRun, userId, onlyFlagged = false }) {
  /** @type {any[]} */
  const methods = [];
  let cursor = null;
  do {
    const page = await learning.listMethods(userId, { limit: 100, cursor });
    methods.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);

  /** @type {Record<string, number>} */
  const totals = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 0]));
  const items = [];
  let withSources = 0;
  for (const method of methods) {
    const lessons = await learning.sourceLessons(userId, method.id);
    const sources = [];
    /** @type {Record<string, number>} */
    const counts = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 0]));
    for (const lesson of lessons) {
      /** @type {any} */
      let run = null;
      try { run = await resolveRun(userId, lesson.projectId, lesson.runId); } catch { run = null; }
      const kind = sourceKind(run, lesson.trigger);
      counts[kind] += 1;
      totals[kind] += 1;
      sources.push({
        projectId: lesson.projectId, runId: lesson.runId, trigger: lesson.trigger, kind,
        routeReason: typeof run?.effectiveRouteReason === "string" ? run.effectiveRouteReason : null,
      });
    }
    if (sources.length > 0) withSources += 1;
    const flagged = counts.verification + counts["gate-repair"];
    if (onlyFlagged && flagged === 0) continue;
    items.push({
      methodId: method.id,
      status: String(method.payload?.status ?? ""),
      consolidated: sources.length === 0 && String(method.payload?.provenance?.consolidatedBy ?? "") !== "",
      sources,
      counts,
      flagged: flagged > 0,
      // Every run it was learnt from is one of the two: nothing of the researcher's own work is in it.
      onlyFlagged: sources.length > 0 && flagged === sources.length,
    });
  }
  return {
    methods: methods.length,
    withSources,
    flagged: items.filter((item) => item.flagged).length,
    onlyFlagged: items.filter((item) => item.onlyFlagged).length,
    sourceRuns: totals,
    items,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments }, { LearningService }, { AgentRunStore }, { resolveLessonSourceRun }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/learningService.mjs"),
    import("../../apps/server/src/agentRuns.mjs"),
    import("../../apps/server/src/learningPreservation.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const learning = new LearningService({ documents: new ProductDocuments(database) });
    // Reads a project's ledger only; no runtime, session store or model is touched.
    const agentRuns = new AgentRunStore(/** @type {any} */ (null), { model: config.deepseekModel });
    /** One ledger read per project, however many lessons name it. @type {Map<string, Promise<Map<string, any> | null>>} */
    const ledgers = new Map();
    const resolveRun = async (/** @type {string} */ userId, /** @type {string} */ projectId, /** @type {string} */ runId) => {
      const key = `${userId}\u0000${projectId}`;
      if (!ledgers.has(key)) {
        ledgers.set(key, (async () => {
          try {
            const user = await store.userById(userId);
            if (!user) return null;
            const project = await store.requireProject(user, projectId);
            return new Map((await agentRuns.list(project)).map((run) => [run.id, run]));
          } catch { return null; }
        })());
      }
      return (await ledgers.get(key))?.get(runId) ?? resolveLessonSourceRun(store, agentRuns, userId, projectId, runId);
    };
    const report = await learnedMethodSources({ learning, resolveRun, userId: options.user, onlyFlagged: options.onlyFlagged });
    process.stdout.write(`${JSON.stringify({ user: options.user, ...report }, null, 2)}\n`);
  } finally {
    await database?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`learned-method-sources: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
