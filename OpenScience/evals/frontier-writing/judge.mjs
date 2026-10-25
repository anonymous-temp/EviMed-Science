#!/usr/bin/env node
/**
 * The swapped-order pairwise judge of two frontier-writing runs (c2-style, 2026-10-25; research note §4.7): the same item written by
 * run A (e.g. the prompts before) and run B (the prompts under test), shown to deepseek-flash twice with the order swapped; a verdict
 * counts only when both orders agree, otherwise it is a tie (position bias, Zheng et al. 2023). The rubric is the research note's
 * §3.7 as questions. Offline only and never a gate: a judge win never outranks a fidelity loss (`run_eval.mjs`' code metrics come
 * first, Wu & Aji 2023), and flash judges flash against flash only (self-preference, Panickssery et al. 2024).
 *
 *   node evals/frontier-writing/judge.mjs --a <run A.json> --b <run B.json> [--key-file <path>] [--limit N] [--max-cny 2] [--out <file>]
 *
 * Reports B's wins, A's wins and ties; B's win rate over decided pairs with a Wilson 95% interval, and with ties as half; and the
 * length difference (B − A) of the 导读 and of everything the reader sees. The key is read from the file and never printed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FrontierEditor } from "../../apps/server/src/frontierEditor.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });

export const JUDGE_INSTRUCTIONS = [
  "你是一位资深医学编辑，替国内的临床医生、药师和研究者把关「前沿动态」的写作。你会看到一条消息的原文（可能截断），和同一条消息的两版中文写作（版本1、版本2）：标题、导读、要点、推荐理由（有的部分可能没有）。",
  "请判断哪一版更好。依次看：",
  "1. 只写原文有的事实，数字准确，结论强度不超过研究设计（关联不写成因果，单臂不写成优于对照，预印本、期中分析写明）？这一条最重要，一版有事实错误或夸大就输。",
  "2. 导读第一句是否直接给出答案：谁、做了什么、主要结果或决定？读完第一句，医生是否知道变了什么、对谁？",
  "3. 原文给出绝对数（事件数、两组发生率）和安全性问题时，是否写到？",
  "4. 是否分清是谁说的（作者、企业、评论者、监管机构）？",
  "5. 是否好读：一句讲一件事，不堆数字，不罗列，不重复？标题是否写明主体和结果，没有悬念、问句、感叹和夸张？",
  "两版差不多时判 tie。不要因为更长或更短本身而偏向哪一版。只输出 JSON：{\"winner\":\"1\"|\"2\"|\"tie\",\"why\":\"一句话\"}。",
].join("\n");

/** What a reader sees of one run's item, as plain labelled text. @param {any} after */
export function packageText(after) {
  const brief = after?.brief ? [...(after.brief.points ?? []).map((point) => `${point.label}：${point.text ?? (point.items ?? []).join("；")}`),
    ...(after.brief.quote ? [`${after.brief.quote.label}：${after.brief.quote.text}${after.brief.quote.zh ? `（${after.brief.quote.zh}）` : ""}`] : [])].join("\n") : "";
  return [after?.title ? `标题：${after.title}` : "", after?.lead ? `导读：${after.lead}` : (after?.summary ? `导读：${after.summary}` : ""),
    brief ? `要点：\n${brief}` : "", after?.reason ? `推荐理由：${after.reason}` : ""].filter(Boolean).join("\n");
}

/** Wilson 95% interval of k of n. @param {number} k @param {number} n */
export function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96; const p = k / n; const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d; const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round((centre - half) * 1000) / 1000, Math.round((centre + half) * 1000) / 1000];
}

async function main() {
  const { values } = parseArgs({ options: {
    a: { type: "string" }, b: { type: "string" }, limit: { type: "string" }, out: { type: "string" },
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    "max-cny": { type: "string", default: "2" }, concurrency: { type: "string", default: "4" },
  } });
  if (!values.a || !values.b) throw new Error("--a and --b are the two run files.");
  const [runA, runB] = await Promise.all([values.a, values.b].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const { cases } = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
  const byId = new Map(cases.map((/** @type {any} */ entry) => [entry.id, entry]));
  const bRows = new Map(runB.results.filter((row) => row.after).map((row) => [row.id, row]));
  const pairs = runA.results.filter((row) => row.after && bRows.has(row.id) && byId.has(row.id)).slice(0, values.limit ? Number(values.limit) : undefined);
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  const maxCny = Number(values["max-cny"]) || 2;
  const usage = { calls: 0, cny: 0 };
  const callModel = async (/** @type {any} */ context, /** @type {any} */ call) => {
    if (usage.cny >= maxCny) throw Object.assign(new Error("The judge's spending limit is reached."), { code: "usage_budget_exceeded" });
    const body = await callModelForControlPlane(context, call);
    const used = body?.usage ?? {};
    const hit = Number(used.prompt_cache_hit_tokens ?? 0);
    const miss = Number(used.prompt_cache_miss_tokens ?? Math.max(0, Number(used.prompt_tokens ?? 0) - hit));
    usage.calls += 1; usage.cny += (hit * PRICE.cacheHit + miss * PRICE.cacheMiss + Number(used.completion_tokens ?? 0) * PRICE.output) / 1e6;
    return body;
  };
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com", frontierModel: "deepseek-flash" },
    { owner: { userId: "eval", projectId: "eval" }, callModel });
  /** @type {any[]} */
  const verdicts = [];
  const queue = [...pairs];
  const ask = async (/** @type {string} */ source, /** @type {string} */ one, /** @type {string} */ two) => {
    const answer = await editor.callJson([{ role: "system", content: JUDGE_INSTRUCTIONS }, { role: "user", content: `原文：\n${source}\n\n版本1：\n${one}\n\n版本2：\n${two}` }],
      { maxTokens: 200, timeoutMs: 60_000 });
    return ["1", "2", "tie"].includes(String(answer?.winner)) ? String(answer.winner) : "tie";
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(6, Number(values.concurrency) || 4)) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const entry = byId.get(row.id);
      const source = `标题：${entry.item.titleRaw}\n${String(entry.text).slice(0, 2_000)}`;
      const a = packageText(row.after); const b = packageText(bRows.get(row.id).after);
      try {
        const first = await ask(source, a, b);   // A is 1
        const second = await ask(source, b, a);  // B is 1
        const forB = first === "2" && second === "1"; const forA = first === "1" && second === "2";
        verdicts.push({ id: row.id, genre: entry.expectGenre, first, second, winner: forB ? "b" : forA ? "a" : "tie",
          leadDelta: [...String(bRows.get(row.id).after.lead ?? "")].length - [...String(row.after.lead ?? "")].length, packageDelta: [...b].length - [...a].length });
      } catch (error) { verdicts.push({ id: row.id, error: /** @type {any} */ (error)?.code ?? String(error) }); }
    }
  }));
  const decided = verdicts.filter((v) => v.winner);
  const b = decided.filter((v) => v.winner === "b").length; const a = decided.filter((v) => v.winner === "a").length; const ties = decided.length - a - b;
  const n = decided.length;
  const halfRate = n ? (b + ties / 2) / n : 0; const halfSe = n ? Math.sqrt((halfRate * (1 - halfRate)) / n) : 0;
  const mean = (/** @type {number[]} */ list) => (list.length ? Math.round(list.reduce((s, x) => s + x, 0) / list.length) : 0);
  /** @type {Record<string, { b: number, a: number, tie: number }>} */
  const byGenre = {};
  for (const v of decided) { const g = (byGenre[v.genre] ??= { b: 0, a: 0, tie: 0 }); g[/** @type {"a" | "b" | "tie"} */ (v.winner)] += 1; }
  const summary = { pairs: n, bWins: b, aWins: a, ties, bWinRateDecided: a + b ? Math.round((b / (a + b)) * 1000) / 1000 : null, bWinRateDecidedCi95: wilson(b, a + b),
    bWinRateTiesHalf: Math.round(halfRate * 1000) / 1000, bWinRateTiesHalfCi95: [Math.round((halfRate - 1.96 * halfSe) * 1000) / 1000, Math.round((halfRate + 1.96 * halfSe) * 1000) / 1000],
    leadCharsDeltaMean: mean(decided.map((v) => v.leadDelta)), packageCharsDeltaMean: mean(decided.map((v) => v.packageDelta)), errors: verdicts.length - n, byGenre,
    usage: { calls: usage.calls, cny: Math.round(usage.cny * 1000) / 1000 } };
  const out = values.out ?? join(here, "results", `judge-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.json`);
  await writeFile(out, `${JSON.stringify({ at: new Date().toISOString(), a: values.a, b: values.b, summary, verdicts }, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ out, summary }, null, 1)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
