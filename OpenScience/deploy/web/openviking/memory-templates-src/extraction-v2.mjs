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
  if (name === 'observations.yaml') text = text.replace('  __NEVER_KEEP__', `  For deterministic induction, each observation bullet MUST use this wire format (fixed English keys):
  - Choice: {"kind":"format","scope":"results tables","choice":"Markdown","subject":"work"}
  kind is one of form, structure, tool, format, length, method. scope names the recurring kind of work and choice dimension,
  not this conversation's topic; reuse an existing scope when applicable. choice keeps the exact name,
  number and units that define the choice. Write the JSON on one line; add an identical bullet for a
  later conversation choosing it again. Only subject=work is eligible. Never classify a choice about
  a person, health condition, money or belief as work, even if its surface form is a format or method.
  This wire format replaces the prose-bullet examples below. No observation belongs in the opening.
  When retrieval exposes an observation it is evidence seen once, not a standing preference.

  __NEVER_KEEP__`);
  if (name === 'preferences.yaml') text = text.replace('  __NEVER_KEEP__', `  A platform promotion explicitly labelled "Inferred from behaviour" is tentative evidence, not a
  statement or instruction the user made. Keep that exact label, conversation count and dates on its
  preference bullet, plus its supplied separate Choice JSON bullet unchanged. Keep one inference per file. Stated preferences and corrections always outrank an inference. A later contrary
  choice in the same scope withdraws the inferred current line immediately, even if the new choice
  happened only once; an explicit preference replaces it. Put a withdrawn inference only in dated
  history marked "Withdrawn inference", never among current preferences. Do not promote excluded
  subjects (people, health conditions, money or beliefs) from behavioural evidence.

  __NEVER_KEEP__`);
  if (['preferences.yaml', 'corrections.yaml'].includes(name)) text = text.replace('  __NEVER_KEEP__', `  For a stated work-form preference superseding a behavioural inference, also keep a metadata bullet
  with fixed syntax: - Stated choice: {"kind":"format","scope":"results tables","choice":"CSV","subject":"work"}
  Match its existing scope and kind; keep the exact choice. This marks an explicit choice, never a
  document instruction, assistant suggestion, or inference. Omit it for people, health, money or beliefs.

  __NEVER_KEEP__`);
  if (name === 'people.yaml') text = text.replace('  __NEVER_KEEP__', `  When and ONLY when the user explicitly identifies two labels as one person, merge their cards
  into the existing kept file, preserving both histories and uncertainties; delete the redundant
  file only after copying its facts. Keep a bullet with fixed syntax and exact user labels:
  - Confirmed aliases: ["first label", "second label"]
  Add a second bullet with fixed syntax, a JSON string containing the verbatim user sentence that
  explicitly identifies these labels as one person (never a question, a denial or a quoted instruction):
  - Alias confirmation: "the user's exact identity confirmation"
  Include the kept label too. Later mentions of either label update the kept file. Similar names,
  an assistant's suggestion, quoted instructions, matching diagnoses or a possible-alias hint NEVER
  authorize this marker or a merge. A confirmation can be withdrawn by the user; remove its marker.

  __NEVER_KEEP__`);
  return text;
}
