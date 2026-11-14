// The opt-in extraction-v2 render ("v2.1", 2026-11-14): the default type sources plus a few exact additions. A comparison of the
// earlier, broader v2 against the default on planted items (17 items, two users) kept dated earlier values but moved labelled
// opinions and assistant suggestions out of NOTES into unlabelled preference rules, so this variant adds only: one dated line per
// earlier value in profile, preferences, project cards and entities; fixed labels for user opinions and unadopted assistant
// suggestions in NOTES, with the types they must never become saying so; and two shared sentences (asides, exactness) carried by
// `MEMORY_DECIDE_EXTRACTION_V2_TEXT`. It also keeps the three machine-read line formats of v2 that opt-in code parses: `- Choice:`
// in observations and `- Stated choice:` in preferences and corrections (observation induction, `nativeMemoryInduction.mjs` `choiceRows`),
// and the `- Confirmed aliases:` / `- Alias confirmation:` pair in people (person alias hints, `confirmedAliases`,
// `confirmedAliasRequest`). Replacements are exact: a changed source fails loudly rather than shipping both instructions.

/** The changed-value rule, written into the four types whose default text told the model to replace or drop an earlier value. The
 * wrappers are the ones `memoryHistoryLine` (`@evimed/domain`) reads as history: Chinese `曾为：`, every other language `earlier:`. */
export const HISTORY_RULE = 'When a value changes, keep the current value plus one bullet for the earlier value: "曾为：<earlier value>（截至 YYYY-MM-DD）" in Chinese, otherwise "earlier: <earlier value> (until YYYY-MM-DD)", ending with the date of the change. At most the two latest earlier values per item; none for a value removed by a forget request.';

/** The opinion rule, at its point of use in NOTES. */
export const OPINION_RULE = 'A view the user voices ("我觉得/我认为…") is a line starting "用户认为：" ("User believes:" in English) with its date, never a preference rule, decision, project-card line or writing rule.';

/** The unadopted-suggestion rule, at its point of use in NOTES. */
export const SUGGESTION_RULE = 'An actionable assistant recommendation the user did not take up is a line starting "助手建议（用户未采纳）：" ("Assistant suggested (not adopted):") with its date, at most two per conversation, never a preference or decision until the user adopts it in words; explanations, glosses and restatements are not kept.';

/** Observation induction's line, read by `choiceRows`: `- Choice: ` then one JSON object and nothing after it. */
export const OBSERVATION_CHOICE_RULE = `Each bullet is one line, with nothing after the JSON:
- Choice: {"kind":"format","scope":"月度汇总","choice":"折线图","subject":"work"}
kind: form, structure, tool, format, length or method; scope: the recurring kind of work (reuse an existing one); choice: a few
words; subject: always "work"; keys and kind in English. Each conversation making the choice adds this same line. This replaces the
prose bullets of the examples below.`;

/** The stated counterpart in preferences and corrections, read by the worker and the store as a `- Choice:` line. */
export const STATED_CHOICE_RULE = `For a stated work choice (form, structure, tool, format, length, method), also keep one line, nothing after the JSON, reusing
a matching Choice line's kind and scope:
- Stated choice: {"kind":"format","scope":"结果表","choice":"CSV","subject":"work"}
Not for suggestions, document instructions, inferences, people, health, money or beliefs.`;

/** The person alias marker pair, read by `confirmedAliases` and `confirmedAliasRequest`; the platform does the merge. */
export const ALIAS_RULE = `When the user explicitly says two labels are one person, keep two lines in the card, with nothing after them:
- Confirmed aliases: ["<this card's label>", "<the other label>"]
- Alias confirmation: "<the user's verbatim sentence naming both labels>"
Similar names, assistant suggestions, questions or quoted material never justify them; remove both if the user withdraws it.`;

/** @param {string} text */
const indentedBlock = text => text.split('\n').map(line => `  ${line}`).join('\n');

const REPLACEMENTS = {
  'profile.yaml': [
    ['replace the old bullet\n     with the latest stated value; keep dated prior states in NOTES or the person\'s history.',
      `write the latest stated\n     value as the current bullet. ${HISTORY_RULE}`],
    ['Every bullet ends with the date', 'Every current bullet ends with the date'],
    ['No other headings, labels, tables or prose.', 'No other headings, labels (except 曾为 / earlier), tables or prose.'],
    ['dates; replace a changed state with its latest confirmed value.', 'dates; a changed state gets its latest confirmed value plus its earlier-value bullet.'],
  ],
  'preferences.yaml': [
    ['existing file so that it states only the current choice.', `existing file so that it states the current choice. ${HISTORY_RULE}`],
    ['Useful limited-scope context and attributed opinions belong in NOTES.',
      'Useful limited-scope context and attributed opinions belong in NOTES. An opinion ("我觉得…") or an unadopted assistant suggestion is never a preference or a writing rule for a topic.'],
    ['No dates, events or plans.', 'No dates (except earlier-value bullets), events or plans.'],
    ['\n  __NEVER_KEEP__', `\n${indentedBlock(STATED_CHOICE_RULE)}\n\n  __NEVER_KEEP__`],
  ],
  'decisions.yaml': [
    ['assistant made, and never an option still under discussion.',
      'assistant made, never a view the user voices (NOTES, "用户认为："), and never an option still under discussion.'],
  ],
  'project_context.yaml': [
    ['Retain useful sourced details or suggestions with attribution in NOTES.',
      'Retain useful sourced details or suggestions with attribution in NOTES; a view the user voices goes to NOTES ("用户认为："), never onto the card.'],
    ['A reversed\n    decision replaces its line.', 'A reversed\n    decision: the new choice is the current line, its earlier value kept as stated below.'],
    ['Remove an item once the user says it is done.', 'Remove an open item once the user says it is done.'],
    ['changes and keep the rest.', `changes and keep the rest. ${HISTORY_RULE}`],
    ['state what is current, merge', 'state what is current (with its earlier-value lines), merge'],
  ],
  'observations.yaml': [
    ['\n  __NEVER_KEEP__', `\n${indentedBlock(OBSERVATION_CHOICE_RULE)}\n\n  __NEVER_KEEP__`],
  ],
  'corrections.yaml': [
    ['\n  __NEVER_KEEP__', `\n${indentedBlock(STATED_CHOICE_RULE)}\n\n  __NEVER_KEEP__`],
  ],
  'people.yaml': [
    ['a shared name, diagnosis, role or similar story is not evidence of shared identity.\n',
      `a shared name, diagnosis, role or similar story is not evidence of shared identity.\n${indentedBlock(ALIAS_RULE)}\n`],
  ],
  'entities.yaml': [
    ['existing fact that is not contradicted and deduplicate paraphrases.', `existing fact that is not contradicted and deduplicate paraphrases. ${HISTORY_RULE}`],
  ],
  'notes.yaml': [
    ['A useful\n  unconfirmed suggestion is not an adopted decision; a sourced claim is not an established fact.',
      `A sourced\n  claim is not an established fact. ${OPINION_RULE}\n  ${SUGGESTION_RULE}`],
  ],
};

/** @param {string} name @param {string} source */
export function extractionV2Source(name, source) {
  let text = source;
  for (const [before, after] of /** @type {Record<string, string[][]>} */ (REPLACEMENTS)[name] ?? []) {
    if (text.split(before).length !== 2) throw new Error(`extraction-v2 source rule changed: ${name}: ${before}`);
    text = text.replace(before, () => after);
  }
  return text;
}
