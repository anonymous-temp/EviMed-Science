// The opt-in extraction-v2 render ("v2.1", 2026-11-14): the default type sources plus a few exact additions. A comparison of the
// earlier, broader v2 against the default on planted items (17 items, two users) kept dated earlier values but moved labelled
// opinions and assistant suggestions out of NOTES into unlabelled preference rules, so this variant adds only: one dated line per
// earlier value in profile, preferences, project cards and entities; fixed labels for user opinions and unadopted assistant
// suggestions in NOTES, with the types they must never become saying so; and two shared sentences (asides, exactness) carried by
// `MEMORY_DECIDE_EXTRACTION_V2_TEXT`. Replacements are exact: a changed source fails loudly rather than shipping both instructions.

/** The changed-value rule, written into the four types whose default text told the model to replace or drop an earlier value. The
 * wrappers are the ones `memoryHistoryLine` (`@evimed/domain`) reads as history: Chinese `曾为：`, every other language `earlier:`. */
export const HISTORY_RULE = 'When a new value replaces an earlier one, keep the current value and add one bullet for the earlier value: "曾为：<earlier value>（截至 YYYY-MM-DD）" in Chinese, otherwise "earlier: <earlier value> (until YYYY-MM-DD)", ending with the date of the change. Keep at most the two most recent earlier values per item, and none for a value removed by a forget request.';

/** The opinion rule, at its point of use in NOTES. */
export const OPINION_RULE = 'A view the user voices ("我觉得/我认为…") is a line starting "用户认为：" ("User believes:" in English) with its date, never a preference rule, decision, project-card line or writing rule.';

/** The unadopted-suggestion rule, at its point of use in NOTES. */
export const SUGGESTION_RULE = 'An actionable assistant recommendation the user did not take up is a line starting "助手建议（用户未采纳）：" ("Assistant suggested (not adopted):") with its date, at most two per conversation, never a preference or decision until the user adopts it in words; explanations, glosses and restatements are not kept.';

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
      'Useful limited-scope context and attributed opinions belong in NOTES. A view the user voices ("我觉得…") and an assistant suggestion the user did not adopt in words are never a preference or a writing rule for a topic: they go to NOTES.'],
    ['No dates, events or plans.', 'No dates (except on an earlier-value bullet), events or plans.'],
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
