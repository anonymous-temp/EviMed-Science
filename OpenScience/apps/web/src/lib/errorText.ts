/**
 * The one place a raw `Error.message` may be read.
 *
 * `webErrorMessage` answers for anything the control plane refused: it has an
 * error code and a registry sentence for it. A file that will not parse has
 * neither — the message comes from a third-party parser, in English, and it is
 * also the only diagnostic there is ("unexpected byte at offset 12" is the
 * answer to "why won't this open?").
 *
 * So the frame is Chinese and states what failed, and the parser's own words
 * follow marked as technical detail rather than as the sentence. The ESLint
 * rule that bans the raw idiom everywhere else is disabled once, here, on
 * purpose: one exception with a reason beats fifty without one.
 */
export function parseFailureMessage(error: unknown, subject: string): string {
  // eslint-disable-next-line no-restricted-syntax -- see the note above: this is the single sanctioned read
  const detail = (error instanceof Error ? error.message : String(error)).trim();
  return detail ? `无法解析${subject}。技术信息：${detail}` : `无法解析${subject}。`;
}
