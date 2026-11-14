/**
 * The eligibility text of a ChiCTR record, read from the record's page (G10, owner decisions of 2026-11-04).
 *
 * The shared evidence API lists a ChiCTR trial with its title, condition, status, phase and address, and no eligibility text, and the registry's own
 * pages refuse a plain request (an Alibaba WAF answers 405). So a Chinese trial was listed and every one of its criteria read as unknown. The page is
 * public, and the platform already has one way to read a public page: the web reader (`webRead.mjs`), which checks the address and pins the socket to
 * it, honours robots.txt, paces one site, and draws a page in a browser where one is configured. This module calls that reader and does nothing the
 * reader would refuse; it cuts the two labelled sections out of what the reader returns.
 *
 * Hidden knowledge:
 *
 * - **Locating the two sections is format, not language.** ChiCTR's record is one fixed template: a table with a row per field, the Chinese label row
 *   (`纳入标准：`) and then the English one (`Inclusion criteria`), each `| label | value |` in the reader's text. The labels are a closed list, the
 *   value is the next cell, and no sentence is read. A page that holds neither section (an unknown record id answers a page with nothing in it, a
 *   page that did not finish drawing, a template that changed) has no eligibility text, and the pair is judged on the title and the condition.
 * - **The Chinese row is taken when it has words, the English one when it does not.** The Chinese is what the registrant wrote; the English is often a
 *   shorter translation of it (a measured record had four exclusions in English against six in Chinese).
 * - **A failure is remembered, a success is kept, and neither blocks anything.** The attempt is made at most once for a trial within `failureHours`
 *   whatever came of it, so a job of thousands of pairs asks a browser for a page once, not once per pair; a page that read is kept `pageDays` days, and
 *   while it is kept the same words come back, so the record's hash is stable. A page that cannot be read again after its days keep the words it had.
 *   Whatever goes wrong here (the reader, the database, the deadline) is a pair judged on what the listing carries, never a refusal.
 * - **Public text, no account.** The page is the registry's, the row belongs to no study and no account, and there is nothing of a patient in it.
 *
 * @module vcrRegistryPages
 */

import { createHash } from 'node:crypto';
import { VCR_SCHEMA } from './vcrPersistence.mjs';
import { VcrStoreBase } from './vcrStoreBase.mjs';

const HOURS = 3_600_000;
const DAYS = 24 * HOURS;
/** The most of a page's eligibility text kept: a registry page is far below it, so this only stops a page that is not one. */
const MAX_CHARS = 60_000;
/** The hosts whose pages are read for a ChiCTR record: the listing's address is another service's word, and only the registry's own site is asked. */
const CHICTR_HOSTS = Object.freeze(['www.chictr.org.cn', 'chictr.org.cn']);

/** The labels of the two sections in ChiCTR's template, lower-cased and without their trailing colon, by language. */
const SECTIONS = Object.freeze({
  inclusion: Object.freeze({ zh: ['纳入标准', '入选标准', '入组标准'], en: ['inclusion criteria', 'inclusion criterion', 'participant inclusion criteria'] }),
  exclusion: Object.freeze({ zh: ['排除标准'], en: ['exclusion criteria', 'exclusion criterion', 'participant exclusion criteria'] }),
});
const HEADINGS = Object.freeze({ inclusion: 'Inclusion Criteria:', exclusion: 'Exclusion Criteria:' });
/** A line of the form `label: words`, with the emphasis marks a reader may leave around the label. */
const LABELLED_LINE = /^[\s*_#>-]*([^：:|]{2,40}?)[*_]*\s*[：:]\s*(.*)$/u;

const tidy = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
/**
 * Which section a label cell names, and in which language, or null. A cell is one label (`纳入标准：`, `Inclusion criteria`) or both (`纳入标准： Inclusion
 * criteria：`, as some of the template's rows are written); the Chinese is taken first. A long cell is a value, not a label.
 * @param {unknown} cell @returns {{ side: 'inclusion' | 'exclusion', language: 'zh' | 'en' } | null}
 */
function sectionOf(cell) {
  const label = tidy(cell).replace(/[：:]/gu, ' ').toLowerCase();
  if (!label || label.length > 80) return null;
  for (const language of /** @type {const} */ (['zh', 'en'])) {
    for (const side of /** @type {const} */ (['inclusion', 'exclusion'])) {
      if (SECTIONS[side][language].some((name) => label.includes(name))) return { side, language };
    }
  }
  return null;
}

/** The cells of one row of the reader's table text (`| a | b |`, a pipe inside a cell is `\|`), or null when the line is no row. @param {string} line */
function rowCells(line) {
  const text = line.trim();
  if (!text.startsWith('|')) return null;
  return text.replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\\|/gu, '|').trim());
}

/**
 * The inclusion and exclusion text of a ChiCTR record page as the web reader returned it, or null when neither section is there. The text keeps the
 * registrant's own words in their own order; what is added is the two headings, so that the clause splitter reads which side each clause is on.
 *
 * @param {unknown} pageText
 * @returns {{ eligibility: string, sections: { inclusion: boolean, exclusion: boolean }, language: { inclusion: 'zh' | 'en' | null, exclusion: 'zh' | 'en' | null } } | null}
 */
export function chictrEligibilityFrom(pageText) {
  const lines = String(pageText ?? '').split(/\r?\n/u);
  /** @type {Record<string, { zh: string, en: string }>} */
  const found = { inclusion: { zh: '', en: '' }, exclusion: { zh: '', en: '' } };
  for (let at = 0; at < lines.length; at += 1) {
    const cells = rowCells(lines[at]);
    /** @type {ReturnType<typeof sectionOf>} */
    let named = null;
    let value = '';
    if (cells && cells.length >= 2) {
      named = sectionOf(cells[0]);
      value = tidy(cells[1]);
    } else if (!cells) {
      // Outside a table the label starts a line, with its words after a colon and on the lines that follow, up to a blank line or the other section.
      const inline = LABELLED_LINE.exec(lines[at]);
      named = inline ? sectionOf(inline[1]) : null;
      if (!inline || !named) continue;
      const rest = [inline[2]];
      for (let next = at + 1; next < lines.length && tidy(lines[next]) && !rowCells(lines[next]); next += 1) {
        const labelled = LABELLED_LINE.exec(lines[next]);
        if (labelled && sectionOf(labelled[1])) break;
        rest.push(lines[next]);
      }
      value = tidy(rest.join(' '));
    }
    if (named && value && !found[named.side][named.language]) found[named.side][named.language] = value;
  }
  /** @type {string[]} */
  const parts = [];
  const language = /** @type {{ inclusion: 'zh' | 'en' | null, exclusion: 'zh' | 'en' | null }} */ ({ inclusion: null, exclusion: null });
  for (const side of /** @type {const} */ (['inclusion', 'exclusion'])) {
    const chosen = found[side].zh ? 'zh' : found[side].en ? 'en' : null;
    if (!chosen) continue;
    language[side] = chosen;
    parts.push(`${HEADINGS[side]}\n${found[side][chosen]}`);
  }
  if (!parts.length) return null;
  return { eligibility: parts.join('\n\n').slice(0, MAX_CHARS), sections: { inclusion: Boolean(language.inclusion), exclusion: Boolean(language.exclusion) }, language };
}

/** The registry-page cache: one row per registry and id, public text, no study. @extends VcrStoreBase */
export class VcrRegistryPageStore extends VcrStoreBase {
  /**
   * A write of its own, outside whatever transaction the caller holds: the row is public text keyed by registry and id, and written inside a
   * matching commit it stayed locked until that commit ended and was lost when the commit was. Production 2026-11-14: 104 writes cancelled waiting
   * on such a row, and 56 pages asked 327 times because the remembered failure did not last.
   * @param {string} sql @param {unknown[]} values
   */
  apart(sql, values) {
    return typeof this.database.withoutTransactionClient === 'function' ? this.database.withoutTransactionClient(() => this.query(sql, values)) : this.query(sql, values);
  }
  /** @param {{ registry: string, registryId: string }} key */
  async get({ registry, registryId }) {
    const row = await this.one(`SELECT * FROM ${VCR_SCHEMA}.registry_pages WHERE registry=$1 AND registry_id=$2`, [registry, registryId]);
    return row ? {
      status: String(row.status), eligibility: String(row.eligibility ?? ''), url: String(row.url ?? ''), source: String(row.source ?? 'web_read'), reason: row.reason ?? null,
      fetchedAt: row.fetched_at ? new Date(row.fetched_at) : null, attemptedAt: new Date(row.attempted_at),
    } : null;
  }

  /** A page that read: its words, replacing whatever was there. @param {{ registry: string, registryId: string, url: string, eligibility: string, at: Date }} entry */
  async saveRead({ registry, registryId, url, eligibility, at }) {
    await this.apart(`INSERT INTO ${VCR_SCHEMA}.registry_pages (registry, registry_id, status, eligibility, url, source, text_hash, reason, fetched_at, attempted_at)
      VALUES ($1,$2,'ok',$3,$4,'web_read',$5,NULL,$6,$6)
      ON CONFLICT (registry, registry_id) DO UPDATE SET status='ok', eligibility=EXCLUDED.eligibility, url=EXCLUDED.url, source=EXCLUDED.source, text_hash=EXCLUDED.text_hash,
        reason=NULL, fetched_at=EXCLUDED.fetched_at, attempted_at=EXCLUDED.attempted_at`,
    [registry, registryId, eligibility, url, createHash('sha256').update(eligibility, 'utf8').digest('hex'), at.toISOString()]);
  }

  /** An attempt that gave nothing: when, and why. Words an earlier read kept stay. @param {{ registry: string, registryId: string, url: string, reason: string, at: Date }} entry */
  async saveFailed({ registry, registryId, url, reason, at }) {
    await this.apart(`INSERT INTO ${VCR_SCHEMA}.registry_pages (registry, registry_id, status, url, reason, attempted_at) VALUES ($1,$2,'failed',$3,$4,$5)
      ON CONFLICT (registry, registry_id) DO UPDATE SET reason=EXCLUDED.reason, attempted_at=EXCLUDED.attempted_at`, [registry, registryId, url, reason, at.toISOString()]);
  }
}

/** What the page reader counts, for the operator's metric family (principle 15). */
export function createRegistryPageCounters() {
  return { read: 0, fromCache: 0, notLocated: 0, failed: 0, remembered: 0, keptOld: 0 };
}

/** The page's own deadline: the reader gets a signal and the pair gets its answer on time even from a reader that ignores it. @template T @param {Promise<T>} work @param {number} ms */
function withDeadline(work, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The page did not read in time.'), { code: 'registry_page_timeout' })), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ store: VcrRegistryPageStore, webReader: { read: (url: string, options?: any) => Promise<{ text: string }> } | null, config?: Record<string, any>,
 *   report?: (code: string) => void, counters?: ReturnType<typeof createRegistryPageCounters>, now?: () => Date }} deps
 */
export function createRegistryPages({ store, webReader, config = {}, report = () => {}, counters = createRegistryPageCounters(), now = () => new Date() }) {
  const keptFor = Math.max(1, Number(config.vcrRegistryPageDays ?? 7) || 7) * DAYS;
  const failureFor = Math.max(1, Number(config.vcrRegistryPageFailureHours ?? 6) || 6) * HOURS;
  const timeoutMs = Math.max(1_000, Number(config.vcrRegistryPageTimeoutMs ?? 45_000) || 45_000);
  /** @type {Map<string, Promise<{ eligibility: string, url: string, fetchedAt: string, source: string } | null>>} one attempt at a time for one page */
  const open = new Map();

  /** @param {{ registry: string, registryId: string, url: string, signal?: AbortSignal, cachedOnly?: boolean }} input */
  async function attempt({ registry, registryId, url, signal, cachedOnly = false }) {
    const held = await store.get({ registry, registryId });
    const at = now();
    /** @param {NonNullable<typeof held>} row */
    const answer = (row) => ({ eligibility: row.eligibility, url: row.url || url, fetchedAt: (row.fetchedAt ?? row.attemptedAt).toISOString(), source: row.source });
    const hasWords = Boolean(held && held.status === 'ok' && held.eligibility);
    if (hasWords && held && held.fetchedAt && at.getTime() - held.fetchedAt.getTime() < keptFor) { counters.fromCache += 1; return answer(held); }
    // The caller asks no page (it holds a transaction): the words there are, however old, and nothing is read or written.
    if (cachedOnly) return hasWords && held ? answer(held) : null;
    // Asked recently and nothing came of it, or the words are old and the last ask failed: the words there are, if any, and no new ask.
    if (held && at.getTime() - held.attemptedAt.getTime() < failureFor && (held.status === 'failed' || held.reason)) {
      counters.remembered += 1;
      return hasWords ? answer(held) : null;
    }
    /** @type {string} */
    let reason;
    try {
      const page = await withDeadline(/** @type {NonNullable<typeof webReader>} */ (webReader).read(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }), timeoutMs);
      const located = chictrEligibilityFrom(page?.text);
      if (located) {
        await store.saveRead({ registry, registryId, url, eligibility: located.eligibility, at });
        counters.read += 1;
        return { eligibility: located.eligibility, url, fetchedAt: at.toISOString(), source: 'web_read' };
      }
      reason = 'eligibility_not_located';
      counters.notLocated += 1;
    } catch (error) {
      reason = String(/** @type {any} */ (error)?.code ?? 'registry_page_unreadable').slice(0, 80);
      counters.failed += 1;
      report(`registry_page_${reason}`);
    }
    await store.saveFailed({ registry, registryId, url, reason, at });
    if (hasWords && held) { counters.keptOld += 1; return answer(held); }
    return null;
  }

  return {
    counters,
    /**
     * The eligibility text of a ChiCTR record from its page, or null. Never throws and never waits longer than the deadline: a null is a pair judged on
     * what the listing carries.
     * `cachedOnly` reads what is held and asks the site nothing.
     * @param {{ registry: string, registryId: string, url?: string | null, signal?: AbortSignal, cachedOnly?: boolean }} input
     * @returns {Promise<{ eligibility: string, url: string, fetchedAt: string, source: string } | null>}
     */
    async eligibilityFor({ registry, registryId, url, signal, cachedOnly = false }) {
      if (config.vcrRegistryPagesEnabled === false || String(registry).toLowerCase() !== 'chictr' || !webReader?.read || !registryId) return null;
      let address;
      try { address = new URL(String(url ?? '')); } catch { return null; }
      if (address.protocol !== 'https:' || !CHICTR_HOSTS.includes(address.hostname)) return null;
      if (cachedOnly) return attempt({ registry: 'chictr', registryId: String(registryId), url: address.href, cachedOnly: true }).catch(() => null);
      const key = `chictr\u0000${registryId}`;
      const running = open.get(key);
      if (running) return running;
      const work = attempt({ registry: 'chictr', registryId: String(registryId), url: address.href, signal }).catch((error) => {
        report(`registry_page_${String(/** @type {any} */ (error)?.code ?? 'failed')}`);
        return null;
      }).finally(() => { open.delete(key); });
      open.set(key, work);
      return work;
    },
  };
}
