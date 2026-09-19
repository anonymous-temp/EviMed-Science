#!/usr/bin/env node
/**
 * What each purpose cost, read straight from the usage ledger.
 *
 *   node scripts/ops/usage-by-purpose.mjs [--days 7] [--json]
 *   pnpm usage:by-purpose -- --days 30
 *
 * On the deployment host it runs inside the web container, which carries the
 * packages it imports and already names the database secret:
 *
 *   docker compose exec open-science-web node scripts/ops/usage-by-purpose.mjs --days 7
 *
 * The same rows `GET /api/ops/usage/by-purpose` answers, for the operator on
 * the host: requests made per purpose over the window, and the settled cache
 * hit, cache miss and output tokens and money. Rows written before the ledger
 * had a purpose column read `other`.
 *
 * The database comes from `DATABASE_URL`, or the sources
 * `check-relational-integrity.mjs` reads (`OPEN_SCIENCE_DATABASE_URL`, then the
 * owner-only file named by `OPEN_SCIENCE_DATABASE_URL_FILE` or
 * `OPEN_SCIENCE_DATABASE_URL_HOST_FILE`, then `deploy/web/secrets/database-url.txt`).
 * The URL is never printed.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { USAGE_PURPOSE_LABELS_ZH } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function databaseUrl() {
  const named = process.env.DATABASE_URL || process.env.OPEN_SCIENCE_DATABASE_URL;
  if (named) return named;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let days = 7;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--days" || argument.startsWith("--days=")) {
      const value = argument === "--days" ? argv[++index] : argument.slice("--days=".length);
      days = Number(value);
      if (!Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error("--days must be a whole number from 1 to 366.");
    } else if (argument !== "--") {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}. Usage: usage-by-purpose.mjs [--days N] [--json]`);
    }
  }
  return { days, json };
}

/**
 * The report as a fixed-width table: one row per purpose, then the total.
 * @param {Array<{ purpose: string, requests: number, cacheHitTokens: number, cacheMissTokens: number, outputTokens: number, costCny: number }>} rows
 * @param {{ days: number, since: string }} window
 */
export function formatUsageReport(rows, { days, since }) {
  const total = rows.reduce((sum, row) => ({
    requests: sum.requests + row.requests,
    cacheHitTokens: sum.cacheHitTokens + row.cacheHitTokens,
    cacheMissTokens: sum.cacheMissTokens + row.cacheMissTokens,
    outputTokens: sum.outputTokens + row.outputTokens,
    costCny: sum.costCny + row.costCny,
  }), { requests: 0, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, costCny: 0 });
  const share = (cost) => (total.costCny > 0 ? `${((cost / total.costCny) * 100).toFixed(1)}%` : "-");
  const header = ["purpose", "用途", "requests", "cache-hit tok", "cache-miss tok", "output tok", "cost CNY", "share"];
  const lines = [
    ...rows.map((row) => [row.purpose, /** @type {Record<string, string>} */ (USAGE_PURPOSE_LABELS_ZH)[row.purpose] ?? row.purpose,
      String(row.requests), String(row.cacheHitTokens), String(row.cacheMissTokens), String(row.outputTokens),
      row.costCny.toFixed(4), share(row.costCny)]),
    ["total", "合计", String(total.requests), String(total.cacheHitTokens), String(total.cacheMissTokens),
      String(total.outputTokens), total.costCny.toFixed(4), total.costCny > 0 ? "100.0%" : "-"],
  ];
  // Width by code point: the labels are Chinese, and padding by UTF-16 length
  // is what every terminal renders anyway for these characters.
  const widths = header.map((title, column) => Math.max(title.length, ...lines.map((line) => line[column].length)));
  const render = (cells) => cells.map((cell, column) => (column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ");
  return [
    `Model usage by purpose, last ${days} day${days === 1 ? "" : "s"} (since ${since})`,
    render(header),
    ...lines.slice(0, -1).map(render),
    render(lines.at(-1)),
  ].join("\n");
}

async function main() {
  const { days, json } = parseArguments(process.argv.slice(2));
  const [{ ControlPlaneDatabase }, { UsageLedger }] = await Promise.all([
    import("../../apps/server/src/controlPlaneDatabase.mjs"),
    import("../../apps/server/src/usageLedger.mjs"),
  ]);
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await new UsageLedger(database).usageByPurpose({ since });
    process.stdout.write(json
      ? `${JSON.stringify({ days, since: since.toISOString(), currency: "CNY", rows })}\n`
      : `${formatUsageReport(rows, { days, since: since.toISOString() })}\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`usage_by_purpose_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
