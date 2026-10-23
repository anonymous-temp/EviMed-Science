import { describe, expect, it } from 'vitest';
import { readQuestionWorkbook, mapQuestionRows } from './geoQuestionImport';
import * as XLSX from 'xlsx';

describe('original question import', () => {
  it('keeps quoted CSV newlines, whitespace, leading zeros and duplicate originals', async () => {
    const book = await readQuestionWorkbook(new TextEncoder().encode('ID,Question,Group\r\n001,"  What, why?\nAgain  ", A\r\n0,"  What, why?\nAgain  ",B\r\n,,\r\n').buffer);
    const result = mapQuestionRows(book.sheets[0].rows, { text: 1, originalId: 0, originalGroup: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(row => row.originalId)).toEqual(['001', '0']);
    expect(result.rows[0].text).toBe('  What, why?\nAgain  ');
    expect(result.rows[0].originalGroup).toBe(' A');
  });
  it('preserves a mapped raw tag cell as one literal label', () => {
    const raw = ' [a,b],x\ny ';
    expect(mapQuestionRows([['Question', 'Tags'], ['Original', raw]], { text: 0, clientTags: 1 }).rows[0].clientTags).toEqual([raw]);
  });
  it('keeps formatted Excel identifiers and reports metadata-only question rows', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([['ID', 'Question'], [1, 'Original'], [0, 'Zero'], ['002', '']]);
    sheet.A2.z = '000';
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, 'Questions');
    const book = await readQuestionWorkbook(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
    expect(() => mapQuestionRows(book.sheets[0].rows, { text: 1, originalId: 0 })).toThrow(/第 4 行/);
    expect(mapQuestionRows(book.sheets[0].rows.slice(0, 3), { text: 1, originalId: 0 }).rows.map(row => row.originalId)).toEqual(['001', '0']);
  });
});
