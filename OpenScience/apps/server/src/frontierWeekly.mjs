import { frontierSourceDisplayName } from '@evimed/domain';
import { clockMinutes, zonedClock, zonedInstant, frontierDailyIssue, frontierDailyMarkdown, dayLabel } from './frontierDaily.mjs';
import { frontierEventRole } from './frontierEvents.mjs';
import { migrateFrontier } from './frontierPersistence.mjs';
/** @param {string} day @param {number} offset */
export function frontierCalendarDay(day, offset) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
}
/** Calendar boundaries are converted separately: a DST week need not be 168 hours.
 * @param {string} week @param {string} timeZone */
export function frontierWeekWindow(week, timeZone) {
    const date = new Date(`${week}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== week || date.getUTCDay() !== 1) {
        throw Object.assign(new Error('Invalid calendar week.'), { code: 'frontier_week_invalid' });
    }
    return { start: zonedInstant(week, 0, timeZone), end: zonedInstant(frontierCalendarDay(week, 7), 0, timeZone) };
}
/** Latest completed week whose publication time has passed; never replay an archive.
 * @param {Date} now @param {{timeZone:string,dailyTime:string}} options */
export function latestFrontierWeek(now, { timeZone, dailyTime }) {
    const wall = zonedClock(now, timeZone);
    const weekday = new Date(`${wall.day}T00:00:00Z`).getUTCDay();
    const monday = frontierCalendarDay(wall.day, -((weekday + 6) % 7));
    return frontierCalendarDay(monday, now < zonedInstant(monday, clockMinutes(dailyTime) ?? 450, timeZone) ? -14 : -7);
}
/** @param {any[]} rows */
export function frontierWeeklyRows(rows) {
    const ordered = [...rows].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || Number(b.score_total ?? -1) - Number(a.score_total ?? -1) || Number(b.id) - Number(a.id));
    const seen = new Set();
    return ordered.filter(row => { const key = row.event_id ? `event:${row.event_id}` : `item:${row.id}`; if (seen.has(key))
        return false; seen.add(key); return true; });
}
/** @param {any} issue */
export function frontierWeeklyMarkdown(issue) {
    return frontierDailyMarkdown({ ...issue, day: issue.weekStart, aiMinute: null })
        .replace(/^# EviMed 医学前沿日报[^\n]*/, `# EviMed 医学前沿周刊 · ${dayLabel(issue.weekStart)}—${dayLabel(frontierCalendarDay(issue.weekStart, 6))}`);
}
export class FrontierWeekly {
    /** @param {{database:any,jobs?:any,owner?:()=>any,config?:Record<string,any>,now?:()=>Date,workerId?:string}} options */
    constructor({ database, jobs = null, owner = () => null, config = {}, now = () => new Date(), workerId = 'frontier-weekly' }) {
        this.database = database;
        this.jobs = jobs;
        this.owner = owner;
        this.config = config;
        this.now = now;
        this.workerId = workerId;
        this.timeZone = String(config.frontierTimeZone || 'Asia/Shanghai');
        this.dailyTime = String(config.frontierDailyTime || '07:30');
        this.counters = { issues: 0, empty: 0, failures: 0 };
    }
    async ready() { await migrateFrontier(this.database, { dimension: Number(this.config.kbEmbeddingDimension) || 1024 }); }
    async runDue() {
        await this.ready();
        const weekStart = latestFrontierWeek(this.now(), this);
        const owner = this.owner();
        if (!this.jobs || !owner)
            return { ran: false, unavailable: true };
        await this.jobs.enqueue(owner.userId, 'frontier-weekly', { weekStart }, { idempotencyKey: `frontier-weekly:${weekStart}`, projectId: owner.projectId });
        const job = await this.jobs.claim(['frontier-weekly'], this.workerId, { leaseMs: 300000 });
        if (!job)
            return { ran: false };
        try {
            // An expired historical retry is completed quietly rather than announcing old weeks.
            if (job.payload.weekStart !== weekStart) {
                await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: 'superseded-week' });
                return { ran: false };
            }
            const issue = await this.compose(weekStart);
            await this.jobs.renew(job.userId, job.id, job.leaseToken, 300000);
            await this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { weekStart, empty: !issue }, async (client) => {
                if (issue)
                    await client.query(`INSERT INTO evimed_frontier.weeklies(week_start,window_start,window_end,lead,sections,safety,markdown,item_ids,generated_at)
          VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::bigint[],$9) ON CONFLICT DO NOTHING`, [weekStart, issue.window.start, issue.window.end, JSON.stringify(issue.lead), JSON.stringify(issue.sections), JSON.stringify(issue.safety), issue.markdown, issue.itemIds, this.now()]);
            });
            this.counters[issue ? 'issues' : 'empty']++;
            return { ran: true, empty: !issue, weekStart };
        }
        catch (error) {
            this.counters.failures++;
            await this.jobs.fail(job.userId, job.id, job.leaseToken, { code: 'frontier_weekly_failed', message: 'Weekly composition failed.' }, { retry: true, delayMs: 60000 });
            throw error;
        }
    }
    /** @param {string} weekStart */
    async compose(weekStart) {
        const window = frontierWeekWindow(weekStart, this.timeZone);
        const rows = (await this.database.query(`SELECT i.*,s.name AS source_name,s.owner_entity AS source_owner,s.source_type AS current_source_type,
      coalesce(e.merged_into,i.event_id) AS event_id
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id=i.primary_source_id
      LEFT JOIN evimed_frontier.events e ON e.id=i.event_id
      WHERE i.state='published' AND s.enabled AND i.visible_at >= $1 AND i.visible_at < $2
        AND i.verification IN ('passed','repaired') AND length(trim(i.summary_zh))>0 AND (i.selected OR i.safety_alert)
      ORDER BY i.score_total DESC NULLS LAST,i.visible_at DESC,i.id DESC LIMIT 1000`, [window.start, window.end])).rows.map(row => ({ ...row,
            source_name: frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name, ownerEntity: row.source_owner }),
            primary: frontierEventRole({ sourceType: row.current_source_type, evidenceType: row.evidence_type }) === 'primary' }));
        const selected = frontierDailyIssue({ rows: frontierWeeklyRows(rows) });
        if (!selected)
            return null;
        const { lead, safety, sections } = selected;
        return { weekStart, window, lead: lead ? { itemId: lead.public_id, title: lead.title_zh || lead.title_raw, text: lead.summary_zh, eventId: null } : null,
            sections: sections.map(section => ({ lane: section.lane, itemIds: section.rows.map(row => row.public_id) })), safety: safety.map(row => row.public_id),
            itemIds: [lead, ...safety, ...sections.flatMap(section => section.rows)].filter(Boolean).map(row => String(row?.id)),
            markdown: frontierWeeklyMarkdown({ weekStart, window, timeZone: this.timeZone, lead, leadText: lead?.summary_zh, safety, sections }) };
    }
    /** @param {number} [limit] */
    async list(limit = 30) { await this.ready(); return (await this.database.query(`SELECT week_start::text AS week_start,lead,cardinality(item_ids) AS items,generated_at FROM evimed_frontier.weeklies ORDER BY week_start DESC LIMIT $1`, [Math.min(60, Math.max(1, limit))])).rows.map(row => ({ weekStart: row.week_start, weekEnd: frontierCalendarDay(row.week_start, 6), title: row.lead?.title ?? null, itemCount: Number(row.items), generatedAt: new Date(row.generated_at).toISOString() })); }
    /** @param {string} weekStart */
    async read(weekStart) {
        try {
            frontierWeekWindow(weekStart, this.timeZone);
        }
        catch {
            return null;
        }
        await this.ready();
        const row = (await this.database.query(`SELECT *,week_start::text AS week,
      (SELECT max(week_start)::text FROM evimed_frontier.weeklies WHERE week_start<$1) AS previous_week,
      (SELECT min(week_start)::text FROM evimed_frontier.weeklies WHERE week_start>$1) AS next_week
      FROM evimed_frontier.weeklies WHERE week_start=$1`, [weekStart])).rows[0];
        return row ? { weekStart: row.week, weekEnd: frontierCalendarDay(row.week, 6), day: row.week, windowStart: new Date(row.window_start).toISOString(), windowEnd: new Date(row.window_end).toISOString(),
            lead: row.lead, sections: row.sections, safety: row.safety, aiMinute: null, markdown: row.markdown, itemCount: row.item_ids.length, generatedAt: new Date(row.generated_at).toISOString(), previousDay: row.previous_week, nextDay: row.next_week } : null;
    }
    status() { return { available: Boolean(this.jobs && this.owner()), counters: { ...this.counters } }; }
}
