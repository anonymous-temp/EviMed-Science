interface PdfTextDocument {
  numPages: number;
  getPage(page: number): Promise<{ getTextContent(): Promise<{ items: readonly unknown[] }> }>;
}

/** Locate a verified quotation in the original PDF when the parser supplied no page map. Ambiguous passages stay unknown. */
export async function findPdfQuotationPage(pdf: PdfTextDocument, quote: string, signal: AbortSignal): Promise<number | null> {
  const needle = quote.replace(/\s/g, "");
  if (!needle) return null;
  let found: number | null = null;
  for (let page = 1; page <= pdf.numPages; page++) {
    if (signal.aborted) return null;
    const source = await pdf.getPage(page);
    if (signal.aborted) return null;
    const content = await source.getTextContent();
    if (signal.aborted) return null;
    const text = content.items.map(item => item && typeof item === "object" && "str" in item && typeof item.str === "string" ? item.str : "").join("").replace(/\s/g, "");
    const start = text.indexOf(needle);
    if (start < 0) continue;
    if (found !== null || text.indexOf(needle, start + 1) >= 0) return null;
    found = page;
  }
  return found;
}

/** The server has verified the preserved quotation. This mapping only paints its unique match in a PDF text layer. */
export function markPdfQuotation(divs: readonly HTMLElement[], strings: readonly string[], quote: string): boolean {
  const flat: Array<{ index: number; start: number; end: number }> = [];
  let text = "";
  strings.forEach((value, index) => {
    for (let start = 0; start < value.length;) {
      const character = String.fromCodePoint(value.codePointAt(start)!);
      const end = start + character.length;
      if (!/\s/.test(character)) {
        text += character;
        for (let unit = start; unit < end; unit++) flat.push({ index, start, end });
      }
      start = end;
    }
  });
  const needle = quote.replace(/\s/g, "");
  const found = needle ? text.indexOf(needle) : -1;
  if (found < 0 || text.indexOf(needle, found + 1) >= 0) return false;
  const first = flat[found], last = flat[found + needle.length - 1];
  for (let index = first.index; index <= last.index; index++) {
    const div = divs[index];
    if (!div) return false;
    const value = strings[index];
    const start = index === first.index ? first.start : 0;
    const end = index === last.index ? last.end : value.length;
    const mark = document.createElement("mark");
    mark.textContent = value.slice(start, end);
    div.replaceChildren(document.createTextNode(value.slice(0, start)), mark, document.createTextNode(value.slice(end)));
  }
  return true;
}
