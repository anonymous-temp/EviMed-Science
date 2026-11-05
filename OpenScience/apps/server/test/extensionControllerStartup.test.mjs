import test from 'node:test';
import assert from 'node:assert/strict';
import { createControllerExtensionComposition } from '../src/extensionControllerComposition.mjs';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('controller startup migrates both schemas before accepting leased work', {skip:!url&&'Local PostgreSQL fixture URL required'}, async () => {
  const isolated=await createGeoTestDatabase(url,'extensionstartup');
  const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:2,databaseConnectionTimeoutMs:2000});
  const deployment={status:'configured',admittedDescriptors:[],admittedNativeBundles:[]};
  const config={databaseUrl:isolated.url,modelGatewaySigningSecret:'x'.repeat(32),dataDir:'/tmp',runtimeDataVolume:'',runtimeContainerBin:'docker'};
  let composition;
  try {
    composition=createControllerExtensionComposition({config,deployment,database});await composition.ready;
    const result=await database.query("SELECT to_regclass('evimed_product.jobs') AS jobs");assert.equal(result.rows[0].jobs,'evimed_product.jobs');
  } finally {await composition?.close();await database.close();await isolated.drop();}
});
