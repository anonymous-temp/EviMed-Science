#!/usr/bin/env node
/**
 * The outside-event trigger as an eval (c2-leads 2026-10-25; principle 6): rounds of real hot-list entries (`cases.json`, built
 * from the archived Weibo hot search, github.com/justjavac/weibo-trending-hot-search `raw/YYYY-MM-DD.json`, and the live boards of
 * 2026-10-25), each sent through the prompts that ship — the grouping call (`FRONTIER_TOPIC_GROUP_INSTRUCTIONS`) and, for each
 * group the code accepts, the topic call (`FRONTIER_TOPIC_WRITE_INSTRUCTIONS`) with its checks and one rewrite — on deepseek-flash
 * through the platform's own `FrontierEditor`. Nothing here is judged by a model; the labels are the cases'.
 *
 *   node evals/frontier-outside-event/run_eval.mjs --key-file <path> [--only <round-id>] [--repeat 1] [--max-cny 5]
 *
 * What is measured, in code:
 * - acceptance: a labelled entry is accepted when the group holding it passes `groupRefusal` (medical, not a named person's
 *   private health, confidence ≥ 0.7); precision and recall over the labels (`accept` positive; `reject` and `must-reject`
 *   negative), and the must-reject cases on their own;
 * - field: an accepted positive's field is one its case accepts;
 * - name leakage: a subject name (the model's own and the case's) in the topic's title, question or an evidence query — in the
 *   first answer, and after the checks (must be 0: the code drops what still leaks);
 * - entity keys: the disease and drug names the topic call gave, as the shared key function spells them (`<kind>:<name>`), and
 *   whether each is a well-formed entity key; whether the vocabulary knows a name is the deployment's glossary, not this file's;
 * - the outputs themselves (titles, questions, pegs, searches) for a reader.
 * Tokens and a cost at the reference price are counted and the run stops at `--max-cny`. The key is read from the file inside
 * this process and never printed; nothing is metered and nothing is written but the result file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isEntityKey } from "../../packages/domain/src/entityKeys.mjs";
import { frontierTopicNamesIn } from "../../packages/domain/index.mjs";
import { FrontierEditor } from "../../apps/server/src/frontierEditor.mjs";
import {
  FRONTIER_TOPIC_GROUP_INSTRUCTIONS, FRONTIER_TOPIC_WRITE_INSTRUCTIONS, buildGroupInput, buildTopicInput, groupRefusal, verifyGroups, verifyTopic,
} from "../../apps/server/src/frontierTopics.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";

/** The reference price of deepseek-flash, CNY per million tokens (`@evimed/domain` metering). */
const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });
const here = dirname(fileURLToPath(import.meta.url));

/** The candidates of one round, as the module builds them from the sightings. @param {any} round */
function candidatesOf(round) {
  return round.entries.map((entry, index) => ({ n: index + 1, key: `k${index + 1}`, title: entry.title, description: entry.desc ?? null,
    boards: [{ board: entry.board, rank: entry.rank, url: null, firstSeenAt: `${round.day ?? "2026-10-25"}T12:00:00.000Z` }] }));
}

/** @param {string | null | undefined} text @param {string[]} names */
const leaks = (text, names) => frontierTopicNamesIn(text, names);

/** What a topic answer leaks, by field. @param {any} answer @param {string[]} names */
function leakage(answer, names) {
  const found = [];
  for (const field of ["title", "question"]) if (leaks(answer?.[field], names).length) found.push(field);
  for (const field of ["zh_evidence", "en_evidence", "stats"]) {
    for (const query of Array.isArray(answer?.queries?.[field]) ? answer.queries[field] : []) if (leaks(query, names).length) found.push(field);
  }
  return found;
}

/** One round: the grouping call, the code's decision per group, the topic call for each accepted group. */
async function runRound(/** @type {any} */ editor, /** @type {any} */ round) {
  const candidates = candidatesOf(round);
  const input = buildGroupInput(candidates, []);
  const answer = await editor.callJson([{ role: "system", content: FRONTIER_TOPIC_GROUP_INSTRUCTIONS }, { role: "user", content: input }],
    { maxTokens: 4_000, timeoutMs: 90_000 });
  const groups = verifyGroups(answer, candidates, []);
  const decided = [];
  for (const group of groups) {
    const refusal = groupRefusal(group);
    /** @type {any} */
    const record = { titles: group.members.map((member) => member.title), domain: group.domain, medical: group.medical, privateHealth: group.privateHealth,
      confidence: group.confidence, subjectNames: group.subjectNames, question: group.question, medicalMembers: group.medicalMembers, refusal };
    // A topic call for each accepted group that holds a labelled positive (an unlabelled accepted group is counted, not written).
    const labelled = round.labels.find((label) => label.expect === "accept" && record.titles.includes(label.title));
    if (!refusal && labelled) {
      const names = [...new Set([...group.subjectNames, ...labelled.names])];
      const topicInput = buildTopicInput(group);
      /** @type {any[]} */
      const attempts = [];
      const result = await editor.writeJson(FRONTIER_TOPIC_WRITE_INSTRUCTIONS, topicInput, 1_200, {
        verify: (/** @type {any} */ raw) => { attempts.push({ leaks: leakage(raw, names) }); return verifyTopic(raw, topicInput, group.subjectNames, group.members.length); },
        timeoutMs: 90_000 });
      const output = result.output ?? null;
      const entities = output ? [...output.entities.diseases.map((name) => `disease:${name}`), ...output.entities.drugs.map((name) => `drug:${name}`)] : [];
      record.topic = { verification: result.verification, attempts: attempts.length, firstLeaks: attempts[0]?.leaks ?? [],
        finalLeaks: output ? leakage(output, names) : [], output, entities, entitiesWellFormed: entities.filter((key) => isEntityKey(key)).length, issues: result.issues ?? [] };
    }
    decided.push(record);
  }
  const labels = round.labels.map((label) => {
    const group = decided.find((record) => record.titles.includes(label.title));
    const accepted = Boolean(group && !group.refusal);
    return { ...label, grouped: Boolean(group), accepted, domain: group?.domain ?? null, refusal: group?.refusal ?? (group ? null : "not_grouped"),
      fieldOk: label.expect === "accept" ? accepted && label.domains.includes(group?.domain) : null };
  });
  const labelledTitles = new Set(round.labels.map((label) => label.title));
  const unlabelledAccepted = decided.filter((record) => !record.refusal && !record.titles.some((title) => labelledTitles.has(title))).map((record) => record.titles);
  return { id: round.id, day: round.day, groups: decided, labels, unlabelledAccepted };
}

/** The figures over every round. @param {any[]} rounds */
function summarize(rounds) {
  const labels = rounds.flatMap((round) => round.labels ?? []);
  const positive = labels.filter((label) => label.expect === "accept");
  const negative = labels.filter((label) => label.expect !== "accept");
  const tp = positive.filter((label) => label.accepted).length;
  const fp = negative.filter((label) => label.accepted).length;
  const topics = rounds.flatMap((round) => (round.groups ?? []).filter((group) => group.topic).map((group) => group.topic));
  return {
    labels: labels.length, positives: positive.length, negatives: negative.length,
    precision: tp + fp ? Math.round((tp / (tp + fp)) * 1000) / 1000 : null,
    recall: positive.length ? Math.round((tp / positive.length) * 1000) / 1000 : null,
    missed: positive.filter((label) => !label.accepted).map((label) => `${label.title} (${label.refusal})`),
    falseAccepts: negative.filter((label) => label.accepted).map((label) => label.title),
    mustRejectHeld: negative.filter((label) => label.expect === "must-reject").map((label) => `${label.title}: ${label.accepted ? "ACCEPTED" : label.refusal}`),
    fieldOk: positive.filter((label) => label.accepted).length ? `${positive.filter((label) => label.fieldOk).length}/${positive.filter((label) => label.accepted).length}` : null,
    topicsWritten: topics.filter((topic) => topic.output).length, topicsDropped: topics.filter((topic) => !topic.output).length,
    firstAnswerLeaks: topics.filter((topic) => topic.firstLeaks.length).length, finalLeaks: topics.filter((topic) => topic.finalLeaks.length).length,
    entityKeys: { topics: topics.filter((topic) => topic.output).length, withKeys: topics.filter((topic) => topic.entities.length).length,
      keys: topics.reduce((sum, topic) => sum + topic.entities.length, 0), wellFormed: topics.reduce((sum, topic) => sum + topic.entitiesWellFormed, 0) },
    unlabelledAccepted: rounds.reduce((sum, round) => sum + (round.unlabelledAccepted?.length ?? 0), 0),
    errors: rounds.filter((round) => round.error).map((round) => `${round.id}: ${round.error}`),
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    only: { type: "string" }, repeat: { type: "string", default: "1" }, "max-cny": { type: "string", default: "5" }, out: { type: "string" },
  } });
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  if (!apiKey) throw new Error("The DeepSeek key file is empty.");
  const maxCny = Number(values["max-cny"]) || 5;
  const usage = { calls: 0, cacheHit: 0, cacheMiss: 0, output: 0, cny: 0 };
  /** @type {typeof callModelForControlPlane} */
  const callModel = async (context, call) => {
    if (usage.cny >= maxCny) throw Object.assign(new Error("The eval's spending limit is reached."), { code: "usage_budget_exceeded" });
    const body = await callModelForControlPlane(context, call);
    const used = body?.usage ?? {};
    const hit = Number(used.prompt_cache_hit_tokens ?? 0);
    const miss = Number(used.prompt_cache_miss_tokens ?? Math.max(0, Number(used.prompt_tokens ?? 0) - hit));
    usage.calls += 1; usage.cacheHit += hit; usage.cacheMiss += miss; usage.output += Number(used.completion_tokens ?? 0);
    usage.cny = (usage.cacheHit * PRICE.cacheHit + usage.cacheMiss * PRICE.cacheMiss + usage.output * PRICE.output) / 1_000_000;
    return body;
  };
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com",
    frontierModel: "deepseek-flash" }, { owner: { userId: "eval", projectId: "eval" }, callModel });
  const { rounds } = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
  const wanted = rounds.filter((/** @type {any} */ round) => !values.only || round.id === values.only);
  const runs = [];
  for (let repeat = 0; repeat < Math.max(1, Number(values.repeat) || 1); repeat += 1) {
    const results = [];
    for (const round of wanted) {
      try { results.push(await runRound(editor, round)); }
      catch (error) { results.push({ id: round.id, error: /** @type {any} */ (error)?.code ?? String(error) }); }
      process.stderr.write(`frontier-outside-event: run ${repeat + 1} ${results.length}/${wanted.length} ¥${usage.cny.toFixed(3)}\n`);
    }
    runs.push({ repeat: repeat + 1, summary: summarize(results), rounds: results });
  }
  const out = values.out ?? join(here, "results", `run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ model: "deepseek-flash", ranAt: new Date().toISOString(), usage, runs }, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ out, usage, summaries: runs.map((run) => run.summary) }, null, 1)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
