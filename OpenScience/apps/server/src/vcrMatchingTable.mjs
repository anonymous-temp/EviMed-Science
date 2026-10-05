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
 *   variable maps to a column only by an exact name — the column's alias or the
 *   concept the field map gave it — and a variable no column answers to, or two
 *   columns answer to, produces no fact: the evaluator reads silence as
 *   `not_recorded`. A column with no unit cannot be compared to a criterion that
 *   names one (`unit_missing`), and a cell with no date cannot answer a window
 *   (`undated`). Nothing here guesses a mapping to make a criterion decidable.
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
 * The facts of every row of a subject table, for the variables the criteria ask.
 *
 * @param {{ header: readonly string[], rows: readonly (readonly string[])[], snapshotId: string,
 *   columns: readonly { name: string, source?: string, concept?: string, unit?: string | null, type?: string | null }[],
 *   variables: readonly string[], subjectColumn?: string, limit?: number }} input
 *   `columns` describe the table's columns: its own name (the alias), the source column it came from, the concept
 *   and unit the field map or the dictionary gave it, and the declared type.
 * @returns {{ subjects: { subjectKey: string, facts: any[] }[], mapped: { variable: string, column: string }[],
 *   unmapped: string[], ambiguous: string[], rows: number, notEvaluated: number }}
 */
export function subjectTableFacts({ header, rows, snapshotId, columns, variables, subjectColumn = "USUBJID", limit = Number.POSITIVE_INFINITY }) {
  const keyAt = header.indexOf(subjectColumn);
  const present = columns.filter((column) => header.includes(column.name));
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
        unit: column.unit ? String(column.unit) : null, polarity: "affirmed", occurredAt, recordedAt: null, visibleAt: null,
        surface: "", source: null, extractedBy: "code", snapshot: { id: snapshotId, field: column.name }, hideValue: true,
      });
    }
    subjects.push({ subjectKey, facts });
  }
  return { subjects, mapped: mapped.map(({ variable, column }) => ({ variable, column: column.name })), unmapped, ambiguous, rows: rows.length, notEvaluated: skipped };
}
