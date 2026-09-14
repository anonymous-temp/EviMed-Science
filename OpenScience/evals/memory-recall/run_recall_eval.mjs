#!/usr/bin/env node
/**
 * Which ranker puts the right memory in front of the model?
 *
 * This is the gate for adopting a recall index. It is not the end-to-end
 * question — `evals/method-quality/configs/memory-ablation-v1.json` asks
 * whether memory changes a delivered package — but it is the cheap one, and a
 * provider that cannot win here cannot win there either.
 *
 * Both arms answer the same twelve queries over the same three hundred
 * records. The `builtin` arm is the shipped term matcher and needs nothing
 * deployed. The `openviking` arm needs a reachable server; it is seeded from
 * this same corpus first, so neither arm sees anything the other does not.
 *
 *   node evals/memory-recall/run_recall_eval.mjs --arm builtin
 *   node evals/memory-recall/run_recall_eval.mjs --arm openviking --url http://127.0.0.1:1933 --seed-index
 *
 * `--label` names a run in its own results, because the arm no longer says
 * what was measured: two `openviking` runs against servers configured with
 * different embedders are different arms, and a comparison whose rows are both
 * called `openviking` is one nobody can read a month later.
 *
 *   node evals/memory-recall/run_recall_eval.mjs --arm openviking --url ... --label qwen
 *
 * `--mode capsule` asks the same question of the other recall path: capsule
 * facts, whose fallback is not the term matcher but the lexical PostgreSQL
 * search `ProductDocuments.search` runs — a whole-query substring match, so it
 * answers nothing at all to a reworded question. The arms are the two call
 * paths, not two servers, and the index arm goes through the real capsule URI
 * layout so that what is measured is what production would recall.
 *
 *   node evals/memory-recall/run_recall_eval.mjs --mode capsule --arm openviking \
 *     --url http://127.0.0.1:1933 --seed-index --label qwen-capsule
 *
 * The key, if the server needs one, comes from OPEN_SCIENCE_OPENVIKING_API_KEY
 * or its _FILE form. It is never written to the results.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const serverSrc = path.join(repoRoot, "apps/server/src");

const { OpenVikingClient, capsuleMemoryRoot, capsuleFactUri, memoryUri, parseCapsuleFactUri } =
  await import(path.join(serverSrc, "openVikingClient.mjs"));
const { MemorySubstrate } = await import(path.join(serverSrc, "memorySubstrate.mjs"));
const { MemoryRerank } = await import(path.join(serverSrc, "memoryRerank.mjs"));
const { DURABLE_RECALL_KINDS, recallContent, searchTokens } = await import(path.join(serverSrc, "memoryRecallPolicy.mjs"));

/** The control-plane reranker, or nothing.
 *
 *  Built from the same key file the index's own embedder is configured from,
 *  and from the pinned model and endpoint, so the arm measures what production
 *  would run rather than a reranker chosen for the measurement. */
async function buildRerank(options) {
  if (!options.rerank) return null;
  const pin = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
  const rerank = new MemoryRerank({
    apiKey: (await readFile(process.env.OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE
      ?? process.env.OPEN_SCIENCE_OPENVIKING_API_KEY_FILE ?? "", "utf8")).trim(),
    model: pin.openviking.rerank.model,
    apiBase: pin.openviking.rerank.apiBase,
    timeoutMs: 20_000,
  });
  if (!rerank.configured) throw new Error(`the reranker is not configured: ${rerank.status().code ?? "no key, model or endpoint"}`);
  return rerank;
}

function parseArguments(argv) {
  const options = { mode: "record", arm: "builtin", label: "", url: "", limit: 5, seedIndex: false, user: "eval-recall-user", out: "", rerank: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--mode") { options.mode = value; index += 1; }
    else if (flag === "--arm") { options.arm = value; index += 1; }
    else if (flag === "--label") { options.label = value; index += 1; }
    else if (flag === "--url") { options.url = value; index += 1; }
    else if (flag === "--limit") { options.limit = Number(value); index += 1; }
    else if (flag === "--user") { options.user = value; index += 1; }
    else if (flag === "--out") { options.out = value; index += 1; }
    else if (flag === "--seed-index") options.seedIndex = true;
    // The third arm. Reranking happens in the control plane, not in the index,
    // so it is a flag on the same vector candidates rather than a different
    // server: what it measures is what the extra DashScope call adds to the
    // order the embedder already produced, and what it costs.
    else if (flag === "--rerank") options.rerank = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!["record", "capsule"].includes(options.mode)) throw new Error(`unknown mode ${options.mode}`);
  if (!["builtin", "openviking"].includes(options.arm)) throw new Error(`unknown arm ${options.arm}`);
  if (options.arm === "openviking" && !options.url) throw new Error("--url is required for the openviking arm");
  if (options.rerank && options.arm !== "openviking") throw new Error("--rerank reorders index candidates, so it needs --arm openviking");
  // Free-form on purpose: what distinguishes two runs of one arm is whatever
  // the operator changed, and a closed list here would have to be edited before
  // every measurement it was meant to record.
  if (!options.label) options.label = options.arm;
  return options;
}

async function readKey() {
  const file = process.env.OPEN_SCIENCE_OPENVIKING_API_KEY_FILE ?? "";
  if (file) return (await readFile(file, "utf8")).trim();
  return process.env.OPEN_SCIENCE_OPENVIKING_API_KEY ?? "";
}

const options = parseArguments(process.argv.slice(2));

/**
 * Capsule recall, over the two call paths a deployment actually has.
 *
 * The lexical arm is `ProductDocuments.search` as `CapsuleService` calls it: one
 * `strpos` of the whole question against the fact's content, newest first. It is
 * reproduced here rather than run against PostgreSQL because what is being
 * compared is a ranking, and a ranking needs no rows of its own — the same
 * reason the record mode scores its term matcher in process.
 *
 * The index arm writes each fact at the URI the capsule index uses in
 * production and reads the hits back through the same parser, so a layout
 * change breaks this measurement instead of quietly making it meaningless.
 */
async function runCapsuleMode() {
  const corpus = JSON.parse(await readFile(path.join(here, "capsule-corpus.json"), "utf8"));
  const gold = JSON.parse(await readFile(path.join(here, "capsule-queries.json"), "utf8"));
  const facts = corpus.facts.map((fact, position) => ({ ...fact, revision: 1, position }));
  const byFactId = new Map(facts.map((fact) => [fact.id, fact]));
  // One account generation for the whole run. It binds the subtree exactly as a
  // real account's creation time does, so a replacement account could not read
  // this one's copies.
  const accountCreatedAt = "2026-09-01T00:00:00.000Z";

  const lexical = (query, limit) => facts
    .filter((fact) => fact.status === "approved" && fact.content.toLowerCase().includes(query.toLowerCase()))
    // `ORDER BY updated_at DESC, id DESC`: with one write per fact the corpus
    // order is that order, reversed.
    .sort((left, right) => right.position - left.position)
    .slice(0, limit)
    .map((fact) => fact.id);

  const client = options.arm === "openviking"
    ? new OpenVikingClient({
      openVikingUrl: options.url,
      openVikingApiKey: await readKey(),
      openVikingAccount: process.env.OPEN_SCIENCE_OPENVIKING_ACCOUNT ?? "evimed",
      openVikingRequestTimeoutMs: 120_000,
    })
    : null;

  if (options.seedIndex) {
    if (!client?.configured) throw new Error("nothing to seed: the index client is not configured");
    const health = await client.status();
    if (!health.connected) throw new Error(`the index is not reachable: ${health.code}`);
    let written = 0;
    for (const fact of facts) {
      if (fact.status !== "approved") continue;
      await client.write(options.user, capsuleFactUri(options.user, {
        accountCreatedAt, capsuleId: fact.capsuleId, factKind: fact.factKind, factId: fact.id, revision: fact.revision,
      }), `${fact.factKind} / ${fact.layer}\n\n${fact.content}`, { wait: true, timeoutSeconds: 120 });
      written += 1;
      if (written % 25 === 0) process.stderr.write(`seeded ${written}/${facts.length}\n`);
    }
    process.stderr.write(`seeded ${written}/${facts.length}\n`);
  }

  const reranker = await buildRerank(options);
  const targets = corpus.capsules.map((capsule) =>
    capsuleMemoryRoot(options.user, { accountCreatedAt, capsuleId: capsule.id }));
  const recall = async (query) => {
    if (options.arm === "builtin") return lexical(query, options.limit);
    const hits = await client.find(options.user, query, { targets, limit: Math.min(100, options.limit * 4) });
    const ordered = [];
    if (reranker) {
      // The capsule index reranks the same way the control plane does: over the
      // hydrated text, after the vector order and before anything is cut.
      const documents = hits.map((hit) => String(hit.content ?? ""));
      const order = await reranker.order(query, documents);
      if (Array.isArray(order) && order.length === hits.length) {
        const reordered = order.map((position) => hits[position]).filter(Boolean);
        if (reordered.length === hits.length) hits.splice(0, hits.length, ...reordered);
      }
    }
    for (const hit of hits) {
      const parsed = parseCapsuleFactUri(hit.uri);
      // Hydrated from the corpus, the way production hydrates from PostgreSQL:
      // a hit that names nothing we hold is dropped rather than guessed at.
      const fact = parsed && byFactId.get(parsed.factId);
      if (!fact || fact.revision !== parsed.revision || ordered.includes(fact.id)) continue;
      ordered.push(fact.id);
      if (ordered.length === options.limit) break;
    }
    return ordered;
  };
  return { corpusSize: facts.length, queries: gold.queries, recall, provider: options.arm, active: options.arm === "openviking" };
}

/** Research-memory recall: the shipped term matcher against the index, over
 *  the same three hundred records and the same twelve questions. */
async function runRecordMode() {
  const corpus = JSON.parse(await readFile(path.join(here, "corpus.json"), "utf8"));
  const gold = JSON.parse(await readFile(path.join(here, "queries.json"), "utf8"));

  const records = corpus.records.map((row) => ({
    ...row,
    scope: "user",
    scopeId: "",
    key: row.id,
    summary: "",
    origin: "inferred",
    status: "active",
    confidence: 0.8,
    importance: 0.6,
    sensitive: false,
    expiresAt: "",
    updatedAt: "2026-09-01T00:00:00Z",
  }));
  const byId = new Map(records.map((row) => [row.id, row]));

  /** The shipped term matcher, scored exactly as the research-memory client does. */
  function builtinRecall(query, limit) {
    const terms = searchTokens(query);
    return records
      .map((record) => {
        const content = recallContent(record);
        const haystack = `${record.key} ${content}`.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        const durable = DURABLE_RECALL_KINDS.has(record.kind);
        return {
          id: record.id,
          recallable: durable || matches > 0,
          score: matches + (durable ? 0.75 : 0) + record.importance + record.confidence * 0.5,
        };
      })
      .filter((row) => row.recallable)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((row) => row.id);
  }

  /** A store that answers only what the substrate is allowed to ask of it. */
  const store = {
    async getRecord(_userId, id) {
      const found = byId.get(id);
      if (!found) throw Object.assign(new Error("not found"), { code: "memory_not_found" });
      return found;
    },
    async listAllRecords() { return records; },
    async list() { return []; },
    async relevant(_userId, query) {
      return builtinRecall(query, options.limit).map((id) => ({ id: `record:${id}`, content: recallContent(byId.get(id)), kind: byId.get(id).kind }));
    },
  };

  const config = {
    memoryIndexProvider: options.arm,
    openVikingUrl: options.url,
    openVikingApiKey: await readKey(),
    openVikingAccount: process.env.OPEN_SCIENCE_OPENVIKING_ACCOUNT ?? "evimed",
    openVikingRequestTimeoutMs: 120_000,
    memoryContextLimit: options.limit,
    memoryContextMaxChars: 20_000,
  };
  const client = options.arm === "openviking" ? new OpenVikingClient(config) : null;
  const substrate = new MemorySubstrate(config, { store, openViking: client, rerank: await buildRerank(options) });

  if (options.seedIndex) {
    if (!substrate.active) throw new Error("nothing to seed: the index provider is not active");
    const health = await client.status();
    if (!health.connected) throw new Error(`the index is not reachable: ${health.code}`);
    let written = 0;
    for (const record of records) {
      await client.write(options.user, memoryUri(options.user, {
        scope: record.scope, scopeId: record.scopeId, kind: record.kind, recordId: record.id,
      }), recallContent(record), { wait: true, timeoutSeconds: 120 });
      written += 1;
      if (written % 25 === 0) process.stderr.write(`seeded ${written}/${records.length}\n`);
    }
    process.stderr.write(`seeded ${written}/${records.length}\n`);
  }

  const recall = async (query) =>
    (await substrate.recall(options.user, query, {})).map((row) => String(row.id).replace("record:", ""));
  return {
    corpusSize: records.length,
    queries: gold.queries,
    recall,
    provider: substrate.provider,
    active: substrate.active,
    lastError: () => substrate.lastError,
  };
}

const plan = options.mode === "capsule" ? await runCapsuleMode() : await runRecordMode();

const rows = [];
for (const { query, expected } of plan.queries) {
  const started = Date.now();
  const returned = await plan.recall(query);
  const ms = Date.now() - started;
  const found = expected.filter((id) => returned.includes(id));
  // Where the first correct memory landed. A ranker that returns the right
  // record fifth has not helped: the budget may cut it, and the model reads
  // the first ones as the most relevant.
  const firstRank = returned.findIndex((id) => expected.includes(id));
  rows.push({
    query,
    expected,
    returned,
    hit: found.length,
    of: expected.length,
    reciprocalRank: firstRank === -1 ? 0 : 1 / (firstRank + 1),
    ms,
  });
}

const expectedTotal = rows.reduce((total, row) => total + row.of, 0);
const hitTotal = rows.reduce((total, row) => total + row.hit, 0);
const summary = {
  label: options.label,
  mode: options.mode,
  arm: plan.provider,
  active: plan.active,
  lastError: plan.lastError ? plan.lastError() : null,
  corpus: plan.corpusSize,
  queries: rows.length,
  limit: options.limit,
  recallAtLimit: Number((hitTotal / expectedTotal).toFixed(4)),
  meanReciprocalRank: Number((rows.reduce((total, row) => total + row.reciprocalRank, 0) / rows.length).toFixed(4)),
  queriesWithNothingRelevant: rows.filter((row) => row.hit === 0).length,
  medianMs: rows.map((row) => row.ms).sort((left, right) => left - right)[Math.floor(rows.length / 2)],
  rows,
};

const text = `${JSON.stringify(summary, null, 2)}\n`;
if (options.out) {
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, text);
  process.stderr.write(`wrote ${options.out}\n`);
}
process.stdout.write(text);
