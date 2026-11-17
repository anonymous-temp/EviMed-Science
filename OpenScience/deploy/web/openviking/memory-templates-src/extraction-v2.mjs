// The optional extraction-v2 variant keeps the machine-readable choice and alias formats.
// Bounded dated history moved into the default templates on 2026-11-17 after the recorded
// write-class audit. This module still owns its shared wording so both renders agree.

/** The changed-value rule, shared by all default state-holding types. The
 * wrappers are the ones `memoryHistoryLine` (`@evimed/domain`) reads as history: Chinese `曾为：`, every other language `earlier:`. */
export const HISTORY_RULE = 'When a value changes, keep the current value plus one bullet for the earlier value: "曾为：<earlier value>（截至 YYYY-MM-DD）" in Chinese, otherwise "earlier: <earlier value> (until YYYY-MM-DD)", ending with the stated date of the change (or the source date labelled as when it was said); if neither is known, label the date unknown, never invent one. Keep the current value first. At most the two latest earlier values per item; none for a value removed by a forget request.';

/** The opinion rule, at its point of use in NOTES. */
export const OPINION_RULE = 'A view the user voices ("我觉得/我认为…") is a line starting "用户认为：" ("User believes:" in English) with its date, never a preference rule, decision, project-card line or writing rule.';

/** The unadopted-suggestion rule, at its point of use in NOTES. */
export const SUGGESTION_RULE = 'An actionable assistant recommendation the user did not take up is a line starting "助手建议（用户未采用）：" ("Assistant suggested (not adopted):") with its date, at most two per conversation, never a preference or decision until the user adopts it in words; explanations, glosses and restatements are not kept.';

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

// History is now in the default sources. Only the optional machine-readable induction
// and alias formats, plus explicit note labels, remain specific to this variant.
const REPLACEMENTS = {
  'preferences.yaml': [
    ['Useful limited-scope context and attributed opinions belong in NOTES.',
      'Useful limited-scope context and attributed opinions belong in NOTES. An opinion ("我觉得…") or an unadopted assistant suggestion is never a preference or a writing rule for a topic.'],
    ['\n  __NEVER_KEEP__', `\n${indentedBlock(STATED_CHOICE_RULE)}\n\n  __NEVER_KEEP__`],
  ],
  'decisions.yaml': [['assistant made, and never an option still under discussion.',
    'assistant made, never a view the user voices (NOTES, "用户认为："), and never an option still under discussion.']],
  'project_context.yaml': [['Retain useful sourced details or suggestions with attribution in NOTES.',
    'Retain useful sourced details or suggestions with attribution in NOTES; a view the user voices goes to NOTES ("用户认为："), never onto the card.']],
  'corrections.yaml': [['\n  __NEVER_KEEP__', `\n${indentedBlock(STATED_CHOICE_RULE)}\n\n  __NEVER_KEEP__`]],
  'observations.yaml': [['\n  __NEVER_KEEP__', `\n${indentedBlock(OBSERVATION_CHOICE_RULE)}\n\n  __NEVER_KEEP__`]],
  'people.yaml': [['\n  __NEVER_KEEP__', `\n${indentedBlock(ALIAS_RULE)}\n\n  __NEVER_KEEP__`]],
  'notes.yaml': [['\n  __NEVER_KEEP__', `\n${indentedBlock(OPINION_RULE)}\n${indentedBlock(SUGGESTION_RULE)}\n\n  __NEVER_KEEP__`]],
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
