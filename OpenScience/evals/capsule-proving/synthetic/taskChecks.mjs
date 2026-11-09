/**
 * Format checks for repeated-task replies: closed formats only, never meaning (principle 5).
 * @module capsule-proving/synthetic/taskChecks
 */

/** Format checks only (principle 5): no check reads meaning. Anything else is judged. */
export const CHECK_KINDS = {
  pattern: 'the reply must contain a match of this regular expression (formats only: dates, numbering, units)',
  forbidPattern: 'the reply must not contain a match of this regular expression',
  maxChars: 'the reply body is at most this many characters',
  startsWith: 'the reply\'s first non-empty line starts with this text',
  endsWith: 'the reply\'s last non-empty line ends with this text',
  table: 'the reply contains a Markdown table',
  judge: 'a reading is needed; give a one-sentence rubric',
};

/** Whether a reply satisfies a format check; `null` for `judge`. */
export function checkReply(check, reply) {
  const text = String(reply ?? '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  switch (check.kind) {
    case 'pattern': return new RegExp(check.value, 'u').test(text);
    case 'forbidPattern': return !new RegExp(check.value, 'u').test(text);
    case 'maxChars': return text.replace(/\s/g, '').length <= Number(check.value);
    case 'startsWith': return (lines[0] ?? '').replace(/^[#>*\s]+/, '').startsWith(check.value);
    case 'endsWith': return (lines.at(-1) ?? '').endsWith(check.value);
    case 'table': return /^\s*\|.+\|\s*$/m.test(text) && /^\s*\|\s*:?-{3,}/m.test(text);
    default: return null;
  }
}
