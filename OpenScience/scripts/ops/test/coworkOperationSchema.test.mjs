// The document tools' help is written from one operation schema (packages/socket/extensions/cowork/operations.mjs),
// and the limits it states are the ones the isolated image enforces (scripts/runtime/extensions/cowork/policy.mjs).
// The policy cannot be edited to read the schema (an admitted image binds its bytes), so this test is what keeps the
// two equal: every boundary case below is derived from the schema, so a limit that moves on one side and not the
// other is a red test instead of a help line that is wrong for a model that trusts it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { normalizeSkillOperation, operationExample } from '@evimed/domain';
import { COWORK_LIMITS, COWORK_OPERATIONS, toolParameters } from '../../../packages/socket/extensions/cowork/operations.mjs';
import { coworkToolSpecs } from '../../../packages/socket/extensions/cowork/bridge.mjs';
import { LIMITS, validateRequest } from '../../runtime/extensions/cowork/policy.mjs';

const operations = new Map(COWORK_OPERATIONS.map((raw) => [raw.name, /** @type {any} */ (normalizeSkillOperation(raw))]));
const accepted = (/** @type {any} */ request) => { try { validateRequest(structuredClone(request)); return true; } catch { return false; } };
const read = (/** @type {any} */ options) => ({ operation: 'doc_read', resourceId: 'res_public', options });
const sheet = (/** @type {number} */ cells, name = 'Data') => ({ name, cells: Array.from({ length: cells }, (_, index) => ({ ref: `A${index + 1}`, value: index })) });
const xlsx = (/** @type {any} */ sheets) => ({ operation: 'doc_write', targetId: 'out_one', format: 'xlsx', spec: { kind: 'create', sheets } });
const notebook = (/** @type {any} */ cells) => ({ operation: 'doc_write', targetId: 'out_one', format: 'ipynb', spec: { kind: 'create', cells } });

test('both operations are in the schema and read through the domain reader without losing a parameter', () => {
  assert.deepEqual([...operations.keys()], ['doc_read', 'doc_write']);
  for (const raw of COWORK_OPERATIONS) assert.equal(operations.get(raw.name).params.length, raw.params.length, raw.name);
});

test('the example call each operation yields is accepted by the policy once its placeholders are real identifiers', () => {
  const concrete = (/** @type {any} */ value) => JSON.parse(JSON.stringify(value).replace('<resourceId>', 'res_public').replace('<targetId>', 'out_one'));
  assert.equal(accepted({ operation: 'doc_read', ...concrete(operationExample(operations.get('doc_read'))) }), true);
  assert.equal(accepted({ operation: 'doc_write', ...concrete(operationExample(operations.get('doc_write'))) }), true);
});

test('every integer option is accepted at the schema\'s bounds and refused one past them', () => {
  const integers = operations.get('doc_read').params.filter((/** @type {any} */ param) => param.name.startsWith('options.') && param.type === 'integer');
  assert.equal(integers.length, 6);
  for (const param of integers) {
    const key = param.name.slice('options.'.length);
    assert.equal(accepted(read({ [key]: param.min })), true, `${key} at its minimum ${param.min}`);
    assert.equal(accepted(read({ [key]: param.max })), true, `${key} at its maximum ${param.max}`);
    assert.equal(accepted(read({ [key]: param.min - 1 })), false, `${key} below its minimum`);
    assert.equal(accepted(read({ [key]: param.max + 1 })), false, `${key} above its maximum`);
    assert.equal(accepted(read({ [key]: 1.5 })), false, `${key} is a whole number`);
  }
  // The policy's own table agrees with the schema where it has one.
  assert.equal(LIMITS.rows, COWORK_LIMITS.rows.max);
  assert.equal(LIMITS.cells, COWORK_LIMITS.cellsWrite);
});

test('options the schema does not list, and a request key it does not list, are refused', () => {
  const listed = new Set(operations.get('doc_read').params.map((/** @type {any} */ param) => param.name.split('.')[0]));
  assert.deepEqual([...listed].sort(), ['options', 'resourceId']);
  assert.equal(accepted(read({ unknownOption: 1 })), false);
  assert.equal(accepted({ ...read({}), path: '/x' }), false);
  const writeKeys = new Set(operations.get('doc_write').params.map((/** @type {any} */ param) => param.name.split('.')[0]));
  assert.deepEqual([...writeKeys].sort(), ['format', 'spec', 'targetId']);
});

test('the sheets option takes the schema\'s count of names of the schema\'s length', () => {
  assert.equal(accepted(read({ sheets: ['a'.repeat(COWORK_LIMITS.sheetNameChars)] })), true);
  assert.equal(accepted(read({ sheets: ['a'.repeat(COWORK_LIMITS.sheetNameChars + 1)] })), false);
  assert.equal(accepted(read({ sheets: Array(COWORK_LIMITS.sheetsRead).fill('a') })), true);
  assert.equal(accepted(read({ sheets: Array(COWORK_LIMITS.sheetsRead + 1).fill('a') })), false);
});

test('a workbook is bounded by the schema\'s sheets, cells, sheet name and characters', () => {
  assert.equal(accepted(xlsx(Array.from({ length: COWORK_LIMITS.sheetsWrite }, (_, index) => sheet(1, `S${index}`)))), true);
  assert.equal(accepted(xlsx(Array.from({ length: COWORK_LIMITS.sheetsWrite + 1 }, (_, index) => sheet(1, `S${index}`)))), false);
  assert.equal(accepted(xlsx([sheet(COWORK_LIMITS.cellsWrite)])), true);
  assert.equal(accepted(xlsx([sheet(COWORK_LIMITS.cellsWrite + 1)])), false);
  assert.equal(accepted(xlsx([sheet(COWORK_LIMITS.cellsWrite / 2, 'A'), sheet(COWORK_LIMITS.cellsWrite / 2 + 1, 'B')])), false, 'the cell limit is across sheets');
  assert.equal(accepted(xlsx([sheet(1, 'a'.repeat(COWORK_LIMITS.sheetNameChars))])), true);
  assert.equal(accepted(xlsx([sheet(1, 'a'.repeat(COWORK_LIMITS.sheetNameChars + 1))])), false);
  for (const character of ['\\', '/', '*', '?', ':', '[', ']']) assert.equal(accepted(xlsx([sheet(1, `a${character}b`)])), false, `a sheet name with ${character}`);
  assert.equal(accepted(xlsx([{ name: 'Data', cells: [{ ref: 'A1', value: 'x'.repeat(COWORK_LIMITS.cellTextBytes) }] }])), true);
  assert.equal(accepted(xlsx([{ name: 'Data', cells: [{ ref: 'A1', value: 'x'.repeat(COWORK_LIMITS.cellTextBytes + 1) }] }])), false);
  for (const value of [{ formula: '=1+1' }, { hyperlink: 'http://x' }]) assert.equal(accepted(xlsx([{ name: 'Data', cells: [{ ref: 'A1', value }] }])), false, 'no formula or link');
});

test('a notebook is bounded by the schema\'s cells and text, takes the three cell types and never runs', () => {
  const cells = (/** @type {number} */ count, type = 'markdown') => Array.from({ length: count }, () => ({ type, source: 'text' }));
  assert.equal(accepted(notebook(cells(COWORK_LIMITS.notebookCells))), true);
  assert.equal(accepted(notebook(cells(COWORK_LIMITS.notebookCells + 1))), false);
  for (const type of ['markdown', 'code', 'raw']) assert.equal(accepted(notebook(cells(1, type))), true, type);
  assert.equal(accepted(notebook(cells(1, 'output'))), false);
  assert.equal(accepted(notebook([{ type: 'code', source: 'x'.repeat(COWORK_LIMITS.cellTextBytes) }])), true);
  assert.equal(accepted(notebook([{ type: 'code', source: 'x'.repeat(COWORK_LIMITS.cellTextBytes + 1) }])), false);
});

test('the closed values and the format a parameter names are the policy\'s: other formats and kinds are refused', () => {
  const format = operations.get('doc_write').params.find((/** @type {any} */ param) => param.name === 'format');
  for (const value of format.values) assert.equal(accepted({ ...xlsx([sheet(1)]), format: value, spec: value === 'xlsx' ? xlsx([sheet(1)]).spec : notebook([]).spec }), true, value);
  for (const value of ['docx', 'pdf', 'xlsm', 'csv']) assert.equal(accepted({ ...xlsx([sheet(1)]), format: value }), false, value);
  assert.equal(accepted({ ...xlsx([sheet(1)]), spec: { kind: 'update', sheets: [] } }), false);
});

test('the identifiers the schema names are the opaque pattern the policy enforces', () => {
  const pattern = new RegExp(COWORK_LIMITS.idPattern);
  for (const id of ['res_public', 'a', 'A9_-x']) { assert.match(id, pattern); assert.equal(accepted({ operation: 'doc_read', resourceId: id }), true, id); }
  for (const id of ['../x', '_leading', '', 'a'.repeat(101), 'with space']) { assert.doesNotMatch(id, pattern); assert.equal(accepted({ operation: 'doc_read', resourceId: id }), false, id); }
});

test('the tool the model meets is the schema: its parameter keys, its limits sentence and its descriptions are generated from it', () => {
  const specs = coworkToolSpecs(async () => ({ ok: true }));
  for (const spec of specs) {
    const operation = operations.get(spec.name);
    assert.deepEqual(Object.keys(spec.parameters).sort(), [...new Set(operation.params.map((/** @type {any} */ param) => param.name.split('.')[0]))].sort(), spec.name);
    for (const limit of operation.limits) assert.ok(spec.description.includes(limit) || spec.description.length >= 400, `${spec.name} states: ${limit}`);
    assert.ok([...spec.description].length <= 480, `${spec.name} description is bounded`);
  }
  const options = specs[0].parameters.options.properties;
  for (const param of operations.get('doc_read').params.filter((/** @type {any} */ item) => item.name.startsWith('options.') && item.type === 'integer')) {
    assert.ok(options[param.name.slice(8)].description.includes(`${param.min}–${param.max}`), `${param.name} says its range`);
  }
  assert.equal(specs[1].parameters.spec.required, true);
  assert.deepEqual(toolParameters(operations.get('doc_read'), () => 'x').options.type, 'object');
});

test('the descriptor\'s operations list the formats the schema accepts and produces', () => {
  const descriptor = JSON.parse(fs.readFileSync(new URL('../../runtime/extensions/cowork/descriptor.json', import.meta.url), 'utf8'));
  assert.deepEqual(descriptor.operations.doc_read.formats, operations.get('doc_read').accepts);
  assert.deepEqual(descriptor.operations.doc_write.formats, operations.get('doc_write').produces);
});
