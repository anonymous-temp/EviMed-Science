#!/usr/bin/env node
/**
 * Make OpenViking's copies of the knowledge base agree with PostgreSQL: the backfill, and the repair after a lost volume.
 *
 * What the engine holds under `…/resources/p/<project>/sources/` and `…/resources/library/` is derived — the text
 * PostgreSQL captured from each document, pushed so the engine's Compile can read it. This command compares the two,
 * project by project, and — with `--apply` — pushes what is missing or stale and removes what PostgreSQL no longer
 * holds. It is the same reconciliation the server's worker runs on a timer and before every compile
 * (`openVikingSourceSync.mjs`), so it always converges and is always safe to run again.
 *
 *   node scripts/ops/rebuild-ov-resources.mjs --user <userId> [--user <userId>]     report only (the default)
 *   node scripts/ops/rebuild-ov-resources.mjs --all --apply                         repair every account
 *   … --json                                                                        every project's lists, not only the counts
 *
 * A dry run by default, because the first thing an operator wants after an incident is the size of the difference.
 * The exit code is 0 when, at the end, every readable document has its file with the same digest and nothing else is
 * there; with `--apply` that is after the repair. The compiled wiki and graph are not touched: they are the engine's
 * own work, and the product ledger holds their mirror.
 *
 * `--all` reads the accounts from the control-plane database, so it needs the configuration the server runs with.
 */
import process from "node:process";

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {string[]} */
  const users = [];
  let all = false;
  let apply = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") all = true;
    else if (argument === "--apply") apply = true;
    else if (argument === "--json") json = true;
    else if (argument === "--user") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--user needs a user id");
      users.push(value);
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!all && users.length === 0) throw new Error("give --user <id> at least once, or --all");
  return { users, all, apply, json };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments, ProductJobs }, { SourceService }, { OpenVikingClient }, { OpenVikingResources },
    { OpenVikingSourceSync, readableSourceProjects }, { createLibrary }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/sourceService.mjs"),
    import("../../apps/server/src/openVikingClient.mjs"),
    import("../../apps/server/src/openVikingResources.mjs"),
    import("../../apps/server/src/openVikingSourceSync.mjs"),
    import("../../apps/server/src/libraryService.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  /** @param {Record<string, unknown>} report */
  const stop = (report) => { process.stdout.write(`${JSON.stringify({ ok: false, ...report }, null, 2)}\n`); process.exitCode = 1; };
  try {
    if (!database) return stop({ reason: "no control-plane database" });
    const client = new OpenVikingClient(config);
    const resources = new OpenVikingResources({ client });
    if (!resources.configured) return stop({ reason: "no engine configured", status: await client.status() });
    const health = await client.status();
    if (!health.connected) return stop({ reason: "engine unreachable", status: health });
    const documents = new ProductDocuments(database);
    const jobs = new ProductJobs(database);
    const sources = new SourceService(documents, jobs);
    const library = createLibrary({ config, store, documents, sources }).service;
    // The switch is not consulted: this command is how an operator fills the engine before turning the module on.
    const sync = new OpenVikingSourceSync({ config: { ...config, ovKnowledgeEnabled: true }, sources, resources, jobs, library });

    let userIds = options.users;
    if (options.all) {
      await store.loadUsers();
      userIds = [...store.users.keys()];
    }
    const wanted = new Set(userIds);
    const projects = (await readableSourceProjects(database, { limit: 100_000 })).filter((entry) => wanted.has(entry.userId));
    /** @type {any[]} */
    const results = [];
    for (const { userId, projectId } of projects) {
      try {
        const report = await sync.reconcileProject(userId, projectId, { apply: options.apply });
        // After a repair, the proof is a second reading that finds nothing to do.
        const after = options.apply ? await sync.reconcileProject(userId, projectId, { apply: false }) : report;
        results.push({ userId, projectId, expected: report.expected, present: report.present, missing: report.missing.length, stale: report.stale.length, extra: report.extra.length,
          pushed: report.pushed, removed: report.removed, failed: report.failed, agrees: after.missing.length + after.stale.length + after.extra.length === 0,
          ...(options.json ? { lists: { missing: report.missing, stale: report.stale, extra: report.extra } } : {}) });
      } catch (error) {
        // One project's failure must not abandon the rest.
        results.push({ userId, projectId, error: /** @type {any} */ (error)?.code ?? "reconcile_failed", agrees: false });
      }
    }
    /** @type {any[]} */
    const libraries = [];
    for (const userId of userIds) {
      try {
        const report = await sync.reconcileLibrary(userId, { apply: options.apply });
        const after = options.apply ? await sync.reconcileLibrary(userId, { apply: false }) : report;
        if (report.expected || report.present) {
          libraries.push({ userId, expected: report.expected, present: report.present, missing: report.missing.length, stale: report.stale.length, extra: report.extra.length,
            pushed: report.pushed, removed: report.removed, failed: report.failed, agrees: after.missing.length + after.stale.length + after.extra.length === 0 });
        }
      } catch (error) { libraries.push({ userId, error: /** @type {any} */ (error)?.code ?? "reconcile_failed", agrees: false }); }
    }
    const disagreeing = [...results, ...libraries].filter((row) => !row.agrees);
    const sum = (/** @type {string} */ key) => [...results, ...libraries].reduce((total, row) => total + (Number(row[key]) || 0), 0);
    process.stdout.write(`${JSON.stringify({
      ok: disagreeing.length === 0, applied: options.apply, engine: health.version ?? null, accounts: userIds.length, projects: results.length, libraries: libraries.length,
      expected: sum("expected"), present: sum("present"), missing: sum("missing"), stale: sum("stale"), extra: sum("extra"), pushed: sum("pushed"), removed: sum("removed"),
      disagreeing: disagreeing.length, results: options.json ? results : disagreeing.filter((row) => "projectId" in row), libraryResults: options.json ? libraries : disagreeing.filter((row) => !("projectId" in row)),
    }, null, 2)}\n`);
    if (disagreeing.length) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
