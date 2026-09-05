import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??"";
if(databaseUrl){const url=new URL(databaseUrl);assert.ok(["127.0.0.1","localhost"].includes(url.hostname));assert.match(url.pathname,/evimed_test/);}
test("actual hosted APIs download, preview, import and revoke a portable snapshot",{skip:!databaseUrl},async()=>{
  const dataDir=await mkdtemp("/tmp/evimed-transfer-app-");
  const app=createWebApiApp({dataDir,port:0,runtimeMode:"mock",devAuth:false,authMode:"local",bootstrapUser:"",bootstrapPassword:"",stateStore:"postgres",requireSharedStateStore:true,databaseUrl});
  const users=[];const password="test-only-transfer-request-passphrase";
  try{
    const address=await app.listen(0,"127.0.0.1");const base=`http://127.0.0.1:${address.port}`;
    const login=async()=>{const name=`transfer${randomUUID().slice(0,8)}`;const user=await app.store.createUser(name,"test-only-login-password",name);users.push(user.id);
      const response=await fetch(`${base}/api/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:name,password:"test-only-login-password"})});
      assert.equal(response.status,200);const data=await response.json();return{"content-type":"application/json",cookie:response.headers.get("set-cookie").split(";")[0],"x-open-science-csrf":data.data.csrfToken};};
    const owner=await login();const recipient=await login();
    const request=(route,headers,body,method="POST")=>fetch(`${base}/api/capsules${route}`,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const created=await request("",owner,{title:"Transfer source"});assert.equal(created.status,201);const capsule=(await created.json()).data;
    assert.equal((await request(`/${capsule.id}/entries`,owner,{factKind:"method_preference",layer:"methods",content:"Retain uncertainty estimates."})).status,201);
    const exported=await request(`/${capsule.id}/exports`,owner,{password});assert.equal(exported.status,201);const result=(await exported.json()).data;
    const download=await request(`/${capsule.id}/exports/${result.snapshot.id}`,owner,undefined,"GET");
    assert.equal(download.status,200);assert.match(download.headers.get("content-disposition"),/\.evimedcap/);assert.equal(download.headers.get("cache-control"),"no-store");assert.equal(await download.text(),result.archive);
    assert.equal((await request(`/${capsule.id}/exports`,recipient,{password})).status,404);
    const preview=await request("/transfers/preview",recipient,{archive:result.archive,password});assert.equal(preview.status,200);const inspection=(await preview.json()).data;
    assert.equal(inspection.issuerTrust,"verified");assert.equal(inspection.entries.length,1);
    const imported=await request("/transfers/import",recipient,{archive:result.archive,password,confirmed:true,expectedDigest:inspection.archiveSha256});assert.equal(imported.status,201);
    const importedCapsule=(await imported.json()).data;const entries=await request(`/${importedCapsule.id}/entries`,recipient,undefined,"GET");assert.equal((await entries.json()).data.items[0].payload.status,"candidate");
    assert.equal((await request(`/${capsule.id}/exports/${result.snapshot.id}`,owner,{expectedRevision:result.snapshot.revision},"DELETE")).status,200);
    assert.equal((await request(`/${capsule.id}/exports/${result.snapshot.id}`,owner,undefined,"GET")).status,409);
    const revoked=await request("/transfers/preview",recipient,{archive:result.archive,password});assert.equal((await revoked.json()).data.hostedStatus,"revoked");
    assert.equal((await request("/transfers/import",recipient,{archive:result.archive,password,confirmed:true,expectedDigest:inspection.archiveSha256})).status,409);
    assert.equal((await request("/transfers/preview",{"content-type":"application/json"},{archive:result.archive,password})).status,401);
    assert.equal((await request("/transfers/preview",{...recipient,"x-open-science-csrf":""},{archive:result.archive,password})).status,403);
  }finally{await app.store.database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])",[users]);await app.close();await rm(dataDir,{recursive:true,force:true});}
});
