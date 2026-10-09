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
