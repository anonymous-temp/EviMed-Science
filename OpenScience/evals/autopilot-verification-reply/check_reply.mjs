/**
 * What a verifier's reply may not say: the names of the file it wrote.
 *
 * A closed vocabulary (principle 5 allows these; it is the file's own, not a pattern over language): the file's name, its field names and
 * the three words its verdict may be, read from the same list the instruction that keeps them out of the reply is built from
 * (`VERIFICATION_FILE_VOCABULARY` in the control plane). A name found in a reply is a back-office word in a sentence a researcher reads
 * (design reference §8.6, E-10).
 *
 * Two kinds of find. The file's name and its field names are never words a reply needs, so any occurrence counts. The three verdict words
 * are English words too, and a reply in English may say the sources "contradict" the claim, or that a claim "stands" without meaning the
 * file's label; they count only when used as a label — in code marks or quotes, or right after `verdict`.
 */
import { VERIFICATION_FILE_VOCABULARY } from "../../apps/server/src/autopilotService.mjs";
import { REFUTATION_VERDICTS } from "../../packages/domain/index.mjs";

const escape = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = VERIFICATION_FILE_VOCABULARY.filter((word) => !REFUTATION_VERDICTS.includes(word));
const nameFound = new RegExp(`(?<![A-Za-z0-9_])(${names.map(escape).join("|")})(?![A-Za-z0-9_])`, "gi");
const verdicts = REFUTATION_VERDICTS.map(escape).join("|");
// A verdict word as a label: between code marks or quotes, or named as the verdict.
const labelFound = new RegExp(`[\`"'“”‘’「」『』](${verdicts})[\`"'“”‘’「」『』]|verdict\\W{0,6}(${verdicts})(?![A-Za-z])`, "gi");

/**
 * @param {string} reply the verifier's final reply, as the researcher reads it
 * @returns {string[]} each back-office word found, in the order found, once each
 */
export function backstageWordsIn(reply) {
  const found = [];
  const text = String(reply ?? "");
  // Reported as the vocabulary spells them, whatever the reply's capitals.
  const canonical = (/** @type {string} */ word) => VERIFICATION_FILE_VOCABULARY.find((entry) => entry.toLowerCase() === word.toLowerCase()) ?? word;
  for (const match of text.matchAll(nameFound)) found.push([match.index ?? 0, canonical(match[1])]);
  for (const match of text.matchAll(labelFound)) found.push([match.index ?? 0, canonical(match[1] ?? match[2])]);
  return [...new Set(found.sort((left, right) => Number(left[0]) - Number(right[0])).map(([, word]) => String(word)))];
}
