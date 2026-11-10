import { nativeMemoryFile } from "./openVikingSessions.mjs";
import { estimatePromptTokens } from "./modelGateway.mjs";

/**
 * Counts only, from the overlay: no body or filename is exposed to the model.
 * Callers supply the gateway's sensitive/deletion and other-project exclusions.
 * @param {Iterable<any>} files
 * @param {{ memoryRoot: string, hiddenUris?: string[], historySearchEnabled?: boolean }} scope
 */
export function nativeMemoryIndex(files, { memoryRoot, hiddenUris = [], historySearchEnabled = false }) {
  /** @type {Record<string, number>} */
  const counts = {};
  const seen = new Set();
  for (const file of files) {
    if (file.sensitive || seen.has(file.uri) || hiddenUris.some(prefix => file.uri === prefix || file.uri.startsWith(`${prefix}/`))) continue;
    const place = nativeMemoryFile(file.uri, memoryRoot);
    if (!place) continue;
    seen.add(file.uri);
    const segment = place.relPath.split("/")[0];
    counts[segment] = (counts[segment] ?? 0) + 1;
  }
  return { counts, historySearchEnabled };
}

/**
 * One bounded line of places, never file names. Whole places are omitted when
 * necessary, retaining the search entrance and whether history is searchable.
 * @param {{ counts: Record<string, number>, historySearchEnabled?: boolean }} index
 * @param {number} maxTokens
 */
export function nativeIndexLine(index, maxTokens) {
  const places = Object.entries(index.counts).filter(([, count]) => Number.isSafeInteger(count) && count > 0)
    .sort(([a], [b]) => a.localeCompare(b)).map(([place, count]) => `${place} ${count}`);
  const suffix = `${index.historySearchEnabled ? '；早先的对话也可搜索' : ''}；用 mcp__openviking__search 查找。`;
  for (let keep = places.length; keep >= 0; keep -= 1) {
    const rest = keep < places.length ? `另 ${places.length - keep} 处` : '';
    const listing = [...places.slice(0, keep), ...(rest ? [rest] : [])].join(' · ') || '暂无已索引文件';
    const line = `记忆索引：${listing}${suffix}`;
    if (estimatePromptTokens(line) <= maxTokens) return line;
  }
  return '';
}
