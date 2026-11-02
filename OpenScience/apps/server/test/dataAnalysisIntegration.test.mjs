import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebApiApp } from '../src/server.mjs';

test('generic project mutation refuses an API-owned project before deletion, archive or rename effects',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'analysis-project-guard-'));
  const app=createWebApiApp({dataDir,port:0,runtimeMode:'mock',devAuth:true});
  try{
    const address=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}`;
    const user=await app.store.devUser(),id=`da-${'a'.repeat(40)}`;
    await app.store.createProject(user,id,'Owned analysis');
    for(const [method,suffix,body] of [['DELETE','',{confirm:id}],['PATCH','',{name:'Changed'}],['POST','/archive',{archived:true}]]){
      const response=await fetch(`${base}/api/projects/${id}${suffix}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,409);assert.equal((await response.json()).code,'analysis_project_reserved');
    }
    const project=await app.store.requireProject(user,id);assert.equal(project.name,'Owned analysis');assert(!project.archivedAt);
  }finally{await app.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
