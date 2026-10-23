import type { GeoQuestionImportRow } from './geoQuestionWorkbenchClient';

export interface QuestionSheet { name: string; rows: string[][] }
export interface QuestionWorkbook { sheets: QuestionSheet[] }
export type QuestionMapping = Partial<Record<'text' | 'originalId' | 'originalGroup' | 'clientTags', number>>;

/** SheetJS parses both formats; raw CSV strings and formatted Excel IDs are retained. Never evaluates formulas. */
export async function readQuestionWorkbook(bytes: ArrayBuffer): Promise<QuestionWorkbook> {
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请拆分后导入。');
  const XLSX = await import('xlsx');
  const book = XLSX.read(bytes, { type: 'array', raw: true, cellText: true, cellFormula: false, sheetRows: 403 });
  const sheets = book.SheetNames.map(name => {
    const sheet = book.Sheets[name];
    const range = sheet['!fullref'] ?? sheet['!ref'];
    if (range && XLSX.utils.decode_range(range).e.r > 400) throw new Error('每张表最多 400 道题，请拆分后导入。');
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    return { name, rows: rows.map(row => row.map(value => String(value ?? ''))) };
  });
  if (!sheets.length) throw new Error('文件中没有工作表。');
  return { sheets };
}

export function mapQuestionRows(table: string[][], mapping: QuestionMapping) {
  if (mapping.text == null) throw new Error('请选择原题文本列。');
  let excludedBlankRows = 0;
  const rows: GeoQuestionImportRow[] = [];
  table.slice(1).forEach((cells, index) => {
    if (cells.every(value => !value.trim())) { excludedBlankRows++; return; }
    const text = cells[mapping.text!] ?? '';
    if (!text.trim()) throw new Error(`第 ${index + 2} 行有其他信息，但原题为空，请修正文件或选择正确的列。`);
    const value = (key: keyof QuestionMapping) => mapping[key] == null ? undefined : cells[mapping[key]!] || undefined;
    rows.push({ text, originalId: value('originalId'), originalGroup: value('originalGroup'), clientTags: value('clientTags') == null ? [] : [value('clientTags')!], kind: 'client', isMeasured: true, classificationStatus: 'unclassified' });
  });
  if (!rows.length || rows.length > 400) throw new Error('请导入 1 至 400 道原题。');
  return { rows, excludedBlankRows };
}
