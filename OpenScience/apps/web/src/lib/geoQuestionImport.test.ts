import { describe, expect, it } from 'vitest';
import { readQuestionWorkbook, mapQuestionRows } from './geoQuestionImport';
import { File as NodeFile } from 'node:buffer';
import * as XLSX from 'xlsx';

describe('original question import', () => {
  it('decodes BOMless Chinese CSV from actual file bytes without corrupting headers or original text', async () => {
    const file = new NodeFile(['编号,问题,标签\r\n001,"原题，为什么？\n 下一行 ","[a,b]\n 原标签"\r\n0,零号原题,原类'], '原题.csv');
    const book = await readQuestionWorkbook(await file.arrayBuffer(), 'csv');
    expect(book.sheets[0].rows[0]).toEqual(['编号', '问题', '标签']);
    const mapped = mapQuestionRows(book.sheets[0].rows, { text: 1, originalId: 0, clientTags: 2 });
    expect(mapped.rows.map(row => row.originalId)).toEqual(['001', '0']);
    expect(mapped.rows[0].text).toBe('原题，为什么？\n 下一行 ');
    expect(mapped.rows[1].text).toBe('零号原题');
    expect(mapped.rows[0].clientTags).toEqual(['[a,b]\n 原标签']);
  });
  it('maps explicit AI adoption and provenance columns without guessing enum values or splitting client labels', () => {
    const result = mapQuestionRows([['Q','kind','pool','who','stage','url','date','status','measured'], ['来源原话','real','P2','patient','就诊','https://example.org/q','2026-10-24','suggested','false']], { text: 0, kind: 1, pool: 2, audience: 3, journeyStage: 4, sourceUrl: 5, collectedAt: 6, classificationStatus: 7, isMeasured: 8 });
    expect(result.rows[0]).toMatchObject({ kind: 'real', pool: 'P2', audience: 'patient', journeyStage: '就诊', sourceUrl: 'https://example.org/q', collectedAt: '2026-10-24', classificationStatus: 'suggested', isMeasured: false });
    expect(() => mapQuestionRows([['Q','kind'], ['原话','模型猜测']], { text: 0, kind: 1 })).toThrow(/kind/);
  });
  it('keeps quoted CSV newlines, whitespace, leading zeros and duplicate originals', async () => {
    const book = await readQuestionWorkbook(new TextEncoder().encode('ID,Question,Group\r\n001,"  What, why?\nAgain  ", A\r\n0,"  What, why?\nAgain  ",B\r\n,,\r\n').buffer, 'csv');
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
it('normalizes typed Excel booleans and dates without guessing formatted regional date strings', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([['ID','Question','Measured','Date'], [1,'Original',true,new Date(Date.UTC(2026,10,10))], [0,'Other',false,new Date(Date.UTC(2026,9,24))]]);
  sheet.A2.z = '000'; sheet.D2.z = 'dd/mm/yyyy'; sheet.D3.z = 'dd/mm/yyyy';
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Q');
  const read = await readQuestionWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
  const mapped = mapQuestionRows(read.sheets[0].rows, { text: 1, originalId: 0, isMeasured: 2, collectedAt: 3 }, read.sheets[0].typedRows);
  expect(mapped.rows.map(row => row.isMeasured)).toEqual([true, false]);
  expect(mapped.rows.map(row => row.collectedAt)).toEqual(['2026-11-10', '2026-10-24']);
  expect(mapped.rows.map(row => row.originalId)).toEqual(['001', '0']);
});
it('counts actual questions after blank rows and rejects scans beyond explicit limits', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([['Question'], ...Array.from({ length: 200 }, (_, i) => [`Q${i}`]), [], [], ...Array.from({ length: 200 }, (_, i) => [`R${i}`])]);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Q');
  const read = await readQuestionWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
  expect(mapQuestionRows(read.sheets[0].rows, { text: 0 })).toMatchObject({ excludedBlankRows: 2, rows: expect.any(Array) });
  expect(mapQuestionRows(read.sheets[0].rows, { text: 0 }).rows).toHaveLength(400);
  sheet['!ref'] = 'A1:A10002';
  await expect(readQuestionWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' }))).rejects.toThrow(/10000/);
});
