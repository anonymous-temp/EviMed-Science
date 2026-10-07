#!/usr/bin/env node
/**
 * Name the 虚拟临研 studies that still carry no name of their own, from what they already hold.
 *
 *   node scripts/vcr/rename-from-definition.mjs                   # report, for every study that is still unnamed
 *   node scripts/vcr/rename-from-definition.mjs --study <std_…>   # report, for one study
 *   node scripts/vcr/rename-from-definition.mjs --apply           # write the names, and their projects'
 *
 * The rule and the reasons are `apps/server/src/vcrNaming.mjs`'s. The report is the same with or without `--apply` and prints only
 * ids and names — the names are the researcher's own question, so a report is shown to the owner of the account and nobody else.
 * Reads the database the way the server does (`loadConfig`).
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** @param {string[]} argv */
export function parseRenameArguments(argv) {
  /** @type {{ apply: boolean, studyId: string | null }} */
  const options = { apply: false, studyId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--study") {
      const next = argv[index + 1];
      if (next == null || next.startsWith("--")) throw new Error("--study needs a study id");
      index += 1;
      options.studyId = next;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (options.studyId != null && !/^[A-Za-z0-9_-]{1,80}$/.test(options.studyId)) throw new Error("--study takes a study id");
  return options;
}

async function main() {
  const options = parseRenameArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { VcrStore }, { applyStudyNames, planStudyNames }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/vcrStore.mjs"),
    import("../../apps/server/src/vcrNaming.mjs"),
  ]);
  const config = loadConfig();
  const projects = createStore(config);
  const database = "database" in projects ? projects.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const store = new VcrStore({ database });
    const plan = await planStudyNames({ store, studyId: options.studyId });
    const report = {
      mode: options.apply ? "applied" : "report only (nothing was written; pass --apply to write)",
      unnamed: plan.length,
      studies: plan.map((entry) => ({ studyId: entry.studyId, from: entry.from, to: entry.to })),
    };
    if (options.apply) {
      const written = await applyStudyNames({
        store, plan,
        renameProject: (user, projectId, name) => projects.renameProject(user, projectId, name),
        currentProjectName: async (userId, projectId) => (await projects.listProjects({ id: userId })).find((/** @type {any} */ project) => project.id === projectId)?.name ?? null,
      });
      console.log(JSON.stringify({ ...report, ...written }, null, 2));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await projects.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`rename-from-definition: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
