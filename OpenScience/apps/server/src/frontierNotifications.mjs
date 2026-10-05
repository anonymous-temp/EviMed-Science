import { DISPLAY_TIME_ZONE, agendaLocalDate, frontierNoticeTarget, frontierSourceDisplayName } from '@evimed/domain';
import { migrateFrontier } from './frontierPersistence.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { migrateNotifications } from './notificationPersistence.mjs';
import { notificationSwitches } from './notificationService.mjs';
import { FrontierSubscriptions, frontierFollowPredicate } from './frontierSubscriptions.mjs';
import { frontierAudienceAllows } from './frontierService.mjs';
import { FRONTIER_PUSH_ACTIVE_MS, zonedClock } from './frontierDaily.mjs';
import { latestFrontierWeek } from './frontierWeekly.mjs';
const CURSOR = 'safety_scan_cursor';
const KIND = 'frontier-notify';
/** Discovery and every delivery use the same publication window. Inferred dates
 * cannot establish recency when a newly added source exposes old announcements.
 * @param {Date} now @param {(value:unknown)=>string} param */
function safetyPublicationPredicate(now, param) {
    return `i.published_at >= ${param(new Date(now.getTime() - 7 * 86400000))}::timestamptz
      AND i.published_at <= ${param(now)}::timestamptz AND i.date_precision IN ('instant','day')
      AND NOT ('date-inferred'=ANY(i.flags))`;
}
/** Public-only immutable payload: no private query, interest, project or match reason.
 * The publication day is the reader's, in the feed's zone: an announcement at 20:00 UTC was made the next morning in China.
 * @param {any} row @param {string} [timeZone] */
export function frontierSafetyNotice(row, timeZone = DISPLAY_TIME_ZONE) {
    const key = `frontier-safety:${row.public_id}`;
    return { noticeType: 'notify', title: String(row.title_zh || row.title_raw).slice(0, 200),
        body: `${frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name, ownerEntity: row.source_owner })} · ${agendaLocalDate(timeZone, new Date(row.published_at))}`,
        actions: [{ id: 'open', label: '查看安全公告', style: 'primary' }], source: { type: 'system', id: key }, idempotencyKey: key, groupKey: key, severity: 'safety' };
}
/** @param {string} week */
export function frontierWeeklyNotice(week) {
    const key = `frontier-weekly:${week}`;
    return { noticeType: 'notify', title: '医学前沿周刊', body: `${week} 起的一周医学进展`, actions: [{ id: 'open', label: '查看周刊', style: 'primary' }],
        source: { type: 'digest', id: key }, idempotencyKey: key, groupKey: key, severity: 'info' };
}
export class FrontierNotifications {
    /** @param {{database:any,jobs?:any,notifications?:any,weekly?:any,subscriptions?:any,config?:Record<string,any>,now?:()=>Date,workerId?:string}} options */
    constructor({ database, jobs = null, notifications = null, weekly = null, subscriptions = null, config = {}, now = () => new Date(), workerId = 'frontier-notify' }) {
        this.database = database;
        this.jobs = jobs;
        this.notifications = notifications;
        this.weekly = weekly;
        this.config = config;
        this.now = now;
        this.workerId = workerId;
        this.subscriptions = subscriptions ?? new FrontierSubscriptions({ database });
        this.batch = Math.min(200, Math.max(1, Math.floor(Number(config.frontierNotifyBatch)) || 50));
        this.scanBatch = Math.min(500, Math.max(1, Math.floor(Number(config.frontierSafetyScanBatch)) || 100));
        this.timeZone = String(config.frontierTimeZone || 'Asia/Shanghai');
        this.counters = { queued: 0, delivered: 0, skipped: 0, failed: 0, scanGaps: 0 };
    }
    async ready() { await migrateFrontier(this.database, { dimension: Number(this.config.kbEmbeddingDimension) || 1024 }); await migrateProductStore(this.database); await migrateNotifications(this.database); }
    /** Current account, switches, public source and all mutes are read again before every delivery.
     * @param {string} userId @param {{kind:string,key:string}} target @param {any} [client] */
    async eligible(userId, target, client = this.database) {
        if (!frontierAudienceAllows(this.config, { id: userId }))
            return false;
        if (target.kind === 'weekly' && target.key !== latestFrontierWeek(this.now(), { timeZone: this.timeZone, dailyTime: String(this.config.frontierDailyTime || '07:30') }))
            return false;
        const account = (await client.query(`SELECT p.switches,up.last_seen_at FROM evimed_control.users u
      LEFT JOIN evimed_inbox.preferences p ON p.user_id=u.id LEFT JOIN evimed_frontier.user_prefs up ON up.user_id=u.id WHERE u.id=$1`, [userId])).rows[0];
        if (!account)
            return false;
        const switches = notificationSwitches(account.switches);
        const toggle = target.kind === 'safety' ? 'frontierSafety' : target.kind === 'weekly' ? 'frontierWeekly' : 'frontier';
        if (switches.notify === false || switches[toggle] === false)
            return false;
        const subscriptions = await this.subscriptions.read(userId);
        const positive = subscriptions.follows.filter(f => !f.muted);
        const values = /** @type {any[]} */ ([userId]);
        const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length}`; };
        const muted = subscriptions.muted.map(f => `(${frontierFollowPredicate(f, param)})`);
        let wanted;
        if (target.kind === 'safety') {
            const matches = positive.filter(f => ['drug', 'specialty', 'event'].includes(f.kind)).map(f => `(least(i.visible_at,i.published_at) >= ${param(f.createdAt)}::timestamptz AND (${frontierFollowPredicate(f, param)}))`);
            if (!matches.length)
                return false;
            wanted = `i.public_id=${param(target.key)} AND i.safety_alert AND (s.source_type='regulator' OR s.safety_feed) AND ${safetyPublicationPredicate(this.now(), param)} AND (${matches.join(' OR ')})`;
        }
        else {
            if (!positive.length && !(account.last_seen_at && new Date(account.last_seen_at).getTime() >= this.now().getTime() - FRONTIER_PUSH_ACTIVE_MS))
                return false;
            wanted = target.kind === 'weekly' ? `i.id=ANY((SELECT item_ids FROM evimed_frontier.weeklies WHERE week_start=${param(target.key)}::date)::bigint[])`
                : `i.id=ANY((SELECT item_ids FROM evimed_frontier.dailies WHERE day=${param(target.key)}::date)::bigint[])`;
        }
        const row = await client.query(`SELECT i.id FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id=i.primary_source_id
      WHERE i.state='published' AND s.enabled AND i.verification IN ('passed','repaired') AND length(trim(i.summary_zh))>0
      AND NOT EXISTS(SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id=$1 AND us.item_id=i.id AND us.hidden_at IS NOT NULL)
      ${muted.length ? `AND NOT (${muted.join(' OR ')})` : ''} AND (${wanted}) LIMIT 1`, values);
        return Boolean(row.rows.length);
    }
    /** Injected into IM without coupling its service to frontier SQL. @param {any} item */
    async deliveryAllowed(item) { const target = frontierNoticeTarget(item.source); return !target || this.eligible(item.userId, target); }
    /** Do not reconstruct a payload already frozen by an earlier discovery attempt.
     * @param {any} client @param {string} userId @param {string} type @param {string} key @param {any} notice */
    async enqueue(client, userId, type, key, notice) {
        const idempotencyKey = `frontier-notify:${type}:${key}`;
        if ((await client.query('SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND idempotency_key=$2', [userId, idempotencyKey])).rows.length)
            return false;
        await this.jobs.enqueue(userId, KIND, { target: { kind: type, key }, notice }, { idempotencyKey, transactionClient: client });
        return true;
    }
    /** Bounded keyset scan: NOT EXISTS excludes every already-frozen recipient, including failed deliveries. */
    async queueWeekly() {
        if (!this.jobs || !this.notifications || !this.weekly)
            return { queued: 0, unavailable: true };
        await this.ready();
        const week = latestFrontierWeek(this.now(), { timeZone: this.timeZone, dailyTime: String(this.config.frontierDailyTime || '07:30') });
        if (!await this.weekly.read(week))
            return { queued: 0 };
        return this.database.transaction(async (client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext('frontier-weekly-recipients'))");
            const key = `frontier-notify:weekly:${week}`;
            const cursorKey = `weekly_recipients:${week}`;
            const after = String((await client.query('SELECT value FROM evimed_frontier.meta WHERE key=$1', [cursorKey])).rows[0]?.value ?? '');
            const rows = (await client.query(`SELECT u.id FROM evimed_control.users u WHERE u.id>$1
        AND NOT EXISTS(SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=u.id AND j.idempotency_key=$2) ORDER BY u.id LIMIT $3`, [after, key, this.batch])).rows;
            let queued = 0;
            for (const row of rows) {
                if (await this.eligible(row.id, { kind: 'weekly', key: week }, client) && await this.enqueue(client, row.id, 'weekly', week, frontierWeeklyNotice(week)))
                    queued++;
            }
            // Wrap after reaching the end, allowing opt-ins and readers arriving later that week.
            await client.query(`INSERT INTO evimed_frontier.meta(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp()`, [cursorKey, JSON.stringify(rows.length === this.batch ? rows.at(-1).id : '')]);
            this.counters.queued += queued;
            return { queued };
        });
    }
    /** Bounded change scan and one recipient page per tick, committed with its checkpoint. */
    async scanSafety() {
        if (!this.jobs || !this.notifications)
            return { queued: 0, unavailable: true };
        await this.ready();
        return this.database.transaction(async (client) => {
            // Sequence numbers are allocated before commit. Await writers before
            // advancing beyond their lower numbers, including initial bootstrap.
            await client.query("LOCK TABLE evimed_frontier.item_changes IN SHARE MODE");
            await client.query("SELECT pg_advisory_xact_lock(hashtext('frontier-safety-scan'))");
            const range = (await client.query('SELECT min(seq)::text AS min,max(seq)::text AS max FROM evimed_frontier.item_changes')).rows[0];
            const previous = (await client.query('SELECT value FROM evimed_frontier.meta WHERE key=$1', [CURSOR])).rows[0]?.value;
            const save = async (value) => client.query(`INSERT INTO evimed_frontier.meta(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp()`, [CURSOR, JSON.stringify(value)]);
            if (!previous) {
                const sequence = (await client.query("SELECT last_value::text AS seq FROM pg_sequences WHERE schemaname='evimed_frontier' AND sequencename='item_changes_seq_seq'")).rows[0];
                await save({ seq: range.max ?? sequence?.seq ?? '0', afterUserId: '' });
                return { queued: 0, bootstrapped: true };
            }
            const pruned = (await client.query("SELECT value FROM evimed_frontier.meta WHERE key='safety_pruned_through'")).rows[0]?.value;
            if (pruned && BigInt(previous.seq) < BigInt(pruned)) {
                await client.query(`INSERT INTO evimed_frontier.meta(key,value) VALUES('safety_scan_gap',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp()`, [JSON.stringify({ from: (BigInt(previous.seq) + 1n).toString(), to: String(pruned), at: this.now().toISOString(), outcome: 'unprocessed' })]);
                await save({ seq: range.max ?? String(pruned), afterUserId: '' });
                this.counters.scanGaps++;
                return { queued: 0, gap: true };
            }
            const changes = (await client.query(`SELECT seq::text AS seq,item_id FROM evimed_frontier.item_changes
              WHERE seq>$1 ORDER BY seq LIMIT $2`, [previous.seq, this.scanBatch])).rows;
            let checkpoint = previous;
            for (const change of changes) {
                const values = /** @type {any[]} */ ([change.item_id]);
                const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length}`; };
                const publication = safetyPublicationPredicate(this.now(), param);
                const row = (await client.query(`SELECT i.*,s.name AS source_name,s.owner_entity AS source_owner
                FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id=i.primary_source_id WHERE i.id=$1
                  AND i.state='published' AND s.enabled AND i.safety_alert AND (s.source_type='regulator' OR s.safety_feed)
                  AND i.verification IN ('passed','repaired') AND length(trim(i.summary_zh))>0 AND ${publication}`, values)).rows[0];
                if (!row) {
                    checkpoint = { seq: change.seq, afterUserId: '' };
                    continue;
                }
                const readers = (await client.query(`SELECT DISTINCT u.id FROM evimed_control.users u JOIN evimed_frontier.user_follows f ON f.user_id=u.id
                WHERE u.id>$1 AND NOT f.muted AND f.kind IN ('drug','specialty','event') AND f.created_at<=$2
                  AND NOT EXISTS(SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=u.id AND j.idempotency_key=$4)
                ORDER BY u.id LIMIT $3`, [checkpoint.afterUserId ?? '', row.visible_at, this.batch, `frontier-notify:safety:${row.public_id}`])).rows;
                // Freeze the item's public payload across every page of this fan-out as well as per recipient.
                const notice = checkpoint.notice ?? frontierSafetyNotice(row, this.timeZone);
                let queued = 0;
                for (const reader of readers) {
                    if (await this.eligible(reader.id, { kind: 'safety', key: row.public_id }, client) && await this.enqueue(client, reader.id, 'safety', row.public_id, notice))
                        queued++;
                }
                await save(readers.length === this.batch ? { seq: checkpoint.seq, afterUserId: readers.at(-1).id, notice } : { seq: change.seq, afterUserId: '' });
                this.counters.queued += queued;
                return { queued };
            }
            if (changes.length)
                await save(checkpoint);
            return { queued: 0 };
        });
    }
    /** Leased inbox creation; an interrupted finish retries the exact immutable notice. */
    async deliverDue() {
        if (!this.jobs || !this.notifications)
            return { delivered: 0, unavailable: true };
        await this.ready();
        let delivered = 0;
        for (let n = 0; n < this.batch; n++) {
            const job = await this.jobs.claim([KIND], this.workerId, { leaseMs: 300000 });
            if (!job)
                break;
            try {
                if (!await this.eligible(job.userId, job.payload.target)) {
                    await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: 'recipient-no-longer-eligible' });
                    this.counters.skipped++;
                    continue;
                }
                if (job.payload.target.kind === 'weekly') {
                    const prefs = await this.notifications.preferences(job.userId);
                    if (zonedClock(this.now(), this.timeZone).clock < prefs.digestTime) {
                        await this.jobs.fail(job.userId, job.id, job.leaseToken, { code: 'frontier_digest_not_due', message: 'Reader digest time has not arrived.' }, { retry: true, delayMs: 60000, refundAttempt: true });
                        continue;
                    }
                }
                await this.notifications.create(job.userId, job.payload.notice, { now: this.now() });
                await this.jobs.finish(job.userId, job.id, job.leaseToken, { delivered: true });
                this.counters.delivered++;
                delivered++;
            }
            catch (error) {
                this.counters.failed++;
                await this.jobs.fail(job.userId, job.id, job.leaseToken, { code: 'frontier_notify_failed', message: 'Frontier notification delivery failed.' }, { retry: true, delayMs: 60000 });
            }
        }
        return { delivered };
    }
    status() { return { available: Boolean(this.jobs && this.notifications), counters: { ...this.counters } }; }
}
