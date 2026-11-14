/** Extraction-v2's line protocol. This checks syntax, never the truth or meaning of a statement. */
export const MEMORY_EXTRACTION_V2_FORMAT_TEXT = `# Exactness, attribution and history (extraction-v2)
Copy names, numbers with units, dates and identifiers exactly as said, including model numbers, drug names and doses. Do not round, translate identifiers, substitute or silently paraphrase an anchor. If unsure which type fits, keep the person's sentence verbatim in NOTES with its conversation date and source label; the hard boundaries still apply.
Opinions, stances, assistant suggestions (including declined and unanswered ones) and document claims: keep, labelled. They are context, not established facts or permission. Every NOTES statement is one self-contained bullet starting with its source label, never an unlabelled paragraph. In Chinese use 用户陈述：, 用户观点：, 助手建议（已采纳）： / 助手建议（未采纳）： / 助手建议（未答复）：, or 文档声称：; end with （记录日期 YYYY-MM-DD）. In English use user stated:, user believes:, assistant suggested (adopted): / assistant suggested (declined): / assistant suggested (not answered):, or document says:; end with (recorded YYYY-MM-DD). Translate the labels for other conversation languages; after a sensitive source label and its colon include the literal metadata marker [sensitive]. The document label names the document when known. Silence means not answered, never adopted. An explicit later adoption or decline updates the outcome and date; retain its earlier outcome as dated history with the same source label.
A stance on politics, religion, health or another sensitive subject uses 用户观点（敏感）： or user believes (sensitive): instead. Keep it in a separate NOTES file from non-sensitive material. This marker sets the existing file-level sensitive flag: it excludes the whole file from ordinary recall and sharing. Never infer a stance from a question; never put a sensitive stance in PROFILE or PREFERENCES.
When a value changes in PROFILE, PREFERENCES, PROJECT_CONTEXT or ENTITIES (as in PEOPLE and NOTES), keep the current line first with its stated date, followed by one dated earlier line for EACH distinct superseded value: earlier: X (until YYYY-MM-DD), or 曾为：X（截至 YYYY-MM-DD） in Chinese. X is the previous complete statement, including the subject and any source label; until is the conversation date on which it changed, never an invented date. If that date is unavailable, say unknown / 未知. Current means the unprefixed line; an earlier / 曾为 line is historical, never the current choice. For NOTES keep the source label first and put the earlier wrapper after it, before the recorded date. Preserve older history through a second or later change. Keep history in the SAME file and section, never route it elsewhere or silently erase it. In profile the current bullet keeps (as of YYYY-MM-DD); history bullets end with their until date instead. Preferences may carry their stated date. Dates supplied as values remain verbatim even when the conversation date is formatted as YYYY-MM-DD.
Reuse an existing subject/topic file; merge exact duplicates, never merge different people or distinct values. Keep one current line per changing attribute, one earlier line per distinct value and end date, and one suggestion per proposal with its outcomes. Do not copy the whole conversation or pad history with unchanged confirmations. Compact wording around exact anchors, never omit an anchor or earlier value to meet a soft length target. Memory preferences, forgetting and all never-kept boundaries override retention.`;

/** @param {string} text @returns {{ value: string, until: string, prefix: string, suffix: string } | null} */
export function memoryHistoryLine(text) {
  const match = /^(earlier: |曾为：)(.+?)( \(until (\d{4}-\d{2}-\d{2}|unknown)\)|（截至 (\d{4}-\d{2}-\d{2}|未知)）)$/.exec(text.trim());
  return match ? { value: match[2], until: match[4] ?? match[5], prefix: match[1], suffix: match[3] } : null;
}

/** Count every NOTES statement with no source label: a conservative format metric, not a semantic opinion detector.
 * Malformed labels/outcomes/dates are counted separately. Headings and the platform's source-change notice are not statements.
 * @param {string} body
 */
export function checkMemoryNoteLabels(body) {
  let checked = 0, missingLabel = 0, malformed = 0, sensitive = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    if (!line || /^#{1,6}\s/.test(line) || line.startsWith('> 来源变更：')) continue;
    checked++;
    // Translated labels still have a language-independent explicit privacy marker; no subject inference.
    sensitive ||= /^[^:：]+[:：]\s*\[sensitive\]/.test(line);
    const label = /^(?:user stated:|user believes(?: \(sensitive\))?:|assistant suggested \((?:adopted|declined|not answered)\):|document says:|用户陈述：|用户观点(?:（敏感）)?：|助手建议（(?:已采纳|未采纳|未答复)）：|文档声称：)/.exec(line);
    // Recognize an attempted protocol label only, not words somewhere in the sentence.
    if (!label) {
      if (/^(?:assistant suggested|user believes|user stated|document says|用户陈述|用户观点|助手建议|文档声称)[:：（(]/.test(line)) malformed++;
      else missingLabel++;
      continue;
    }
    sensitive ||= label[0] === 'user believes (sensitive):' || label[0] === '用户观点（敏感）：';
    if (!/(?:\(recorded \d{4}-\d{2}-\d{2}\)|（记录日期 \d{4}-\d{2}-\d{2}）)$/.test(line) || !line.slice(label[0].length).replace(/(?:\(recorded [^)]+\)|（记录日期 [^）]+）)$/, '').trim()) malformed++;
  }
  return { checked, missingLabel, malformed, sensitive };
}

/** Shared by the existing consolidation and verification requests; no extra call. */
export const MEMORY_EXTRACTION_V2_REVIEW_TEXT = 'An earlier: / 曾为： line is dated history, not a stale current assertion. Preserve every distinct prior value and its end date, the unprefixed current value, exact names/numbers/units, and the source label, suggestion outcome/date and sensitive marker. Do not collapse history into the current choice or promote attributed claims to facts. Deduplicate only unchanged repetitions.';
