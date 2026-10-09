import { locateSourceQuotation } from '@evimed/domain';
import { projectSourceManifestRecord } from './sourceService.mjs';
import { HttpError } from './security.mjs';

/** A quote is read from the source's current immutable capture, regardless of how the run read it. */
export async function locateSourceQuote(service, userId, source, quote) {
  if (typeof quote !== 'string' || quote.trim().length < 4 || quote.length > 2000) {
    throw new HttpError(400, 'source_payload_invalid', 'A quotation must contain 4 to 2000 characters.');
  }
  const capture = await service.loadCapture(userId, source);
  const identity = { sourceId: source.id, title: projectSourceManifestRecord(source).display.title,
    generation: source.payload.generation, quote };
  if (!capture) return { ...identity, status: 'source_unavailable', start: null, end: null, page: null, textSha256: null };
  return { ...identity, textSha256: source.payload.analysis.textSha256,
    ...locateSourceQuotation({ text: capture.input.text, quote, pageMap: capture.pageMap ?? [] }) };
}

/** The reader revalidates the version and offsets; a refreshed document cannot silently inherit an old highlight. */
export async function sourceQuoteExcerpt(service, userId, source, params) {
  const start = Number(params.get('start'));
  const end = Number(params.get('end'));
  if (!params.has('start') || !params.has('end') || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end - start > 2000) throw new HttpError(400, 'source_payload_invalid', 'Invalid quotation offsets.');
  const capture = await service.loadCapture(userId, source);
  if (!capture || source.payload.analysis.textSha256 !== params.get('sha') || end > capture.input.text.length) {
    return { status: 'unavailable', text: null, quote: null, start: null, end: null, page: null };
  }
  const from = Math.max(0, start - 300);
  const text = capture.input.text.slice(from, end + 300);
  const pages = (capture.pageMap ?? []).filter(row => row.start <= start && row.end >= end);
  return { status: 'available', text, quote: capture.input.text.slice(start, end), start: start - from, end: end - from,
    page: pages.length === 1 ? pages[0].page : null };
}
