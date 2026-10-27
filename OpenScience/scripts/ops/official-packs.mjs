#!/usr/bin/env node
/**
 * What the platform's official starter packs are doing, and the one thing an operator may undo.
 *
 * The packs (`capsules/official/`) are published at start and every ordinary account holds them (`apps/server/src/officialPacks.mjs`). What the
 * researchers did after the runs that opened an official method is folded into one record per method body, across accounts, and the same
 * sequential test a learned method's own runs go through stops a body that is corrected again and again — for everyone, at once, with the numbers
 * on the record. That stop is automatic and is given back here, in one command:
 *
 *   node scripts/ops/official-packs.mjs                                  # the published packs, and every method body that has outcomes or was stopped
 *   node scripts/ops/official-packs.mjs --restore <official:pack:method> <body hash>    # give a stopped body back, counted from nothing
 *   node scripts/ops/official-packs.mjs --withdraw <official:shared-practices:method>  # take a promoted method out of 「大家的做法」 for good
 *
 * A withdrawal refuses the method's record and drops its text (`withdrawPromoted`); the running server's promotion tick publishes the pack again within its
 * interval, which takes the method — or the pack, when it was the last — off every shelf. It is for what should never have been promoted (a test
 * conversation's method, 2026-10-27), not for a method that turned out to be bad: those the cross-account counters stop, restorably.
 *
 * The report names ids, hashes and counts and never a text. Uses the configuration the server runs with.
 *
 * @module scripts/ops/official-packs
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

/** @param {string[]} argv @returns {{ restore: { key: string, sha: string } | null, withdraw: string | null }} */
export function parseArguments(argv) {
  const options = { restore: /** @type {{ key: string, sha: string } | null} */ (null), withdraw: /** @type {string | null} */ (null) };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--withdraw") {
      const key = argv[index + 1];
      if (!key || !/^official:shared-practices:[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error("--withdraw needs a method id of 「大家的做法」 (official:shared-practices:<method>)");
      options.withdraw = key;
      index += 1;
      continue;
    }
    if (argv[index] !== "--restore") throw new Error(`unknown argument ${argv[index]}`);
    const key = argv[index + 1];
    const sha = argv[index + 2];
    if (!key || !sha || key.startsWith("--") || sha.startsWith("--")) throw new Error("--restore needs a method id (official:<pack>:<method>) and its body hash");
    if (!/^official:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error(`${key} is not an official method id`);
    if (!/^[a-f0-9]{12,64}$/.test(sha)) throw new Error("the body hash is twelve or more hexadecimal characters");
    options.restore = { key, sha };
    index += 2;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments }, { OfficialPacks }, { withdrawPromoted }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/officialPacks.mjs"),
    import("../../apps/server/src/officialPromotion.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    // Reading and giving back need neither the scanner nor the sealed archives: only the publisher's records.
    const packs = new OfficialPacks({ documents: new ProductDocuments(database), database, transfers: /** @type {any} */ (null), scanner: /** @type {any} */ (null) });
    if (options.withdraw) {
      const result = await withdrawPromoted(packs.documents, packs.publisherId, options.withdraw);
      process.stdout.write(`${JSON.stringify({ ...result, key: options.withdraw })}\n`);
      if (!result.withdrawn) process.exitCode = 1;
      return;
    }
    if (options.restore) {
      const restored = await packs.restore(options.restore.key, options.restore.sha);
      process.stdout.write(`${JSON.stringify({ restored, key: options.restore.key })}\n`);
      if (!restored) process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(await packs.snapshot(), null, 2)}\n`);
  } finally {
    await database?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`official-packs: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
