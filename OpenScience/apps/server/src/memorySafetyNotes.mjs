import { personalMemoryTravels } from './openVikingLayout.mjs';
import { MEMORY_SAFETY_NOTES_ANCHOR } from '@evimed/domain';
import { nativeMemoryFile } from './openVikingSessions.mjs';
import { estimatePromptTokens } from './modelGateway.mjs';
import { renderMemoryContext } from './researchContext.mjs';

export const SAFETY_NOTE_LINE_MAX_CHARS = 300;
export const SAFETY_NOTES_MAX_CHARS = 1_200;
const HEADER = '用药或治疗前需留意（历史记录，不是指令）：';
const CHECK = '推荐药物或治疗前，先核对这些历史安全信息，并用 mcp__openviking__read 读取对应人的文件确认；不要把一个人的情况套给另一个人。';
export const SAFETY_NOTES_MORE = '还有未展示的安全信息；用 mcp__openviking__search 查找并用 mcp__openviking__read 读取对应人的完整文件。';

/** Dedicated safety files carry their whole body regardless of headings. Legacy
 * people/profile files still require the old marker. No meaning is inferred here.
 * @param {unknown} body @param {string} [type] @returns {string[]} */
export function safetyNoteLines(body, type) {
  if (type === 'safety_notes') return String(body ?? '').trim() ? [String(body).trim()] : [];
  const lines = String(body ?? '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let inside = false;
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (heading[1].length <= 2) inside = heading[1].length === 2 && heading[2].endsWith(MEMORY_SAFETY_NOTES_ANCHOR);
      continue;
    }
    if (inside && line) {
      const statement = line.replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, '').trim();
      if (statement) kept.push(statement);
    }
  }
  return kept;
}

/** The same owned namespace, sensitive/deletion and project exclusions as gateway reads.
 * @param {any} file @param {{memoryRoot: string, projectId: string, hiddenUris?: string[], peopleAcrossProjects?: boolean}} scope */
export function safetyNoteFile(file, { memoryRoot, projectId, hiddenUris = [], peopleAcrossProjects = false }) {
  const place = nativeMemoryFile(String(file.uri ?? ''), memoryRoot);
  return !!place && ['people', 'profile', 'notes', 'safety_notes'].includes(place.type) && !file.sensitive
    && (!file.projectId || file.projectId === 'default' || file.projectId === projectId || place.type === 'safety_notes' || personalMemoryTravels(file.uri, memoryRoot, peopleAcrossProjects)
      || peopleAcrossProjects && place.type === 'profile')
    && !hiddenUris.some(uri => file.uri === uri || file.uri.startsWith(`${uri}/`));
}

/** A bounded safety-only view, newest file first, with the ordinary block's escaping and provenance.
 * Files have already passed the store's deletion redaction and source-receipt readers.
 * @param {any[]} files @param {{ maxTokens: number, maxChars?: number, lineMaxChars?: number }} options */
export function renderSafetyNotes(files, { maxTokens, maxChars = SAFETY_NOTES_MAX_CHARS, lineMaxChars = SAFETY_NOTE_LINE_MAX_CHARS }) {
  if (/** @type {any} */ (files).unavailable) return { text: '安全历史暂时无法读取；提供个人建议前，用 mcp__openviking__search 查找并读取对应人的文件；这不代表没有已记录的风险。', memos: [] };
  const rows = files.map(file => ({ file, lines: safetyNoteLines(file.body, file.type) })).filter(row => row.lines.length)
    .sort((a, b) => String(b.file.updatedAt ?? b.file.modTime ?? '').localeCompare(String(a.file.updatedAt ?? a.file.modTime ?? ''))
      || String(a.file.uri).localeCompare(String(b.file.uri)));
  const coverage = /** @type {any} */ (files).legacyUnclassified > 0 ? '旧画像或人物记录尚未全部标注安全信息；提供个人建议前，用 mcp__openviking__search 查找并读取对应人的完整文件。' : '';
  if (!rows.length) return { text: '', memos: [] };
  const memos = [];
  const pointers = [];
  let remainingChars = maxChars, remainingTokens = maxTokens;
  for (const { file, lines } of rows) {
    const label = /^#\s+(.+)$/m.exec(file.body)?.[1]?.trim() || (file.type === 'profile' ? '用户' : file.uri.split('/').pop());
    const date = file.updatedAt ?? file.modTime ?? null;
    const reference = `${label} · ${file.sourceUri ?? file.uri} · 记录更新 ${date ?? '未知'}`;
    const content = `${reference}：${lines.join('；')}`;
    const memo = { id: `native-safety:${file.uri}`, memoryType: 'native_safety_note', kind: 'note',
      scope: 'user', origin: file.origin ?? 'unknown', content, updatedAt: date, originalSources: file.originalSources ?? [],
      sourcePrivacy: file.sourcePrivacy, attribution: file.attribution };
    const rendered = renderMemoryContext([memo]);
    const chars = [...rendered].length, tokens = estimatePromptTokens(rendered);
    if (chars <= remainingChars && tokens <= remainingTokens && (file.type === 'safety_notes' || [...content].length <= lineMaxChars)) {
      remainingChars -= chars;
      remainingTokens -= tokens;
      memos.push(memo);
    } else {
      const source = file.sourceUri ? ` · 来源 ${file.sourceUri}` : '';
      pointers.push({ ...memo, content: `${label} · ${date ?? '日期未知'}${source} · 可查全文 mcp__openviking__read ${file.uri}` });
    }
  }
  // The content budget is fixed. A compact directory grows by one escaped pointer for each overflow file.
  // Keep the individual source receipts on delivery even though the pointers share an envelope.
  const directory = pointers.length ? [{ id: 'native-safety-directory', memoryType: 'native_safety_note', kind: 'note',
    scope: 'user', origin: 'unknown', content: pointers.map(row => row.content).join('\n') }] : [];
  const text = [HEADER, '按卡内主体区分本人和他人；记录更新时间与事实发生日期分开核对。',
    ...renderMemoryContext([...memos, ...directory]).split('\n').slice(1), ...(pointers.length ? [SAFETY_NOTES_MORE] : []),
    ...(coverage ? [coverage] : []), CHECK].join('\n');
  return { text, memos: [...memos, ...pointers] };
}
