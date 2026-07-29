/**
 * The model sometimes leaks internal bookkeeping tokens into assistant prose:
 * raw HTML comments (`<!-- claim:CLM-006 -->`) and literal claim markers
 * (`[claim:CLM-006]`, `【claim:CLM-006】`). Neither is meant for the reader, so
 * they are stripped before the prose is rendered as chat markdown.
 *
 * Code is content, not prose — an HTML comment inside a fenced ```html sample
 * or an inline `code` span must survive — so stripping only happens outside
 * code. Citation-style brackets (`[1]`) never match the claim pattern.
 */

// A protected segment is a fenced code block (``` / ~~~, closed or still open
// while streaming) or an inline code span. split() keeps the captures, so
// protected segments sit at odd indexes and are passed through verbatim.
const CODE = /((?:^|\n)(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n(?:`{3,}|~{3,})[^\n]*(?=\n|$)|$)|`[^`\n]+`)/g;

// A closed comment, or one still streaming in (runs to the end of the segment).
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

// `[claim:CLM-006]` / `【claim: CLM-006】` — any case, tolerant of whitespace
// and of the fullwidth colon a Chinese-writing model may use.
const CLAIM_MARKER = /[[【]\s*claim\s*[:：]\s*clm\s*-?\s*\d+[\w-]*\s*[\]】]/gi;

export function sanitizeAssistantText(text: string): string {
  return text
    .split(CODE)
    .map((segment, i) =>
      i % 2 === 1 ? segment : segment.replace(HTML_COMMENT, "").replace(CLAIM_MARKER, ""),
    )
    .join("");
}
