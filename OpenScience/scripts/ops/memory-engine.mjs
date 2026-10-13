#!/usr/bin/env node
/**
 * Move one account's memory between the two engines, or check that no account is on both.
 *
 * An account's memory is on exactly one engine at a time (`evimed_memory.settings.engine`): `legacy` — the platform's own
 * extraction into PostgreSQL records, handed to a conversation as the resident profile and the recall tool — or `native` —
 * OpenViking's engine, learning and recalling through the memory plugin behind the memory gateway. A new account takes the
 * deployment's default (`OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED` on → native); an existing one stays where it is until this
 * moves it.
 *
 *   node scripts/ops/memory-engine.mjs --check                                        # the path walk: nobody on both
 *   node scripts/ops/memory-engine.mjs --user <id> --to native --migrate               # report: what would be carried over
 *   node scripts/ops/memory-engine.mjs --user <id> --to native --migrate --apply       # carry it over, then move the account
 *   node scripts/ops/memory-engine.mjs --user <id> --to native --leave-records --apply # move without carrying the records
 *   node scripts/ops/memory-engine.mjs --user <id> --to legacy --apply                 # move back
 *
 * `--migrate` replays the account's PostgreSQL records through the engine (`nativeMemoryMigration.mjs`: a session per kind and
 * project whose messages state them in the person's words, then a commit; each group's diff is read back and every record
 * looked for in what was written). The account is moved only when every group finished. PostgreSQL's rows are kept: moving
 * back finds them as they were, and the engine keeps what it learned for a later return. A native account with records and no
 * `--migrate` is refused unless `--leave-records` says the page should start empty.
 *
 * Without `--apply` nothing is written and the engine is not asked. Prints counts, ids and file paths, never memory text.
 * Idempotent: moving to the engine the account is on changes nothing, and a second `--migrate` runs only the groups that are
 * missing. The runtime of a moved account is let go by the server's native memory worker within a minute (a busy one keeps its
 * launch value until it stops, and the gateway withholds from an account that is not native meanwhile).
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { user: "", to: "", migrate: false, leaveRecords: false, apply: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    if (argument === "--migrate") { options.migrate = true; continue; }
    if (argument === "--leave-records") { options.leaveRecords = true; continue; }
    if (argument === "--check") { options.check = true; continue; }
    const field = { "--user": "user", "--to": "to" }[argument];
    if (!field) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    /** @type {any} */ (options)[field] = value;
    index += 1;
  }
  if (options.check) return options;
  if (!options.user) throw new Error("give --user <id> (or --check)");
  if (options.to !== "native" && options.to !== "legacy") throw new Error("give --to native or --to legacy");
  if (options.to === "legacy" && (options.migrate || options.leaveRecords)) throw new Error("--migrate and --leave-records are for --to native");
  if (options.migrate && options.leaveRecords) throw new Error("--migrate and --leave-records exclude each other");
  return options;
}

/**
 * The switch itself, over injected collaborators so it can be run against a test database and a stub engine.
 * @param {{ researchMemory: any, sessions: any, overlay: any, worker: any, enabled: boolean, planMigration: Function, runMigration: Function, now?: () => Date, sleep?: (ms: number) => Promise<void> }} deps
 * @param {ReturnType<typeof parseArguments>} options
 */
export async function switchEngine(deps, options) {
  const { researchMemory, sessions, overlay, worker, enabled } = deps;
  if (options.check) {
    const walk = await researchMemory.engineWalk();
    return { ok: walk.both.length === 0, check: { examined: walk.examined, accountsOnBothPaths: walk.both.length, accounts: walk.both.map((/** @type {any} */ entry) => ({ userId: entry.userId, engine: entry.engine, writes: entry.writes })) } };
  }
  const stored = await researchMemory.storedMemoryEngine(options.user);
  const report = /** @type {Record<string, any>} */ ({
    user: options.user, from: stored.engine, to: options.to, applied: options.apply, deploymentHasNativeEngine: enabled,
  });
  if (stored.engine === options.to) return { ok: true, ...report, changed: false, note: "the account is on that engine already" };
  if (options.to === "native" && !enabled) {
    return { ok: false, ...report, error: "OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED is off here: an account cannot be moved to an engine the deployment does not have" };
  }
  if (options.to === "legacy") {
    report.keeps = "the account's native memory files stay in the engine for a return; the PostgreSQL records and their index copies resume";
    if (!options.apply) return { ok: true, ...report, changed: false };
    const moved = await researchMemory.setMemoryEngine(options.user, "legacy");
    return { ok: true, ...report, changed: moved.changed, changedAt: moved.changedAt };
  }
  const records = await researchMemory.listAllRecords(options.user);
  const plan = deps.planMigration(records, { now: (deps.now ?? (() => new Date()))() });
  report.records = { total: plan.total, carried: plan.carried, notCarried: plan.skipped };
  report.sessions = plan.sessions.map((/** @type {any} */ session) => ({ session: session.session, kind: session.kind, projectId: session.projectId, records: session.records, messages: session.messages.length }));
  if (plan.carried > 0 && !options.migrate && !options.leaveRecords) {
    return { ok: false, ...report, error: `the account holds ${plan.carried} records the native page would not show; give --migrate to carry them over or --leave-records to start the page empty` };
  }
  if (!options.apply) return { ok: true, ...report, changed: false, willMigrate: options.migrate, sessionsToRun: options.migrate ? plan.sessions.length : 0 };
  if (options.migrate && plan.carried > 0) {
    if (!sessions?.configured) return { ok: false, ...report, error: "the memory engine is not configured here (OPEN_SCIENCE_OPENVIKING_URL and its key)" };
    const migrated = await deps.runMigration({ sessions, overlay, worker, ...(deps.sleep ? { sleep: deps.sleep } : {}) }, options.user, plan);
    report.migration = {
      groups: migrated.groups.map((/** @type {any} */ group) => ({ session: group.session, kind: group.kind, projectId: group.projectId, state: group.state, records: group.records,
        foundVerbatim: group.found, notFoundVerbatim: group.notFoundVerbatim, files: group.files, ...(group.error ? { error: group.error } : {}) })),
      failed: migrated.failed,
    };
    if (migrated.failed > 0) return { ok: false, ...report, changed: false, error: `${migrated.failed} group(s) did not finish; the account stays on ${stored.engine}. Run it again to do the missing ones.` };
  }
  const moved = await researchMemory.setMemoryEngine(options.user, "native");
  return { ok: true, ...report, changed: moved.changed, changedAt: moved.changedAt };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { OpenVikingClient }, { OpenVikingSessions }, { ResearchMemoryStore }, { NativeMemoryOverlay }, { NativeMemoryWorker }, migration] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/openVikingClient.mjs"),
    import("../../apps/server/src/openVikingSessions.mjs"),
    import("../../apps/server/src/researchMemory.mjs"),
    import("../../apps/server/src/nativeMemoryOverlay.mjs"),
    import("../../apps/server/src/nativeMemoryWorker.mjs"),
    import("../../apps/server/src/nativeMemoryMigration.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const researchMemory = new ResearchMemoryStore(config, { database });
    const sessions = new OpenVikingSessions(new OpenVikingClient(config), { timeoutMs: 30_000, fastTimeoutMs: 10_000 });
    const overlay = new NativeMemoryOverlay({ database });
    const worker = new NativeMemoryWorker({ config, researchMemory, sessions, overlay, report: (line) => process.stderr.write(`${line}\n`) });
    const result = await switchEngine({ researchMemory, sessions, overlay, worker, enabled: config.ovNativeMemoryEnabled === true, ...migration }, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`memory_engine_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
