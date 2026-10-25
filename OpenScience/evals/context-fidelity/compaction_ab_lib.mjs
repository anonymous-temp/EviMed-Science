// The controlled A/B of compaction policy: the scripted conversation, what must survive it, the scoring, and the rule that decides.
//
// Why this exists: the context-fidelity report (`report.py`) reads the run ledger and cannot say anything until compaction has happened in production, and the
// platform's window equals its run budget, so it hardly ever does. `structured` (the EviMed engine in `packages/socket/plugins/compaction.mjs`) has been built and
// switched off since 2026-09, and the measurement that was to decide it never came. This runs the same conversation on a real kernel under each policy, with
// the window lowered until compaction fires in a few turns, and asks the thing that matters: after the history was folded into a summary, is what the person
// said still there, and does the next answer still use it?
//
// What is measured, all by code (nothing here asks a model whether an answer is good):
//  - survival: the person stated three rules, two file paths worth of naming, two ids and one open item in the first turns (`FACTS`). After compaction
//    they ask for them back. A fact survives when its text (one of the spellings the check lists) is in the answer.
//  - the next answer: they ask for a piece of work that needs two of those facts (the unit rule and the file). It stays correct when the answer carries the
//    converted number, the unit and the path.
//  - validity: a sample counts only if the kernel compacted before the probes (`compactionsIn`); a run that never compacted compared two identical arms.
//  - cost and time: what each sample spent through the control plane's gateway, and how long its turns took, so the price of `structured` (a second,
//    stricter summary call when the first misses a handle) is on the page beside what it bought.
//
// The decision rule is written down before the numbers (`DECISION`), because a threshold picked after seeing them is a story: structured is switched on by default
// only when it keeps at least fifteen points more of what was said than basic over at least three valid samples of each, and answers the next task no worse;
// when it does not, `structured` is deleted (owner decision of 2026-10-25, "dead arms are deleted, not kept just in case"). Between those the result is
// inconclusive and the way to settle it is more samples, not a different threshold.
//
// The pure parts are here and tested (`compaction_ab.test.mjs`); the kernel and the gateway are the runner's (`compaction_ab.mjs`).

/** The two policies of `OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY`. */
export const ARMS = Object.freeze(["basic", "structured"]);

/** What decides, fixed before there is a number to argue from. */
export const DECISION = Object.freeze({ minValidPerArm: 3, minGap: 0.15, noGain: 0.05 });

/** What the scripted conversation is sized by: the lowered window, the share of it at which pressure compaction fires, and the filler that gets there. */
export const DEFAULTS = Object.freeze({ samples: 3, contextWindow: 20_000, thresholdRatio: 0.8, fillerTurns: 8, fillerRows: 160 });

/**
 * What the person said and what must come back. Each fact lists the spellings that count (a model may write 「3 条」 or 「三条」); a check is a match on any
 * of them, with white space and case ignored.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const FACTS = Object.freeze({
  rule_unit: ["mmol/L", "mmol／L", "毫摩尔"],
  rule_bullets: ["三条", "3条", "3 条", "三 条", "最多三", "最多 3", "最多3", "three"],
  rule_directory: ["out/", "out／"],
  path: ["out/q3-summary.md"],
  case_id: ["CASE-4471"],
  batch_id: ["BATCH-20261025-B"],
  open_item: ["12条", "12 条", "十二条", "十二 条", "12行", "12 行", "12 records", "12 rows"],
});

/** What a correct next answer carries: the converted number (126 mg/dL is 6.99 mmol/L), the unit the person asked for, and the file. */
export const TASK_CHECKS = Object.freeze({
  converted: ["6.99", "6.994", "7.0mmol", "7.0 mmol", "约7mmol", "约 7 mmol", "7 mmol/L", "7mmol/L", "6.9mmol", "6.9 mmol"],
  unit: ["mmol/L", "mmol／L"],
  file: ["out/q3-summary.md"],
});

/** @param {unknown} text @returns {string} lower case, no white space: what an answer is compared as */
const squash = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, "");

/**
 * Whether an answer holds one of the spellings.
 * @param {unknown} answer @param {readonly string[]} spellings @returns {boolean}
 */
export function holds(answer, spellings) {
  const text = squash(answer);
  return spellings.some((spelling) => text.includes(squash(spelling)));
}

/**
 * One table of the filler: deterministic, dense and dull, the kind of pasted data a conversation really carries. `index` and `rows` are all that decide it.
 * @param {number} index @param {number} rows @returns {string}
 */
export function fillerTable(index, rows) {
  /** @type {string[]} */
  const lines = ["序号\t受试者\t访视日期\t空腹血糖(mg/dL)\t体重(kg)\t备注"];
  let state = (index + 1) * 2654435761 % 2147483647;
  const next = () => { state = (state * 48271) % 2147483647; return state; };
  for (let row = 1; row <= rows; row += 1) {
    const glucose = 70 + (next() % 130);
    const weight = 48 + (next() % 55);
    lines.push(`${row}\tS${String(index * 1000 + row).padStart(5, "0")}\t2026-${String(1 + (next() % 9)).padStart(2, "0")}-${String(1 + (next() % 27)).padStart(2, "0")}\t${glucose}\t${weight}\t${["按时随访", "延后一周", "电话随访", "门诊复查", "漏访待补"][next() % 5]}`);
  }
  return lines.join("\n");
}

/**
 * The scripted conversation: two turns that state the facts, `fillerTurns` turns of pasted tables that fill the window, then the two probes.
 * @param {{ fillerTurns?: number, fillerRows?: number }} [options]
 * @returns {{ turns: { id: string, kind: "setup" | "filler" | "recall" | "task", prompt: string }[], facts: typeof FACTS, taskChecks: typeof TASK_CHECKS }}
 */
export function buildScenario({ fillerTurns = DEFAULTS.fillerTurns, fillerRows = DEFAULTS.fillerRows } = {}) {
  /** @type {{ id: string, kind: "setup" | "filler" | "recall" | "task", prompt: string }[]} */
  const turns = [
    { id: "01-rules", kind: "setup", prompt: "我在整理 2026 年 Q3 的糖尿病随访数据，之后会分几步做。先说好三条规则：1）所有血糖值只用 mmol/L 报告；2）每一节最多三条要点；3）所有文件都放在 out/ 目录下，周报存为 out/q3-summary.md。病例编号 CASE-4471，批次号 BATCH-20261025-B。先回我一句“收到”。" },
    { id: "02-open", kind: "setup", prompt: "还有一件事没做完：有 12 条记录对不上，之后要核对。现在先回我一句“记下了”。" },
  ];
  for (let index = 1; index <= fillerTurns; index += 1) {
    turns.push({ id: `${String(index + 2).padStart(2, "0")}-table-${index}`, kind: "filler", prompt: `读一下下面这张表，只用一句话告诉我空腹血糖最高的是第几行。\n\n${fillerTable(index, fillerRows)}` });
  }
  const at = turns.length + 1;
  turns.push(
    { id: `${String(at).padStart(2, "0")}-recall`, kind: "recall", prompt: "停一下，先不管表格的事。请只列出：(a) 我们约定的三条规则；(b) 已经说好的文件路径；(c) 病例编号和批次号；(d) 还没做完的事项。逐条列，不要解释。" },
    { id: `${String(at + 1).padStart(2, "0")}-task`, kind: "task", prompt: "好，接着做：之前提到的一个空腹血糖是 126 mg/dL。请按我们约定的规则把它写进报告里的一句话，并说清楚这句话要存到哪个文件。" },
  );
  return { turns, facts: FACTS, taskChecks: TASK_CHECKS };
}

/**
 * How many times a kernel's event stream says it compacted. A compaction is told by its end (`compaction/end`); when no event says it ended, the starts are counted,
 * because a stream that names a compaction at all means one happened. A stream of nothing recognisable is zero, and a sample with zero compactions is not a sample.
 * @param {readonly any[]} events @returns {number}
 */
export function compactionsIn(events) {
  const names = events.map((event) => String(event?.type ?? event?.event ?? event?.kind ?? event?.name ?? "")).filter((name) => /compact/i.test(name));
  const ended = names.filter((name) => /(end|done|complete|finish)/i.test(name)).length;
  return ended || names.length;
}

/**
 * @typedef {object} TurnReceipt
 * @property {string} id @property {string} kind @property {string} text the answer
 * @property {number} compactions @property {number} latencyMs @property {number} code
 *
 * @typedef {object} Sample
 * @property {string} id @property {string} arm @property {TurnReceipt[]} turns @property {number} cost @property {number} requests @property {string | null} [error]
 */

/**
 * What one sample says. Pure. A sample that failed to run to the probes, or never compacted before them, is not valid and is not scored for survival.
 * @param {Sample} sample @returns {{ id: string, arm: string, valid: boolean, why: string | null, compactions: number, survived: string[], missing: string[], survivedFraction: number | null,
 *   task: Record<string, boolean>, taskFraction: number | null, taskPassed: boolean | null, latencyMs: number, cost: number, requests: number }}
 */
export function scoreSample(sample) {
  const turns = sample.turns ?? [];
  const recall = turns.find((turn) => turn.kind === "recall");
  const task = turns.find((turn) => turn.kind === "task");
  const compactions = turns.filter((turn) => turn.kind !== "recall" && turn.kind !== "task").reduce((total, turn) => total + (turn.compactions ?? 0), 0);
  const latencyMs = turns.reduce((total, turn) => total + (turn.latencyMs ?? 0), 0);
  const base = { id: sample.id, arm: sample.arm, compactions, latencyMs, cost: sample.cost ?? 0, requests: sample.requests ?? 0 };
  const empty = { survived: /** @type {string[]} */ ([]), missing: /** @type {string[]} */ ([]), survivedFraction: null, task: {}, taskFraction: null, taskPassed: null };
  if (sample.error || !recall || !task || turns.some((turn) => turn.code !== 0)) return { ...base, ...empty, valid: false, why: sample.error ?? "the probes did not run" };
  if (compactions < 1) return { ...base, ...empty, valid: false, why: "the kernel never compacted before the probes: both arms would have read the same history" };
  const survived = Object.entries(FACTS).filter(([, spellings]) => holds(recall.text, spellings)).map(([name]) => name);
  const missing = Object.keys(FACTS).filter((name) => !survived.includes(name));
  const checks = Object.fromEntries(Object.entries(TASK_CHECKS).map(([name, spellings]) => [name, holds(task.text, spellings)]));
  const passed = Object.values(checks).filter(Boolean).length;
  return {
    ...base, valid: true, why: null, survived, missing, survivedFraction: survived.length / Object.keys(FACTS).length,
    task: checks, taskFraction: passed / Object.keys(TASK_CHECKS).length, taskPassed: passed === Object.keys(TASK_CHECKS).length,
  };
}

/** @param {readonly number[]} values @returns {number | null} */
const mean = (values) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
/** @param {number | null} value @param {number} [places] */
const round = (value, places = 4) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

/**
 * One arm's samples summarised. Survival and the next answer are over the valid samples only; cost and time over every sample that ran, because a sample that
 * did not compact still spent money.
 * @param {ReturnType<typeof scoreSample>[]} scored
 */
export function summarizeArm(scored) {
  const valid = scored.filter((entry) => entry.valid);
  const fractions = valid.map((entry) => /** @type {number} */ (entry.survivedFraction));
  return {
    samples: scored.length,
    valid: valid.length,
    invalid: scored.filter((entry) => !entry.valid).map((entry) => ({ id: entry.id, why: entry.why })),
    survival: { mean: round(mean(fractions)), min: fractions.length ? round(Math.min(...fractions)) : null, max: fractions.length ? round(Math.max(...fractions)) : null },
    lostMost: Object.keys(FACTS).map((name) => ({ fact: name, lost: valid.filter((entry) => entry.missing.includes(name)).length })).filter((entry) => entry.lost > 0).sort((a, b) => b.lost - a.lost),
    nextAnswer: { passed: valid.filter((entry) => entry.taskPassed).length, of: valid.length, rate: round(valid.length ? valid.filter((entry) => entry.taskPassed).length / valid.length : null) },
    compactions: round(mean(scored.map((entry) => entry.compactions)), 2),
    latencyMs: round(mean(scored.map((entry) => entry.latencyMs)), 0),
    cost: { mean: round(mean(scored.map((entry) => entry.cost)), 6), total: round(scored.reduce((total, entry) => total + entry.cost, 0), 6), requests: scored.reduce((total, entry) => total + entry.requests, 0) },
  };
}

/**
 * The rule, applied. Pure, and the only place a verdict is made.
 * @param {{ basic: ReturnType<typeof summarizeArm>, structured: ReturnType<typeof summarizeArm> }} arms
 * @returns {{ verdict: "structured" | "basic" | "inconclusive", gap: number | null, taskGap: number | null, reason: string, action: string }}
 */
export function decide({ basic, structured }) {
  const enough = basic.valid >= DECISION.minValidPerArm && structured.valid >= DECISION.minValidPerArm;
  if (!enough) {
    return { verdict: "inconclusive", gap: null, taskGap: null, action: "run more samples; do not change the default",
      reason: `at least ${DECISION.minValidPerArm} valid samples of each arm are needed, there are ${basic.valid} of basic and ${structured.valid} of structured (a sample is valid only if the kernel compacted before the probes)` };
  }
  const gap = round(/** @type {number} */ (structured.survival.mean) - /** @type {number} */ (basic.survival.mean));
  const taskGap = round(/** @type {number} */ (structured.nextAnswer.rate) - /** @type {number} */ (basic.nextAnswer.rate));
  if (/** @type {number} */ (gap) >= DECISION.minGap && /** @type {number} */ (taskGap) >= 0) {
    return { verdict: "structured", gap, taskGap, action: "make `structured` the default of OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY (config.mjs, compose, .env.example)",
      reason: `structured kept ${Math.round(/** @type {number} */ (gap) * 100)} points more of what was said than basic and answered the next task no worse` };
  }
  if (/** @type {number} */ (gap) <= DECISION.noGain || /** @type {number} */ (taskGap) < 0) {
    return { verdict: "basic", gap, taskGap, action: "delete `structured`: the engine, the state-handle packet, the policy lever and the plugin's non-basic branch (owner decision of 2026-10-25)",
      reason: `structured kept ${Math.round(/** @type {number} */ (gap) * 100)} points ${/** @type {number} */ (gap) < 0 ? "less" : "more"} than basic${/** @type {number} */ (taskGap) < 0 ? " and answered the next task worse" : ", which is no gain worth a second summary call"}` };
  }
  return { verdict: "inconclusive", gap, taskGap, action: "run more samples of each arm (six or more); do not change the default",
    reason: `the gap, ${Math.round(/** @type {number} */ (gap) * 100)} points, is between the ${Math.round(DECISION.noGain * 100)} that is no gain and the ${Math.round(DECISION.minGap * 100)} that is a win` };
}

/**
 * Everything the runner needs of a kernel, as one function: the next turn, in a session. The real one is `createNativeDsh`'s; a test brings its own.
 * @typedef {(request: { prompt: string, filename: string, sessionId?: string | null }) => Promise<{ code: number, timedOut?: boolean, events: any[], latencyMs: number, sessionId: string | null, text: string }>} Native
 */

/**
 * Run the scripted conversation once under one arm.
 * @param {{ native: Native, scenario: ReturnType<typeof buildScenario>, arm: string, id: string, meter?: { begin: (id: string) => void, end: (id: string) => Promise<{ cost: number, requests: number }> } | null,
 *   log?: (line: string) => void }} input
 * @returns {Promise<Sample>}
 */
export async function runSample({ native, scenario, arm, id, meter = null, log = () => {} }) {
  /** @type {TurnReceipt[]} */
  const turns = [];
  /** @type {string | null} */
  let sessionId = null;
  /** @type {string | null} */
  let error = null;
  meter?.begin(id);
  for (const turn of scenario.turns) {
    let result;
    try {
      result = await native({ prompt: turn.prompt, filename: `${id}-${turn.id}`, sessionId });
    } catch (failure) {
      error = `${turn.id}: ${/** @type {any} */ (failure)?.message ?? failure}`;
      break;
    }
    sessionId = result.sessionId ?? sessionId;
    const receipt = { id: turn.id, kind: turn.kind, text: String(result.text ?? ""), compactions: compactionsIn(result.events ?? []), latencyMs: result.latencyMs ?? 0, code: result.timedOut ? -1 : result.code };
    turns.push(receipt);
    log(`${id} ${turn.id} code=${receipt.code} compactions=${receipt.compactions} ${receipt.latencyMs}ms`);
    if (receipt.code !== 0) { error = `${turn.id}: the kernel ${result.timedOut ? "timed out" : `exited with ${result.code}`}`; break; }
  }
  const spent = meter ? await meter.end(id).catch(() => ({ cost: 0, requests: 0 })) : { cost: 0, requests: 0 };
  return { id, arm, turns, cost: spent.cost, requests: spent.requests, error };
}

/**
 * The report: per arm, the decision, and what it cost. Plain text for the person who runs it.
 * @param {{ basic: ReturnType<typeof summarizeArm>, structured: ReturnType<typeof summarizeArm> }} arms @param {ReturnType<typeof decide>} decision
 * @param {{ contextWindow: number, thresholdRatio: number, samples: number }} setup
 * @returns {string}
 */
export function render(arms, decision, setup) {
  const pct = (/** @type {number | null} */ value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
  /** @param {string} name @param {typeof arms.basic} arm */
  const line = (name, arm) => `${name.padEnd(11)} valid ${arm.valid}/${arm.samples}  survived ${pct(arm.survival.mean)} (${pct(arm.survival.min)}-${pct(arm.survival.max)})  next answer ${arm.nextAnswer.passed}/${arm.nextAnswer.of}  `
    + `compactions ${arm.compactions}  ${Math.round((arm.latencyMs ?? 0) / 1000)}s  cost ${arm.cost.mean} per sample (${arm.cost.total} in ${arm.cost.requests} requests)`;
  return [
    `Compaction A/B: window ${setup.contextWindow} tokens, pressure at ${Math.round(setup.thresholdRatio * 100)}%, ${setup.samples} samples per arm`,
    line("basic", arms.basic),
    line("structured", arms.structured),
    ...[["basic", arms.basic], ["structured", arms.structured]].flatMap(([name, arm]) => /** @type {typeof arms.basic} */ (arm).lostMost.length
      ? [`  ${name} lost most often: ${/** @type {typeof arms.basic} */ (arm).lostMost.map((entry) => `${entry.fact} (${entry.lost}/${/** @type {typeof arms.basic} */ (arm).valid})`).join(", ")}`] : []),
    ...[["basic", arms.basic], ["structured", arms.structured]].flatMap(([name, arm]) => /** @type {typeof arms.basic} */ (arm).invalid.map((entry) => `  ${name} ${entry.id} not valid: ${entry.why}`)),
    `Verdict: ${decision.verdict}${decision.gap === null ? "" : `, survival gap ${pct(decision.gap)}, next-answer gap ${pct(decision.taskGap)}`}`,
    `  ${decision.reason}`,
    `  Do: ${decision.action}`,
  ].join("\n");
}
