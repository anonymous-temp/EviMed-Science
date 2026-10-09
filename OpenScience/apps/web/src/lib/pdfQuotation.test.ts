import { describe, expect, it } from 'vitest';
import { markPdfQuotation } from './pdfQuotation';

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
