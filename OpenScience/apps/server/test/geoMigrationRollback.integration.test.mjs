import assert from 'node:assert/strict';
import test from 'node:test';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {migrateGeo} from '../src/geoPersistence.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
const databaseUrl=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
test('first GEO migration rolled back by its owner is retried against the actual schema', {skip:!databaseUrl},async()=>{
 const isolated=await createGeoTestDatabase(databaseUrl,'geomigrationrollback');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
 try{
  await database.migrate();
  await assert.rejects(database.transaction(client=>database.withTransactionClient(client,async()=>{
   await migrateGeo(database);
   assert.ok((await database.query("SELECT to_regclass('evimed_geo.projects') AS relation")).rows[0].relation);
   throw Error('outer publication rollback');
  })),/outer publication rollback/);
  assert.equal((await database.query("SELECT to_regclass('evimed_geo.projects') AS relation")).rows[0].relation,null);
  await migrateGeo(database);
  assert.ok((await database.query("SELECT to_regclass('evimed_geo.projects') AS relation")).rows[0].relation);
 }finally{await database.close();await isolated.drop();}
});

for(const [name,load] of [['GEO',async()=>migrateGeo],['inbox',async()=>(await import('../src/notificationPersistence.mjs')).migrateNotifications]]){
 test(`${name} owner can migrate again while a standalone migration waits on its advisory lock`,{skip:!databaseUrl,timeout:10000},async()=>{
  const isolated=await createGeoTestDatabase(databaseUrl,'migrationbarrier');
  const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  let enter,release,again,finished;
  const entered=new Promise(r=>{enter=r;});const barrier=new Promise(r=>{release=r;});
  const repeat=new Promise(r=>{again=r;});const repeated=new Promise(r=>{finished=r;});
  let owner,standalone;
  try{
   await database.migrate();const migrate=await load();
   owner=database.transaction(client=>database.withTransactionClient(client,async()=>{
    await migrate(database);enter();await repeat;await migrate(database);finished();await barrier;
   }));
   await entered;
   standalone=migrate(database);
   // The standalone promise is registered synchronously; it cannot commit while its owner holds the lock.
   again();await repeated;release();await owner;await standalone;
  }finally{again?.();release?.();await owner?.catch(()=>{});await standalone?.catch(()=>{});await database.close();await isolated.drop();}
 });
}
