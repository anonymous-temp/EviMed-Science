// Line formats the opt-in extraction-v2 templates write, and the checks that read them. Syntax only, never the truth or meaning of a statement.

/** @param {string} text @returns {{ value: string, until: string, prefix: string, suffix: string } | null} */
export function memoryHistoryLine(text) {
  const match = /^(earlier: |曾为：)(.+?)( \(until (\d{4}-\d{2}-\d{2}|unknown)\)|（截至 (\d{4}-\d{2}-\d{2}|未知)）)$/.exec(text.trim());
  return match ? { value: match[2], until: match[4] ?? match[5], prefix: match[1], suffix: match[3] } : null;
}

/** The NOTES labels the extraction-v2 templates ask for (v2.1): a user's opinion and an assistant suggestion the user did not take up. */
const V21_LABEL = /^(?:用户认为：|User believes:|助手建议（用户未采纳）：|Assistant suggested \(not adopted\):)/;
/** The labels of the earlier v2 line protocol, still recognised so that recorded memory and its fixtures keep counting; they end with a recorded date. */
const V2_LABEL = /^(?:user stated:|user believes(?: \(sensitive\))?:|assistant suggested \((?:adopted|declined|not answered)\):|document says:|用户陈述：|用户观点(?:（敏感）)?：|助手建议（(?:已采纳|未采纳|未答复)）：|文档声称：)/;
/** The start of an attempted label, not words somewhere in the sentence. */
const ATTEMPTED_LABEL = /^(?:assistant suggested|user believes|user stated|document says|用户陈述|用户观点|用户认为|助手建议|文档声称)[:：（(]/i;

/** Count NOTES statements and how many carry a recognised source label: a syntax count, never a semantic opinion detector and never a
 * change to what is written. An unlabelled statement is ordinary (v2.1 labels only opinions and unadopted suggestions), so it is checked
 * but not an error; an attempted label that is not one of the recognised forms, or an old v2 label without its recorded date, is
 * malformed. Headings and the platform's source-change notice are not statements.
 * @param {string} body
 */
export function checkMemoryNoteLabels(body) {
  let checked = 0, labelled = 0, malformed = 0, sensitive = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    if (!line || /^#{1,6}\s/.test(line) || line.startsWith('> 来源变更：')) continue;
    checked++;
    // Translated labels still have a language-independent explicit privacy marker; no subject inference.
    sensitive ||= /^[^:：]+[:：]\s*\[sensitive\]/.test(line);
    const current = V21_LABEL.exec(line);
    if (current) {
      if (line.slice(current[0].length).trim()) labelled++;
      else malformed++;
      continue;
    }
    const label = V2_LABEL.exec(line);
    if (!label) {
      if (ATTEMPTED_LABEL.test(line)) malformed++;
      continue;
    }
    sensitive ||= label[0] === 'user believes (sensitive):' || label[0] === '用户观点（敏感）：';
    if (!/(?:\(recorded \d{4}-\d{2}-\d{2}\)|（记录日期 \d{4}-\d{2}-\d{2}）)$/.test(line) || !line.slice(label[0].length).replace(/(?:\(recorded [^)]+\)|（记录日期 [^）]+）)$/, '').trim()) malformed++;
    else labelled++;
  }
  return { checked, labelled, malformed, sensitive };
}

/** Shared by the existing consolidation and verification requests; no extra call. */
export const MEMORY_EXTRACTION_V2_REVIEW_TEXT = 'An earlier: / 曾为： line is dated history, not a stale current assertion. Preserve each earlier value and its date, the unprefixed current value, exact names, numbers and units, and the labels 用户认为： / User believes: and 助手建议（用户未采纳）： / Assistant suggested (not adopted):. Keep - Choice:, - Stated choice:, - Confirmed aliases: and - Alias confirmation: lines unchanged. Do not collapse history into the current value or turn a labelled opinion or suggestion into a fact. Deduplicate only unchanged repetitions.';
