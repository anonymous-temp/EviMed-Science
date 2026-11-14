// Exact source replacements remove contradictory default rules only in the opt-in render.
// A changed source fails loudly rather than silently shipping both instructions.
const REPLACEMENTS = {
  'profile.yaml': [
    ['replace the old bullet\n     with the latest stated value; keep dated prior states in NOTES or the person\'s history.', 'write the latest stated value first and keep each dated earlier value in this same profile.'],
    ['Every bullet ends with the date', 'Every current bullet ends with the date'],
    ['No other headings, labels, tables or prose.', 'No other headings, tables or prose; earlier / 曾为 labels identify history bullets.'],
    ['dates; replace a changed state with its latest confirmed value.', 'dates; keep the latest confirmed value first and every distinct earlier value with its until date.'],
  ],
  'preferences.yaml': [
    ['existing file so that it states only the current choice.', 'existing file with the current choice first, then each dated earlier choice in the same file.'],
    ['No dates, events or plans.', 'A preference may carry its stated date; retain dated earlier choices, clearly labelled as history.'],
  ],
  'observations.yaml': [
    ['in a few words, with no name, no number and\n  nothing of the work\'s content', 'in a few words, keeping exactly the name or number with units that IS the choice,\n  without unrelated work content'],
    ['No names, numbers or content of the work.', 'Keep names, numbers and units that define the choice exactly; omit unrelated content of the work.'],
  ],
  'project_context.yaml': [
    ['decision replaces its line.', 'decision becomes the current line followed by its dated earlier value in this section.'],
    ['Remove an item once the user says it is done.', 'When the user says an item is done, write that current state and keep the dated earlier state in this section.'],
  ],
  'entities.yaml': [
    ["Entity name in the user's words. If English, use lowercase with underscores, max 3 words.", "Entity name copied exactly in the user's words, including model numbers and identifiers."],
    ['claims about an entity from documents\n  or the assistant may be retained with explicit attribution, without treating them as true.', 'claims about an entity from documents\n  or the assistant are kept, labelled, in NOTES, without treating them as true.'],
    ['existing fact that is not contradicted and deduplicate paraphrases.', 'current fact plus each dated earlier value in the same card; deduplicate unchanged confirmations.'],
  ],
};

/** @param {string} name @param {string} source */
export function extractionV2Source(name, source) {
  let text = source;
  for (const [before, after] of /** @type {Record<string, string[][]>} */ (REPLACEMENTS)[name] ?? []) {
    if (!text.includes(before)) throw new Error(`extraction-v2 source rule changed: ${name}: ${before}`);
    text = text.replace(before, () => after);
  }
  return text;
}
