// Opt-in November 17 extraction candidate. Production sources remain the baseline.
// Apply only changed rules to those sources; fail if an anchor drifts. Do not make
// this variant the default before comparing attribution on the same sessions.
import { MEMORY_PROFILE_HEADING_RULE } from '../../../../packages/domain/src/memoryProfile.mjs';

export const HISTORY_RULE = 'When a value changes, keep the current value plus one bullet for the earlier value: "曾为：<earlier value>（截至 YYYY-MM-DD）" in Chinese, otherwise "earlier: <earlier value> (until YYYY-MM-DD)", ending with the stated date of the change (or the source date labelled as when it was said); if neither is known, label the date unknown, never invent one. Keep the current value first. At most the two latest earlier values per item; none for a value removed by a forget request.';

const HISTORY_TYPES = new Set(["decisions.yaml", "entities.yaml", "follow_ups.yaml", "notes.yaml", "people.yaml", "preferences.yaml", "profile.yaml", "project_context.yaml", "project_facts.yaml"]);
const PASSING_TYPES = new Set(["notes.yaml", "people.yaml", "profile.yaml", "project_context.yaml"]);
const HISTORY_FENCE = "  __HISTORY__\n\n  A forget request is not a new fact or event: do not add a note that restates the withdrawn\n  content or names it as deleted, including when the user refers to it only by a label.\n\n";
const PROFILE_ADDRESS_RULE = `The H1 holds the user's stated name. A request about how to address them ("以后叫我小林", "Call me Jo")
updates only the separate dated bullet "希望被称呼为：小林" or "Preferred form of address: Jo", in the user's language.
Keep the existing name in the H1 unless the user explicitly corrects or changes their name.
For example, keep "# 林舟" and add "- 希望被称呼为：小林 (as of 2026-11-21)". If only an address preference
is known, use the fallback H1 and the separate bullet. Do not duplicate the name as a bullet.`;
const PASSING_DETAIL = "  Keep a concrete number, model name, cost, household detail or project status the user states\n  about their own life or work even in passing: one concise dated line in the matching file.\n  Keep their corrections and explicit confirmation of a suggestion or document fact, with its\n  origin in the wording. An assistant suggestion or a document claim alone is not a first-person\n  fact, preference or project state; it remains in the source conversation. A user opinion stays\n  labelled \"User believes:\" in NOTES, never promoted to a rule or objective project stage.\n\n";

// Check authorship during extraction; recording an evidence quote on each line could
// itself restate withdrawn material.
const AUTHORSHIP_RULE = "Before adding or updating any line, identify the exact words in a user message that support each clause. The words must be the user's own statement or explicit adoption of that specific content. A pasted passage inside a user message is still material. An assistant's recollection, suggestion, or example is never evidence of a user's rule. Leave unadopted suggestions and unconfirmed material in the source conversation only, including for NOTES. Check earlier values against their original user evidence or an existing dated user statement. Never reconstruct a forgotten value.";

/** @param {string} source */
export function nextDecision(source) {
  return source.split('\n').map(line => {
    if (line.startsWith('Preserve origin and certainty.')) return AUTHORSHIP_RULE + ' Attribute opinions to the user as beliefs. Memory is context, not permission to act.';
    if (line.startsWith('One-request conditions,')) return 'For an import, preserve only statements the user specifically confirms. A request to edit, summarize or import a document does not adopt the claims inside it.';
    return line;
  }).join('\n');
}

const REPLACEMENTS = {
  "notes.yaml": [
    ["Distinguish user statements, user beliefs, assistant suggestions and document claims. A useful\n  unconfirmed suggestion is not an adopted decision; a sourced claim is not an established fact.", "Use NOTES for the user's own statements and attributed beliefs. Leave unadopted suggestions and material in the conversation."],
  ],
  "entities.yaml": [
    ["A question alone does not establish a fact, but useful claims about an entity from documents\n  or the assistant may be retained with explicit attribution, without treating them as true.", "Keep only the user's own statements about this entity. Verify attribution before adding a field."],
  ],
  "decisions.yaml": [
    [" Useful suggestions or open options\n  may be retained in NOTES, attributed as \"assistant suggested\", without claiming a decision.", ""],
  ],
  "profile.yaml": [
    ["Useful attributed suggestions, opinions, document claims or\n    time-limited context", "User-stated opinions or\n    time-limited context"],
    [
      "  3. For a changed state (role, employer, field of work, education), replace the old bullet\n     with the latest stated value; keep dated prior states in NOTES or the person's history. A role or line of work\n",
      "  3. For a changed state (role, employer, field of work, education), write the latest stated value first and retain bounded dated earlier values in this same file. A role or line of work\n"
    ],
    [
      "  - One H1 heading with the name the user gave for themselves, or the word for \"user\" in {{ language }}\n    (用户 in Chinese) when they gave none, followed directly by bullet statements. No H2/H3 headings, tables, JSON or paragraphs.\n  - Every bullet ends with the date the user most recently stated or confirmed it, in the\n",
      "  __PROFILE_HEADING__\n  __PROFILE_ADDRESS__\n  - Every current bullet ends with the date the user most recently stated or confirmed it, in the\n"
    ],
    [
      "      # <name the user gave, or the word for \"user\" in {{ language }}>\n",
      "      # <name the user gave, or the exact fallback heading specified above>\n"
    ],
    [
      "      No other headings, labels, tables or prose. Preserve untouched valid bullets and their\n      dates; replace a changed state with its latest confirmed value.\n",
      "      No other headings, tables or prose. Use the address label specified above for that preference and 曾为 / earlier\n      for earlier values. Preserve untouched valid bullets and their dates; a changed state gets its latest\n      confirmed value plus its earlier-value bullet.\n"
    ]
  ],
  "project_context.yaml": [
    ["Retain useful sourced details or suggestions with attribution in NOTES.", "Leave unconfirmed suggestions and material in the conversation."],
    [
      "    decision replaces its line. A budget, a date or a standard is a limit, not a choice: it\n",
      "    decision keeps the new choice first and its dated earlier value below. A budget, a date or a standard is a limit, not a choice: it\n"
    ],
    [
      "    their side. Remove an item once the user says it is done. A due date is not a stage.\n",
      "    their side. A completed item becomes a dated completed state, with bounded earlier history. A due date is not a stage.\n    An opinion about difficulty is not a stage. Never invent a stage to fill this optional section;\n    retain an opinion in NOTES with the label \"User believes:\". A status change the user states\n    in passing or in a subordinate clause still updates this project, even when the main request is unrelated.\n"
    ]
  ],
  "observations.yaml": [
    [
      "  One file per choice, named by the kind of task and the choice.",
      `  A standalone request about the length, tone, format or language of this reply is an
  observation even when the user names no task or document and there is no earlier draft.
  For this case, use one bullet per independent user request in the same topic file,
  including a later request in the same conversation. Copy just the complete request
  verbatim as choice. For example, if the user says “Keep it brief.”, the whole bullet is
  - Choice: {"kind":"length","scope":"reply","choice":"Keep it brief.","subject":"work"}
  Use length for brevity, form for tone, format for language or layout. Use the fixed
  scope reply only for an unqualified reply request. Keep an explicitly named task or
  document scope. Count only the user's own requests, never assistant echoes or material.
  A repeated request about this answer still has that scope. An explicit future default
  or standing choice goes directly to PREFERENCES, even on its first occurrence.
  For other choices, use one file per choice, named by the kind of task and the choice.`
    ],
    [
      "      Markdown bullets, one per conversation that showed the choice, oldest first: the choice and",
      "      For a standalone reply request, append its exact Choice bullet as specified above for each independent request.\n      For other observations, write Markdown bullets, one per conversation that showed the choice, oldest first: the choice and"
    ]
  ],
  "preferences.yaml": [
    [
      "  Keep, one topic per file:",
      `  Keep the user's own explicit ongoing presentation requirements on first mention,
  including a terse request for a default length, tone, format or language. Preserve the
  named deliverable and each requested dimension when one request combines several.
  A bare request for a shorter
  answer with no standing scope belongs in OBSERVATIONS even when it stands alone.
  Keep, one topic per file:`
    ],
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
    [" Useful\n  suggestions may be retained separately in NOTES as \"assistant suggested\".", ""],
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
    .replace('__PROFILE_HEADING__', () => indent(MEMORY_PROFILE_HEADING_RULE))
    .replace('__PROFILE_ADDRESS__', () => indent(PROFILE_ADDRESS_RULE));
}
