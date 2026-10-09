import { describe, expect, it } from 'vitest';
import { findPdfQuotationPage, markPdfQuotation } from './pdfQuotation';

describe('PDF quotation page location without parser pages', () => {
  const pdf = (pages: string[][]) => ({ numPages: pages.length, getPage: async (page: number) => ({
    getTextContent: async () => ({ items: pages[page - 1].map(str => ({ str })) }),
  }) });
  it('finds the actual page across line breaks without changing quoted numbers', async () => {
    const source = pdf([['Cover'], ['The measured response ', 'was eighteen percent.'], ['Appendix']]);
    expect(await findPdfQuotationPage(source, 'The measured response was eighteen percent.', new AbortController().signal)).toBe(2);
    expect(await findPdfQuotationPage(source, 'The measured response was eighty percent.', new AbortController().signal)).toBeNull();
  });
  it('does not guess between repeated pages or repeated passages', async () => {
    for (const pages of [[['Trial 12.'], ['Trial 12.']], [['Trial 12. Trial 12.']]]) {
      expect(await findPdfQuotationPage(pdf(pages), 'Trial 12.', new AbortController().signal)).toBeNull();
    }
  });
  it('stops reading a document when the reader closes or changes it', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = { numPages: 3, getPage: async () => { throw new Error('Must not read a canceled document'); } };
    expect(await findPdfQuotationPage(source, 'Trial 12.', controller.signal)).toBeNull();
  });
});

describe('PDF quotation painting', () => {
  it('marks only the quoted characters across text spans and line breaks', () => {
    const strings = ['Before. The trial', ' reported 12 participants.', ' After.'];
    const divs = strings.map(text => { const span = document.createElement('span'); span.textContent = text; return span; });
    expect(markPdfQuotation(divs, strings, 'The trial\nreported 12 participants.')).toBe(true);
    expect(divs.map(div => div.textContent)).toEqual(strings);
    expect(divs.map(div => div.querySelector('mark')?.textContent ?? '').join('')).toBe('The trial reported 12 participants.');
  });
  it('does not choose between repeated passages or mark a changed number', () => {
    const div = document.createElement('span');
    expect(markPdfQuotation([div], ['Trial 12. Trial 12.'], 'Trial 12.')).toBe(false);
    expect(markPdfQuotation([div], ['Trial 12.'], 'Trial 120.')).toBe(false);
    expect(div.querySelector('mark')).toBeNull();
  });
});
