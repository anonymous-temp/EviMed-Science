import type { GeoQuestionImportRow } from './geoQuestionWorkbenchClient';

export interface QuestionSheet { name: string; rows: string[][] }
export interface QuestionWorkbook { sheets: QuestionSheet[] }
export type QuestionMapping = Partial<Record<'text' | 'originalId' | 'originalGroup' | 'clientTags' | 'pool' | 'audience' | 'journeyStage' | 'kind' | 'sourceUrl' | 'collectedAt' | 'classificationStatus' | 'isMeasured', number>>;

/** SheetJS parses both formats; raw CSV strings and formatted Excel IDs are retained. Never evaluates formulas. */
export async function readQuestionWorkbook(bytes: ArrayBuffer, format: 'csv' | 'excel' = 'excel'): Promise<QuestionWorkbook> {
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请拆分后导入。');
  const XLSX = await import('xlsx');
  let input: string | ArrayBuffer = bytes;
  if (format === 'csv') {
    try { input = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('CSV 必须采用 UTF-8 编码，请另存为 UTF-8 CSV 后重试。'); }
  }
  const book = XLSX.read(input, { type: format === 'csv' ? 'string' : 'array', raw: true, cellText: true, cellFormula: false, sheetRows: 403 });
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
    const enumValue = <const T extends string>(field: keyof QuestionMapping, allowed: readonly T[], fallback?: T): T | undefined => {
      const selected = value(field);
      if (selected == null) return fallback;
      if (!allowed.includes(selected as T)) throw new Error(`第 ${index + 2} 行的 ${field} 值无效，请修正映射或文件。`);
      return selected as T;
    };
    const measured = value('isMeasured');
    if (measured != null && !['true', 'false', '1', '0'].includes(measured)) throw new Error(`第 ${index + 2} 行的 isMeasured 必须为 true / false / 1 / 0。`);
    rows.push({ text, originalId: value('originalId'), originalGroup: value('originalGroup'), clientTags: value('clientTags') == null ? [] : [value('clientTags')!], kind: enumValue('kind', ['client', 'typical', 'real', 'label_safety'], 'client'), pool: enumValue('pool', ['P1', 'P2', 'P3', 'P4']) ?? null, audience: enumValue('audience', ['patient', 'physician', 'caregiver', 'pharmacist', 'institution', 'other']) ?? null, journeyStage: value('journeyStage'), sourceUrl: value('sourceUrl'), collectedAt: value('collectedAt'), isMeasured: measured == null || measured === 'true' || measured === '1', classificationStatus: enumValue('classificationStatus', ['unclassified', 'suggested', 'confirmed'], 'unclassified') });
  });
  if (!rows.length || rows.length > 400) throw new Error('请导入 1 至 400 道原题。');
  return { rows, excludedBlankRows };
}
