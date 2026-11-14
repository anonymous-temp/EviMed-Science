/** Extraction-v2's line protocol. This checks syntax, never the truth or meaning of a statement. */
export const MEMORY_EXTRACTION_V2_FORMAT_TEXT = `# Exactness, attribution and history (extraction-v2)
Copy names, numbers with units, dates and identifiers exactly as said, including model numbers, drug names and doses. Do not round, translate identifiers, substitute or silently paraphrase an anchor. If unsure which type fits, keep the person's sentence verbatim in NOTES with its conversation date and source label; the hard boundaries still apply.
Useful opinions, stances, assistant suggestions (including declined and unanswered ones) and document claims: keep, labelled. Source labels apply in every memory type, including PREFERENCES; NOTES labels every statement. Each is a self-contained bullet, context rather than fact or permission. Opinions and unadopted suggestions belong in NOTES, never as standing preferences. A suggestion proposes a concrete action or choice for the user to consider. Explanations, definitions and hypothetical examples are not suggestions; retain them only if useful, with their actual source. In Chinese use 用户陈述：, 用户观点：, 助手建议（已采纳）： / 助手建议（未采纳）： / 助手建议（未答复）：, or 文档声称：; end with （记录日期 YYYY-MM-DD）. In English use user stated:, user believes:, assistant suggested (adopted): / assistant suggested (declined): / assistant suggested (not answered):, or document says:; end with (recorded YYYY-MM-DD). Name the document when known. Translate labels for other languages; put [sensitive] after a sensitive label's colon. Silence means not answered, never adopted. Update an explicitly changed outcome/date; preserve earlier outcomes as dated history under the same label.
Sensitive stances (politics, religion, health or other sensitive subjects) use 用户观点（敏感）： or user believes (sensitive): in a separate NOTES file. This sets the file's sensitive flag, excluding it from ordinary recall and sharing. Never infer a stance from a question or put a sensitive stance in PROFILE or PREFERENCES.
For changing values in PROFILE, PREFERENCES, PROJECT_CONTEXT, ENTITIES, PEOPLE and NOTES, keep the current line first with its stated date, then EACH distinct earlier value: earlier: X (until YYYY-MM-DD), or 曾为：X（截至 YYYY-MM-DD）. X retains the complete statement, subject and source label; until is the conversation date of the change, or unknown / 未知, never invented. Only the unprefixed line is current. In NOTES put the source label before the earlier wrapper and the recorded date after it. Preserve all history through later changes in the SAME file and section. In profile current bullets end with (as of YYYY-MM-DD), history with their until date. Preferences may carry their stated date. Dates that are values remain verbatim.
Reuse the subject/topic file; merge exact duplicates, never different people or values. Keep one current line per attribute, one earlier line per distinct value/end date, one suggestion per proposal with its outcomes. Omit whole-conversation copies and unchanged confirmations; compact wording, never anchors or history, to meet soft length targets. Memory preferences, forgetting and never-kept boundaries override retention.`;

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
