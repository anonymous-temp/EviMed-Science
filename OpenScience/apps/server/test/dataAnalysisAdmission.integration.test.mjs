import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createDataAnalysisDispatchLock } from '../src/dataAnalysisAdmission.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
if(url){const parsed=new URL(url);assert(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);}
test('four parallel admissions leave a metadata pool of one available for independently committed work',{skip:!url,timeout:20000},async()=>{
  const config={databaseUrl:url,databasePoolMax:1,databaseConnectionTimeoutMs:2000,dataAnalysisMaxDispatches:4};
  const database=new ControlPlaneDatabase(config),admit=createDataAnalysisDispatchLock(config);
  try{
    await database.migrate();
    const values=await Promise.all(Array.from({length:4},(_,i)=>admit('analysis-test',randomUUID(),async guard=>{
      await guard();return database.transaction(async client=>Number((await client.query('SELECT $1::integer AS value',[i])).rows[0].value));
    })));
    assert.deepEqual(values,[0,1,2,3]);
    assert.equal(Number((await database.query('SELECT 1 AS value')).rows[0].value),1);
  }finally{await database.close();}
});
