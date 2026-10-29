/** Exact calendar-date binding for newly extracted facts. It does not infer clinical dates from metadata. */
/** @param {string} value @param {string} quote */
export function clinicalDateInQuote(value, quote) {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(String(value));
  if (!date || !Number.isFinite(Date.parse(value))) return false;
  const wanted = `${date[1]}-${date[2]}-${date[3]}`;
  if (new Date(Date.UTC(Number(date[1]), Number(date[2])-1, Number(date[3]))).toISOString().slice(0,10) !== wanted) return false;
  for (const match of String(quote).matchAll(/(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日)?(?!\d)/gu)) {
    if (`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}` === wanted) return true;
  }
  const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const printed = new RegExp(`(?<![A-Za-z0-9])(?:${month}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}|\\d{1,2}\\s+${month}\\.?[,]?\\s+\\d{4})(?!\\d)`, 'gi');
  for (const match of String(quote).matchAll(printed)) {
    const parsed = Date.parse(match[0].replace(/(\d)(st|nd|rd|th)/gi, '$1') + ' UTC');
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,10) === wanted) return true;
  }
  return false;
}

/** A relative interval needs a quoted calendar anchor and an explicitly selected literal duration.
 * @param {{start:string,end:string}} interval @param {string} quote @param {string|null|undefined} dateSurface */
export function clinicalIntervalInQuote(interval, quote, dateSurface) {
  if (!interval) return true;
  const startKnown = clinicalDateInQuote(interval.start, quote), endKnown = clinicalDateInQuote(interval.end, quote);
  if (startKnown && endKnown) return true;
  if ((!startKnown && !endKnown) || !dateSurface || !quote.includes(dateSurface)) return false;
  const duration = /^(\d+)\s*(days?|weeks?|months?|years?|天|周|月|年)$/iu.exec(dateSurface.trim());
  if (!duration || !Number.isSafeInteger(Number(duration[1]))) return false;
  const value = Number(duration[1]); const unit = duration[2].toLowerCase();
  const anchor = new Date(endKnown ? interval.end : interval.start); const direction = endKnown ? -1 : 1;
  if (/^(?:months?|月)$/u.test(unit)) anchor.setUTCMonth(anchor.getUTCMonth()+direction*value);
  else if (/^(?:years?|年)$/u.test(unit)) anchor.setUTCFullYear(anchor.getUTCFullYear()+direction*value);
  else anchor.setUTCDate(anchor.getUTCDate()+direction*value*(/^(?:weeks?|周)$/u.test(unit)?7:1));
  return Number.isFinite(anchor.getTime()) && anchor.getTime() === Date.parse(endKnown ? interval.start : interval.end);
}
