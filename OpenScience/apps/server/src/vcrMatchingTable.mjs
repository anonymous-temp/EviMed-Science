/**
 * Matching from the data plane's subject table: each row a candidate, the
 * criteria judged against the columns the field map and the dictionary describe.
 *
 * Hidden knowledge:
 *
 * - **A study that arrived as one cohort table had no candidates.** Matching
 *   looked for candidates only among per-person documents and the facts a run
 *   wrote about them, so a study whose T1 intake converted an uploaded cohort
 *   table into the module's subject and events tables ran `vcr-matching` on zero
 *   subjects. The table already says who the people are (`USUBJID`, the study's
 *   pseudonym) and what is known about each; this turns that into the facts the
 *   one evaluator already reads, so there is one three-valued logic and not a
 *   second one for tables.
 * - **The engine has no method that does this, and the control plane does not
 *   need one.** `cohort.build` takes a subject table by location and hash, but it
 *   answers with counts and the ids it kept — no verdict per criterion per
 *   person, no units, no windows, no applicability — and `matching.evaluate`
 *   takes verdicts already made. Eligibility is logic, not statistics, and it is
 *   this module's evaluator (`vcrMatching.mjs`) that already runs it for every
 *   other source of facts: the numbers of a funnel are tallies of those verdicts.
 * - **A criterion the table cannot decide is `unknown`, by construction.** A
 *   variable maps to a column only by an exact name — the column's alias, the
 *   concept the field map gave it, or the concept the model recorded for it in the
 *   dataset's meaning (`vcrTableMeaning.mjs`) — and a variable no column answers
 *   to, or two columns answer to, produces no fact: the evaluator reads silence as
 *   `not_recorded`. A column with no unit cannot be compared to a criterion that
 *   names one (`unit_missing`), and a cell with no date cannot answer a window
 *   (`undated`).
 * - **A filled cell is not an affirmation.** `0`, `No`, `否`, `无` and `false` are
 *   filled cells that say the event did not happen, and a table is the one source
 *   in which a column of them is the usual way to record a history. What a code
 *   MEANS is language, so it is the model's to say and the dataset's to remember
 *   (`valueMap`, basis `model_inferred` until the researcher corrects it); this
 *   module only applies it, exactly, cell by cell. A cell carries its reading as
 *   `presence` — `present`, `absent`, or `unknown` — beside the value, because the
 *   same fact serves a comparison (`ecog <= 1` reads the number and never asks what
 *   0 means) and a presence question (`present diabetes` reads the map). Only
 *   format is read without the map: a real date in a date column is the event's
 *   date, a number in a column the model called a measurement is the measurement
 *   being there. Every other code the map does not name is `unknown`, which the
 *   evaluator answers `coding_unmapped` and never `satisfied` or `not_satisfied`.
 * - **The cells are read to judge and are never written down.** The facts live
 *   for the length of one evaluation, in memory; what is stored afterwards is the
 *   verdicts (`matching_assessments`, keyed by the pseudonym), and the evidence
 *   of a verdict names the column, not the value (`hideValue`), so a member who
 *   may see a candidate's states may not read their age off the page.
 *
 * @module vcrMatchingTable
 */

/** The columns' standing names for one variable, tried in order of how explicit they are. */
const NAME_ORDER = Object.freeze(["name", "concept", "source"]);
/** Names that mean one variable. */
const SYNONYMS = Object.freeze(/** @type {Record<string, readonly string[]>} */ ({ sex: ["sex", "gender"], gender: ["sex", "gender"] }));

/** A name as a comparable token. @param {unknown} value */
const token = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s_\-./]+/g, "");

/**
 * Every variable a criterion's requirement (and its applicability) asks a fact
 * about. A `language` node asks a model, never the table.
 * @param {readonly any[]} criteria @returns {string[]}
 */
export function matchingVariablesOf(criteria) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (["compare", "present", "absent", "elapsed_since"].includes(String(node.op)) && typeof node.variable === "string" && node.variable) found.add(node.variable);
    for (const child of Array.isArray(node.operands) ? node.operands : []) walk(child);
    if (node.operand) walk(node.operand);
  };
  for (const criterion of criteria ?? []) { walk(criterion?.requirement); walk(criterion?.applicability); }
  return [...found].sort();
}

/**
 * The column a variable is asked of: the one whose alias, else whose concept,
 * else whose source column name is that variable. Two columns at the same level
 * are an ambiguity and answer nothing.
 * @param {string} variable
 * @param {readonly { name: string, concept?: string, source?: string }[]} columns
 * @returns {{ column: any | null, ambiguous: boolean }}
 */
export function columnForVariable(variable, columns) {
  const wanted = new Set([token(variable), ...(SYNONYMS[variable] ?? []).map(token)]);
  for (const field of NAME_ORDER) {
    const hits = columns.filter((column) => wanted.has(token(/** @type {any} */ (column)[field])) && token(/** @type {any} */ (column)[field]) !== "");
    if (hits.length === 1) return { column: hits[0], ambiguous: false };
    if (hits.length > 1) return { column: null, ambiguous: true };
  }
  return { column: null, ambiguous: false };
}

/** @param {string} cell @returns {string | null} an ISO instant, when the cell is a date */
function isoOf(cell) {
  const parsed = Date.parse(cell);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * What the dataset's recorded meaning says about the columns of a table: the variable a column answers to and what each of its
 * codes means (`vcrTableMeaning.mjs` reads it from the dataset-semantics asset).
 * @typedef {{ columns: Record<string, { concept?: string, valueMap?: { values: Record<string, string>, measurement: boolean } }> }} TableMeaning
 */

/**
 * The columns as the mapping reads them: a column the field map gave no concept takes the one the meaning recorded. The field map's
 * word stands where it has one.
 * @template {{ name: string, concept?: string }} C
 * @param {readonly C[]} columns @param {TableMeaning | null | undefined} meaning @returns {C[]}
 */
export function columnsWithMeaning(columns, meaning) {
  return columns.map((column) => {
    const recorded = meaning?.columns?.[column.name]?.concept;
    return column.concept || !recorded ? column : { ...column, concept: recorded };
  });
}

/**
 * Whether one filled cell says the event its column records is there, by the column's recorded value map. A real date in a date
 * column is the event's date, and a number in a column the model called a measurement is the measurement being there: those are format.
 * Every other code is read through the map and, when the map does not name it, is `unknown` — never taken for `present`.
 * @param {string} cell @param {{ type?: string | null }} column @param {{ values: Record<string, string>, measurement: boolean } | null | undefined} valueMap
 * @returns {"present" | "absent" | "unknown"}
 */
export function cellPresence(cell, column, valueMap) {
  if (column.type === "date") return isoOf(cell) ? "present" : "unknown";
  const named = valueMap && Object.hasOwn(valueMap.values, cell) ? valueMap.values[cell] : null;
  if (named === "present" || named === "absent" || named === "unknown") return named;
  return valueMap?.measurement === true && Number.isFinite(Number(cell)) ? "present" : "unknown";
}

/**
 * The facts of every row of a subject table, for the variables the criteria ask.
 *
 * @param {{ header: readonly string[], rows: readonly (readonly string[])[], snapshotId: string,
 *   columns: readonly { name: string, source?: string, concept?: string, unit?: string | null, type?: string | null }[],
 *   variables: readonly string[], subjectColumn?: string, limit?: number, meaning?: TableMeaning | null }} input
 *   `columns` describe the table's columns: its own name (the alias), the source column it came from, the concept
 *   and unit the field map or the dictionary gave it, and the declared type. `meaning` is what the dataset recorded about
 *   them; without it a code is `unknown` for a presence question and every comparison reads as it always did.
 * @returns {{ subjects: { subjectKey: string, facts: any[] }[], mapped: { variable: string, column: string }[],
 *   unmapped: string[], ambiguous: string[], rows: number, notEvaluated: number }}
 */
export function subjectTableFacts({ header, rows, snapshotId, columns, variables, subjectColumn = "USUBJID", limit = Number.POSITIVE_INFINITY, meaning = null }) {
  const keyAt = header.indexOf(subjectColumn);
  const present = columnsWithMeaning(columns.filter((column) => header.includes(column.name)), meaning);
  /** @type {{ variable: string, column: any, at: number }[]} */
  const mapped = [];
  /** @type {string[]} */
  const unmapped = [];
  /** @type {string[]} */
  const ambiguous = [];
  for (const variable of variables) {
    const { column, ambiguous: many } = columnForVariable(variable, present);
    if (column) mapped.push({ variable, column, at: header.indexOf(column.name) });
    else (many ? ambiguous : unmapped).push(variable);
  }
  if (keyAt < 0) return { subjects: [], mapped: [], unmapped: [...variables], ambiguous: [], rows: rows.length, notEvaluated: rows.length };

  /** @type {{ subjectKey: string, facts: any[] }[]} */
  const subjects = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows) {
    const subjectKey = String(row[keyAt] ?? "").trim();
    // A row with no key, or a key seen before, is not a second person: the derivation refuses duplicates, and a table that
    // reaches here with one is counted as not evaluated rather than judged twice.
    if (!subjectKey || seen.has(subjectKey)) { skipped += 1; continue; }
    if (subjects.length >= limit) { skipped += 1; continue; }
    seen.add(subjectKey);
    /** @type {any[]} */
    const facts = [];
    for (const { variable, column, at } of mapped) {
      const cell = String(row[at] ?? "").trim();
      if (!cell) continue;
      const numeric = ["integer", "number"].includes(String(column.type ?? "")) && Number.isFinite(Number(cell));
      const occurredAt = column.type === "date" ? isoOf(cell) : null;
      facts.push({
        id: `tbl:${snapshotId}:${subjectKey}:${variable}`, subjectKey, variable, value: numeric ? Number(cell) : cell,
        // A filled cell is a value, and says nothing yet about the event: `presence` is what the column's meaning reads from it.
        unit: column.unit ? String(column.unit) : null, polarity: "affirmed", presence: cellPresence(cell, column, meaning?.columns?.[column.name]?.valueMap),
        occurredAt, recordedAt: null, visibleAt: null,
        surface: "", source: null, extractedBy: "code", snapshot: { id: snapshotId, field: column.name }, hideValue: true,
      });
    }
    subjects.push({ subjectKey, facts });
  }
  return { subjects, mapped: mapped.map(({ variable, column }) => ({ variable, column: column.name })), unmapped, ambiguous, rows: rows.length, notEvaluated: skipped };
}
