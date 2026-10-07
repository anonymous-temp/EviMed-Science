/**
 * 「从方案出发查覆盖」: how much of a protocol's eligibility the data a study holds can answer (plan §8.5 item 3, R10).
 *
 * A protocol's criteria are written once, in the closed grammar of `validateRequirement` (`compare`, `present`, `all`, …) over variable
 * names; a frozen real snapshot has columns. This turns the criteria the snapshot can answer into the cohort rules the engine already
 * evaluates three-valued (`cohort.build`: kept, excluded, cannot-tell, per criterion and on its own), and says by name which criteria it
 * could not — no column for the variable, a window or an event the table cannot carry, a sentence only a reader can judge. The counts
 * are the engine's; this file only chooses the rules.
 *
 * Hidden knowledge:
 *
 * - **A criterion is converted whole or not at all.** A composite with one operand the snapshot cannot answer is skipped, never
 *   evaluated on the operands that could be: `all(a, b)` read without `b` is a looser protocol than the one written, and a count
 *   of it would answer a question nobody asked.
 * - **A variable meets a column only by name.** The field map's own words — the column's name, its alias, its parameter, its concept —
 *   are compared, after one normalisation (lower case, runs of anything but letters and digits to `_`), with the variable; the
 *   one column that matches is the column, two that match are `ambiguous_column` and none is `no_column`. Nothing is guessed from
 *   meaning: no model and no pattern over prose decides which column is the ECOG.
 * - **Not applicable is not unknown.** A criterion with an `applicability` (the pregnancy test only women take) is kept for everyone
 *   it does not apply to: `any(not(applicability), requirement)`, which in three values is TRUE where it does not apply and
 *   exactly the requirement where it does.
 * - **The names are the codes the page shows.** Each rule is named for its criterion (`I1`, `E2`, by position in the protocol), so the
 *   engine's waterfall and independent impact line up with the criteria table without a lookup.
 * - **Exclusions are requirements too.** The protocol skill writes every criterion as the requirement to satisfy, an exclusion as the
 *   absence of what it excludes; the converter reads them that way and keeps the people who satisfy each.
 *
 * @module vcrCoverage
 */

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);

/** The reasons a criterion is not evaluated on a snapshot, each in a sentence for the person who reads the answer. */
export const VCR_COVERAGE_SKIP_REASONS = Object.freeze(/** @type {Record<string, string>} */ ({
  no_column: "这份数据里没有对应这个变量的列",
  ambiguous_column: "有不止一列对得上这个变量，没有替你选",
  needs_events: "要看有没有这类事件或诊断的记录，受试者级的列判断不了",
  needs_window: "带时间窗（或取最近一次以外的汇总），受试者级的列判断不了",
  needs_reading: "只能靠读病历文字判断",
  unit_differs: "条件的单位和这一列的单位对不上，没有自己换算",
  not_a_number: "比较大小需要数值，这个条件给的不是数",
  unreadable: "这条条件的写法这里读不了",
}));

/** @param {unknown} value */
const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The code each criterion has on the page: `I1`, `I2`, … for inclusions and `E1`, … for exclusions, by position in the protocol.
 * @param {ReadonlyArray<Record<string, any>>} criteria
 * @returns {Map<string, string>} criterion id → code
 */
export function vcrCriterionCodes(criteria) {
  /** @type {Map<string, string>} */
  const codes = new Map();
  let inclusion = 0;
  let exclusion = 0;
  for (const criterion of [...criteria].sort((a, b) => Number(a.ordinal) - Number(b.ordinal))) {
    codes.set(String(criterion.id), criterion.kind === "exclusion" ? `E${++exclusion}` : `I${++inclusion}`);
  }
  return codes;
}

/**
 * The column a variable is, in the snapshot's field map.
 * @param {string} variable @param {ReadonlyArray<Record<string, any>>} fieldMap entries with `column`, `alias`, `parameter`, `concept`, `identifier`
 * @returns {{ column: string, unit: string | null } | { skip: "no_column" | "ambiguous_column" }}
 */
function columnOf(variable, fieldMap) {
  const wanted = normalized(variable);
  const found = fieldMap.filter((entry) => entry.identifier !== true
    && [entry.alias, entry.parameter, entry.column, entry.concept].some((word) => word != null && normalized(word) === wanted));
  const names = [...new Set(found.map((entry) => String(entry.alias || entry.column)))];
  if (!names.length) return { skip: "no_column" };
  if (names.length > 1) return { skip: "ambiguous_column" };
  const entry = found.find((candidate) => String(candidate.alias || candidate.column) === names[0]);
  return { column: names[0], unit: entry?.unit ? String(entry.unit) : null };
}

/** @typedef {{ rule: Record<string, any> } | { skip: keyof typeof VCR_COVERAGE_SKIP_REASONS }} Converted */

/**
 * One requirement node as a row rule over a column, or the reason it cannot be.
 * @param {unknown} raw @param {ReadonlyArray<Record<string, any>>} fieldMap
 * @returns {Converted}
 */
function convert(raw, fieldMap) {
  const node = object(raw);
  switch (node.op) {
    case "all":
    case "any": {
      const operands = list(node.operands).map((operand) => convert(operand, fieldMap));
      const skipped = operands.find((operand) => "skip" in operand);
      if (skipped || !operands.length) return skipped ?? { skip: "unreadable" };
      return { rule: { op: node.op, operands: operands.map((operand) => /** @type {{ rule: any }} */ (operand).rule) } };
    }
    case "not": {
      const operand = convert(node.operand, fieldMap);
      return "skip" in operand ? operand : { rule: { op: "not", operand: operand.rule } };
    }
    case "compare": {
      // A window or an aggregate other than the latest value is a question about records over time, not about a subject's column.
      if (node.window !== undefined || (node.aggregate !== undefined && node.aggregate !== "latest")) return { skip: "needs_window" };
      const column = columnOf(String(node.variable ?? ""), fieldMap);
      if ("skip" in column) return column;
      if (node.unit && column.unit && normalized(node.unit) !== normalized(column.unit)) return { skip: "unit_differs" };
      const comparator = String(node.comparator);
      if (["lt", "lte", "gt", "gte"].includes(comparator)) {
        return typeof node.value === "number" && Number.isFinite(node.value)
          ? { rule: { op: "compare", column: column.column, comparator, value: node.value } } : { skip: "not_a_number" };
      }
      if (comparator === "eq" || comparator === "ne") {
        const value = node.value;
        return ["number", "string", "boolean"].includes(typeof value) ? { rule: { op: "compare", column: column.column, comparator, value } } : { skip: "unreadable" };
      }
      if (comparator === "between") {
        return Number.isFinite(node.value) && Number.isFinite(node.highValue)
          ? { rule: { op: "between", column: column.column, low: node.value, high: node.highValue } } : { skip: "not_a_number" };
      }
      if (comparator === "in" || comparator === "not_in") {
        return Array.isArray(node.value) && node.value.length ? { rule: { op: comparator, column: column.column, values: node.value } } : { skip: "unreadable" };
      }
      return { skip: "unreadable" };
    }
    case "present":
    case "absent":
    case "elapsed_since":
      return { skip: "needs_events" };
    case "language":
      return { skip: "needs_reading" };
    default:
      return { skip: "unreadable" };
  }
}

/**
 * The cohort rules a protocol's criteria make on a snapshot, and the criteria that could not be made into rules.
 *
 * @param {{ criteria: ReadonlyArray<Record<string, any>>, fieldMap: ReadonlyArray<Record<string, any>> }} input
 *   `criteria`: `{ id, kind, ordinal, requirement, applicability }`; `fieldMap`: `{ column, alias, parameter, concept, unit, identifier }`
 * @returns {{ rules: Array<{ name: string, rule: Record<string, any>, unknownAs: "exclude" }>,
 *   skipped: Array<{ code: string, criterionId: string, reason: keyof typeof VCR_COVERAGE_SKIP_REASONS, why: string }> }}
 */
export function vcrCohortRulesFromCriteria({ criteria, fieldMap }) {
  const codes = vcrCriterionCodes(criteria);
  /** @type {Array<{ name: string, rule: Record<string, any>, unknownAs: "exclude" }>} */
  const rules = [];
  /** @type {Array<{ code: string, criterionId: string, reason: keyof typeof VCR_COVERAGE_SKIP_REASONS, why: string }>} */
  const skipped = [];
  for (const criterion of [...criteria].sort((a, b) => Number(a.ordinal) - Number(b.ordinal))) {
    const code = codes.get(String(criterion.id)) ?? String(criterion.id);
    const wanted = convert(criterion.requirement, fieldMap);
    const applies = criterion.applicability ? convert(criterion.applicability, fieldMap) : null;
    const failure = "skip" in wanted ? wanted : applies && "skip" in applies ? applies : null;
    if (failure) {
      skipped.push({ code, criterionId: String(criterion.id), reason: failure.skip, why: VCR_COVERAGE_SKIP_REASONS[failure.skip] });
      continue;
    }
    const rule = applies ? { op: "any", operands: [{ op: "not", operand: /** @type {{ rule: any }} */ (applies).rule }, /** @type {{ rule: any }} */ (wanted).rule] }
      : /** @type {{ rule: any }} */ (wanted).rule;
    rules.push({ name: code, rule, unknownAs: "exclude" });
  }
  return { rules, skipped };
}

/** What the population object's name says it is. */
export const VCR_COVERAGE_POPULATION_NAME = "按方案条件查覆盖";
