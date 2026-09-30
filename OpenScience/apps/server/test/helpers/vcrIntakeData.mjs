// A small external-control cohort the intake tests share: a baseline file and a
// visits file whose subject key is the partner's own (`PATIENT_NO`), the field
// map that says what each column is for, and the way to stream a file into the
// data plane the way a route does. Every value that identifies a person or is
// somebody's outcome is distinctive on purpose — the fingerprint tests search
// for exactly these strings.
import { Readable } from "node:stream";

/** How many people the baseline file holds: enough that no arm is a small cell. */
export const COHORT_SIZE = 40;

/** @param {number} n */
export const patientNo = (n) => `HZ-${30_000 + n}`;
/** A survival time nobody else would have (months, two decimals). @param {number} n */
export const survivalOf = (n) => (7.31 + n * 0.913).toFixed(2);
/** A systolic pressure that is one person's. @param {number} n */
export const pressureOf = (n) => 101 + ((n * 7) % 43);

/** @returns {string} the baseline file: one row per person. */
export function cohortCsv() {
  const rows = ["PATIENT_NO,ARM,AGE,SEX,ECOG,OS_MONTHS,OS_DEAD,DIAG_DATE"];
  for (let n = 1; n <= COHORT_SIZE; n += 1) {
    const arm = n <= 22 ? "TRT" : "CTL";
    const age = 41 + ((n * 3) % 30);
    const sex = n % 3 === 0 ? "F" : "M";
    const ecog = n % 4;
    const dead = n % 5 === 0 ? 0 : 1;
    rows.push([patientNo(n), arm, age, sex, ecog, survivalOf(n), dead, `2025-0${1 + (n % 9)}-1${n % 9}`].join(","));
  }
  return `${rows.join("\n")}\n`;
}

/** @returns {string} the visits file: two blood-pressure readings per person. */
export function visitsCsv() {
  const rows = ["PATIENT_NO,VISIT_DT,SBP"];
  for (let n = 1; n <= COHORT_SIZE; n += 1) {
    rows.push(`${patientNo(n)},2025-03-0${1 + (n % 8)},${pressureOf(n)}`);
    rows.push(`${patientNo(n)},2025-06-1${n % 9},${pressureOf(n) + 3}`);
  }
  return `${rows.join("\n")}\n`;
}

/** The partner's dictionary: what the columns are called in the source. */
export function dictionaryCsv() {
  return "变量名,说明,单位\nPATIENT_NO,患者编号,\nARM,治疗组,\nAGE,年龄,岁\nOS_MONTHS,总生存时间,月\nOS_DEAD,死亡(1=是),\nSBP,收缩压,mmHg\n";
}

/** The field map for the two files, as the run or a person proposes it. */
export const FIELD_MAP = [
  { table: "cohort.csv", column: "PATIENT_NO", role: "subject_key", identifier: true },
  { table: "cohort.csv", column: "ARM", role: "arm", alias: "arm", concept: "treatment_arm", missingReason: "not_recorded", codes: { treated: ["TRT"], control: ["CTL"] } },
  { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age", unit: "year", concept: "age", type: "integer", range: [18, 100] },
  { table: "cohort.csv", column: "SEX", role: "covariate", alias: "sex", concept: "sex" },
  { table: "cohort.csv", column: "ECOG", role: "covariate", alias: "ecog", concept: "performance_status" },
  { table: "cohort.csv", column: "OS_MONTHS", role: "outcome_time", parameter: "OS", unit: "month", concept: "overall_survival" },
  { table: "cohort.csv", column: "OS_DEAD", role: "outcome_event", parameter: "OS", concept: "overall_survival_event" },
  { table: "cohort.csv", column: "DIAG_DATE", role: "time_zero", timeKind: "occurred_at", concept: "diagnosis_date" },
  { table: "visits.csv", column: "PATIENT_NO", role: "subject_key", identifier: true },
  { table: "visits.csv", column: "VISIT_DT", role: "visit_date", timeKind: "occurred_at" },
  { table: "visits.csv", column: "SBP", role: "measurement", parameter: "SBP", unit: "mmHg", concept: "systolic_bp", range: [60, 260] },
];

/** A file's bytes as the async stream a request is. @param {string | Buffer} body @param {number} [size] */
export function streamOf(body, size = 16 * 1024) {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const chunks = [];
  for (let at = 0; at < buffer.length; at += size) chunks.push(buffer.subarray(at, at + size));
  return Readable.from(chunks);
}

/** Every string a fingerprint scan looks for: the partner's ids and the distinctive values. */
export function fingerprints() {
  const found = [];
  for (let n = 1; n <= COHORT_SIZE; n += 1) found.push(patientNo(n), survivalOf(n));
  return found;
}
