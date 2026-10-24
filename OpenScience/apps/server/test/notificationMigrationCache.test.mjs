import assert from 'node:assert/strict';
import test from 'node:test';
import {migrateNotifications} from '../src/notificationPersistence.mjs';

test('a migration in an enclosing transaction cannot populate the committed migration cache',async()=>{
 let scoped=true,calls=0;
 const database={transactionScope:()=>scoped?{}:null,transaction:async operation=>{calls++;await operation({query:async()=>({rows:[]})});}};
 await migrateNotifications(database);
 // The owning transaction may roll back its DDL after the savepoint succeeds.
 await migrateNotifications(database);
 assert.equal(calls,2);
 scoped=false;
 await migrateNotifications(database);
 await migrateNotifications(database);
 assert.equal(calls,3,'a standalone committed migration still caches normally');
});

test('GEO savepoint migrations cannot satisfy later transactions until committed standalone',async()=>{
 const {migrateGeo}=await import('../src/geoPersistence.mjs');
 let scoped=true,calls=0;
 const database={transactionScope:()=>scoped?{}:null,transaction:async operation=>{calls++;return operation({query:async()=>({rows:[]})});}};
 await migrateGeo(database);
 await migrateGeo(database);
 assert.equal(calls,2);
 scoped=false;
 await migrateGeo(database);
 await migrateGeo(database);
 assert.equal(calls,3);
});

for(const [name,load] of [['inbox',async()=>migrateNotifications],['GEO',async()=>(await import('../src/geoPersistence.mjs')).migrateGeo]]){
 test(`${name} scoped retry never waits for a standalone migration blocked behind its owner`,{timeout:2000},async()=>{
  const migrate=await load();let scoped=true,calls=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const database={transactionScope:()=>scoped?{}:null,transaction:async operation=>{calls++;if(!scoped)await barrier;return operation({query:async()=>({rows:[]})});}};
  await migrate(database);
  scoped=false;const standalone=migrate(database);
  scoped=true;await migrate(database);
  assert.equal(calls,3,'scoped work uses its own transaction rather than a blocked global promise');
  release();await standalone;
  await migrate(database);assert.equal(calls,3,'committed migrations are reusable inside a scope');
 });
}
