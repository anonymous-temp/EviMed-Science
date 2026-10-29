#!/usr/bin/env node
/**
 * Move coverage of the 导读 of a frontier-writing run (c2-style, 2026-10-25): each sentence labelled with one move of the closed
 * vocabulary (`frontierStyle.mjs` `FRONTIER_LEAD_MOVES`, plus OTHER) by deepseek-flash, 8-shot (Yu, Bondi & Hyland 2024; 39 of 50
 * labels agreed with a hand reading when the corpus was labelled), then read against the genre's card in code: does the first
 * sentence carry the card's first move, how many of the card's moves appear, and how often two of them appear in the card's order.
 * A notice metric for the hand-off — never a check of a written text.
 *
 *   node evals/frontier-writing/moves_report.mjs --run <run.json> [--key-file <path>] [--max-cny 1] [--out <file>]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FrontierEditor } from "../../apps/server/src/frontierEditor.mjs";
import { FRONTIER_LEAD_MOVES, FRONTIER_STYLE_CARDS } from "../../apps/server/src/frontierStyle.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";
import { sentencesOf } from "./style_metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });
const MOVES = [...Object.keys(FRONTIER_LEAD_MOVES), "OTHER"];

export const MOVE_ANNOTATOR_INSTRUCTIONS = [
  "你在做医学新闻语篇的「语步」标注：给每个句子一个语步标签，说明这句话在文章里起什么作用。只看句子的功能，不评价写得好坏。",
  "标签（只能用这些英文键）：",
  "FINDING 核心发现或核心事实：谁做了什么、主要结果是什么（研究的主要发现、事件本身）",
  "POPULATION 人群或适用对象：研究纳入谁、文件或药物针对谁",
  "DESIGN 研究设计或方法：随机、队列、分期、怎么做的",
  "SIZE 样本量或随访时间",
  "EFFECT 效应量：HR、OR、相对风险、P 值、置信区间、百分比的组间比较",
  "ABSOLUTE 绝对数：事件数、两组各自的发生率、绝对风险差、需治疗人数",
  "HARM 安全性：不良事件、毒性、风险",
  "LIMIT 局限或不确定性：样本小、观察性、期中分析、作者写明的局限、警示",
  "DECISION 决定、措施或推荐：监管批准或警示、政策要求、指南推荐、医务人员应该怎么做",
  "DEAL 交易或经营：金额、首付款、融资、销售额、市场份额",
  "SOURCE 出处归属：发表在哪个期刊、会议，由哪个机构或作者发布",
  "CHINA 与国内的关系：国内上市情况、中国人群数据、国内医保或政策",
  "NEXT 下一步：后续研究、申报计划、时间节点、预计何时",
  "BACKGROUND 背景：疾病负担、既往认识、为什么要做这件事",
  "OPINION 他人的观点或评论：专家、作者或评论者的看法、引语",
  "OTHER 与内容无关：署名、关注引导、广告、版权、目录",
  "一句话兼有几种作用时，选最主要的那个：句子的主干在说什么就标什么（如「该研究纳入 1,200 例患者，中位随访 3 年」标 SIZE；「研究发现，A 组死亡风险降低 25%（HR 0.75）」主干是结果，标 FINDING；单独报效应量的句子标 EFFECT）。",
  "只输出 JSON：{\"labels\":[\"…\"]}，labels 的个数与句子数相同，按顺序。",
  "",
  "示例（句子 → 标签）：",
  "1. 一项发表于《柳叶刀》的 III 期试验显示，X 药使晚期胃癌患者的总生存期延长至 14.2 个月。 → FINDING",
  "2. 研究共纳入 18 个国家的 812 例患者，按 1:1 随机分组。 → SIZE",
  "3. 对照组的 3 级以上不良事件发生率为 21%，X 药组为 34%。 → HARM",
  "4. 两组 5 年累计卒中发生率分别为 2.1% 和 3.4%。 → ABSOLUTE",
  "5. 作者指出，研究为开放标签设计，结论外推到亚洲人群需谨慎。 → LIMIT",
  "6. 美国 FDA 于本周加速批准该药用于既往接受过两线治疗的成人患者。 → DECISION",
  "7. 心血管病是我国居民的首位死因，每年约有 400 万人因此死亡。 → BACKGROUND",
  "8. 「这一结果可能改变一线治疗格局。」论文通讯作者在接受采访时说。 → OPINION",
].join("\n");

/**
 * One 导读's labels read against its card: the first move, the card's moves present, and the share of ordered pairs.
 * @param {string[]} labels @param {readonly string[]} card
 */
export function coverage(labels, card) {
  const seq = labels.filter((label) => label && label !== "OTHER");
  const present = card.filter((move) => seq.includes(move));
  let pairs = 0, ordered = 0;
  for (let i = 0; i < present.length; i += 1) for (let j = i + 1; j < present.length; j += 1) {
    pairs += 1; if (seq.indexOf(present[i]) < seq.indexOf(present[j])) ordered += 1;
  }
  return { firstIsCards: seq[0] === card[0], present: present.length, of: card.length, ordered, pairs };
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: "string" }, out: { type: "string" }, "max-cny": { type: "string", default: "1" },
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") } } });
  if (!values.run) throw new Error("--run is the run file.");
  const run = JSON.parse(await readFile(values.run, "utf8"));
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  const maxCny = Number(values["max-cny"]) || 1;
  const usage = { calls: 0, cny: 0 };
  const callModel = async (/** @type {any} */ context, /** @type {any} */ call) => {
    if (usage.cny >= maxCny) throw Object.assign(new Error("The report's spending limit is reached."), { code: "usage_budget_exceeded" });
    const body = await callModelForControlPlane(context, call);
    const used = body?.usage ?? {};
    const hit = Number(used.prompt_cache_hit_tokens ?? 0);
    const miss = Number(used.prompt_cache_miss_tokens ?? Math.max(0, Number(used.prompt_tokens ?? 0) - hit));
    usage.calls += 1; usage.cny += (hit * PRICE.cacheHit + miss * PRICE.cacheMiss + Number(used.completion_tokens ?? 0) * PRICE.output) / 1e6;
    return body;
  };
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com", frontierModel: "deepseek-flash" },
    { owner: { userId: "eval", projectId: "eval" }, callModel });
  const rows = run.results.filter((row) => row.after?.lead && FRONTIER_STYLE_CARDS[row.after.genre]);
  /** @type {any[]} */
  const out = [];
  const queue = [...rows];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const sentences = sentencesOf(row.after.lead);
      try {
        const answer = await editor.callJson([{ role: "system", content: MOVE_ANNOTATOR_INSTRUCTIONS }, { role: "user", content: sentences.map((s, i) => `${i + 1}. ${s}`).join("\n") }],
          { maxTokens: 300, timeoutMs: 60_000 });
        const labels = (Array.isArray(answer?.labels) ? answer.labels : []).map((label) => (MOVES.includes(label) ? label : "OTHER"));
        out.push({ id: row.id, genre: row.after.genre, labels, ...coverage(labels, FRONTIER_STYLE_CARDS[row.after.genre].moves) });
      } catch (error) { out.push({ id: row.id, error: /** @type {any} */ (error)?.code ?? String(error) }); }
    }
  }));
  const ok = out.filter((row) => !row.error);
  const sum = (/** @type {string} */ key) => ok.reduce((s, row) => s + row[key], 0);
  const summary = { leads: ok.length, firstIsCards: ok.filter((row) => row.firstIsCards).length, cardMovesPresent: `${sum("present")}/${sum("of")}`,
    orderedPairs: `${sum("ordered")}/${sum("pairs")}`, usage: { calls: usage.calls, cny: Math.round(usage.cny * 1000) / 1000 } };
  const file = values.out ?? values.run.replace(/\.json$/, ".moves.json");
  await writeFile(file, `${JSON.stringify({ run: values.run, summary, rows: out }, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ out: file, summary }, null, 1)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
