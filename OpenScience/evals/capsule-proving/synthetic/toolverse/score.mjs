/**
 * Per-turn trajectory scoring against the gold call sequence (ToolVerse's turn-level scoring, deterministic).
 * A step is a tool call `{ tool, args }` or a clarifying question `{ ask: { params: [...] } }` naming the parameters the
 * assistant asked the user for. Arguments are compared by canonicalising dict match.
 * @module capsule-proving/synthetic/toolverse/score
 */
import { sameArgs } from './env.mjs';

const isAsk = (s) => Boolean(s && typeof s === 'object' && s.ask);
const askParams = (s) => [...new Set((s.ask.params || []).map(String))].sort();
export function stepMatches(gold, call) {
  if (!call) return false;
  if (isAsk(gold)) return isAsk(call) && JSON.stringify(askParams(gold)) === JSON.stringify(askParams(call));
  if (isAsk(call)) return false;
  return gold.tool === call.tool && sameArgs(gold.args, call.args);
}

/**
 * @param {{ steps: object[], askedAboutKnown?: string[] } | object[]} gold  `askedAboutKnown`: parameter names whose value
 *   the arm supplied; asking the user for one of them is a TellOnce failure.
 * @param {object[]} calls the trajectory the assistant produced, in order
 * @returns {{ perStep: boolean[], firstFail: number|null, pass: boolean, tellOnceFailure: boolean, extraCalls: number, unexpectedAsks: number }}
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
  return { perStep, firstFail: firstFail < 0 ? null : firstFail, pass: firstFail < 0 && extraCalls === 0 && !tellOnceFailure, tellOnceFailure, extraCalls, unexpectedAsks };
}
