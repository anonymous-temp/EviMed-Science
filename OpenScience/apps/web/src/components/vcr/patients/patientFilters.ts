/**
 * The choices a person has for narrowing a table of virtual patients (R19, plan §5.3 「年龄 ▾ ECOG ▾」).
 *
 * They are made from the table's own profile — the quartiles and levels the engine counted — so a narrowing is a band of the table's
 * own distribution or one of its own levels, never a number typed against a column nobody has seen. The server does the
 * filtering (`filter[column]`: a number column takes `a..b`, either end may be left out, or one number; a text column a comma
 * list); this is only which texts the page offers.
 *
 * Hidden knowledge:
 *  - **Bands, not a free range.** A continuous variable offers its lower quarter (`..q1`), its middle half (`q1..q3`) and its upper
 *    quarter (`q3..`): three choices that always have people in them. A variable whose quartiles the engine withheld offers none.
 *  - **A level the engine withheld is not offered**: a share of a handful of people is not a thing to filter down to.
 *  - **A number is written as a plain decimal.** The server's range reads digits and a point; an exponent would be refused.
 */
import type { VcrGeneratedRow } from "@/lib/vcrClient";
import { numberText } from "../vcrText";

export interface VariableFilterOption {
  /** The filter text the server reads. */
  value: string;
  label: string;
}

export interface VariableFilter {
  /** The column's name in the table. */
  variable: string;
  label: string;
  options: VariableFilterOption[];
}

const MAX_LEVELS = 8;

/**
 * The columns the engine writes to say who is in which arm and what became of them: the structure of the table, not who the
 * patients are. A patient's baseline is every other column — what the filters offer and what a baseline distribution is of.
 */
const STRUCTURE_COLUMNS: ReadonlySet<string> = new Set(["patientId", "arm", "time", "status", "entry", "y", "visit"]);

/** The variables of the profile that describe the patients themselves. */
export function baselineVariables(profile: readonly VcrGeneratedRow[]): VcrGeneratedRow[] {
  return profile.filter((row) => !STRUCTURE_COLUMNS.has(row.variable));
}

/** A number as digits and a point, with no exponent and no trailing zeros. */
export function plainDecimal(value: number): string {
  const text = value.toFixed(6).replace(/\.?0+$/, "");
  return text === "" || text === "-0" ? "0" : text;
}

export function variableFilters(profile: readonly VcrGeneratedRow[], max = 3): VariableFilter[] {
  const found: VariableFilter[] = [];
  for (const row of baselineVariables(profile)) {
    if (found.length >= max) break;
    if (!row.variable) continue;
    if (row.kind === "continuous") {
      if (row.q1 === null || row.q3 === null || !(row.q3 >= row.q1)) continue;
      const q1 = plainDecimal(row.q1);
      const q3 = plainDecimal(row.q3);
      found.push({
        variable: row.variable,
        label: row.label,
        options: [
          { value: `..${q1}`, label: `≤ ${numberText(row.q1)}` },
          { value: `${q1}..${q3}`, label: `${numberText(row.q1)}–${numberText(row.q3)}` },
          { value: `${q3}..`, label: `≥ ${numberText(row.q3)}` },
        ],
      });
      continue;
    }
    const levels = (row.levels ?? []).filter((level) => !level.suppressed && level.n !== 0).slice(0, MAX_LEVELS);
    if (levels.length < 2) continue;
    found.push({ variable: row.variable, label: row.label, options: levels.map((level) => ({ value: level.level, label: level.label })) });
  }
  return found;
}

/** The study's own words for its variables, by the column's key: the profile's labels. */
export function variableLabels(profile: readonly VcrGeneratedRow[]): Record<string, string> {
  return Object.fromEntries(profile.filter((row) => row.variable && row.label).map((row) => [row.variable, row.label]));
}
