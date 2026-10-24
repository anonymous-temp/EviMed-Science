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
 *   node scripts/ops/memory-engine.mjs --user <id> --to native                         # report: what would be carried over
 *   node scripts/ops/memory-engine.mjs --user <id> --to native --apply                 # carry it over, then move the account
 *   node scripts/ops/memory-engine.mjs --user <id> --to native --migrate               # an account ALREADY native: report what was left behind
 *   node scripts/ops/memory-engine.mjs --user <id> --to native --migrate --apply       # ... and carry it over (sets migrated_at)
 *   node scripts/ops/memory-engine.mjs --user <id> --to legacy --apply                 # move back
 *
 * A move to the native engine always replays the account's PostgreSQL records through the engine (`nativeMemoryMigration.mjs`:
 * a session per kind and project whose messages state them in the person's words, then a commit; each group's diff is read back
 * and every record looked for in what was written). The account is moved only when every group finished. There is no way to move
 * an account and leave its records behind (`--leave-records` is refused by name): from that moment the page, the recall, the
 * dispatch and the map read the engine only, so rows left in PostgreSQL are read by nothing — which is what happened to the
 * owner's own account on 2026-10-13 (one profile record and ten project notes, found on 2026-10-23). PostgreSQL's rows are kept:
 * moving back finds them as they were, and the engine keeps what it learned for a later return. `--migrate` is accepted on a
 * move as what it always meant; it is what completes an account that is already native and was moved without its records
 * (`native_accounts.migrated_at` empty while migratable records remain): report first, then `--apply`.
 *
 * Without `--apply` nothing is written and the engine is not asked. Prints counts, ids and file paths, never memory text.
 * Idempotent: moving to the engine the account is on changes nothing, and a second run carries only the groups that are
 * missing. The runtime of a moved account is let go by the server's native memory worker within a minute (a busy one is marked
 * and replaced at its next dispatch between two runs; the gateway withholds from an account that is not native meanwhile).
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { user: "", to: "", migrate: false, apply: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    if (argument === "--migrate") { options.migrate = true; continue; }
    if (argument === "--leave-records") {
      throw new Error("--leave-records was removed: a move to the native engine always carries the account's records over (rows left in PostgreSQL are read by nothing once the account is native); drop the flag");
    }
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
  if (options.to === "legacy" && options.migrate) throw new Error("--migrate is for --to native");
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
  const now = (deps.now ?? (() => new Date()))();
  // An account already on the engine is left as it is, unless `--migrate` asks to complete a move that carried nothing over.
  if (stored.engine === options.to && !(options.to === "native" && options.migrate)) {
    if (options.to === "native" && overlay && deps.planMigration) {
      const account = await overlay.account(options.user);
      const left = account.migratedAt ? null : deps.planMigration(await researchMemory.listAllRecords(options.user), { now });
      if (left?.carried) report.recordsLeftBehind = { carried: left.carried, hint: "this account was moved without its records and nothing reads them; run again with --migrate (report), then --migrate --apply" };
    }
    return { ok: true, ...report, changed: false, note: "the account is on that engine already" };
  }
  if (options.to === "native" && !enabled) {
    return { ok: false, ...report, error: "OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED is off here: an account cannot be moved to an engine the deployment does not have" };
  }
  if (options.to === "legacy") {
    report.keeps = "the account's native memory files stay in the engine for a return; the PostgreSQL records and their index copies resume";
    if (!options.apply) return { ok: true, ...report, changed: false };
    const moved = await researchMemory.setMemoryEngine(options.user, "legacy");
    return { ok: true, ...report, changed: moved.changed, changedAt: moved.changedAt };
  }
  const alreadyNative = stored.engine === "native";
  const records = await researchMemory.listAllRecords(options.user);
  const plan = deps.planMigration(records, { now });
  report.records = { total: plan.total, carried: plan.carried, notCarried: plan.skipped };
  report.sessions = plan.sessions.map((/** @type {any} */ session) => ({ session: session.session, kind: session.kind, projectId: session.projectId, records: session.records, messages: session.messages.length }));
  if (alreadyNative) {
    const account = await overlay.account(options.user);
    if (account.migratedAt) return { ok: true, ...report, changed: false, note: `the account was migrated at ${account.migratedAt}; nothing is left behind` };
    if (plan.carried === 0) return { ok: true, ...report, changed: false, note: "the account is native and holds no record that would be carried over" };
  }
  if (!options.apply) return { ok: true, ...report, changed: false, willMigrate: plan.carried > 0, sessionsToRun: plan.sessions.length };
  if (plan.carried > 0) {
    if (!sessions?.configured) return { ok: false, ...report, error: "the memory engine is not configured here (OPEN_SCIENCE_OPENVIKING_URL and its key)" };
    const migrated = await deps.runMigration({ sessions, overlay, worker, ...(deps.sleep ? { sleep: deps.sleep } : {}) }, options.user, plan);
    report.migration = {
      groups: migrated.groups.map((/** @type {any} */ group) => ({ session: group.session, kind: group.kind, projectId: group.projectId, state: group.state, records: group.records,
        foundVerbatim: group.found, notFoundVerbatim: group.notFoundVerbatim, files: group.files, ...(group.error ? { error: group.error } : {}) })),
      failed: migrated.failed,
    };
    if (migrated.failed > 0) return { ok: false, ...report, changed: false, error: `${migrated.failed} group(s) did not finish; the account stays on ${stored.engine}. Run it again to do the missing ones.` };
  }
  if (alreadyNative) return { ok: true, ...report, changed: false, migrated: true };
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
