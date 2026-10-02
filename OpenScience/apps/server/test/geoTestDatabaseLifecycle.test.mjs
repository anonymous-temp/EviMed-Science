import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
test('nested suite databases retain unique suffixes within PostgreSQL identifier limits and reject unsafe names',async t=>{
 const created=[];class FakeClient{async connect(){}async query(sql){created.push(sql);return{rows:[]};}async end(){}}
 const originalClient=pg.Client;t.after(()=>{pg.Client=originalClient;});pg.Client=FakeClient;
 const base='evimed_test_product_extensiongenerationservice_12345678';
 const first=await createGeoTestDatabase(`postgresql://fixture@127.0.0.1/${base}`,'extgenroles');
 const second=await createGeoTestDatabase(`postgresql://fixture@127.0.0.1/${base}`,'extgenroles');
 assert.equal(first.name.length,63);assert.notEqual(first.name,second.name);
 assert.match(first.name,/^evimed_test[a-z0-9_]*_[a-f0-9]{8}$/);
 assert.equal(new URL(first.url).pathname,`/${first.name}`);
 await first.drop();await second.drop();
 assert.ok(created.includes(`DROP DATABASE IF EXISTS "${first.name}" WITH (FORCE)`));
 const before=created.length;
 for(const url of ['postgresql://fixture@127.0.0.1/production',`postgresql://fixture@127.0.0.1/evimed_test${'a'.repeat(64)}`])await assert.rejects(createGeoTestDatabase(url,'fixture'));
 await assert.rejects(createGeoTestDatabase('postgresql://fixture@127.0.0.1/evimed_test','bad-label'));
 assert.equal(created.length,before);
});
test('staged isolated DB preservation closes its actual admin handle without DROP; later DROP reconnects only to its owned name',async t=>{
 const clients=[];
 class FakeClient{
  constructor(){this.commands=[];this.ended=0;clients.push(this);}
  async connect(){this.commands.push('CONNECT');}
  async query(sql){this.commands.push(sql);return{rows:[]};}
  async end(){this.ended++;}
 }
 const originalClient=pg.Client;t.after(()=>{pg.Client=originalClient;});pg.Client=FakeClient;
 const isolated=await createGeoTestDatabase('postgresql://fixture@127.0.0.1/evimed_test','lifecycle');
 assert.match(isolated.name,/^evimed_test_lifecycle_[a-f0-9]{8}$/);
 await isolated.close();await isolated.close();assert.equal(clients[0].ended,1);assert.equal(clients[0].commands.some(value=>value.startsWith('DROP')),false);
 await isolated.drop();assert.equal(clients.length,2);assert.deepEqual(clients[1].commands,['CONNECT',`DROP DATABASE IF EXISTS "${isolated.name}" WITH (FORCE)`]);assert.equal(clients[1].ended,1);
});
test('actual owned PG close preserves rows, admin session physically ends, and later explicit drop reconnects and removes only owned namespace',{skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL},async()=>{
 const source=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,isolated=await createGeoTestDatabase(source,'lifecycle'),data=new pg.Client({connectionString:isolated.url}),observer=new pg.Client({connectionString:source});
 try{
  await data.connect();await data.query('CREATE TABLE lifecycle_probe(value integer NOT NULL)');await data.query('INSERT INTO lifecycle_probe(value) VALUES(1)');await data.end();
  await isolated.close();await observer.connect();
  assert.equal((await observer.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',[`evimed-isolated-${isolated.name}`])).rows[0].count,0);
  const preserved=new pg.Client({connectionString:isolated.url});await preserved.connect();try{assert.deepEqual((await preserved.query('SELECT value FROM lifecycle_probe')).rows,[{value:1}]);}finally{await preserved.end();}
  await isolated.drop();assert.equal((await observer.query('SELECT datname FROM pg_database WHERE datname=$1',[isolated.name])).rowCount,0);
 }finally{await data.end().catch(()=>{});await observer.end();await isolated.drop();}
});
