import { FRONTIER_LANES, FRONTIER_LANE_LABELS_ZH, frontierSourceDisplayName } from "@evimed/domain";
import { clockMinutes, zonedClock, zonedInstant } from "./frontierDaily.mjs";
import { isChineseProse, trimToWholeSentences } from "./frontierEditor.mjs";
import { frontierEventRole } from "./frontierEvents.mjs";
import { FrontierJobRearm } from "./frontierJobRearm.mjs";
import { checkNumbers } from "./frontierNumbers.mjs";
import { migrateFrontier } from "./frontierPersistence.mjs";
import { frontierWeeklyRows } from "./frontierWeekly.mjs";

/**
 * The frontier feed's monthly report (「前沿动态」 月报, 2026-10-22), beside the weekly.
 *
 * After AIHOT's `packages/backend/src/reports/compose.ts` (MIT, KKKKhazix/AIHOT 47531fa): a month is compiled from its
 * dailies. What it carries is decided by code — the items the month's dailies published, read live (a withdrawn one leaves),
 * one per event, the first-hand report first and then the higher score, thirty at most, grouped by lane, the first one the lead.
 * A model writes only the overview and the introductions of the sections of three or more events
 * (`FrontierEditor.writeMonthly`).
 *
 * Hidden knowledge:
 *
 * - **A written sentence must name only what the entries name** (`frontierGroundedText`). Each sentence is held to the
 *   entries' own words: every number it states is one they state (`frontierNumbers.mjs`), every Latin name in it (a token with
 *   a capital or a digit: FDA, GLP-1, KEYNOTE-189) is in them, and every glossary term it names (a drug, an agency, a trial)
 *   is one they name. A sentence that names anything else is replaced by a template sentence that code writes from the
 *   counts; the same template once, however many sentences it replaces. Nothing the model wrote is softened.
 * - **A month is due from the 1st's daily time** (07:30 in the feed's zone) for the month before, and written once through the
 *   job ledger (`frontier-monthly:<YYYY-MM>`), like the weekly; a month whose dailies published nothing is no issue.
 * - The model call is the feed's (purpose `frontier`, the module's budget); with the budget spent or the call failed the issue
 *   is still written, with its template overview and no introductions.
 *
 * @module frontierMonthly
 */

/** Events a monthly carries, at most (AIHOT's monthly: 30). */
export const FRONTIER_MONTHLY_EVENTS = 30;
/** Characters an overview and an introduction may be (the prompt asks 240 and 50); a section is introduced from three events. */
export const FRONTIER_MONTHLY_LIMITS = Object.freeze({ overview: 340, intro: 90, introEvents: 3 });
const JOB_KIND = "frontier-monthly";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LINK = /https?:\/\/|www\./i;

/** The month after, as `YYYY-MM`. @param {string} month @param {number} [offset] */
export function frontierMonthAdd(month, offset = 1) {
  const [year, number] = month.split("-").map(Number);
  const index = year * 12 + (number - 1) + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * A month's days and window in the zone: [the 1st 00:00, the next 1st 00:00).
 * @param {string} month @param {string} timeZone
 */
export function frontierMonthWindow(month, timeZone) {
  if (!MONTH.test(String(month ?? ""))) throw Object.assign(new Error("Invalid month."), { code: "frontier_month_invalid" });
  const next = frontierMonthAdd(month);
  const last = new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
  return { first: `${month}-01`, last, start: zonedInstant(`${month}-01`, 0, timeZone), end: zonedInstant(`${next}-01`, 0, timeZone) };
}

/**
 * The last complete month whose issue is due: from the 1st's daily time, the month before; until then, the one before that.
 * @param {Date} now @param {{ timeZone: string, dailyTime: string }} options
 */
export function latestFrontierMonth(now, { timeZone, dailyTime }) {
  const { day, minutes } = zonedClock(now, timeZone);
  const month = day.slice(0, 7);
  const due = day.slice(8, 10) !== "01" || minutes >= (clockMinutes(dailyTime) ?? 450);
  return frontierMonthAdd(month, due ? -1 : -2);
}

/** Sentences of a Chinese text: up to and with each sentence end. @param {string} text @returns {string[]} */
function sentences(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().match(/[^。！？]+(?:[。！？]+[」”’）]*|$)/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

/**
 * A written text with every sentence that names anything outside the entries replaced by `template` (once), and then its
 * leading whole sentences that fit `max`; the template alone when nothing of the text stands, or null when there is no template.
 * @param {unknown} text what the model wrote
 * @param {{ corpus: string, max: number, template: string | null, glossary?: { match: (text: string) => Array<{ termEn: string, termZh: string }> } | null }} options
 *   `corpus` the entries' words exactly as the model was shown them; `glossary` the feed's (`FrontierGlossary`)
 * @returns {{ text: string | null, replaced: number }}
 */
export function frontierGroundedText(text, { corpus, max, template, glossary = null }) {
  const known = String(corpus ?? "");
  const lower = known.toLowerCase();
  const kept = [];
  let replaced = 0;
  for (const sentence of sentences(String(text ?? ""))) {
    const latin = (sentence.match(/[A-Za-z][A-Za-z0-9.+\-/]*/g) ?? []).map((word) => word.replace(/[.+\-/]+$/, "")).filter((word) => /[A-Z0-9]/.test(word));
    const terms = glossary ? glossary.match(sentence) : [];
    const grounded = isChineseProse(sentence) && !LINK.test(sentence)
      && !checkNumbers({ sentence }, known).missing.length
      && latin.every((word) => lower.includes(word.toLowerCase()))
      && terms.every((term) => (term.termZh && known.includes(term.termZh)) || (term.termEn && lower.includes(term.termEn.toLowerCase())));
    if (grounded) { kept.push(sentence); continue; }
    replaced += 1;
    if (template && !kept.includes(template)) kept.push(template);
  }
  const joined = kept.join("");
  const fitted = joined ? (([...joined].length <= max ? joined : trimToWholeSentences(joined, max))) : null;
  return { text: fitted || template || null, replaced };
}

/**
 * The month's events from the items its dailies published (read now): one per event, the first-hand report first, then the
 * higher score (`frontierWeeklyRows`), thirty at most; grouped by lane in the vocabulary's order, the first event the lead.
 * @param {any[]} rows
 */
export function frontierMonthlyIssue(rows) {
  const top = frontierWeeklyRows(rows).slice(0, FRONTIER_MONTHLY_EVENTS);
  if (!top.length) return null;
  const groups = FRONTIER_LANES.map((lane) => ({ lane, label: FRONTIER_LANE_LABELS_ZH[lane] ?? lane, rows: top.filter((row) => row.lane === lane) }))
    .filter((group) => group.rows.length);
  return { lead: top[0], top, groups };
}

/** A title or a sentence safe inside Markdown. @param {unknown} text */
function markdownText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().replace(/([\\`*_[\]])/g, "\\$1");
}

/**
 * The issue as Markdown, the way 「复制」 hands it on: the overview, then each section with its introduction and its items,
 * each with its institution and a link to the original; signed 「来源：EviMed 前沿动态」.
 * @param {{ month: string, overview: string | null, sections: Array<{ lane: string, intro: string | null, rows: Array<{ title_zh?: string | null, title_raw: string, summary_zh?: string | null, source_name: string, canonical_url: string }> }> }} issue
 */
export function frontierMonthlyMarkdown({ month, overview, sections }) {
  const [year, number] = month.split("-").map(Number);
  const count = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const parts = [`# EviMed 医学前沿月报 · ${year}年${number}月`, "", `本月精选 ${count} 件要事。`];
  if (overview) parts.push("", "## 本月总述", "", markdownText(overview));
  for (const section of sections) {
    parts.push("", `## ${FRONTIER_LANE_LABELS_ZH[/** @type {keyof typeof FRONTIER_LANE_LABELS_ZH} */ (section.lane)] ?? section.lane}`);
    if (section.intro) parts.push("", markdownText(section.intro));
    parts.push("", ...section.rows.map((row) => `- **${markdownText(row.title_zh || row.title_raw)}**（${markdownText(row.source_name)}）${row.summary_zh ? `：${markdownText(row.summary_zh)}` : ""} [原文](${row.canonical_url})`));
  }
  parts.push("", "---", "", "来源：EviMed 前沿动态", "");
  return parts.join("\n");
}

export class FrontierMonthly {
  /**
   * @param {{ database: any, jobs?: any, editor?: any, owner?: () => any, glossary?: any, config?: Record<string, any>,
   *   budget?: (() => Promise<{ state: string }>) | null, now?: () => Date, workerId?: string }} options
   *   `glossary` a `FrontierGlossaryStore` (`current()`) or a `FrontierGlossary` (`match()`), what a sentence's terms are read by.
   */
  constructor({ database, jobs = null, editor = null, owner = () => null, glossary = null, config = {}, budget = null, now = () => new Date(), workerId = "frontier-monthly" }) {
    if (!database) throw new TypeError("The frontier monthly needs the product database.");
    this.database = database;
    this.jobs = jobs;
    this.editor = editor;
    this.owner = owner;
    this.glossary = glossary;
    this.config = config ?? {};
    this.budgetReader = budget;
    this.now = now;
    this.workerId = String(workerId).slice(0, 120);
    this.timeZone = String(this.config.frontierTimeZone || "Asia/Shanghai");
    this.dailyTime = clockMinutes(this.config.frontierDailyTime) == null ? "07:30" : String(this.config.frontierDailyTime).trim();
    /** Observable counters (principle 15): issues, empty months, failures, sentences replaced by a template, model calls lost. */
    this.counters = { issues: 0, empty: 0, failures: 0, rearmed: 0, replacedSentences: 0, writerFailures: 0 };
    this.rearm = new FrontierJobRearm({ jobs, kind: JOB_KIND, limit: 3, withinMs: 7 * 86_400_000 });
  }

  async ready() { await migrateFrontier(this.database, { dimension: Number(this.config.kbEmbeddingDimension) || 1024 }); }

  /** Called every minute by the composer: the last complete month's issue, once, through the job ledger. */
  async runDue() {
    await this.ready();
    const month = latestFrontierMonth(this.now(), this);
    const owner = this.owner?.();
    if (!this.jobs || !owner) return { ran: false, unavailable: true };
    if ((await this.database.query("SELECT 1 FROM evimed_frontier.monthlies WHERE month = $1", [month])).rowCount) return { ran: false, month };
    this.counters.rearmed += await this.rearm.run(this.now());
    await this.jobs.enqueue(owner.userId, JOB_KIND, { month }, { idempotencyKey: `${JOB_KIND}:${month}`, projectId: owner.projectId, maxAttempts: 3 });
    const job = await this.jobs.claim([JOB_KIND], this.workerId, { leaseMs: 300_000 });
    if (!job) return { ran: false, month };
    try {
      // An old month's retry is finished quietly: the archive is not replayed.
      if (job.payload?.month !== month) {
        await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: "superseded-month" });
        return { ran: false, month };
      }
      const issue = await this.compose(month);
      await this.jobs.renew(job.userId, job.id, job.leaseToken, 300_000);
      await this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { month, empty: !issue }, async (/** @type {any} */ client) => {
        if (!issue) return;
        await client.query(`INSERT INTO evimed_frontier.monthlies (month, window_start, window_end, lead, overview, sections, markdown, item_ids, model,
            written, generated_at)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::bigint[], $9, $10, $11) ON CONFLICT (month) DO NOTHING`,
        [month, issue.window.start, issue.window.end, JSON.stringify(issue.lead), issue.overview, JSON.stringify(issue.sections), issue.markdown,
          issue.itemIds, issue.model, issue.written, this.now()]);
      });
      this.counters[issue ? "issues" : "empty"] += 1;
      return { ran: true, empty: !issue, month };
    } catch (error) {
      this.counters.failures += 1;
      await this.jobs.fail(job.userId, job.id, job.leaseToken, { code: "frontier_monthly_failed", message: "Monthly composition failed." },
        { retry: true, delayMs: 600_000 }).catch(() => { this.counters.failures += 1; });
      throw error;
    }
  }

  /**
   * One month's issue, composed but not stored; null when its dailies published nothing that still stands.
   * @param {string} month
   */
  async compose(month) {
    const window = frontierMonthWindow(month, this.timeZone);
    const rows = (await this.database.query(`SELECT i.*, s.name AS source_name, s.owner_entity AS source_owner, s.source_type AS current_source_type,
        coalesce(e.merged_into, i.event_id) AS event_id
      FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      LEFT JOIN evimed_frontier.events e ON e.id = i.event_id
      WHERE i.id = ANY(ARRAY(SELECT DISTINCT unnest(d.item_ids) FROM evimed_frontier.dailies d WHERE d.day >= $1::date AND d.day <= $2::date))
        AND i.state = 'published' AND s.enabled AND i.verification IN ('passed', 'repaired') AND length(btrim(coalesce(i.summary_zh, ''))) > 0
      ORDER BY i.score_total DESC NULLS LAST, i.visible_at DESC, i.id DESC LIMIT 2000`, [window.first, window.last])).rows.map((/** @type {any} */ row) => ({
      ...row, source_name: frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name, ownerEntity: row.source_owner }),
      primary: frontierEventRole({ sourceType: row.current_source_type, evidenceType: row.evidence_type }) === "primary" }));
    const issue = frontierMonthlyIssue(rows);
    if (!issue) return null;
    const groups = issue.groups.map((group) => ({ label: group.label, intro: group.rows.length >= FRONTIER_MONTHLY_LIMITS.introEvents,
      items: group.rows.map((row) => ({ title: String(row.title_zh || row.title_raw), summary: row.summary_zh ?? null })) }));
    const input = { month, startDate: window.first, endDate: window.last, groups };
    let written = { overview: /** @type {string | null} */ (null), sections: /** @type {Record<string, string>} */ ({}), input: "", error: /** @type {string | null} */ (null) };
    if (this.editor?.available && typeof this.editor.writeMonthly === "function" && await this.#modelAllowed()) {
      written = await this.editor.writeMonthly(input);
      if (written.error) this.counters.writerFailures += 1;
    }
    const glossary = await this.#glossary();
    // The corpus is exactly what the writer was shown (the template sentences are code's and stand on the counts).
    const corpus = written.input || "";
    const overviewTemplate = `本月精选 ${issue.top.length} 件要事，${issue.groups.map((group) => `${group.label} ${group.rows.length} 件`).join("、")}。`;
    const overview = frontierGroundedText(written.overview, { corpus, max: FRONTIER_MONTHLY_LIMITS.overview, template: overviewTemplate, glossary });
    this.counters.replacedSentences += overview.replaced;
    const sections = issue.groups.map((group) => {
      const own = group.rows.length >= FRONTIER_MONTHLY_LIMITS.introEvents ? written.sections[group.label] : null;
      const intro = own ? frontierGroundedText(own, { corpus, max: FRONTIER_MONTHLY_LIMITS.intro, template: `本栏目本月收录 ${group.rows.length} 件要事。`, glossary }) : null;
      if (intro) this.counters.replacedSentences += intro.replaced;
      return { lane: group.lane, intro: intro?.text ?? null, rows: group.rows };
    });
    return {
      month, window,
      lead: { itemId: issue.lead.public_id, title: String(issue.lead.title_zh || issue.lead.title_raw) },
      overview: overview.text,
      sections: sections.map((section) => ({ lane: section.lane, intro: section.intro, itemIds: section.rows.map((row) => row.public_id) })),
      itemIds: issue.top.map((row) => String(row.id)),
      markdown: frontierMonthlyMarkdown({ month, overview: overview.text, sections }),
      model: String(this.editor?.model || this.config.frontierModel || "deepseek-flash"),
      written: Boolean(written.overview) && overview.replaced === 0,
    };
  }

  /** The archive, newest first. @param {number} [limit] */
  async list(limit = 24) {
    await this.ready();
    return (await this.database.query(`SELECT month, lead, cardinality(item_ids) AS items, generated_at FROM evimed_frontier.monthlies
      ORDER BY month DESC LIMIT $1`, [Math.min(60, Math.max(1, Math.floor(limit) || 24))])).rows.map((/** @type {any} */ row) => ({
      month: row.month, title: typeof row.lead?.title === "string" ? row.lead.title : null, itemCount: Number(row.items ?? 0),
      generatedAt: new Date(row.generated_at).toISOString() }));
  }

  /** One issue as it was written, with the months on either side that have one, or null. @param {string} month */
  async read(month) {
    if (!MONTH.test(String(month ?? ""))) return null;
    await this.ready();
    const row = (await this.database.query(`SELECT *, (SELECT max(m.month) FROM evimed_frontier.monthlies m WHERE m.month < $1) AS previous_month,
        (SELECT min(m.month) FROM evimed_frontier.monthlies m WHERE m.month > $1) AS next_month
      FROM evimed_frontier.monthlies WHERE month = $1`, [month])).rows[0];
    if (!row) return null;
    return { month: row.month, label: `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`, windowStart: new Date(row.window_start).toISOString(),
      windowEnd: new Date(row.window_end).toISOString(), lead: row.lead, overview: row.overview ?? null,
      sections: Array.isArray(row.sections) ? row.sections : [], markdown: row.markdown, itemCount: row.item_ids.length,
      generatedAt: new Date(row.generated_at).toISOString(), previousMonth: row.previous_month ?? null, nextMonth: row.next_month ?? null };
  }

  status() { return { available: Boolean(this.jobs && this.owner?.()), counters: { ...this.counters } }; }

  async #modelAllowed() {
    if (!this.budgetReader) return true;
    try { return (await this.budgetReader()).state !== "exhausted"; } catch { return false; }
  }

  /** @returns {Promise<{ match: (text: string) => Array<{ termEn: string, termZh: string }> } | null>} */
  async #glossary() {
    if (!this.glossary) return null;
    if (typeof this.glossary.match === "function") return this.glossary;
    try { return typeof this.glossary.current === "function" ? await this.glossary.current() : null; } catch { return null; }
  }
}
