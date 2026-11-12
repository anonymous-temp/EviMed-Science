import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CLINICAL_UNIT_VERSION, convertClinicalUnit } from '../index.mjs';

const table = JSON.parse(readFileSync(new URL('../src/clinical-units.json', import.meta.url), 'utf8'));

/** @param {number} value @param {string} from @param {string} to @param {string} analyte */
const convert = (value, from, to, analyte) => convertClinicalUnit(value, from, to, analyte)?.value;

test('the four explicit rows keep the factors a stored comparison was made with', () => {
  assert.equal(CLINICAL_UNIT_VERSION, 'evimed-lab-units-4');
  assert.equal(convert(1.2, 'mg/dL', 'umol/L', 'creatinine'), 1.2 * 88.4);
  assert.equal(convert(2, 'mg/dL', 'umol/L', 'bilirubin'), 2 * 17.1);
  assert.equal(convert(5, 'mmol/L', 'mg/dL', 'glucose'), 5 * 18.016);
  assert.equal(convert(12, 'g/dL', 'g/L', 'hemoglobin'), 120);
});

test('mass concentrations convert to molar ones through the molar mass, as ucum-lhc does with a molecular weight', () => {
  // HAND: 1 mg/dL of a substance of M g/mol is 10 / M mmol/L.
  const molar = (/** @type {string} */ id) => table.analytes.find((/** @type {{ id: string }} */ row) => row.id === id).molarMass;
  assert.ok(Math.abs(/** @type {number} */ (convert(9, 'mg/dL', 'mmol/L', 'calcium')) - 90 / molar('calcium')) < 1e-9);
  assert.ok(Math.abs(/** @type {number} */ (convert(200, 'mg/dL', 'mmol/L', 'ldl_cholesterol')) - 2000 / molar('cholesterol')) < 1e-9, 'an alias of the analyte');
  assert.ok(Math.abs(/** @type {number} */ (convert(20, 'mg/dL', 'mmol/L', 'blood_urea_nitrogen')) - 7.1393) < 1e-3, 'BUN 20 mg/dL is urea 7.14 mmol/L');
  assert.ok(Math.abs(/** @type {number} */ (convert(8.5, 'mg/dL', 'umol/L', 'uric_acid')) - 505.6) < 0.5);
  assert.ok(Math.abs(/** @type {number} */ (convert(3.5, 'g/dL', 'umol/L', 'albumin')) - 526.3) < 0.1);
  // and back: the molar form returns the mass form
  const there = /** @type {number} */ (convert(200, 'mg/dL', 'mmol/L', 'cholesterol'));
  assert.ok(Math.abs(/** @type {number} */ (convert(there, 'mmol/L', 'mg/dL', 'cholesterol')) - 200) < 1e-9);
});

test('two mass or two molar concentrations convert by size; an ion converts between mEq/L and mmol/L by its valence', () => {
  assert.equal(convert(50, 'ug/mL', 'ng/mL', 'vitamin_d'), 50000);
  assert.equal(convert(5, 'ng/mL', 'ug/L', 'testosterone'), 5);
  assert.equal(convert(2000, 'nmol/L', 'umol/L', 'cortisol'), 2);
  assert.equal(convert(140, 'mEq/L', 'mmol/L', 'sodium'), 140);
  assert.equal(convert(2.2, 'mmol/L', 'mEq/L', 'calcium'), 4.4);
  assert.equal(convert(4.4, 'mEq/L', 'mmol/L', 'calcium'), 2.2);
});

test('a conversion the table cannot make is null: an unknown analyte, a unit outside the tables, a mass without a molar mass, an ion without a valence', () => {
  assert.equal(convertClinicalUnit(1, 'mg/dL', 'mmol/L', 'unknown_analyte'), null);
  assert.equal(convertClinicalUnit(1, 'mg/dL', 'IU/L', 'creatinine'), null);
  assert.equal(convertClinicalUnit(12, 'g/dL', 'mmol/L', 'hemoglobin'), null, 'the monomer or the tetramer is not guessed');
  assert.equal(convertClinicalUnit(1, 'mEq/L', 'mmol/L', 'glucose'), null);
  assert.equal(convertClinicalUnit(Number.NaN, 'mg/dL', 'mmol/L', 'calcium'), null);
  assert.equal(convertClinicalUnit(1, 'mg/dL', 'mmol/L', 'hba1c'), null, 'HbA1c is read in %, never converted by a factor');
});

test('body measures convert with their own scale and offset, and a cut-off written in another unit lands on the cut-off', () => {
  assert.equal(convert(100.4, 'degF', 'degC', 'temperature'), 38);
  assert.equal(convert(38, 'C', 'F', 'body_temperature'), 100.4);
  assert.equal(convert(154, 'lbs', 'kg', 'weight'), 69.85322498, '154 x 0.45359237');
  assert.equal(convert(1.75, 'm', 'cm', 'height'), 175);
  assert.equal(convert(70, 'in', 'cm', 'height'), 177.8);
  assert.equal(convert(16, 'kPa', 'mmHg', 'systolic_blood_pressure'), 120.00992, '16 x 7.50062');
  assert.equal(convertClinicalUnit(1, 'kg', 'mg/dL', 'weight'), null);
});

test('insulin converts by the usual factor; a unit spelled with a micro sign is the table\'s unit', () => {
  assert.equal(convert(15, 'µIU/mL', 'pmol/L', 'insulin'), 15 * 6.945);
  assert.equal(convertClinicalUnit(15, 'μIU/mL', 'pmol/L', 'insulin')?.from, 'uIU/mL');
});
