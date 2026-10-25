import type { GeoQuestionImportRow } from './geoQuestionWorkbenchClient';

export type QuestionTypedCell = boolean | { date: string } | null;
export interface QuestionSheet { name: string; rows: string[][]; typedRows?: QuestionTypedCell[][] }
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
  const book = XLSX.read(input, { type: format === 'csv' ? 'string' : 'array', raw: true, cellText: true, cellFormula: false, sheetRows: 10002, cellNF: true });
  if (book.SheetNames.length > 20) throw new Error('文件最多包含 20 张工作表。');
  let scannedCells = 0;
  const sheets = book.SheetNames.map(name => {
    const sheet = book.Sheets[name];
    const range = sheet['!fullref'] ?? sheet['!ref'];
    if (range) {
      const bounds = XLSX.utils.decode_range(range);
      scannedCells += (bounds.e.r + 1) * (bounds.e.c + 1);
      if (bounds.e.r >= 10000 || bounds.e.c >= 256 || scannedCells > 250000) throw new Error('扫描上限为每表 10000 行、256 列，文件共 250000 个单元格，请拆分文件。');
    }
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    const origin = range ? XLSX.utils.decode_range(range).s : { r: 0, c: 0 };
    const typedRows = rows.map((row, rowIndex) => row.map((_, column): QuestionTypedCell => {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex + origin.r, c: column + origin.c })];
      if (cell?.t === 'b') return cell.v === true;
      if (cell?.t === 'n' && typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z)) {
        const date = XLSX.SSF.parse_date_code(Number(cell.v), { date1904: book.Workbook?.WBProps?.date1904 === true });
        if (date) return { date: `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}` };
      }
      return null;
    }));
    return { name, rows: rows.map(row => row.map(value => String(value ?? ''))), typedRows };
  });
  if (!sheets.length) throw new Error('文件中没有工作表。');
  return { sheets };
}

export function mapQuestionRows(table: string[][], mapping: QuestionMapping, typedRows?: QuestionTypedCell[][]) {
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
    const typed = (field: keyof QuestionMapping) => mapping[field] == null ? null : typedRows?.[index + 1]?.[mapping[field]!];
    const typedMeasured = typed('isMeasured');
    const measured = typeof typedMeasured === 'boolean' ? String(typedMeasured) : value('isMeasured');
    const typedDate = typed('collectedAt');
    const collectedAt = typedDate && typeof typedDate === 'object' ? typedDate.date : value('collectedAt');
    if (collectedAt != null && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(collectedAt)) throw new Error(`第 ${index + 2} 行的采集日期请使用 YYYY-MM-DD 或 Excel 日期单元格。`);
    if (measured != null && !['true', 'false', '1', '0'].includes(measured)) throw new Error(`第 ${index + 2} 行的 isMeasured 必须为 true / false / 1 / 0。`);
    rows.push({ text, originalId: value('originalId'), originalGroup: value('originalGroup'), clientTags: value('clientTags') == null ? [] : [value('clientTags')!], kind: enumValue('kind', ['client', 'typical', 'real', 'label_safety'], 'client'), pool: enumValue('pool', ['P1', 'P2', 'P3', 'P4']) ?? null, audience: enumValue('audience', ['patient', 'physician', 'caregiver', 'pharmacist', 'institution', 'other']) ?? null, journeyStage: value('journeyStage'), sourceUrl: value('sourceUrl'), collectedAt, isMeasured: measured == null || measured === 'true' || measured === '1', classificationStatus: enumValue('classificationStatus', ['unclassified', 'suggested', 'confirmed'], 'unclassified') });
  });
  if (!rows.length || rows.length > 400) throw new Error('请导入 1 至 400 道原题。');
  return { rows, excludedBlankRows };
}
