#!/usr/bin/env node
/**
 * Read again the documents whose stored reading is not the kind the platform would write for them today.
 *
 * Until 2026-10-13 every PDF was read into a paper's slots, the clinical ones among them, so a product test, a policy or a contract
 * read before then still carries 研究设计 / 研究人群 / 干预或暴露 on its record. The reader no longer draws a slot its document's type does
 * not have; this command makes the reading itself again, through the source service's `retry` — the path of 「重新读取」 — so it is
 * queued, run by the server's source worker under the account's caps and charged as any reading is. A source is outdated when its
 * current understanding carries slot keys its type does not have or was made under another schema than its type is read with
 * (`apps/server/src/sourceUnderstandingCurrency.mjs`). Nothing else is touched, and nothing is printed but counts and source ids.
 *
 *   node scripts/ops/reunderstand-sources.mjs --user <userId> [--user <userId>]     report only (the default)
 *   node scripts/ops/reunderstand-sources.mjs --all                                  report for every account
 *   … --apply [--limit 25]                                                           queue the new readings, at most --limit of them per run
 *   … --json                                                                         every outdated source, not only the counts
 *
 * Idempotent: a source being read again is not outdated until its new reading lands, and the new reading follows the domain, so a
 * second run finds nothing to do for it. Run it again while `left` is above zero. In the production container:
 *   docker exec -w /app web-open-science-web-1 node scripts/ops/reunderstand-sources.mjs --all [--apply]
 */
import process from "node:process";

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {string[]} */
  const users = [];
  let all = false;
  let apply = false;
  let json = false;
  let limit = 25;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") all = true;
    else if (argument === "--apply") apply = true;
    else if (argument === "--json") json = true;
    else if (argument === "--user" || argument === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--user") users.push(value);
      else {
        limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit is a whole number from 1 to 1000");
      }
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!all && users.length === 0) throw new Error("give --user <id> at least once, or --all");
  return { users, all, apply, json, limit };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments, ProductJobs }, { SourceService }, { outdatedUnderstandings, requeueOutdated }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/sourceService.mjs"),
    import("../../apps/server/src/sourceUnderstandingCurrency.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: "no control-plane database" }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const documents = new ProductDocuments(database);
    const sources = new SourceService(documents, new ProductJobs(database));
    const found = await outdatedUnderstandings({ database, documents, userIds: options.all ? null : options.users });
    const queued = options.apply ? await requeueOutdated({ sources }, found.outdated, { limit: options.limit }) : null;
    const accounts = new Set(found.outdated.map((item) => item.userId));
    process.stdout.write(`${JSON.stringify({
      ok: true, applied: options.apply, scanned: found.scanned, outdated: found.outdated.length, accounts: accounts.size,
      byReason: { slots: found.outdated.filter((item) => item.extra.length > 0).length, schema: found.outdated.filter((item) => item.schema).length },
      ...(queued ? { queued: queued.queued.length, left: queued.left, failed: queued.failed } : {}),
      ...(options.json ? { sources: found.outdated.map((item) => ({ userId: item.userId, projectId: item.projectId, sourceId: item.sourceId, docType: item.docType, extra: item.extra, schema: item.schema,
        queued: queued ? queued.queued.includes(item.sourceId) : false })) } : {}),
    }, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
