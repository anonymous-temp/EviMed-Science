// C2 benchmark adapters: which tasks, what the product is given (the benchmark's own statement and files), and the paper's
// figure each one is compared with. Scoring is not here: score_dabench.py and score_dacode.py call the official scorers.
//
// Presentation rule (plan 5.5, principle "the benchmark configuration is the product configuration"): one user message per task,
// written in the benchmark's own words, the task files uploaded through the product's upload route, nothing in a system prompt.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export const PUBLIC = '/srv/evimed/data/memdata-data/public';

/** The EvoDS paper's figures (plan 5.5 row C2): the no-code-skill baseline and the full system with cross-task reuse. */
export const PAPER = {
  dabench: { set: 'c2-dabench', baseline: 0.894, reuse: 0.911, metric: 'accuracy by question (all sub-answers exact)' },
  'da-code': { set: 'c2-da-code', baseline: 0.341, reuse: 0.351, metric: 'average official score' },
  sab: { set: 'c2-sab', baseline: 0.108, reuse: 0.118, metric: 'success rate' },
};

/** Per-turn timeout (minutes) by benchmark: DABench questions are single computations; DA-Code includes model training. */
export const TIMEOUT_MIN = { dabench: 15, 'da-code': 30, sab: 30 };

/** Accepts the frozen sample file and returns the ordered task ids of a benchmark. */
export function sampleIds(samples, bench) {
  const sets = samples.sets ?? {};
  if (bench === 'dabench') return null; // whole set: every question of the pinned file, in file order
  if (bench === 'da-code') return [...sets['da-code'].tasks];
  if (bench === 'sab') return [...sets.scienceagentbench.tasks];
  throw new Error(`unknown bench ${bench}`);
}

const jsonl = async (file) => (await fs.readFile(file, 'utf8')).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));

// ---------------------------------------------------------------------------------------------------------------------------
// InfiAgent-DABench (pinned 3d6c4a7, examples/DA-Agent/data). Official generation script pipeline/activities/eval.py builds
//   prompt = f"Question: {question}\n{constraints}\n"   and uploads the csv;
// the official reformat step (reformat.py) then asks for the `format` with a fixed sentence. Both go into the one message here,
// in that order and with the reformat sentence verbatim, so no second model call rewrites the product's answer.
export const DABENCH_DIR = `${PUBLIC}/infiagent-dabench/examples/DA-Agent`;
const REFORMAT_SENTENCE = 'Your answer should contain all the "@answer_name[answer]" in the order mentioned, each "answer" should be in the range of value as required.';

export function dabenchText(q) {
  return `Question: ${q.question}\n${q.constraints}\n\nThe format requirements of this question is:\n${q.format}\n${REFORMAT_SENTENCE}`;
}

export async function dabenchTasks(dir = DABENCH_DIR) {
  const questions = await jsonl(`${dir}/data/da-dev-questions.jsonl`);
  return questions.map((q) => ({
    id: `dabench-${q.id}`, bench: 'dabench', sourceId: q.id, level: q.level, concepts: q.concepts, file: q.file_name,
    fixtureRoot: `${dir}/data/da-dev-tables`,
    spec: { id: `dabench-${q.id}`, family: 'c2-dabench', inputs: [{ fixture: q.file_name, to: q.file_name }], turns: [{ text: dabenchText(q) }] },
  }));
}

// ---------------------------------------------------------------------------------------------------------------------------
// DA-Code (pinned b211daf). The official agent copies da_code/source/<id>/ into /workspace and works there; it ends with
// Terminate(output="literal_answer_or_output_path"), whose output is what the official evaluator reads as the result. The task
// statement is the instruction verbatim, followed by the official description of that terminate action (da_agent/agent/action.py),
// so the product's reply carries the answer the evaluator expects. The source and gold folders of the full 500-task release come
// from the Google Drive archives named in the pinned README (the repository itself carries 62 of them).
export const DACODE_REPO = `${PUBLIC}/da-code`;
export const DACODE_FULL = '/srv/evimed/data/c2-dacode-full';
export const TERMINATE_SENTENCE = 'When the task is complete, end your reply with Terminate(output="literal_answer_or_output_path"): it returns the final answer or the output file/folder path. Make sure the output file is located in the initial workspace directory.';

export function dacodeText(task) {
  return `${task.instruction.trim()}\n\n${TERMINATE_SENTENCE}`;
}

export async function dacodeTasks(ids, { repo = DACODE_REPO, full = DACODE_FULL } = {}) {
  const configs = new Map((await jsonl(`${repo}/da_code/configs/task/all.jsonl`)).map((row) => [row.id, row]));
  const evals = new Map((await jsonl(`${repo}/da_code/configs/eval/eval_all.jsonl`)).map((row) => [row.id, row]));
  const sourceRoot = fsSync.existsSync(`${full}/source`) ? `${full}/source` : `${repo}/da_code/source`;
  const out = [];
  for (const id of ids) {
    const config = configs.get(id);
    if (!config) throw new Error(`DA-Code task ${id} is not in configs/task/all.jsonl`);
    const dir = path.join(sourceRoot, id);
    const entries = fsSync.existsSync(dir) ? (await fs.readdir(dir)).sort() : [];
    out.push({
      id, bench: 'da-code', type: config.type, hardness: config.hardness, postProcess: config.post_process ?? [], eval: evals.get(id) ?? null,
      sourceDir: dir, missingSource: entries.length === 0, fixtureRoot: sourceRoot,
      spec: { id, family: 'c2-da-code', inputs: entries.map((entry) => ({ fixture: `${id}/${entry}`, to: entry })), turns: [{ text: dacodeText(config) }] },
    });
  }
  return out;
}

/** Files above the product's upload ceiling (OPEN_SCIENCE_MAX_FILE_BYTES, 50 MB by default): reported, never silently dropped. */
export async function oversizedInputs(task, maxBytes = 50 * 1024 * 1024) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(next, `${rel}${entry.name}/`);
      else if ((await fs.stat(next)).size > maxBytes) out.push(`${rel}${entry.name}`);
    }
  };
  if (task.sourceDir && fsSync.existsSync(task.sourceDir)) await walk(task.sourceDir, '');
  return out;
}

export async function tasksFor(bench, samples, options = {}) {
  if (bench === 'dabench') return dabenchTasks(options.dabenchDir);
  if (bench === 'da-code') return dacodeTasks(sampleIds(samples, bench), options);
  if (bench === 'sab') throw new Error('ScienceAgentBench is not runnable on the product path yet: see SAB_GAPS in run_c2.mjs.');
  throw new Error(`unknown bench ${bench}`);
}

/**
 * The reuse arm's split (EvoDS reuse protocol: practise on a validation part, use on a test part): the first 3/5 of the tasks in
 * task order learn, the remaining 2/5 are the test.
 */
export function reuseSplit(ids) {
  const cut = Math.round(ids.length * 3 / 5);
  return { validation: ids.slice(0, cut), test: ids.slice(cut) };
}
