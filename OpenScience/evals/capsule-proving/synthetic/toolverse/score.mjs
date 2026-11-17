/**
 * Per-turn trajectory scoring against the gold call sequence (ToolVerse's turn-level scoring, deterministic).
 * A step is a tool call `{ tool, args }` or a clarifying question `{ ask: { params: [...] } }` naming the parameters the
 * assistant asked the user for. Arguments are compared by canonicalising dict match.
 * @module capsule-proving/synthetic/toolverse/score
 */
import { sameArgs, sameToolArgs } from './env.mjs';

const isAsk = (s) => Boolean(s && typeof s === 'object' && s.ask);
const askParams = (s) => [...new Set((s.ask.params || []).map(String))].sort();
export function stepMatches(gold, call) {
  if (!call) return false;
  if (isAsk(gold)) return isAsk(call) && JSON.stringify(askParams(gold)) === JSON.stringify(askParams(call));
  if (isAsk(call)) return false;
  return gold.tool === call.tool && sameToolArgs(gold.tool, gold.args, call.args);
}

/**
 * @param {{ steps: object[], askedAboutKnown?: string[] } | object[]} gold  `askedAboutKnown`: parameter names whose value
 *   the arm supplied; asking the user for one of them is a TellOnce failure.
 * @param {object[]} calls the trajectory the assistant produced, in order
 * @returns {{ perStep: boolean[], firstFail: number|null, pass: boolean, finalTaskCorrect: boolean, tellOnceFailure: boolean, extraCalls: number, unexpectedAsks: number }}
 */
export function scoreTrajectory(gold, calls) {
  const steps = Array.isArray(gold) ? gold : gold.steps;
  const known = new Set((Array.isArray(gold) ? [] : gold.askedAboutKnown) || []);
  const made = Array.isArray(calls) ? calls : [];
  const tellOnceFailure = made.some((c) => isAsk(c) && askParams(c).some((p) => known.has(p)));
  const goldHasAsk = steps.some(isAsk);
  // an ask the gold does not expect never shifts the alignment of the real calls
  const aligned = goldHasAsk ? made : made.filter((c) => !isAsk(c));
  const unexpectedAsks = goldHasAsk ? 0 : made.length - aligned.length;
  const perStep = steps.map((s, i) => stepMatches(s, aligned[i]));
  const firstFail = perStep.indexOf(false);
  const extraCalls = Math.max(0, aligned.length - steps.length);
  // Terminal-operation correctness permits a recovered path; it does not grade the assistant's final prose.
  const finalTask = steps.filter(step => !isAsk(step)).at(-1);
  // Later read-only verification is not a replacement for the task's terminal operation.
  const finalCall = made.filter(step => !isAsk(step) && step.tool === finalTask?.tool).at(-1);
  const readOnly = /^(?:get_|read_|list_|convert_|add_days$|term_normalize$|drug_term_normalize$|find_|search_|fetch_|file_stat$)/.test(finalTask?.tool ?? '');
  const finalTaskCorrect = Boolean(finalTask && (readOnly ? made.some(call => stepMatches(finalTask, call)) : stepMatches(finalTask, finalCall)));
  let pathIndex = 0;
  for (const call of aligned) if (pathIndex < steps.length && stepMatches(steps[pathIndex], call)) pathIndex++;
  const prescribedPathFollowed = pathIndex === steps.length;
  const legacyStrictPass = steps.every((step, i) => isAsk(step) ? stepMatches(step, aligned[i]) : aligned[i]?.tool === step.tool && sameArgs(step.args, aligned[i]?.args)) && extraCalls === 0 && !tellOnceFailure;
  return { legacyStrictPass, prescribedPathFollowed, perStep, firstFail: firstFail < 0 ? null : firstFail, pass: firstFail < 0 && extraCalls === 0 && !tellOnceFailure, finalTaskCorrect, tellOnceFailure, extraCalls, unexpectedAsks };
}
