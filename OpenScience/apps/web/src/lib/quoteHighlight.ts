/**
 * Finding a quotation in a rendered source, so 「在保存的原文中定位这段引文」
 * lands on the words the claim rests on rather than on the top of a
 * forty-page paper (plan §5 act 4: 「点引用……高亮原文」).
 *
 * The match ignores whitespace runs and letter case, because the rendered text
 * reflows what the extractor preserved; it does not ignore anything else. An
 * elided quotation (「A … B」) is located by its first part — the gate checks
 * each side on its own, and the reader needs a place to start, not a proof.
 * No match is no highlight: a quotation that is not in the source is exactly
 * what the reader came to see, and the page says so.
 */

const HIGHLIGHT = "evimed-quote";

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The part of a quotation to look for: the text before the first elision mark. */
export function quoteNeedle(quote: string): string {
  return normalized(quote.split(/…|\.{3}/)[0] ?? "");
}

/** A range over the first occurrence of the quotation in the root's text, or null. */
export function findQuoteRange(root: Node, quote: string): Range | null {
  const needle = quoteNeedle(quote);
  if (needle.length < 4 || typeof document === "undefined") return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const positions: { node: Text; offset: number }[] = [];
  let text = "";
  let space = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const data = node.data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const character = data[offset];
      if (/\s/.test(character)) {
        if (space) continue;
        text += " ";
        space = true;
      } else {
        text += character.toLowerCase();
        space = false;
      }
      positions.push({ node, offset });
    }
  }
  const index = text.indexOf(needle);
  if (index < 0) return null;
  const start = positions[index];
  const end = positions[index + needle.length - 1];
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(): { highlights: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight ? { highlights: css.highlights, Highlight } : null;
}

/**
 * Marks the quotation (CSS Custom Highlight API, styled in index.css as
 * `::highlight(evimed-quote)`) and scrolls it into view. Returns whether the
 * quotation was found; a browser without the API still gets the scroll.
 */
export function highlightQuote(root: HTMLElement, quote: string): boolean {
  const range = findQuoteRange(root, quote);
  if (!range) return false;
  registry()?.highlights.set(HIGHLIGHT, new (registry()!.Highlight)(range));
  const element = range.startContainer.parentElement;
  if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
  return true;
}

export function clearQuoteHighlight(): void {
  registry()?.highlights.delete(HIGHLIGHT);
}
