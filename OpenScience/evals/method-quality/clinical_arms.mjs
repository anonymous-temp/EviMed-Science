// The arms of the native clinical extraction evaluation (`run_native_clinical.mjs`), and the prompt each one is given.
//
// Two arms: `native` is DSH + DeepSeek with only the task's own instructions — the control; `on` adds the enhanced extraction
// guidance and the fact contract. A third arm, `off`, ran until 2026-10-10 with a prompt byte-identical to `native`'s (the guidance
// only ever went to `on`), so the gap between them was the noise floor and a second control that said nothing the first did not.
// Archives written then still hold `off` cells; `score_native_clinical.py` reads them as `native`. An arm that is not a different
// prompt is a replicate, and replicates are the runner's `repeats`.

export const CLINICAL_ARMS = Object.freeze(['native', 'on']);

/** The arm that carries the enhanced guidance; every other arm is the control. */
const GUIDED_ARM = 'on';

/** Every arm once per repeat, in an order that alternates so that no arm always goes first. @param {number} repeat */
export function armsForRepeat(repeat) {
  return repeat % 2 ? ['on', 'native'] : ['native', 'on'];
}

/**
 * The extraction prompt of one arm for one case. The text before the guidance slot is the task and is the same for every arm; the
 * `native` arm's prompt is exactly the one the archived `native` cells were run with.
 * @param {{ arm: string, guidance: string, factContract: unknown, input: Record<string, unknown> }} parts
 */
export function clinicalExtractionPrompt({ arm, guidance, factContract, input }) {
  if (!CLINICAL_ARMS.includes(arm)) throw new Error(`unknown clinical arm ${JSON.stringify(arm)}`);
  const extra = arm === GUIDED_ARM ? guidance + '\n' + JSON.stringify({ factContract }) : '';
  return `Extract sourced facts for this synthetic study. Return only JSON {"facts":[...]}. Each fact has subjectKey, documentId, variable, value (number or text), unit (optional), polarity (affirmed/negated/hypothetical/family), occurredAt (ISO date if explicit), surface (exact substring), quote (exact substring). Do not calculate eligibility. Optional clinical metadata follows the supplied schema when guidance is present. No invented measurements. Omit optional unknown fields. Clinical metadata belongs only inside clinical.\n${extra}\n${JSON.stringify(input)}`;
}
