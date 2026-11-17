// Opt-in November 17 extraction candidate. Production sources remain the baseline.
// Apply only changed rules to those sources; fail if an anchor drifts. Do not make
// this variant the default before comparing attribution on the same sessions.
import { MEMORY_PROFILE_HEADING_RULE } from '../../../../packages/domain/src/memoryProfile.mjs';

export const HISTORY_RULE = 'When a value changes, keep the current value plus one bullet for the earlier value: "曾为：<earlier value>（截至 YYYY-MM-DD）" in Chinese, otherwise "earlier: <earlier value> (until YYYY-MM-DD)", ending with the stated date of the change (or the source date labelled as when it was said); if neither is known, label the date unknown, never invent one. Keep the current value first. At most the two latest earlier values per item; none for a value removed by a forget request.';

const HISTORY_TYPES = new Set(["decisions.yaml", "entities.yaml", "follow_ups.yaml", "notes.yaml", "people.yaml", "preferences.yaml", "profile.yaml", "project_context.yaml", "project_facts.yaml"]);
const PASSING_TYPES = new Set(["notes.yaml", "people.yaml", "profile.yaml", "project_context.yaml"]);
const HISTORY_FENCE = "  __HISTORY__\n\n  A forget request is not a new fact or event: do not add a note that restates the withdrawn\n  content or names it as deleted, including when the user refers to it only by a label.\n\n";
const PASSING_DETAIL = "  Keep a concrete number, model name, cost, household detail or project status the user states\n  about their own life or work even in passing: one concise dated line in the matching file.\n  Keep their corrections and explicit confirmation of a suggestion or document fact, with its\n  origin in the wording. An assistant suggestion or a document claim alone is not a first-person\n  fact, preference or project state; it remains in the source conversation. A user opinion stays\n  labelled \"User believes:\" in NOTES, never promoted to a rule or objective project stage.\n\n";

const REPLACEMENTS = {
  "profile.yaml": [
    [
      "  3. For a changed state (role, employer, field of work, education), replace the old bullet\n     with the latest stated value; keep dated prior states in NOTES or the person's history. A role or line of work\n",
      "  3. For a changed state (role, employer, field of work, education), write the latest stated value first and retain bounded dated earlier values in this same file. A role or line of work\n"
    ],
    [
      "  - One H1 heading with the name the user gave for themselves, or the word for \"user\" in {{ language }}\n    (用户 in Chinese) when they gave none, followed directly by bullet statements. No H2/H3 headings, tables, JSON or paragraphs.\n  - Every bullet ends with the date the user most recently stated or confirmed it, in the\n",
      "  __PROFILE_HEADING__\n  - Every current bullet ends with the date the user most recently stated or confirmed it, in the\n"
    ],
    [
      "      # <name the user gave, or the word for \"user\" in {{ language }}>\n",
      "      # <name the user gave, or the exact fallback heading specified above>\n"
    ],
    [
      "      No other headings, labels, tables or prose. Preserve untouched valid bullets and their\n      dates; replace a changed state with its latest confirmed value.\n",
      "      No other headings, labels (except 曾为 / earlier), tables or prose. Preserve untouched valid bullets and their\n      dates; a changed state gets its latest confirmed value plus its earlier-value bullet.\n"
    ]
  ],
  "project_context.yaml": [
    [
      "    decision replaces its line. A budget, a date or a standard is a limit, not a choice: it\n",
      "    decision keeps the new choice first and its dated earlier value below. A budget, a date or a standard is a limit, not a choice: it\n"
    ],
    [
      "    their side. Remove an item once the user says it is done. A due date is not a stage.\n",
      "    their side. A completed item becomes a dated completed state, with bounded earlier history. A due date is not a stage.\n    An opinion about difficulty is not a stage. Never invent a stage to fill this optional section;\n    retain an opinion in NOTES with the label \"User believes:\". A status change the user states\n    in passing or in a subordinate clause still updates this project, even when the main request is unrelated.\n"
    ]
  ],
  "preferences.yaml": [
    [
      "  A place names where something goes; it does not say that something always exists to put\n",
      "  Do not add an exception, permission to ask, or scope the user never stated.\n  A place names where something goes; it does not say that something always exists to put\n"
    ],
    [
      "  existing file so that it states only the current choice.\n",
      "  existing file so that it states the current choice first, followed by bounded dated earlier values.\n"
    ],
    [
      "      condition, exception or reason the user gave. No dates, events or plans.\n",
      "      condition, exception or reason the user gave. No dates (except earlier-value bullets), events or plans.\n"
    ]
  ],
  "follow_ups.yaml": [
    [
      "  One file per subject. When the user says an item is done or dropped, remove it; delete\n  the file when nothing in it is open.\n",
      "  One file per subject. When the user says an item is done or dropped, mark it completed or dropped\n  with the stated date; keep bounded earlier states, without presenting them as open.\n"
    ]
  ]
};

/** @param {string} name @param {string} source */
export function nextSource(name, source) {
  let text = source;
  for (const [before, after] of /** @type {Record<string, string[][]>} */ (REPLACEMENTS)[name] ?? []) {
    if (text.split(before).length !== 2) throw new Error(`next source rule changed: ${name}: ${before}`);
    text = text.replace(before, () => after);
  }
  if (HISTORY_TYPES.has(name)) text = text.replace('  __NEVER_KEEP__', () => `${HISTORY_FENCE}  __NEVER_KEEP__`);
  if (PASSING_TYPES.has(name)) text = text.replace('  __DECIDE__', () => `${PASSING_DETAIL}  __DECIDE__`);
  const indent = value => value.split('\n').join('\n  ');
  return text.replace('__HISTORY__', () => indent(HISTORY_RULE))
    .replace('__PROFILE_HEADING__', () => indent(MEMORY_PROFILE_HEADING_RULE));
}
