import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { migrateEvidenceZones } from '../src/evidenceZonePersistence.mjs';
import { rankEvidenceCards } from '../src/evidenceJudgeRanking.mjs';
import { EvidenceZoneSubscriptions } from '../src/evidenceZoneSubscription.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'local PostgreSQL required' };
let isolated, database;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'evidencejudge');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateEvidenceZones(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('bob','p1','Project',1048576),('bob','p2','Other',1048576),('alice','p1','Attribution',1048576)");
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('J13 sends only published subscribed cards, preserves cards, and never recalls another tenant/project', options, async () => {
  const zone = 'ez_aaaaaaaaaaaaaaaa'; const draft = 'ez_bbbbbbbbbbbbbbbb';
  await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES($1,'alice','Evidence','published'),($2,'alice','Private','draft')", [zone, draft]);
  for (const [id, zoneId, state] of [['ec_aaaaaaaa',zone,'published'],['ec_bbbbbbbb',zone,'published'],['ec_cccccccc',zone,'draft'],['ec_dddddddd',draft,'published']])
    await database.query("INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,state,summary) VALUES($1,$2,'alice','stroke prevention','academic',$3,'stroke evidence')", [id,zoneId,state]);
  const calls = [];
  const judgeService = { judge: async (site, input) => {
    assert.equal(site, 'J13'); calls.push(input);
    assert.deepEqual(new Set(input.cards.map(c => c.id)), new Set(['ec_aaaaaaaa','ec_bbbbbbbb']));
    return { outcome: 'settled', value: { rankedIds: ['ec_bbbbbbbb','ec_aaaaaaaa'] } };
  } };
  const subscriptions = new EvidenceZoneSubscriptions({ database, documents: new ProductDocuments(database), enabled: true, judgeService });
  await subscriptions.subscribe('bob', 'p1', zone);
  assert.deepEqual((await subscriptions.recall('bob', 'p1', 'stroke prevention')).map(c => c.id), ['ec_bbbbbbbb','ec_aaaaaaaa']);
  assert.deepEqual(await subscriptions.recall('alice', 'p1', 'stroke prevention'), []);
  assert.deepEqual(await subscriptions.recall('bob', 'p2', 'stroke prevention'), []);
  assert.equal(calls.length, 1);
});


test('actual JudgeService and durable ledger bill J13 to the real project', options, async () => {
  const { UsageLedger } = await import('../src/usageLedger.mjs');
  const { createJudgeService } = await import('../src/judgeService.mjs');
  const judge = createJudgeService({ calibrationMode: true, database, usageLedger: new UsageLedger(database),
    config: { typesafeApiKey: 'test-only-key', reviewJevModel: 'jev-1.13.0', reviewJevApiBase: 'https://jev.test/v1', requireDurableUsageLedger: true },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        const selected = 'related';
        return [id, { type: 'choice', choice: selected, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) }];
      }));
      return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 5 } });
    } });
  try {
    const ranked = await rankEvidenceCards([{ id: 'ec_aaaaaaaa', title: 'stroke prevention', summary: 'stroke evidence' }, { id: 'ec_bbbbbbbb', title: 'stroke prevention', summary: 'stroke evidence' }],
      'stroke', judge, { userId: 'bob', projectId: 'p1', runId: null });
    assert.equal(ranked.length, 2);
    const billed = (await database.query("SELECT project_id,status FROM evimed_usage.model_requests WHERE operation='J13' AND user_id='bob'")).rows;
    assert.equal(billed.length, 1); assert.equal(billed[0].project_id, 'p1'); assert.equal(billed[0].status, 'settled');
  } finally { await judge.close(); }
});
