/** Lane-local receipt accounting. Peak rates bound both peak and off-peak calls; cache reuse of a saved model answer costs nothing.
 * Prices come from the product's price list, verified against https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ on 2026-11-11.
 * The batch reserves a further CNY 50 for unfinished episodes, in-flight/unrecorded replies, and embeddings.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceUsage, REFERENCE_PRICE_LIST } from "../../../packages/domain/src/metering.mjs";

export function receiptTotals(learning, episodes) {
  let prompt = 0, cached = 0, output = 0, calls = 0;
  for (const row of [...learning, ...episodes]) {
    if (row.cached === true) continue;
    const counts = [row.promptTokens, row.cachedTokens ?? row.cachedPromptTokens ?? 0, row.completionTokens];
    if (counts.some(value => !Number.isSafeInteger(value) || value < 0) || counts[1] > counts[0]) throw new Error("Unreadable usage receipt");
    prompt += counts[0]; cached += counts[1]; output += counts[2];
    calls += row.steps ?? 1;
  }
  const price = priceUsage({ resourceType: "model", model: "deepseek-flash", cacheHit: cached, cacheMiss: prompt - cached, output, peak: true });
  if (!price.priced || price.currency !== "CNY") throw new Error("No CNY price for the experiment model");
  return { promptTokens: prompt, cachedTokens: cached, completionTokens: output, calls,
    peakCostUpperCny: price.cost, priceVersion: REFERENCE_PRICE_LIST.version };
}

async function lines(file) {
  const text = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  // A writer may be between its append and newline. The reserve covers that unfinished receipt.
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

export async function laneSpend(root) {
  const learning = [], episodes = [];
  for (const library of ["c1c-pilot-long", "c1c-pilot-soft-card", "c1c-priority-probe", "c1c-lib"]) {
    for (const env of ["alfworld", "scienceworld"]) learning.push(...await lines(path.join(root, library, `${env}-pyramid/calls.jsonl`)));
  }
  for (const arm of ["no-skill", "flat", "pyramid"]) episodes.push(...await lines(path.join(root, `c1c-${arm}/episodes.jsonl`)));
  return receiptTotals(learning, episodes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await laneSpend(process.argv[2] ?? "/srv/evimed/runs"))}\n`);
}
