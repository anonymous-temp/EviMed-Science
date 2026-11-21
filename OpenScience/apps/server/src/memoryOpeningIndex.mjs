import { nativeMemoryFile, observationFile, OBSERVATIONS_SEGMENT } from "./openVikingSessions.mjs";
import { estimatePromptTokens } from "./modelGateway.mjs";

/**
 * Counts and observation availability from the overlay, without bodies or filenames.
 * Callers supply the gateway's sensitive/deletion and other-project exclusions.
 * @param {Iterable<any>} files
 * @param {{ memoryRoot: string, hiddenUris?: string[], historySearchEnabled?: boolean }} scope
 */
export function nativeMemoryIndex(files, { memoryRoot, hiddenUris = [], historySearchEnabled = false }) {
  /** @type {Record<string, number>} */
  const counts = {};
  const seen = new Set();
  let hasObservations = false;
  for (const file of files) {
    if (file.sensitive || seen.has(file.uri) || hiddenUris.some(prefix => file.uri === prefix || file.uri.startsWith(`${prefix}/`))) continue;
    if (observationFile(file.uri, memoryRoot)) {
      hasObservations = true;
      continue;
    }
    const place = nativeMemoryFile(file.uri, memoryRoot);
    if (!place) continue;
    seen.add(file.uri);
    const segment = place.relPath.split("/")[0];
    counts[segment] = (counts[segment] ?? 0) + 1;
  }
  return { counts, historySearchEnabled, hasObservations };
}

/**
 * One bounded line of places, never file names. Whole places are omitted when
 * necessary, retaining the search entrance and whether history is searchable.
 * @param {{ counts: Record<string, number>, historySearchEnabled?: boolean, hasObservations?: boolean }} index
 * @param {number} maxTokens
 * @param {boolean} observationRecallEnabled
 */
export function nativeIndexLine(index, maxTokens, observationRecallEnabled = false) {
  const places = Object.entries(index.counts).filter(([, count]) => Number.isSafeInteger(count) && count > 0)
    .sort(([a], [b]) => a.localeCompare(b)).map(([place, count]) => `${place} ${count}`);
  const suffix = `${index.historySearchEnabled ? '；早先的对话也可搜索' : ''}；目录仅分类，notes 等处也可能有同一主题；用 mcp__openviking__search 跨目录查找。`;
  const observationHint = observationRecallEnabled && index.hasObservations
    ? `${OBSERVATIONS_SEGMENT} 中有只见过一次的观察可查。` : '';
  for (let keep = places.length; keep >= 0; keep -= 1) {
    const rest = keep < places.length ? `另 ${places.length - keep} 处` : '';
    const listing = [...places.slice(0, keep), ...(rest ? [rest] : [])].join(' · ') || '暂无已索引文件';
    const line = `记忆索引：${listing}${suffix}`;
    if (observationHint && estimatePromptTokens(line + observationHint) <= maxTokens) return line + observationHint;
    if (estimatePromptTokens(line) <= maxTokens) return line;
  }
  return '';
}
