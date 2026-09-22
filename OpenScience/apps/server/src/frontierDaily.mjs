/**
 * The frontier feed's daily issue and its push (「前沿动态」 日报, plan §4.5, §4.9,
 * §6.4, §10.5.5, §14.8 #6).
 *
 * One issue a day, fixed once written: a lead (with its event), a safety block,
 * one section per lane that has anything, and 「AI 一分钟」 — the one paragraph
 * a model writes — assembled by code from what was published in the window,
 * and a Markdown copy of the same. Then, at each reader's own digest time, one
 * inbox item that opens it.
 *
 * Hidden knowledge:
 *
 * - **The window is Beijing's morning, computed in the configured zone.** The
 *   issue of day D covers [D−1 07:00, D 07:00) in `OPEN_SCIENCE_FRONTIER_TIMEZONE`
 *   (Asia/Shanghai) by the moment an item became visible here, and is
 *   finalized at `OPEN_SCIENCE_FRONTIER_DAILY_TIME` (07:30). The container runs
 *   in UTC and this platform has been bitten by that (memory note: the learning
 *   window ran in container time): every cut here goes through `Intl` with the
 *   zone named. A daily time earlier than 07:00 moves the cut with it — an
 *   issue never claims a window that ends after it was written.
 * - **Only items with a verified summary** (passed or repaired): a title-only
 *   item has nothing to say in an issue a reader forwards to colleagues. What
 *   arrives after the cut is tomorrow's. A lane with nothing is not a section
 *   — no padding on a quiet day (§14.8 #6) — and a day with nothing at all is
 *   no issue and no push.
 * - **Written through the job ledger, once per day.** The `frontier-daily` job
 *   (key `frontier-daily:<day>`, under the operator's internal project) makes
 *   the issue idempotent across restarts and instances; the row itself is
 *   inserted in the job's own completion transaction, with
 *   `meta.daily_version`. A failure retries on the job's schedule and leaves
 *   yesterday's issue the latest (plan §10.5.7). From a quarter past the daily
 *   time on, a day without its issue is reported (`missing`, a metric and an
 *   alert line) — never shown to a reader as an error.
 * - **The issue's structure is frozen; its items are read live.** The lead,
 *   the sections and the Markdown are what was decided at 07:30; the page
 *   reads the items themselves when it opens, so a retraction flag shows and a
 *   withdrawn item leaves (it never holds a retracted claim up as news).
 * - **The push is the platform's digest, not a new channel** (plan §10.5.5):
 *   a `notify` inbox item with source `digest`, id and idempotency key
 *   `frontier-daily:<day>`, at the reader's own `digestTime`, behind the
 *   `frontier` notification switch (on unless turned off). Only to people who
 *   opened the page in the last 14 days or follow something, only once a day
 *   (`user_prefs.last_push_day`), and only to accounts the module's audience
 *   admits. Its body carries no personal reason: a Feishu binding may be a
 *   group chat.
 *
 * @module frontierDaily
 */

import { FRONTIER_LANES, FRONTIER_LANE_LABELS_ZH } from "@evimed/domain";
import { bumpFrontierVersion, FRONTIER_META_KEYS, migrateFrontier } from "./frontierPersistence.mjs";
import { migrateNotifications } from "./notificationPersistence.mjs";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The cut every issue's window ends at, local time (plan §4.5). */
export const FRONTIER_DAILY_CUT = "07:00";
/** How long after the daily time a missing issue is an alert (plan §10.5.8: 07:45). */
export const FRONTIER_DAILY_ALERT_MS = 15 * MINUTE;
/** Items per section, at most; an issue is read in two minutes. */
export const FRONTIER_DAILY_SECTION_MAX = 8;
/** Safety alerts an issue lists, at most. */
export const FRONTIER_DAILY_SAFETY_MAX = 10;
/** AI-lane items the AI minute is written from, at most. */
export const FRONTIER_DAILY_AI_MAX = 12;
/** Readers pushed per scan (the scan runs every minute). */
export const FRONTIER_PUSH_BATCH = 50;
/** A reader who opened the page in this long, or follows something, is pushed to. */
export const FRONTIER_PUSH_ACTIVE_MS = 14 * DAY;
const JOB_KIND = "frontier-daily";
const JOB_LEASE_MS = 5 * MINUTE;
const JOB_RETRY_MS = 10 * MINUTE;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ───────────────────────── time in the zone (unit-tested) ─────────────────────────

/** @param {Date} at @param {string} timeZone */
function wallParts(at, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
}

/** The zone's offset from UTC at an instant, in milliseconds. @param {Date} at @param {string} timeZone */
function offsetAt(at, timeZone) {
  const parts = wallParts(at, timeZone);
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The zone's calendar day and clock at an instant.
 * @param {Date} at @param {string} timeZone
 * @returns {{ day: string, minutes: number, clock: string }}
 */
export function zonedClock(at, timeZone) {
  const parts = wallParts(at, timeZone);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), clock: `${parts.hour}:${parts.minute}` };
}

/** "HH:MM" → minutes after midnight, or null. @param {unknown} value */
export function clockMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * The instant a wall-clock time of a day has in a zone (exact outside the one
 * ambiguous hour of a daylight-saving switch; Asia/Shanghai has none).
 * @param {string} day YYYY-MM-DD @param {number} minutes after local midnight @param {string} timeZone
 */
export function zonedInstant(day, minutes, timeZone) {
  const [year, month, date] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date, 0, minutes);
  const guess = wall - offsetAt(new Date(wall), timeZone);
  return new Date(wall - offsetAt(new Date(guess), timeZone));
}

/** The calendar day before. @param {string} day */
export function previousDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

/**
 * The window of day D's issue: [D−1 cut, D cut), where the cut is 07:00 or
 * the daily time when that is earlier.
 * @param {string} day @param {{ timeZone: string, dailyTime: string }} options
 * @returns {{ start: Date, end: Date }}
 */
export function frontierDailyWindow(day, { timeZone, dailyTime }) {
  const cut = Math.min(/** @type {number} */ (clockMinutes(FRONTIER_DAILY_CUT)), clockMinutes(dailyTime) ?? Infinity);
  return { start: zonedInstant(previousDay(day), cut, timeZone), end: zonedInstant(day, cut, timeZone) };
}

// ───────────────────────── the issue (unit-tested) ─────────────────────────

/**
 * @typedef {{ id: string | number, public_id: string, title_raw: string, title_zh?: string | null, summary_zh?: string | null,
 *             lane: string, selected: boolean, safety_alert: boolean, score_total?: number | null, visible_at: string | Date,
 *             canonical_url: string, source_name: string, event_id?: string | number | null, event_public_id?: string | null,
 *             event_title?: string | null, event_reports?: number | null, event_digest?: string | null }} FrontierDailyRow
 */

/** @param {FrontierDailyRow} row */
const titleOf = (row) => String(row.title_zh || row.title_raw);

/** Higher score first, then the newer, then the higher id. @param {FrontierDailyRow} left @param {FrontierDailyRow} right */
function byWeight(left, right) {
  return (Number(right.score_total ?? -1) - Number(left.score_total ?? -1))
    || new Date(right.visible_at).getTime() - new Date(left.visible_at).getTime()
    || Number(right.id) - Number(left.id);
}

/**
 * What one day's issue holds, from the window's verified items: the lead —
 * the selected item whose event ranks highest on the hot list, else the
 * highest scored — the safety alerts, one section per lane with selected
 * items (at most eight each, none empty), and the AI-lane items the AI minute
 * is written from. Null when there is nothing to publish.
 * @param {{ rows: FrontierDailyRow[], hotEventIds?: string[] }} input
 */
export function frontierDailyIssue({ rows, hotEventIds = [] }) {
  const rank = new Map(hotEventIds.map((id, index) => [String(id), index]));
  const safety = rows.filter((row) => row.safety_alert).sort((left, right) => new Date(right.visible_at).getTime() - new Date(left.visible_at).getTime())
    .slice(0, FRONTIER_DAILY_SAFETY_MAX);
  const selected = rows.filter((row) => row.selected && !row.safety_alert);
  const lead = [...selected].sort((left, right) => (rank.get(String(left.event_id)) ?? Infinity) - (rank.get(String(right.event_id)) ?? Infinity)
    || byWeight(left, right))[0] ?? null;
  /** @type {Array<{ lane: string, rows: FrontierDailyRow[] }>} */
  const sections = [];
  for (const lane of FRONTIER_LANES) {
    const members = selected.filter((row) => row.lane === lane && row !== lead).sort(byWeight).slice(0, FRONTIER_DAILY_SECTION_MAX);
    if (members.length) sections.push({ lane, rows: members });
  }
  if (!lead && !safety.length && !sections.length) return null;
  const ai = rows.filter((row) => row.lane === "ai").sort((left, right) => Number(right.selected) - Number(left.selected) || byWeight(left, right))
    .slice(0, FRONTIER_DAILY_AI_MAX);
  return { lead, safety, sections, ai };
}

/** A title or a sentence safe inside Markdown link text and emphasis. @param {unknown} text */
function markdownText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().replace(/([\\`*_[\]])/g, "\\$1");
}

/** "2026-09-22" → 「2026年9月22日」. @param {string} day */
export function dayLabel(day) {
  const [year, month, date] = day.split("-").map(Number);
  return `${year}年${month}月${date}日`;
}

/** An instant as 「9月21日 07:00」 in the zone. @param {Date} at @param {string} timeZone */
function momentLabel(at, timeZone) {
  const { day, clock } = zonedClock(at, timeZone);
  const [, month, date] = day.split("-").map(Number);
  return `${month}月${date}日 ${clock}`;
}

/**
 * The issue as Markdown, the way 「复制为 Markdown」 hands it to a department
 * chat: the lead, the safety alerts, the sections, the AI minute, each item
 * with its source and a link to the original.
 * @param {{ day: string, window: { start: Date, end: Date }, timeZone: string, lead: FrontierDailyRow | null, leadText: string | null,
 *           safety: FrontierDailyRow[], sections: Array<{ lane: string, rows: FrontierDailyRow[] }>, aiMinute: string | null }} issue
 */
export function frontierDailyMarkdown({ day, window, timeZone, lead, leadText, safety, sections, aiMinute }) {
  const count = new Set([lead, ...safety, ...sections.flatMap((section) => section.rows)].filter(Boolean).map((row) => String(row?.id))).size;
  const line = (/** @type {FrontierDailyRow} */ row) => `- **${markdownText(titleOf(row))}**（${markdownText(row.source_name)}）${row.summary_zh ? `：${markdownText(row.summary_zh)}` : ""} [原文](${row.canonical_url})`;
  const parts = [
    `# EviMed 医学前沿日报 · ${dayLabel(day)}`,
    "",
    `覆盖 ${momentLabel(window.start, timeZone)} 至 ${momentLabel(window.end, timeZone)}（北京时间），共 ${count} 条。`,
  ];
  if (lead) {
    parts.push("", "## 头条", "", `**${markdownText(titleOf(lead))}**（${markdownText(lead.source_name)}）`);
    if (leadText) parts.push("", markdownText(leadText));
    parts.push("", `[原文](${lead.canonical_url})`);
  }
  if (safety.length) parts.push("", "## 安全警示", "", ...safety.map(line));
  for (const section of sections) {
    parts.push("", `## ${FRONTIER_LANE_LABELS_ZH[/** @type {keyof typeof FRONTIER_LANE_LABELS_ZH} */ (section.lane)] ?? section.lane}`, "", ...section.rows.map(line));
  }
  if (aiMinute) parts.push("", "## AI 一分钟", "", markdownText(aiMinute));
  parts.push("", "---", "", "由 EviMed「前沿动态」编辑。导读由模型根据原文写成，数字已逐字核对；引用前请阅读原文。", "");
  return parts.join("\n");
}

/**
 * The inbox item a day's issue is pushed as. Counts and the lead's title, and
 * nothing about the reader: the same text reaches a Feishu group chat.
 * @param {{ day: string, lead: { title?: string | null } | null, sections: Array<{ lane: string, itemIds: string[] }>, safety: string[] }} issue
 */
export function frontierDailyNotice({ day, lead, sections, safety }) {
  const selected = (lead ? 1 : 0) + sections.reduce((sum, section) => sum + section.itemIds.length, 0);
  const lanes = sections.map((section) => `${FRONTIER_LANE_LABELS_ZH[/** @type {keyof typeof FRONTIER_LANE_LABELS_ZH} */ (section.lane)] ?? section.lane} ${section.itemIds.length} 条`);
  const body = [
    lead?.title ? `头条：${String(lead.title).slice(0, 120)}` : null,
    safety.length ? `安全警示 ${safety.length} 条` : null,
    lanes.length ? lanes.join(" · ") : null,
    "打开「前沿动态」看完整日报，可以复制为 Markdown 转给同事。",
  ].filter(Boolean).join("\n");
  const [, month, date] = day.split("-").map(Number);
  return {
    noticeType: "notify",
    title: selected ? `今日前沿 · ${month}月${date}日 · ${selected} 条精选` : `今日前沿 · ${month}月${date}日`,
    body,
    actions: [{ id: "open", label: "查看日报", style: "primary" }],
    source: { type: "digest", id: `frontier-daily:${day}` },
    idempotencyKey: `frontier-daily:${day}`,
    groupKey: `frontier-daily:${day}`,
    severity: /** @type {const} */ ("info"),
  };
}

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_daily_failed";
}

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());

// ───────────────────────── the daily ─────────────────────────

export class FrontierDaily {
  /**
   * @param {{ database: any, jobs?: any, notifications?: any, editor?: any, events?: any, config?: Record<string, any>,
   *           owner?: () => ({ userId: string, projectId: string } | null), budget?: (() => Promise<{ state: string }>) | null,
   *           now?: () => Date, workerId?: string, dimension?: number }} options
   *   `jobs` a `ProductJobs`, `notifications` a `NotificationService`, `editor` a
   *   `FrontierEditor` (the AI minute), `events` a `FrontierEvents` (the hot
   *   list the lead is chosen by), `owner` the operator's internal project.
   */
  constructor({ database, jobs = null, notifications = null, editor = null, events = null, config = {}, owner = () => null,
    budget = null, now = () => new Date(), workerId = "frontier-daily", dimension = 1024 }) {
    if (!database) throw new TypeError("The frontier daily needs the product database.");
    this.database = database;
    this.jobs = jobs;
    this.notifications = notifications;
    this.editor = editor;
    this.events = events;
    this.config = config ?? {};
    this.owner = owner;
    this.budgetReader = budget;
    this.now = now;
    this.workerId = String(workerId).slice(0, 120);
    this.timeZone = String(this.config.frontierTimeZone || this.config.frontierTimezone || "Asia/Shanghai");
    this.dailyTime = clockMinutes(this.config.frontierDailyTime) == null ? "07:30" : String(this.config.frontierDailyTime).trim();
    this.dimension = Number(this.config.kbEmbeddingDimension) || dimension;
    /** Observable counters (principle 15). */
    this.counters = { issues: 0, empty: 0, failures: 0, aiMinutes: 0, aiMinuteDropped: 0, pushed: 0, pushFailures: 0 };
    /** @type {{ day: string | null, missing: boolean, lastIssueDay: string | null, lastGeneratedAt: string | null, lastError: string | null }} */
    this.state = { day: null, missing: false, lastIssueDay: null, lastGeneratedAt: null, lastError: null };
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /** The day an issue is due for now, and whether it is due yet. */
  #due(now = this.now()) {
    const { day, minutes } = zonedClock(now, this.timeZone);
    const at = /** @type {number} */ (clockMinutes(this.dailyTime));
    return { day, due: minutes >= at, alert: minutes * MINUTE >= at * MINUTE + FRONTIER_DAILY_ALERT_MS };
  }

  /**
   * Called every minute: past today's daily time, with no issue for today,
   * the day's job is queued (idempotent on the day), claimed and run. A job of
   * an earlier day still queued for a retry is claimed the same way and run
   * for its own day.
   */
  async runDue() {
    await this.ready();
    const now = this.now();
    const { day, due, alert } = this.#due(now);
    const existing = (await this.database.query("SELECT day::text AS day, generated_at FROM evimed_frontier.dailies ORDER BY day DESC LIMIT 1")).rows?.[0];
    this.state.lastIssueDay = existing?.day ?? null;
    this.state.lastGeneratedAt = iso(existing?.generated_at);
    this.state.day = day;
    const done = existing?.day === day;
    const owner = this.owner?.();
    if (!due || done || !this.jobs || !owner) {
      this.state.missing = alert && !done && !(await this.#emptyDay(day, owner));
      return { day, ran: false };
    }
    await this.jobs.enqueue(owner.userId, JOB_KIND, { day }, { idempotencyKey: `${JOB_KIND}:${day}`, projectId: owner.projectId, maxAttempts: 3 });
    const job = await this.jobs.claim([JOB_KIND], this.workerId, { leaseMs: JOB_LEASE_MS });
    if (!job) {
      this.state.missing = alert && !(await this.#emptyDay(day, owner));
      return { day, ran: false };
    }
    const jobDay = DAY_PATTERN.test(String(job.payload?.day)) ? String(job.payload.day) : day;
    try {
      const issue = await this.compose(jobDay);
      if (!issue) {
        await this.jobs.finish(job.userId, job.id, job.leaseToken, { day: jobDay, empty: true });
        this.counters.empty += 1;
      } else {
        await this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { day: jobDay, items: issue.itemIds.length }, async (/** @type {any} */ client) => {
          const inserted = await client.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, ai_minute,
              markdown, item_ids, model, cost_cny, generated_at, finalized_at)
            VALUES ($1::date, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::bigint[], $10, NULL, $11, $11)
            ON CONFLICT (day) DO NOTHING`, [jobDay, issue.window.start, issue.window.end, JSON.stringify(issue.lead), JSON.stringify(issue.sections),
            JSON.stringify(issue.safety), issue.aiMinute, issue.markdown, issue.itemIds, issue.model, now]);
          if (inserted.rowCount) await bumpFrontierVersion(client, FRONTIER_META_KEYS.dailyVersion);
        });
        this.counters.issues += 1;
        this.state.lastIssueDay = jobDay > (this.state.lastIssueDay ?? "") ? jobDay : this.state.lastIssueDay;
        this.state.lastGeneratedAt = now.toISOString();
      }
      this.state.lastError = null;
      this.state.missing = false;
      return { day: jobDay, ran: true, empty: !issue };
    } catch (error) {
      this.counters.failures += 1;
      this.state.lastError = codeOf(error);
      this.state.missing = alert;
      await this.jobs.fail(job.userId, job.id, job.leaseToken, { code: codeOf(error), message: "The frontier daily could not be composed." },
        { retry: true, delayMs: JOB_RETRY_MS }).catch(() => { this.counters.failures += 1; });
      throw error;
    }
  }

  /** Whether the day's job finished with nothing to publish (not an alert). @param {string} day @param {any} owner */
  async #emptyDay(day, owner) {
    if (!owner) return false;
    let row;
    try {
      row = (await this.database.query(`SELECT status, result FROM evimed_product.jobs WHERE user_id = $1 AND idempotency_key = $2`,
        [owner.userId, `${JOB_KIND}:${day}`])).rows?.[0];
    } catch (error) {
      // The ledger could not say the day was empty: the alert stands (a quiet
      // day reported missing is checked; a missing one reported quiet is not).
      this.state.lastError = codeOf(error);
      return false;
    }
    return row?.status === "succeeded" && row?.result?.empty === true;
  }

  /**
   * One day's issue, composed but not stored: the window's verified items,
   * the lead by the hot list, the AI minute when a model may be called, the
   * Markdown. Null when the window holds nothing to publish.
   * @param {string} day
   */
  async compose(day) {
    if (!DAY_PATTERN.test(day)) throw Object.assign(new Error("The daily's day is invalid."), { code: "frontier_daily_day_invalid" });
    const window = frontierDailyWindow(day, { timeZone: this.timeZone, dailyTime: this.dailyTime });
    /** @type {FrontierDailyRow[]} */
    const rows = (await this.database.query(`SELECT i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.lane, i.selected, i.safety_alert,
        i.score_total, i.visible_at, i.canonical_url, i.event_id, s.name AS source_name,
        e.public_id AS event_public_id, e.title_zh AS event_title, e.report_count AS event_reports, e.digest_zh AS event_digest
      FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      LEFT JOIN evimed_frontier.events e ON e.id = i.event_id AND e.merged_into IS NULL
      WHERE i.state = 'published' AND s.enabled AND i.visible_at >= $1::timestamptz AND i.visible_at < $2::timestamptz
        AND i.verification IN ('passed', 'repaired') AND i.summary_zh IS NOT NULL AND (i.selected OR i.safety_alert OR i.lane = 'ai')
      ORDER BY i.visible_at DESC, i.id DESC LIMIT 500`, [window.start, window.end])).rows ?? [];
    /** @type {string[]} */
    let hotEventIds = [];
    try {
      hotEventIds = this.events ? await this.events.hotEventIds() : [];
    } catch (error) {
      // The lead is then the highest scored item: the issue is still written,
      // and the reason it was chosen without the hot list is on the status.
      this.state.lastError = codeOf(error);
    }
    const issue = frontierDailyIssue({ rows, hotEventIds });
    if (!issue) return null;
    const { lead, safety, sections, ai } = issue;
    // An event page is worth linking once it holds more than one report; its
    // digest, when there is one, is the better lead than one report's summary.
    const leadEvent = lead?.event_public_id && Number(lead.event_reports) > 1 ? { id: lead.event_public_id, title: lead.event_title ?? null } : null;
    const leadText = lead ? (leadEvent && lead.event_digest ? lead.event_digest : lead.summary_zh ?? null) : null;
    let aiMinute = null;
    if (ai.length && this.editor?.available && (await this.#modelAllowed())) {
      const written = await this.editor.writeDaily({ day, items: ai.map((row) => ({ titleRaw: row.title_raw, titleZh: row.title_zh,
        summaryZh: row.summary_zh, sourceName: row.source_name })) });
      if (["passed", "repaired"].includes(written.verification) && written.aiMinuteZh) {
        aiMinute = written.aiMinuteZh;
        this.counters.aiMinutes += 1;
      } else if (written.verification !== "skipped") this.counters.aiMinuteDropped += 1;
    }
    const markdown = frontierDailyMarkdown({ day, window, timeZone: this.timeZone, lead, leadText, safety, sections, aiMinute });
    const itemIds = [...new Set([lead, ...safety, ...sections.flatMap((section) => section.rows)].filter(Boolean).map((row) => String(row?.id)))];
    return {
      day, window, aiMinute, markdown, itemIds,
      model: String(this.editor?.model || this.config.frontierModel || "deepseek-flash"),
      lead: lead ? { itemId: lead.public_id, title: titleOf(lead), text: leadText, eventId: leadEvent?.id ?? null, eventTitle: leadEvent?.title ?? null } : null,
      sections: sections.map((section) => ({ lane: section.lane, itemIds: section.rows.map((row) => row.public_id) })),
      safety: safety.map((row) => row.public_id),
    };
  }

  /** The AI minute is a model call like any other: only while the day's budget is not spent. */
  async #modelAllowed() {
    if (!this.budgetReader) return true;
    try {
      return (await this.budgetReader()).state !== "exhausted";
    } catch {
      return false;
    }
  }

  // ───────────────────────── push ─────────────────────────

  /**
   * Called every minute (plan §10.5.5): today's issue, when there is one, to
   * every reader whose digest time has passed, whose `frontier` switch is on,
   * who opened the page in the last 14 days or follows something, and who has
   * not been pushed today. One inbox item each, idempotent on the day.
   */
  async pushDue() {
    if (!this.notifications) return { pushed: 0 };
    await this.ready();
    const now = this.now();
    const { day, clock } = zonedClock(now, this.timeZone);
    const issue = (await this.database.query(`SELECT day::text AS day, lead, sections, safety FROM evimed_frontier.dailies WHERE day = $1::date`, [day])).rows?.[0];
    if (!issue) return { pushed: 0 };
    await migrateNotifications(this.database);
    const audience = this.config.frontierAudience === "all" ? null
      : [...new Set([...(this.config.operatorUsers ?? []), ...(this.config.frontierPreviewUsers ?? [])].map(String))];
    // Each reader's digest time is their own and read in China Standard Time,
    // as the inbox's own digest branch reads it (imService.pushNotBefore).
    const readers = (await this.database.query(`SELECT up.user_id FROM evimed_frontier.user_prefs up
      JOIN evimed_control.users u ON u.id = up.user_id
      LEFT JOIN evimed_inbox.preferences p ON p.user_id = up.user_id
      WHERE (up.last_push_day IS NULL OR up.last_push_day <> $1::date)
        AND coalesce((p.switches->>'frontier')::boolean, true)
        AND coalesce(p.digest_time, '08:00') <= $2
        AND (up.last_seen_at >= $3::timestamptz OR EXISTS (SELECT 1 FROM evimed_frontier.user_follows f WHERE f.user_id = up.user_id))
        AND ($4::text[] IS NULL OR up.user_id = ANY($4::text[]))
      ORDER BY up.user_id LIMIT $5`, [day, clock, new Date(now.getTime() - FRONTIER_PUSH_ACTIVE_MS), audience, FRONTIER_PUSH_BATCH])).rows ?? [];
    if (!readers.length) return { pushed: 0 };
    const notice = frontierDailyNotice({ day, lead: issue.lead ?? null, sections: Array.isArray(issue.sections) ? issue.sections : [],
      safety: Array.isArray(issue.safety) ? issue.safety : [] });
    let pushed = 0;
    for (const reader of readers) {
      try {
        await this.notifications.create(reader.user_id, notice, { now });
        await this.database.query(`INSERT INTO evimed_frontier.user_prefs (user_id, last_push_day) VALUES ($1, $2::date)
          ON CONFLICT (user_id) DO UPDATE SET last_push_day = EXCLUDED.last_push_day`, [reader.user_id, day]);
        pushed += 1;
      } catch (error) {
        // One reader's inbox refusing is that reader's; the next scan tries
        // again (the key makes a second attempt the same item).
        this.counters.pushFailures += 1;
        this.state.lastError = codeOf(error);
      }
    }
    this.counters.pushed += pushed;
    return { pushed };
  }

  // ───────────────────────── reading ─────────────────────────

  /** The archive, newest first. @param {number} [limit] */
  async list(limit = 30) {
    await this.ready();
    const rows = (await this.database.query(`SELECT day::text AS day, lead, cardinality(item_ids) AS items, generated_at
      FROM evimed_frontier.dailies ORDER BY day DESC LIMIT $1`, [Math.max(1, Math.min(60, Math.floor(limit) || 30))])).rows ?? [];
    return rows.map((row) => ({ day: row.day, title: typeof row.lead?.title === "string" ? row.lead.title : null,
      itemCount: Number(row.items ?? 0), generatedAt: iso(row.generated_at) }));
  }

  /** One issue as it was frozen, or null. @param {string} day */
  async read(day) {
    if (!DAY_PATTERN.test(String(day ?? ""))) return null;
    await this.ready();
    const row = (await this.database.query(`SELECT day::text AS day, window_start, window_end, lead, sections, safety, ai_minute, markdown,
        cardinality(item_ids) AS items, generated_at FROM evimed_frontier.dailies WHERE day = $1::date`, [day])).rows?.[0];
    if (!row) return null;
    return {
      day: row.day, windowStart: iso(row.window_start), windowEnd: iso(row.window_end), generatedAt: iso(row.generated_at),
      lead: row.lead && typeof row.lead === "object" ? row.lead : null,
      sections: Array.isArray(row.sections) ? row.sections : [],
      safety: Array.isArray(row.safety) ? row.safety : [],
      aiMinute: row.ai_minute ?? null, markdown: row.markdown, itemCount: Number(row.items ?? 0),
    };
  }

  status() {
    return { ...this.state, counters: { ...this.counters } };
  }
}
