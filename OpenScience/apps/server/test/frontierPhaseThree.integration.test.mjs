import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { FrontierWorker } from '../src/frontierWorker.mjs';
import { FrontierWeekly } from '../src/frontierWeekly.mjs';
import { FrontierNotifications, frontierDeliveryInfrastructureError } from '../src/frontierNotifications.mjs';
import { HttpError } from '../src/security.mjs';
import { FrontierService, frontierVocabularyView } from '../src/frontierService.mjs';
import { NotificationService } from '../src/notificationService.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { PRODUCT_JOB_KINDS, migrateProductStore } from '../src/productPersistence.mjs';
import { migrateFrontier } from '../src/frontierPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { insertSource, TEST_VOCABULARY } from './helpers/frontierFixtures.mjs';
import { insertComposedItem } from './helpers/frontierComposeFixtures.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'local PostgreSQL required' };
let db, isolated, jobs, notices, weekly, service, delivery;
const now = () => new Date('2026-09-28T01:00:00Z');
const config = { frontierEnabled: true, frontierAudience: 'all', frontierTimeZone: 'Asia/Shanghai', frontierDailyTime: '07:30', frontierNotifyBatch: 1 };
before(async () => {
    if (!url)
        return;
    isolated = await createGeoTestDatabase(url, 'p3');
    db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
    await migrateFrontier(db, { dimension: 1024 });
    await migrateProductStore(db);
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development'),('bob','Bob','development'),('operator','Operator','development')");
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('operator','frontier','Frontier',1000000)");
    await db.query("INSERT INTO evimed_frontier.glossary(kind,term_en,term_zh,origin) VALUES('drug','semaglutide','司美格鲁肽','test')");
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => {
    if (!db)
        return;
    await db.query('TRUNCATE evimed_frontier.items,evimed_frontier.user_follows,evimed_frontier.user_prefs,evimed_frontier.weeklies,evimed_frontier.item_changes,evimed_product.jobs CASCADE');
    await db.query("DELETE FROM evimed_frontier.meta WHERE key LIKE 'safety_%' OR key LIKE 'weekly_recipients:%'");
    await db.query('DELETE FROM evimed_frontier.sources');
    await insertSource(db, 'fda', { source_type: 'regulator', name: 'FDA' });
    await insertSource(db, 'news', { source_type: 'media' });
    jobs = new ProductJobs(db);
    notices = new NotificationService(db);
    for (const id of ['alice', 'bob']) {
        await notices.preferences(id);
        await db.query('UPDATE evimed_inbox.preferences SET switches=$2::jsonb WHERE user_id=$1', [id, JSON.stringify({ notify: true, review: true, question: true, frontier: true })]);
    }
    await db.query('DELETE FROM evimed_inbox.notifications');
    weekly = new FrontierWeekly({ database: db, jobs, owner: () => ({ userId: 'operator', projectId: 'frontier' }), config, now });
    service = new FrontierService({ database: db, config, vocabulary: frontierVocabularyView(TEST_VOCABULARY), weekly });
    delivery = new FrontierNotifications({ database: db, jobs, notifications: notices, weekly, config, now });
});
async function follow(user = 'alice', extra = {}) { await service.createFollow({ id: user }, { kind: 'drug', key: '司美格鲁肽', ...extra }); await db.query("UPDATE evimed_frontier.user_follows SET created_at='2026-09-20' WHERE user_id=$1", [user]); }
async function item(extra = {}) { return insertComposedItem(db, { sourceId: 'fda', sourceType: 'regulator', evidenceType: 'safety-notice', title: 'Public safety notice', titleZh: '安全公告', summaryZh: '已发布安全公告。', selected: true, safetyAlert: true, verification: 'passed', visibleAt: '2026-09-25T01:00:00Z', entityKeys: ['drug:semaglutide'], ...extra }); }
async function changed(id) { await db.query("INSERT INTO evimed_frontier.item_changes(item_id,op,reason) VALUES($1,'upsert','published')", [id]); }
test('old client omission preserves new explicit switches and legacy opt-out', options, async () => {
    let p = await notices.preferences('alice');
    const write = switches => notices.updatePreferences('alice', { quietHours: p.quietHours, digestTime: p.digestTime, channels: p.channels, switches }, p.revision);
    p = await write({ notify: true, question: true, review: true, frontier: false });
    assert.equal(p.switches.frontierWeekly, false);
    p = await write({ notify: true, question: true, review: true, frontierSafety: true });
    assert.equal(p.switches.frontierSafety, true);
    p = await write({ notify: true, question: true, review: true });
    assert.equal(p.switches.frontierSafety, true);
    assert.equal(p.switches.frontierWeekly, false);
    await assert.rejects(write({ notify: true, question: true, review: true, noSuchSwitch: true }), { code: 'notification_preferences_invalid' });
});
test('weekly publishes once, reads current items, catches up only latest week and queues ordinary readers', options, async () => {
    const included = await item();
    await item({ title: 'After boundary', visibleAt: '2026-09-27T16:00:00Z' });
    await item({ title: 'Before boundary', visibleAt: '2026-09-20T15:59:59Z' });
    await follow();
    await follow('bob');
    await Promise.all([weekly.runDue(), weekly.runDue()]);
    const index = await weekly.list();
    assert.equal(index.length, 1);
    assert.equal(index[0].weekStart, '2026-09-21');
    let issue = (await service.weeklyIssue({ id: 'alice' }, index[0].weekStart)).weekly;
    assert.equal(issue.itemCount, 1);
    assert.match(issue.markdown, /安全公告/);
    await delivery.queueWeekly();
    await delivery.queueWeekly();
    await delivery.deliverDue();
    await delivery.deliverDue();
    assert.equal((await db.query("SELECT count(*)::int n FROM evimed_inbox.notifications WHERE source->>'id'='frontier-weekly:2026-09-21'")).rows[0].n, 2);
    await db.query("UPDATE evimed_frontier.items SET state='withdrawn' WHERE id=$1", [included.id]);
    issue = (await service.weeklyIssue({ id: 'alice' }, index[0].weekStart)).weekly;
    assert.equal(issue.itemCount, 0);
    assert.doesNotMatch(issue.markdown, /安全公告/);
});
test('official matching safety fan-out checkpoints, freezes payload, and rechecks mute at delivery', options, async () => {
    await follow();
    await follow('bob');
    const alert = await item();
    await changed(alert.id);
    assert.equal((await delivery.scanSafety()).bootstrapped, true);
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_product.jobs')).rows[0].n, 0);
    await changed(alert.id);
    await delivery.scanSafety();
    await db.query("UPDATE evimed_frontier.items SET title_zh='重编标题' WHERE id=$1", [alert.id]);
    const restarted = new FrontierNotifications({ database: db, jobs, notifications: notices, weekly, config, now });
    await restarted.scanSafety();
    assert.equal((await db.query("SELECT count(*)::int n FROM evimed_product.jobs WHERE kind='frontier-notify'")).rows[0].n, 2);
    await service.createFollow({ id: 'bob' }, { kind: 'source', key: 'fda', muted: true });
    await restarted.deliverDue();
    await restarted.deliverDue();
    const inbox = (await db.query('SELECT user_id,title,body FROM evimed_inbox.notifications')).rows;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].user_id, 'alice');
    assert.equal(inbox[0].title, '安全公告');
    assert.doesNotMatch(inbox[0].body, /司美格鲁肽|关注|记忆/);
    await changed(alert.id);
    await restarted.scanSafety();
    await restarted.scanSafety();
    await restarted.deliverDue();
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_inbox.notifications')).rows[0].n, 1);
});
test('shared regulator, later follows, pending prose, withdrawal and source mute never qualify', options, async () => {
    await follow();
    const unrelated = await item({ entityKeys: ['drug:dapagliflozin'] });
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: unrelated.publicId }), false);
    const pending = await item({ verification: 'title-only', summaryZh: null });
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: pending.publicId }), false);
    const wanted = await item();
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: wanted.publicId }), true);
    await db.query('UPDATE evimed_frontier.user_follows SET created_at=now()');
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: wanted.publicId }), false);
});
test('retained scan gap records lost range without a historical flood', options, async () => {
    await follow();
    const alert = await item();
    await changed(alert.id);
    await delivery.scanSafety();
    await changed(alert.id);
    await changed(alert.id);
    const max = (await db.query('SELECT max(seq)::text seq FROM evimed_frontier.item_changes')).rows[0].seq;
    await db.query("UPDATE evimed_frontier.item_changes SET changed_at='2026-01-01' WHERE seq<$1", [max]);
    const worker = new FrontierWorker({ database: db, ingest: { plugin: { configured: false } }, now });
    assert.equal((await worker.cleanup()).itemChanges, 2);
    assert.equal((await delivery.scanSafety()).gap, true);
    assert.equal(delivery.status().counters.scanGaps, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_product.jobs')).rows[0].n, 0);
});
test('creation-success/finish-failure retries identical notice after edits and does not duplicate', options, async () => {
    await follow();
    const alert = await item();
    await delivery.scanSafety();
    await changed(alert.id);
    await delivery.scanSafety();
    const finish = jobs.finish.bind(jobs);
    let failed = false;
    jobs.finish = async (...args) => {
        if (!failed) {
            failed = true;
            throw new Error('simulated crash');
        }
        return finish(...args);
    };
    await delivery.deliverDue();
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_inbox.notifications')).rows[0].n, 1);
    await db.query("UPDATE evimed_frontier.items SET title_zh='Updated public title' WHERE id=$1", [alert.id]);
    await db.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE status='queued'");
    await delivery.deliverDue();
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_inbox.notifications')).rows[0].n, 1);
    assert.equal((await db.query("SELECT status FROM evimed_product.jobs WHERE kind='frontier-notify'")).rows[0].status, 'succeeded');
});
test('pending alerts can qualify after verification, with source, hide and audience rechecked', options, async () => {
    await follow();
    const alert = await item({ verification: 'title-only', summaryZh: null });
    await delivery.scanSafety();
    await changed(alert.id);
    await delivery.scanSafety();
    await delivery.scanSafety();
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_product.jobs')).rows[0].n, 0);
    await db.query("UPDATE evimed_frontier.items SET verification='passed',summary_zh='Verified prose' WHERE id=$1", [alert.id]);
    await changed(alert.id);
    await delivery.scanSafety();
    await db.query("UPDATE evimed_frontier.sources SET enabled=false WHERE id='fda'");
    await delivery.deliverDue();
    assert.equal(delivery.status().counters.skipped, 1);
    await db.query("UPDATE evimed_frontier.sources SET enabled=true WHERE id='fda'");
    await service.setItemState({ id: 'alice' }, alert.publicId, 'hide');
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: alert.publicId }), false);
    await service.setItemState({ id: 'alice' }, alert.publicId, 'unhide');
    const preview = new FrontierNotifications({ database: db, jobs, notifications: notices, config: { ...config, frontierAudience: 'operators', operatorUsers: ['operator'] }, now });
    assert.equal(await preview.eligible('alice', { kind: 'safety', key: alert.publicId }), false);
    const media = await item({ sourceId: 'news', sourceType: 'media' });
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: media.publicId }), false);
});
test('concurrent fan-out and one failing inbox never lose another recipient', options, async () => {
    await follow();
    await follow('bob');
    const alert = await item();
    await delivery.scanSafety();
    await changed(alert.id);
    await Promise.all([delivery.scanSafety(), delivery.scanSafety()]);
    assert.equal((await db.query("SELECT count(*)::int n FROM evimed_product.jobs WHERE kind='frontier-notify'")).rows[0].n, 2);
    const create = notices.create.bind(notices);
    notices.create = async (user, ...args) => {
        if (user === 'alice')
            throw new Error('one inbox unavailable');
        return create(user, ...args);
    };
    await delivery.deliverDue();
    await delivery.deliverDue();
    assert.deepEqual((await db.query('SELECT user_id FROM evimed_inbox.notifications')).rows.map(row => row.user_id), ['bob']);
});
test('empty week succeeds without issue or push and future quiet preferences do not exhaust delivery attempts', options, async () => {
    assert.equal((await weekly.runDue()).empty, true);
    assert.deepEqual(await weekly.list(), []);
    assert.deepEqual(await delivery.queueWeekly(), { queued: 0 });
    await db.query('DELETE FROM evimed_product.jobs');
    await item();
    await follow();
    await weekly.runDue();
    await delivery.queueWeekly();
    await db.query("UPDATE evimed_inbox.preferences SET digest_time='12:00' WHERE user_id='alice'");
    await delivery.deliverDue();
    const job = (await db.query("SELECT status,attempts FROM evimed_product.jobs WHERE kind='frontier-notify'")).rows[0];
    assert.deepEqual(job, { status: 'queued', attempts: 0 });
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_inbox.notifications')).rows[0].n, 0);
});
test('ordinary changes are scanned in a bounded batch before the next relevant safety item', options, async () => {
    await follow();
    await delivery.scanSafety();
    for (let n = 0; n < 12; n++) {
        const ordinary = await item({ safetyAlert: false, title: `Ordinary news ${n}` });
        await changed(ordinary.id);
    }
    const alert = await item();
    await changed(alert.id);
    await delivery.scanSafety();
    assert.equal((await db.query("SELECT count(*)::int n FROM evimed_product.jobs WHERE kind='frontier-notify'")).rows[0].n, 1);
});

test('weekly generation recovers an expired lease and refreshes older job-kind constraints',options,async()=>{
    const older=PRODUCT_JOB_KINDS.filter(kind=>!['frontier-weekly','frontier-notify'].includes(kind));
    await db.query('ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check');
    await db.query(`ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK(kind IN (${older.map(kind=>"'"+kind+"'").join(',')}))`);
    const next=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:2,databaseConnectionTimeoutMs:2000});
    try{await migrateProductStore(next);}finally{await next.close();}
    await item();const job=await jobs.enqueue('operator','frontier-weekly',{weekStart:'2026-09-21'},{idempotencyKey:'frontier-weekly:2026-09-21',projectId:'frontier'});
    const expired=await jobs.claim(['frontier-weekly'],'dead-worker',{leaseMs:1000});assert.equal(expired.id,job.id);
    await db.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    await weekly.runDue();assert.equal((await weekly.list()).length,1);
    await assert.rejects(jobs.finish('operator',job.id,expired.leaseToken,{bad:true}),{code:'product_job_lease_lost'});
});

test('old, inferred and post-publication follows do not turn newly ingested history into an alert', options, async () => {
    await follow();
    const old = await item({ publishedAt: '2026-06-01T00:00:00Z', visibleAt: now().toISOString() });
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: old.publicId }), false);
    const inferred = await item({ publishedAt: now().toISOString(), visibleAt: now().toISOString() });
    await db.query("UPDATE evimed_frontier.items SET date_precision='inferred' WHERE id=$1", [inferred.id]);
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: inferred.publicId }), false);
    const after = await item({ publishedAt: '2026-09-22T01:00:00Z' });
    await db.query("UPDATE evimed_frontier.user_follows SET created_at='2026-09-23T00:00:00Z'");
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: after.publicId }), false);
    await db.query("UPDATE evimed_frontier.user_follows SET created_at='2026-09-22T01:00:00Z'");
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: after.publicId }), true);
});

test('an ordinary rolled-back sequence allocation is not a retention gap', options, async () => {
    await follow(); await delivery.scanSafety(); const alert = await item();
    await assert.rejects(db.transaction(async client => { await client.query("INSERT INTO evimed_frontier.item_changes(item_id,op,reason) VALUES($1,'upsert','rolled-back')", [alert.id]); throw new Error('rollback'); }));
    await changed(alert.id); const result = await delivery.scanSafety();
    assert.equal(result.gap, undefined); assert.equal(result.queued, 1);
});

test('a scan waits for earlier uncommitted sequence allocations before advancing', { ...options, timeout: 5000 }, async () => {
    await follow(); await delivery.scanSafety(); const alert = await item(); const ordinary = await item({ safetyAlert: false });
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const inserted = new Promise(resolve => { started = resolve; });
    const writer = db.transaction(async client => {
        await client.query("INSERT INTO evimed_frontier.item_changes(item_id,op,reason) VALUES($1,'upsert','published')", [alert.id]);
        started(); await gate;
    });
    await inserted; await changed(ordinary.id);
    let completed = false; const scanning = delivery.scanSafety().then(result => { completed = true; return result; });
    try { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(completed, false); }
    finally { release(); }
    await writer; assert.equal((await scanning).queued, 1);
});

test('scan and actual retention cleanup share a non-upgrading lock order', { ...options, timeout: 5000 }, async () => {
    await follow(); await delivery.scanSafety(); const alert = await item(); await changed(alert.id);
    const worker = new FrontierWorker({ database: db, ingest: { plugin: { configured: false } }, now });
    const results = await Promise.all([delivery.scanSafety(), worker.cleanup()]);
    assert.equal(results[0].queued, 1); assert.equal(results[1].itemChanges, 0);
});

test('known publication recency is bounded and inferred flags never establish recency', options, async () => {
    await follow();
    for (const [publishedAt, allowed] of [['2026-09-21T01:00:00Z', true], ['2026-09-21T00:59:59Z', false], ['2026-09-29T00:00:00Z', false], [null, false]]) {
        const alert = await item({ publishedAt });
        assert.equal(await delivery.eligible('alice', { kind: 'safety', key: alert.publicId }), allowed);
    }
    const inferred = await item({ flags: ['date-inferred'] });
    assert.equal(await delivery.eligible('alice', { kind: 'safety', key: inferred.publicId }), false);
    assert.equal((await service.getItem({ id: 'alice' }, inferred.publicId)).body.item.id, inferred.publicId, 'the item remains browsable');
});

// D-02 (review 2026-10-10): a weekly or a notice whose job used its three attempts was failed for good; nothing asked again.
/** A clock the test moves. @param {string} start */
function clock(start = '2026-09-28T01:00:00Z') {
    let at = new Date(start);
    return { now: () => at, advance: (/** @type {number} */ ms) => { at = new Date(at.getTime() + ms); } };
}
const jobRow = async (kind) => (await db.query('SELECT status,attempts FROM evimed_product.jobs WHERE kind=$1', [kind])).rows;
/** The job's own retry pause skipped: it is not what these tests are about. */
const retryNow = (kind) => db.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE kind=$1 AND status='queued'", [kind]);
async function queuedSafetyNotice() {
    await follow();
    const alert = await item();
    await delivery.scanSafety();
    await changed(alert.id);
    await delivery.scanSafety();
    assert.equal((await jobRow('frontier-notify')).length, 1);
    return alert;
}
test('D-02: a weekly whose job gave up is asked again an hour later, and written once its cause is gone', options, async () => {
    await item();
    const time = clock();
    const issuer = new FrontierWeekly({ database: db, jobs, owner: () => ({ userId: 'operator', projectId: 'frontier' }), config, now: time.now });
    const compose = issuer.compose.bind(issuer);
    issuer.compose = async () => { throw Object.assign(new Error('database blip'), { code: 'database_unavailable' }); };
    for (let attempt = 1; attempt <= 3; attempt++) {
        await retryNow('frontier-weekly');
        await assert.rejects(issuer.runDue(), { code: 'database_unavailable' });
    }
    assert.deepEqual(await jobRow('frontier-weekly'), [{ status: 'failed', attempts: 3 }], 'three attempts, then the job gives up');
    issuer.compose = compose; // the cause is gone
    time.advance(60_000);
    assert.deepEqual(await issuer.runDue(), { ran: false }, 'a minute after giving up is too soon to ask again');
    assert.deepEqual(await issuer.list(), []);
    time.advance(61 * 60_000);
    assert.equal((await issuer.runDue()).ran, true, 'an hour later the job is put back and run');
    assert.equal((await issuer.list()).length, 1);
    assert.deepEqual(await jobRow('frontier-weekly'), [{ status: 'succeeded', attempts: 1 }]);
    assert.equal(issuer.counters.rearmed, 1);
});
test('D-02: a notice job that gave up is asked again an hour later, and delivered once the inbox is back', options, async () => {
    // The review's probe: a safety notice whose delivery threw three times delivered nothing after recovery.
    await queuedSafetyNotice();
    const time = clock();
    const sender = new FrontierNotifications({ database: db, jobs, notifications: { create: async () => { throw new Error('inbox unavailable'); } }, weekly, config, now: time.now });
    for (let attempt = 1; attempt <= 3; attempt++) {
        await retryNow('frontier-notify');
        await sender.deliverDue();
    }
    assert.deepEqual(await jobRow('frontier-notify'), [{ status: 'failed', attempts: 3 }]);
    sender.notifications = notices; // the inbox is back
    time.advance(60_000);
    assert.deepEqual(await sender.deliverDue(), { delivered: 0 }, 'a minute after giving up is too soon to ask again');
    assert.equal((await db.query('SELECT count(*)::int n FROM evimed_inbox.notifications')).rows[0].n, 0);
    time.advance(61 * 60_000);
    assert.deepEqual(await sender.deliverDue(), { delivered: 1 }, 'an hour later the job is put back and delivered');
    assert.deepEqual((await db.query('SELECT user_id FROM evimed_inbox.notifications')).rows, [{ user_id: 'alice' }]);
    assert.equal(sender.status().counters.rearmed, 1);
});
test('D-02: a notice job that keeps failing is asked three times an hour, and not for ever', options, async () => {
    await queuedSafetyNotice();
    const time = clock();
    let calls = 0;
    const sender = new FrontierNotifications({ database: db, jobs, notifications: { create: async () => { calls++; throw new Error('inbox unavailable'); } }, weekly, config, now: time.now });
    for (let minute = 0; minute < 150; minute++) {
        await retryNow('frontier-notify');
        await sender.deliverDue();
        time.advance(60_000);
    }
    assert.equal(calls, 9, 'the first round, then one more at each hour — a job asked every minute would have run 150 times');
    // A job older than a week is let be: the notice it carries is no longer one anybody can be told.
    await db.query("UPDATE evimed_product.jobs SET status='failed',attempts=3,created_at=now()-interval '8 days' WHERE kind='frontier-notify'");
    time.advance(2 * 60 * 60_000);
    await sender.deliverDue();
    assert.equal(calls, 9);
    assert.deepEqual(await jobRow('frontier-notify'), [{ status: 'failed', attempts: 3 }]);
});
test('D-02: only the platform\'s own plumbing failing gives an attempt back; a refusal the notice earned does not', () => {
    const coded = (/** @type {unknown} */ code) => Object.assign(new Error('x'), { code });
    for (const code of ['40001', '40P01', '55P03', '57014', '57P01', '57P03', '08006', '08001', '53100', '53300', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'])
        assert.equal(frontierDeliveryInfrastructureError(coded(code)), true, String(code));
    for (const code of ['23505', '23503', '42P01', '22001', '5300', 'notification_invalid', 'frontier_notify_failed', '', undefined])
        assert.equal(frontierDeliveryInfrastructureError(coded(code)), false, String(code));
    assert.equal(frontierDeliveryInfrastructureError(new Error('inbox unavailable')), false, 'an error that names nothing counts as an attempt');
    assert.equal(frontierDeliveryInfrastructureError(new HttpError(409, '40001', 'refused')), false, 'our own refusal is the notice\'s');
    assert.equal(frontierDeliveryInfrastructureError(null), false);
});
test('D-02: an infrastructural failure gives its attempt back, so an outage does not use a notice job up', options, async () => {
    await queuedSafetyNotice();
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const sender = new FrontierNotifications({ database: db, jobs, notifications: { create: async () => { throw deadlock; } }, weekly, config, now });
    for (let round = 1; round <= 6; round++) {
        await retryNow('frontier-notify');
        await sender.deliverDue();
        assert.deepEqual(await jobRow('frontier-notify'), [{ status: 'queued', attempts: 0 }], `after ${round} infrastructural failures the job is still whole`);
    }
    assert.equal(sender.status().counters.failed, 6);
    assert.equal(sender.status().counters.refunded, 6);
    sender.notifications = notices; // the lock cleared
    await retryNow('frontier-notify');
    assert.deepEqual(await sender.deliverDue(), { delivered: 1 });
    assert.deepEqual(await jobRow('frontier-notify'), [{ status: 'succeeded', attempts: 1 }]);
});

/** Every reader's safety notices in the inbox: user → titles, alphabetically (they are made in the same instant). */
async function safetyInbox() {
    const rows = (await db.query("SELECT user_id,title FROM evimed_inbox.notifications WHERE source->>'id' LIKE 'frontier-safety:%' ORDER BY user_id,title")).rows;
    const byUser = {};
    for (const row of rows)
        (byUser[row.user_id] ??= []).push(row.title);
    return byUser;
}
/** Bootstrap the scan's cursor, then record each change and scan until the fan-out is done. @param {FrontierNotifications} scanner @param {Array<{id:string}>} alerts */
async function scanAlerts(scanner, alerts) {
    await scanner.scanSafety();
    for (const alert of alerts)
        await changed(alert.id);
    for (let n = 0; n < alerts.length * 3; n++)
        await scanner.scanSafety();
}
test('F12c: a Class I recall or a boxed-warning alert reaches every reader whose switches allow it, and any other alert still reaches the followers of what it names', options, async () => {
    // The platform's own publisher account exists wherever the frontier is migrated; it is no reader.
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('carol','Carol','development'),('dave','Dave','development')");
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('evimed-evidence-center','Evidence centre','platform') ON CONFLICT (id) DO NOTHING");
    try {
        await db.query("UPDATE evimed_control.users SET created_at='2026-09-01T00:00:00Z'");
        for (const id of ['carol', 'dave'])
            await notices.preferences(id);
        await db.query("UPDATE evimed_inbox.preferences SET switches=$1::jsonb WHERE user_id='carol'", [JSON.stringify({ notify: true, review: true, question: true, frontier: true, frontierSafety: false })]);
        await follow('alice');
        await service.createFollow({ id: 'dave' }, { kind: 'source', key: 'fda', muted: true });
        const wide = new FrontierNotifications({ database: db, jobs, notifications: notices, weekly, config: { ...config, frontierNotifyBatch: 20 }, now });
        // None of the four names the drug alice follows, but the last.
        const recall = await item({ title: 'Class I recall', titleZh: 'Class I recall', flags: ['class-i-recall'], entityKeys: ['drug:dapagliflozin'] });
        const boxed = await item({ title: 'Boxed warning added', titleZh: 'Boxed warning added', flags: ['boxed-warning'], entityKeys: ['drug:dapagliflozin'] });
        const ordinary = await item({ title: 'Ordinary alert', titleZh: 'Ordinary alert', entityKeys: ['drug:dapagliflozin'] });
        const followed = await item({ title: 'Alert on a followed drug', titleZh: 'Alert on a followed drug', entityKeys: ['drug:semaglutide'] });
        await scanAlerts(wide, [recall, boxed, ordinary, followed]);
        await wide.deliverDue();
        assert.deepEqual(await safetyInbox(), {
            alice: ['Alert on a followed drug', 'Boxed warning added', 'Class I recall'],
            bob: ['Boxed warning added', 'Class I recall'],
            operator: ['Boxed warning added', 'Class I recall'],
        }, 'everyone with the push on gets the two; the ordinary alert and the followed one reach alice alone for what she follows; carol turned the switch off, dave muted the source, the platform account is no reader');
        assert.equal(await wide.eligible('bob', { kind: 'safety', key: ordinary.publicId }), false, 'no follow, no mark: no push');
        assert.equal(await wide.eligible('bob', { kind: 'safety', key: recall.publicId }), true);
        assert.equal(await wide.eligible('carol', { kind: 'safety', key: recall.publicId }), false);
        assert.equal(await wide.eligible('dave', { kind: 'safety', key: boxed.publicId }), false, 'a source a reader muted stays muted');
        // The IM channel asks the same question before it sends, and answers the same.
        assert.equal(await wide.deliveryAllowed({ userId: 'bob', source: { type: 'system', id: `frontier-safety:${boxed.publicId}` } }), true);
        assert.equal(await wide.deliveryAllowed({ userId: 'bob', source: { type: 'system', id: `frontier-safety:${ordinary.publicId}` } }), false);
        // A reader who hides the item is not pushed it either, and a mark on a media story is no alert.
        await service.setItemState({ id: 'bob' }, recall.publicId, 'hide');
        assert.equal(await wide.eligible('bob', { kind: 'safety', key: recall.publicId }), false);
        const story = await item({ sourceId: 'news', sourceType: 'media', flags: ['class-i-recall'] });
        assert.equal(await wide.eligible('alice', { kind: 'safety', key: story.publicId }), false);
    }
    finally {
        await db.query("DELETE FROM evimed_control.users WHERE id=ANY($1)", [['carol', 'dave']]);
    }
});
test('F12c: a reader receives at most three safety pushes a day, from either reach; the fourth is counted and dropped, and the next day starts again', options, async () => {
    await db.query("UPDATE evimed_control.users SET created_at='2026-09-01T00:00:00Z'");
    await follow('alice');
    const wide = new FrontierNotifications({ database: db, jobs, notifications: notices, weekly, config: { ...config, frontierNotifyBatch: 20 }, now });
    const alerts = [
        await item({ title: 'Recall 1', titleZh: 'Recall 1', flags: ['class-i-recall'] }),
        await item({ title: 'Recall 2', titleZh: 'Recall 2', flags: ['class-i-recall'] }),
        await item({ title: 'Followed 1', titleZh: 'Followed 1', entityKeys: ['drug:semaglutide'] }),
        await item({ title: 'Followed 2', titleZh: 'Followed 2', entityKeys: ['drug:semaglutide'] }),
    ];
    await scanAlerts(wide, alerts);
    assert.equal((await db.query("SELECT count(*)::int n FROM evimed_product.jobs WHERE kind='frontier-notify'")).rows[0].n, 2 * 3 + 2, 'three readers for each recall, alice alone for her two');
    for (let n = 0; n < 3; n++)
        await wide.deliverDue();
    const inbox = await safetyInbox();
    assert.deepEqual(Object.fromEntries(Object.entries(inbox).map(([user, titles]) => [user, titles.length])), { alice: 3, bob: 2, operator: 2 },
        'alice has her three; the fourth push of the day is not made');
    assert.equal(wide.status().counters.safetyCapped, 1, 'and it is counted');
    const results = (await db.query("SELECT result FROM evimed_product.jobs WHERE kind='frontier-notify' AND user_id='alice' ORDER BY id")).rows.map(row => row.result);
    assert.equal(results.filter(result => result?.skipped === 'daily-cap').length, 1);
    assert.equal(results.filter(result => result?.delivered === true).length, 3);
    // A fifth the same day is dropped for alice and delivered to those below the cap.
    const fifth = await item({ title: 'Recall 3', titleZh: 'Recall 3', flags: ['class-i-recall'] });
    await scanAlerts(wide, [fifth]);
    await wide.deliverDue();
    assert.deepEqual(Object.fromEntries(Object.entries(await safetyInbox()).map(([user, titles]) => [user, titles.length])), { alice: 3, bob: 3, operator: 3 });
    assert.equal(wide.status().counters.safetyCapped, 2);
    // The next day, in the feed's own zone, is a new count.
    const tomorrow = new FrontierNotifications({ database: db, jobs, notifications: notices, weekly, config: { ...config, frontierNotifyBatch: 20 }, now: () => new Date('2026-09-29T01:00:00Z') });
    const next = await item({ title: 'Recall 4', titleZh: 'Recall 4', flags: ['class-i-recall'], publishedAt: '2026-09-28T10:00:00Z', visibleAt: '2026-09-28T10:00:00Z' });
    await scanAlerts(tomorrow, [next]);
    await tomorrow.deliverDue();
    assert.deepEqual((await safetyInbox()).alice.length, 4, 'alice is pushed again');
    assert.equal(tomorrow.status().counters.safetyCapped, 0);
});
test('F12c: the day the cap counts is the feed zone\'s: a push at 23:30 Beijing time and one at 00:30 are two days', options, async () => {
    await db.query("UPDATE evimed_control.users SET created_at='2026-09-01T00:00:00Z'");
    const at = (iso) => new FrontierNotifications({ database: db, jobs, notifications: notices, weekly, config: { ...config, frontierNotifyBatch: 20, frontierSafetyPushDailyCap: 1 }, now: () => new Date(iso) });
    const first = await item({ title: 'Recall A', titleZh: 'Recall A', flags: ['class-i-recall'], publishedAt: '2026-09-27T10:00:00Z', visibleAt: '2026-09-27T10:00:00Z' });
    const evening = at('2026-09-27T15:30:00Z');
    await scanAlerts(evening, [first]);
    await evening.deliverDue();
    assert.equal((await safetyInbox()).alice.length, 1);
    const second = await item({ title: 'Recall B', titleZh: 'Recall B', flags: ['class-i-recall'], publishedAt: '2026-09-27T10:00:00Z', visibleAt: '2026-09-27T10:00:00Z' });
    const sameDay = at('2026-09-27T15:50:00Z');
    await scanAlerts(sameDay, [second]);
    await sameDay.deliverDue();
    assert.equal((await safetyInbox()).alice.length, 1, '23:50 Beijing time: the same day, over a cap of one');
    assert.equal(sameDay.status().counters.safetyCapped >= 1, true);
    const third = await item({ title: 'Recall C', titleZh: 'Recall C', flags: ['class-i-recall'], publishedAt: '2026-09-27T10:00:00Z', visibleAt: '2026-09-27T10:00:00Z' });
    const morning = at('2026-09-27T16:30:00Z');
    await scanAlerts(morning, [third]);
    await morning.deliverDue();
    assert.equal((await safetyInbox()).alice.length, 2, '00:30 Beijing time: the next day');
});
test('F12c: a push made whose job then failed to finish is still the one push when the job comes back, even at the ceiling', options, async () => {
    await db.query("UPDATE evimed_control.users SET created_at='2026-09-01T00:00:00Z'");
    const one = new FrontierNotifications({ database: db, jobs, notifications: notices, weekly, config: { ...config, frontierNotifyBatch: 20, frontierSafetyPushDailyCap: 1 }, now });
    const alert = await item({ title: 'Recall once', titleZh: 'Recall once', flags: ['boxed-warning'] });
    await scanAlerts(one, [alert]);
    const finish = jobs.finish.bind(jobs);
    let failures = 0;
    jobs.finish = async (user, ...args) => {
        if (user === 'alice' && failures++ === 0)
            throw new Error('simulated crash after the notice was made');
        return finish(user, ...args);
    };
    await one.deliverDue();
    await db.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE status='queued'");
    await one.deliverDue();
    assert.deepEqual((await safetyInbox()).alice, ['Recall once']);
    assert.equal(one.status().counters.safetyCapped, 0, 'the retry found its own row and was not counted against the ceiling');
    assert.equal((await db.query("SELECT status FROM evimed_product.jobs WHERE user_id='alice' AND kind='frontier-notify'")).rows[0].status, 'succeeded');
});
