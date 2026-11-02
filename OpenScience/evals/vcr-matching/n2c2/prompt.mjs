/**
 * The model's instructions for one patient: the matching skill's own rules, quoted from the shipping file when the run starts,
 * and the thirteen criteria in the guide's words.
 *
 * Nothing the skill says about reading a note is paraphrased here. Three stretches of `capabilities/vcr-matching/SKILL.md` are
 * cut out of the file by their opening and closing words and placed in the prompt unchanged:
 *
 * - the paragraphs that keep "does it apply / is the fact recorded / does it satisfy" apart and say what a fact may claim;
 * - the fact-writing section (fields, polarity, value and unit, dates, the verbatim quotation);
 * - the language-judgment section (three states, a quotation for any answer but unknown).
 *
 * If the skill is edited so that an opening or closing phrase is gone, the cut fails by name instead of silently measuring a
 * different prompt, and the freeze digest of the skill file changes, which the run refuses to ignore.
 *
 * What is the harness's own is small and is only form: that there are no tools in this evaluation so the answer is one JSON
 * object, the shape of that object, the guide's two rules about "now" and carrying a status forward, and how a quotation survives
 * the file's hard wrapping. The rules about units and dates are the skill's (a second measurement, with the skill that teaches them
 * in its own words). Tuning is allowed to change the form of the prompt and nothing else.
 *
 * @module n2c2/prompt
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LANGUAGE_CRITERIA, VARIABLES, variablesOf, languageKeysOf } from './criteria.mjs';
import { sha256 } from './data.mjs';

export const SKILL_PATH = path.resolve(import.meta.dirname, '../../../capabilities/vcr-matching/SKILL.md');

/** Each stretch: where it opens (included) and where the next thing begins (excluded). */
const STRETCHES = Object.freeze([
  { name: 'evidence-decisions', from: 'Keep three questions separate for every criterion', to: 'Do not mark a person eligible while your own explanation' },
  { name: 'writing-a-fact', from: '每个事实用 `mcp__evimed__vcr_write` `what: "fact"` 写', to: '## 三、只回答需要语言的条件' },
  { name: 'language-judgment', from: '用 `what: "language_judgment"` 回答', to: '## 四、交给评估器，读回结果' },
]);

/**
 * @param {string} skill the text of SKILL.md
 * @returns {Array<{ name: string, text: string }>}
 */
export function skillExcerpts(skill) {
  return STRETCHES.map(({ name, from, to }) => {
    const start = skill.indexOf(from);
    const end = start < 0 ? -1 : skill.indexOf(to, start + from.length);
    if (start < 0 || end < 0) throw new Error(`The matching skill no longer holds the "${name}" stretch between "${from.slice(0, 40)}" and "${to.slice(0, 40)}": read the skill again before measuring it.`);
    return { name, text: skill.slice(start, end).trim() };
  });
}

/** @param {string} [skillPath] */
export async function readSkill(skillPath = SKILL_PATH) {
  const text = await readFile(skillPath, 'utf8');
  return { text, sha256: sha256(text), excerpts: skillExcerpts(text) };
}

const ANSWER_SHAPE = `{
  "facts": [
    { "variable": "<one of the fact variables>", "polarity": "affirmed | negated | hypothetical | family",
      "value": <a number printed in the quotation, only for a numeric fact>, "unit": "<as the note prints it>",
      "occurredAt": "YYYY-MM-DD, only when a date printed whole, with its year, is in the quotation or in dateQuote", "dateSurface": "<the date as printed>",
      "dateQuote": "<a second verbatim line of the file that prints that date, when the quotation does not>",
      "surface": "<the words you read, inside the quotation>", "quote": "<verbatim from the note>" }
  ],
  "language_judgments": [
    { "criterionKey": "<one of the language criteria>", "state": "satisfied | not_satisfied | unknown",
      "evidence": [ { "quote": "<verbatim from the note>" } ] }
  ]
}`;

/**
 * The system prompt for one patient file, from the shipping skill's text.
 * @param {{ excerpts: ReadonlyArray<{ name: string, text: string }> }} skill
 */
export function systemPrompt(skill) {
  const fact = variablesOf().map((variable) => `- ${variable}: ${VARIABLES[variable]}`).join('\n');
  const language = languageKeysOf().map((key) => `- ${key}: ${LANGUAGE_CRITERIA[key]}`).join('\n');
  return [
    'This is the evidence-reading step of a matching workflow. One patient\'s file is below; you decide nothing about eligibility: you write the facts the criteria need, each with a verbatim quotation from the file, and you answer the language criteria. The platform re-reads every quotation in the file and computes every verdict itself.',
    'There are no tools in this evaluation, so the tool calls the skill names are replaced by one JSON answer (its shape is at the end). The skill follows, quoted from the product\'s own file.',
    '=== SKILL (quoted unchanged) ===',
    ...skill.excerpts.map((excerpt) => excerpt.text),
    '=== END OF SKILL ===',
    'The criteria are the annotation guide\'s wording. Write a fact only for a variable below, using the variable name exactly; answer a language criterion by its key.',
    `Fact variables:\n${fact}`,
    `Language criteria (answer with a state and, for satisfied or not_satisfied, a quotation that supports it):\n${language}`,
    'The file holds several dated records of one patient, oldest first, each opening with a "Record date:" line. The most recent record is "now", whatever its calendar date; the earlier records are read as of that moment. Assume the patient\'s status does not change between records until a later record indicates it.',
    'The file is hard-wrapped at about seventy characters, so a sentence often continues on the next line. Write a fact for each place the file supports one; do not write a fact for a variable the file does not mention.',
    'How a fact is written so that the platform can re-read it. The quotation (and dateQuote) is copied exactly from the file, character for character, from within one line: do not run it across a line break (and in JSON a line break inside a string is written \\n, never typed). The surface is a stretch of the quotation itself, copied exactly, with the same letters and case.',
    `Answer with one JSON object and nothing else, in this shape (an empty list where there is nothing to write):\n${ANSWER_SHAPE}`,
  ].join('\n\n');
}

/**
 * The user message: the evaluation date and the file, as it is.
 * @param {{ text: string, asOf: string | null }} patient
 */
export function userMessage(patient) {
  return `Now (the date of the most recent record): ${patient.asOf ?? 'not stated'}\n\n=== PATIENT FILE ===\n${patient.text}\n=== END OF PATIENT FILE ===`;
}

/** A digest of the instructions that does not depend on any patient: the system prompt is the same for every file. @param {Parameters<typeof systemPrompt>[0]} skill */
export function promptDigest(skill) {
  return sha256(systemPrompt(skill));
}
