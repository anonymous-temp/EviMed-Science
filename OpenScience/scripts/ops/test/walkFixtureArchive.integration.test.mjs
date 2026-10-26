// The walk fixture's daily archive against a real PostgreSQL: the issues the module composes for the days its items cover, and the copies
// before them, so 日报's archive is drawn by month (c5-reader, 2026-10-26). Skipped without OPEN_SCIENCE_TEST_POSTGRES_URL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { FrontierDaily, frontierDailyWindow } from '../../../apps/server/src/frontierDaily.mjs';
import { migrateFrontier } from '../../../apps/server/src/frontierPersistence.mjs';
import { FRONTIER_PROJECT_ID } from '../../../apps/server/src/internalProjects.mjs';
import { ProductJobs } from '../../../apps/server/src/productJobs.mjs';
import { migrateProductStore } from '../../../apps/server/src/productPersistence.mjs';
import { insertSource } from '../../../apps/server/test/helpers/frontierFixtures.mjs';
import { insertComposedItem, resetFrontier } from '../../../apps/server/test/helpers/frontierComposeFixtures.mjs';
import { fixtureArchiveDays, furnishArchive } from '../walk-fixture/frontier.mjs';
import { frontierDayIn } from '@evimed/domain';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured' };

const operator = `operator_${randomUUID().slice(0, 8)}`;
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $1, 'development')", [operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id, id, name, quota_bytes) VALUES ($1, $2, 'EviMed 前沿动态', 1000000)", [operator, FRONTIER_PROJECT_ID]);
});

after(async () => {
  if (!database) return;
  await database.query('DELETE FROM evimed_control.users WHERE id = $1', [operator]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await resetFrontier(database);
  await insertSource(database, 'nejm', { authority: 5 });
});

const dailyOf = () => new FrontierDaily({
  database, jobs: new ProductJobs(database), editor: { available: false }, config: { frontierDailyTime: '07:30', frontierTimeZone: 'Asia/Shanghai' },
  owner: () => ({ userId: operator, projectId: FRONTIER_PROJECT_ID }), budget: async () => ({ state: 'ok' }), workerId: 'walk-archive-test',
});

/** The fixture's items: a few of each lane in every window the archive composes (the three days before today), by the same windows the module cuts. */
async function seedWindows() {
  const today = frontierDayIn(new Date());
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const items = [];
  for (const back of [0, 1, 2]) {
    const day = new Date(Date.parse(`${yesterday}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    const window = frontierDailyWindow(day, { timeZone: 'Asia/Shanghai', dailyTime: '07:30' });
    for (const [lane, count] of [['evidence', 5], ['guideline', 3]]) {
      for (let at = 0; at < count; at += 1) {
        items.push(await insertComposedItem(database, {
          sourceId: 'nejm', title: `${day} ${lane} ${at}`, titleZh: `${day} ${lane} ${at}`, summaryZh: '导读。', verification: 'passed', selected: true, lane,
          scoreTotal: 90 - at - back, visibleAt: new Date(window.start.getTime() + (at + 1 + (lane === 'guideline' ? 5 : 0)) * 3_600_000).toISOString(),
        }));
      }
    }
  }
  return { today, items };
}

test('the archive is composed for the days the items cover and copied before them: months, counts that differ, an issue time of 07:31 in Beijing', options, async () => {
  const { today } = await seedWindows();
  const logged = [];
  await furnishArchive(database, dailyOf(), (line) => logged.push(line));
  const reader = dailyOf();
  const archive = await reader.list(60);
  const days = archive.map((entry) => entry.day);
  assert.deepEqual(days, [...days].sort().reverse(), 'newest first');
  assert.ok(days.every((day) => day < today), 'none of today');
  for (const day of fixtureArchiveDays(today)) assert.ok(days.includes(day), `the copy of ${day}`);
  assert.ok(new Set(days.map((day) => day.slice(0, 7))).size >= 2, `months: ${[...new Set(days.map((day) => day.slice(0, 7)))]}`);
  assert.ok(new Set(archive.map((entry) => entry.itemCount)).size >= 3, `counts: ${archive.map((entry) => entry.itemCount)}`);
  assert.ok(archive.every((entry) => entry.itemCount >= 1));
  // An issue is stamped as the job stamps it: 07:31 on its own day in Beijing.
  const stamped = (await database.query(`SELECT day::text AS day, to_char(generated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') AS at FROM evimed_frontier.dailies`)).rows;
  for (const row of stamped) assert.equal(row.at, `${row.day} 07:31`, row.day);
  // A copy reads as an issue: a lead, lanes, the days on either side of it.
  const copy = await reader.read(fixtureArchiveDays(today)[0]);
  assert.ok(copy.lead?.itemId, 'a lead');
  assert.ok(copy.sections.length >= 2 && copy.sections.every((section) => section.itemIds.length >= 1));
  assert.ok(copy.nextDay === null || copy.nextDay > copy.day);
  assert.match(logged.at(-1), /archive — \d+ composed, \d+ copied/);
});

test('furnishing twice changes nothing, and never writes over a day that has an issue', options, async () => {
  await seedWindows();
  await furnishArchive(database, dailyOf(), () => {});
  const first = (await database.query('SELECT day::text AS day, markdown, cardinality(item_ids) AS items FROM evimed_frontier.dailies ORDER BY day')).rows;
  await database.query(`UPDATE evimed_frontier.dailies SET markdown = 'kept' WHERE day = $1::date`, [first[0].day]);
  await furnishArchive(database, dailyOf(), () => {});
  const second = (await database.query('SELECT day::text AS day, markdown, cardinality(item_ids) AS items FROM evimed_frontier.dailies ORDER BY day')).rows;
  assert.equal(second.length, first.length);
  assert.equal(second[0].markdown, 'kept');
  assert.deepEqual(second.map((row) => [row.day, row.items]), first.map((row) => [row.day, row.items]));
});

test('with nothing to compose it says so and writes no copies', options, async () => {
  const logged = [];
  await furnishArchive(database, dailyOf(), (line) => logged.push(line));
  assert.deepEqual((await database.query('SELECT 1 FROM evimed_frontier.dailies')).rows, []);
  assert.match(logged.at(-1), /no issue to copy from/);
});
