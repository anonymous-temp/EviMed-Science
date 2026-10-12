#!/usr/bin/env node
/**
 * What the topic grouping makes of an account's memories, against sets with a known grouping (principle 6: a class of mistake is a
 * case, not a keyword — and here the mistakes are the ones a grouping makes: one theme said in many words left as many topics, two
 * themes that share a word made one, a topic named after a kind of note, a researcher's rename undone by a regrouping).
 *
 * Every case in `cases/` is a set of memories with the themes a reader would find in it (`truth`) and what the grouping must do
 * (`expect`). The decided checks are all decidable by code, over the topics the model returned after the platform's own re-verification
 * (`parseTopics`): how many topics (`topics`); within each true theme, the share of pairs that landed in a common topic (`pairRecall`
 * — merge: one theme in many words is one topic); pairs that must never share one (`neverTogether` — split: a shared word is not a
 * shared theme); that no label is only the name of a kind of note (`noKindWords`) or of a medical specialty on an account that has none
 * (`noSpecialtyWords` — the vocabulary is open); that a name the researcher gave and the id it is kept under survive a regrouping
 * (`keeps`); and that a topic they dismissed does not come back (`dismissedAbsent`). The language judgement — is this a good name
 * for these memories — is the model's and is not decided here.
 *
 *   node evals/memory-topics/run_topics_eval.mjs --offline
 *   OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=/path/to/key \
 *     node evals/memory-topics/run_topics_eval.mjs --runs 3 --out evals/memory-topics/results/$(date +%F).json
 *
 * `--offline` runs what needs no model: the corpus's shape, and each case's two fixtures — a grouping that is right must pass every
 * check the case names, and one that makes the mistakes the case is about must fail at least the checks `badFails` lists, which
 * is what proves a check is not vacuous. The live run asks the deployment's own model, with the platform's own prompt
 * (`topicsRequestBody`), `--runs` times for each case (a model is sampled more than once), and writes what was measured; the key is
 * never written to the results.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const serverSrc = path.join(repoRoot, "apps/server/src");

/** The classes the corpus must hold a case of. */
export const REQUIRED_CLASSES = Object.freeze(["merge", "split", "general", "stability", "bounds"]);
/** What a topic is never named: the name of a kind of note, or of the platform's own machinery. A closed list, compared by equality. */
export const KIND_WORDS = Object.freeze(["偏好", "决定", "决策", "纠正", "习惯", "背景", "项目事实", "待跟进", "记忆", "笔记", "平台", "工具", "杂项", "其他"]);
export const EXPECT_FIELDS = Object.freeze([
  "topics", "pairRecall", "neverTogether", "noKindWords", "noSpecialtyWords", "keeps", "dismissedAbsent", "groupable", "minMemories", "noModelCall",
]);

/** @returns {Promise<any[]>} */
export async function loadCases(directory = path.join(here, "cases")) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => ({ file: name, ...JSON.parse(await readFile(path.join(directory, name), "utf8")) })));
}

/** What is wrong with one case's shape, or []. @param {any} item */
export function caseIssues(item) {
  const issues = [];
  for (const field of ["id", "class", "description"]) if (typeof item[field] !== "string" || !item[field].trim()) issues.push(`${item.file}: ${field} is missing`);
  if (`${item.id}.json` !== item.file) issues.push(`${item.file}: the file is not named after its id`);
  if (!Array.isArray(item.memories) || item.memories.length === 0) issues.push(`${item.file}: no memories`);
  const ids = new Set((item.memories ?? []).map((memory) => memory.id));
  if (ids.size !== (item.memories ?? []).length) issues.push(`${item.file}: a memory id is repeated`);
  for (const memory of item.memories ?? []) {
    if (!memory.id || !memory.summary || !memory.kind || !["user", "project"].includes(memory.scope)) issues.push(`${item.file}: ${memory.id}: a memory needs id, kind, scope (user|project) and summary`);
  }
  for (const [theme, members] of Object.entries(item.truth ?? {})) {
    if (!Array.isArray(members) || members.length < 2) issues.push(`${item.file}: the theme ${theme} has fewer than two memories`);
    for (const id of members ?? []) if (!ids.has(id)) issues.push(`${item.file}: the theme ${theme} names ${id}, which is no memory`);
  }
  for (const field of Object.keys(item.expect ?? {})) if (!EXPECT_FIELDS.includes(field)) issues.push(`${item.file}: expect.${field} is not a check the runner decides`);
  for (const pair of item.expect?.neverTogether ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((id) => ids.has(id))) issues.push(`${item.file}: neverTogether holds a pair that is not two memories of the case`);
  }
  if (item.fixtures) {
    if (!item.fixtures.good || !item.fixtures.bad || !Array.isArray(item.fixtures.badFails) || item.fixtures.badFails.length === 0) issues.push(`${item.file}: the fixtures need good, bad and badFails`);
    for (const check of item.fixtures?.badFails ?? []) if (!EXPECT_FIELDS.includes(check)) issues.push(`${item.file}: badFails names ${check}, which is not a check`);
  } else if (item.class !== "bounds") issues.push(`${item.file}: a case that asks the model carries fixtures`);
  return issues;
}

/** @param {string} label */
const key = (label) => String(label ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/**
 * The verdicts code can reach about one grouping.
 * @param {any} item @param {{ id: string, label: string, members: string[] }[]} topics what the platform keeps of the model's reply
 * @param {{ specialties?: readonly string[] }} [tools]
 * @returns {{ check: string, passed: boolean, detail: string }[]}
 */
export function topicVerdicts(item, topics, { specialties = [] } = {}) {
  const expect = item.expect ?? {};
  const verdicts = [];
  const together = (a, b) => topics.some((topic) => topic.members.includes(a) && topic.members.includes(b));
  if (expect.topics) {
    verdicts.push({ check: "topics", passed: topics.length >= expect.topics.min && topics.length <= expect.topics.max, detail: `${topics.length} topics (${expect.topics.min}–${expect.topics.max})` });
  }
  if (typeof expect.pairRecall === "number") {
    const shortfalls = [];
    for (const [theme, members] of Object.entries(item.truth ?? {})) {
      let pairs = 0;
      let shared = 0;
      for (let left = 0; left < members.length; left += 1) for (let right = left + 1; right < members.length; right += 1) { pairs += 1; if (together(members[left], members[right])) shared += 1; }
      if (pairs > 0 && shared / pairs < expect.pairRecall) shortfalls.push(`${theme} ${shared}/${pairs}`);
    }
    verdicts.push({ check: "pairRecall", passed: shortfalls.length === 0, detail: shortfalls.length ? `under ${expect.pairRecall}: ${shortfalls.join(", ")}` : `every theme at ${expect.pairRecall} or more` });
  }
  if (Array.isArray(expect.neverTogether)) {
    const joined = expect.neverTogether.filter(([a, b]) => together(a, b)).map(([a, b]) => `${a}+${b}`);
    verdicts.push({ check: "neverTogether", passed: joined.length === 0, detail: joined.length ? `shared a topic: ${joined.join(", ")}` : "kept apart" });
  }
  if (expect.noKindWords) {
    const named = topics.filter((topic) => KIND_WORDS.some((word) => key(topic.label) === key(word))).map((topic) => topic.label);
    verdicts.push({ check: "noKindWords", passed: named.length === 0, detail: named.join("、") });
  }
  if (expect.noSpecialtyWords) {
    const named = topics.filter((topic) => specialties.some((name) => name.length >= 2 && key(topic.label).includes(key(name)))).map((topic) => topic.label);
    verdicts.push({ check: "noSpecialtyWords", passed: named.length === 0, detail: named.join("、") });
  }
  if (Array.isArray(expect.keeps)) {
    const lost = expect.keeps.filter((want) => !topics.some((topic) => topic.id === want.id && topic.label === want.label)).map((want) => `${want.id} ${want.label}`);
    verdicts.push({ check: "keeps", passed: lost.length === 0, detail: lost.length ? `not kept: ${lost.join(", ")}` : "kept" });
  }
  if (Array.isArray(expect.dismissedAbsent)) {
    const back = topics.filter((topic) => expect.dismissedAbsent.some((name) => key(topic.label).includes(key(name)) || key(name).includes(key(topic.label)))).map((topic) => topic.label);
    verdicts.push({ check: "dismissedAbsent", passed: back.length === 0, detail: back.join("、") });
  }
  return verdicts;
}

/** The records a case's memories are, as the grouping reads them. @param {any} item */
export function recordsOf(item) {
  return item.memories.map((memory, index) => ({
    id: memory.id, kind: memory.kind, scope: memory.scope, summary: memory.summary, value: memory.summary, status: "active", importance: 0.5,
    sensitive: false, version: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00Z`,
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : "";
  const runsIndex = argv.indexOf("--runs");
  const runs = runsIndex >= 0 ? Math.max(1, Math.min(10, Number(argv[runsIndex + 1]) || 1)) : 1;
  const cases = await loadCases();
  const shape = cases.flatMap(caseIssues);
  const missing = REQUIRED_CLASSES.filter((name) => !cases.some((item) => item.class === name));
  if (shape.length || missing.length) {
    process.stderr.write(`${[...shape, ...missing.map((name) => `no case of class ${name}`)].join("\n")}\n`);
    process.exitCode = 2;
    return;
  }
  const { parseTopics, groupable, topicsRequestBody } = await import(pathToFileURL(path.join(serverSrc, "memoryTopics.mjs")).href);
  const { FRONTIER_SPECIALTIES } = await import(pathToFileURL(path.join(repoRoot, "packages/domain/index.mjs")).href);
  const tools = { specialties: FRONTIER_SPECIALTIES };
  /** @type {any[]} */ const results = [];
  /** @type {string | null} */ let model = null;
  let callModel = null;
  let config = null;
  if (!offline) {
    const { loadConfig } = await import(pathToFileURL(path.join(serverSrc, "config.mjs")).href);
    ({ callModelForControlPlane: callModel } = await import(pathToFileURL(path.join(serverSrc, "modelGateway.mjs")).href));
    config = loadConfig({});
    if (!config.deepseekApiKey) throw new Error("no DeepSeek key: set OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE, or run --offline");
    model = config.memoryExtractionModel || config.deepseekModel || null;
  }
  for (const item of cases) {
    const records = recordsOf(item);
    const ids = records.map((record) => record.id);
    if (item.class === "bounds") {
      const count = groupable(records).length;
      const verdicts = [
        { check: "groupable", passed: count === item.expect.groupable, detail: `${count} groupable` },
        { check: "minMemories", passed: count < item.expect.minMemories, detail: `${count} < ${item.expect.minMemories}: nothing is grouped, and no model is asked` },
      ];
      results.push({ id: item.id, class: item.class, verdict: verdicts.every((entry) => entry.passed) ? "passed" : "failed", verdicts });
      continue;
    }
    const existing = (item.existing ?? []).map((topic) => ({ id: topic.id, label: topic.label, modelLabel: topic.label, fixed: Boolean(topic.fixed) }));
    if (offline) {
      const good = topicVerdicts(item, parseTopics(JSON.stringify(item.fixtures.good), ids, existing), tools);
      const bad = topicVerdicts(item, parseTopics(JSON.stringify(item.fixtures.bad), ids, existing), tools);
      const failedBad = bad.filter((entry) => !entry.passed).map((entry) => entry.check).sort();
      const wanted = [...item.fixtures.badFails].sort();
      const verdicts = [
        ...good.map((entry) => ({ ...entry, check: `good: ${entry.check}` })),
        { check: "bad fails at least what the case is about", passed: wanted.every((check) => failedBad.includes(check)), detail: `failed ${failedBad.join(", ") || "nothing"}; wanted ${wanted.join(", ")}` },
      ];
      results.push({ id: item.id, class: item.class, verdict: verdicts.every((entry) => entry.passed) ? "passed" : "failed", verdicts });
      continue;
    }
    /** @type {any[]} */ const sampled = [];
    for (let run = 0; run < runs; run += 1) {
      const body = await callModel({ config, usageLedger: null }, {
        userId: "eval-memory-topics", projectId: "eval", purpose: "memory-extraction",
        body: topicsRequestBody(String(model), { existing, dismissed: item.dismissed ?? [], memories: records }),
      });
      const topics = parseTopics(body?.choices?.[0]?.message?.content, ids, existing);
      sampled.push({ topics: topics.map((topic) => ({ id: topic.id, label: topic.label, members: topic.members })), verdicts: topicVerdicts(item, topics, tools) });
    }
    const passedRuns = sampled.filter((entry) => entry.verdicts.every((verdict) => verdict.passed)).length;
    results.push({ id: item.id, class: item.class, verdict: passedRuns === runs ? "passed" : passedRuns === 0 ? "failed" : "flaky", passedRuns, runs, sampled });
  }
  const report = { ranAt: new Date().toISOString(), offline, model, runs: offline ? 0 : runs, cases: results };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(out, text);
  }
  process.stdout.write(text);
  if (results.some((result) => result.verdict === "failed")) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`memory topics eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
