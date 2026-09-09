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

const { OpenVikingClient, memoryUri } = await import(path.join(serverSrc, "openVikingClient.mjs"));
const { MemorySubstrate } = await import(path.join(serverSrc, "memorySubstrate.mjs"));
const { DURABLE_RECALL_KINDS, recallContent, searchTokens } = await import(path.join(serverSrc, "memoryRecallPolicy.mjs"));

function parseArguments(argv) {
  const options = { arm: "builtin", url: "", limit: 5, seedIndex: false, user: "eval-recall-user", out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--arm") { options.arm = value; index += 1; }
    else if (flag === "--url") { options.url = value; index += 1; }
    else if (flag === "--limit") { options.limit = Number(value); index += 1; }
    else if (flag === "--user") { options.user = value; index += 1; }
    else if (flag === "--out") { options.out = value; index += 1; }
    else if (flag === "--seed-index") options.seedIndex = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!["builtin", "openviking"].includes(options.arm)) throw new Error(`unknown arm ${options.arm}`);
  if (options.arm === "openviking" && !options.url) throw new Error("--url is required for the openviking arm");
  return options;
}

async function readKey() {
  const file = process.env.OPEN_SCIENCE_OPENVIKING_API_KEY_FILE ?? "";
  if (file) return (await readFile(file, "utf8")).trim();
  return process.env.OPEN_SCIENCE_OPENVIKING_API_KEY ?? "";
}

const options = parseArguments(process.argv.slice(2));
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
const memos = {
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
  memosContextLimit: options.limit,
  memosContextMaxChars: 20_000,
};
const client = options.arm === "openviking" ? new OpenVikingClient(config) : null;
const substrate = new MemorySubstrate(config, { memos, openViking: client });

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

const rows = [];
for (const { query, expected } of gold.queries) {
  const started = Date.now();
  const recalled = await substrate.recall(options.user, query, {});
  const ms = Date.now() - started;
  const returned = recalled.map((row) => String(row.id).replace("record:", ""));
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
  arm: substrate.provider,
  active: substrate.active,
  lastError: substrate.lastError,
  corpus: records.length,
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
