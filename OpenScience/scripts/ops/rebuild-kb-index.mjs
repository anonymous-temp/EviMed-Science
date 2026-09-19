#!/usr/bin/env node
/**
 * Rebuild the knowledge-base search index from the sources' frozen captures.
 *
 * The index holds nothing of its own — every chunk is cut from a capture that
 * lives in `evimed_product` — so this always converges and is always safe to
 * run again. It is the command for a change of embedding model or width, a lost
 * or restored index schema, and a parser revision whose documents should be
 * cut afresh. It re-indexes what was parsed; it does not parse again: a source
 * re-parsed under a new parser revision is the source card's 「重新分析」.
 *
 *   node scripts/ops/rebuild-kb-index.mjs --user <userId> [--user <userId>]
 *   node scripts/ops/rebuild-kb-index.mjs --all
 *
 * It needs the configuration the server runs with (database, DashScope key).
 * Without an embedding key the index is rebuilt keyword-only and says so.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function parseArguments(argv) {
  const users = [];
  let all = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") all = true;
    else if (argument === "--user") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--user needs a user id");
      users.push(value);
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!all && users.length === 0) throw new Error("give --user <id> at least once, or --all");
  return { users, all };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments }, { SourceService }, { KnowledgeBaseIndex }, { KbEmbedder }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/sourceService.mjs"),
    import("../../apps/server/src/kbIndex.mjs"),
    import("../../apps/server/src/kbEmbedding.mjs"),
  ]);
  const config = loadConfig();
  if (!config.kbSearchEnabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "OPEN_SCIENCE_KB_SEARCH_ENABLED is false; nothing is indexed" })}\n`);
    process.exitCode = 1;
    return;
  }
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: "no control-plane database" })}\n`);
      process.exitCode = 1;
      return;
    }
    // Captures are only read here; nothing is queued, so the job queue is a stub.
    const sources = new SourceService(new ProductDocuments(database), { enqueue: async () => null });
    const embedder = new KbEmbedder({ apiKey: config.dashscopeApiKey, model: config.kbEmbeddingModel,
      dimension: config.kbEmbeddingDimension, apiBase: config.kbEmbeddingApiBase, timeoutMs: config.kbEmbeddingTimeoutMs });
    const index = new KnowledgeBaseIndex({ database, sources, embedder, dimension: config.kbEmbeddingDimension });
    const capabilities = await index.ready();
    const started = Date.now();
    const totals = await index.rebuild({ userIds: options.all ? null : options.users });
    const summary = {
      ok: totals.failed === 0,
      scope: options.all ? "all" : options.users,
      ...totals,
      vectors: capabilities.vector ? (embedder.configured ? "embedded" : "skipped: no DashScope key") : "skipped: pgvector is not installed",
      trigram: capabilities.trigram,
      ms: Date.now() - started,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await store.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { parseArguments };
