import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
for(const changed of [false,'upstream','admitted'])test(`build overlay preserves upstream bytes and rejects changed lock: ${changed}`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-overlay-'));
  const lock='lockfileVersion: 9\n',admitted=lock+'overrides: pinned\n',workspace="packages:\n  - 'packages/*'\n";
  const pins=JSON.parse(await fs.readFile(path.join(here,'pins.json'),'utf8'));pins.upstreamLockSha256=createHash('sha256').update(lock).digest('hex');pins.admittedLockSha256=createHash('sha256').update(admitted).digest('hex');
  await fs.writeFile(path.join(root,'pnpm-lock.yaml'),changed==='upstream'?lock+'changed':lock);await fs.writeFile(path.join(root,'pnpm-workspace.yaml'),workspace);await fs.writeFile(path.join(root,'pins.json'),JSON.stringify(pins));await fs.writeFile(path.join(root,'admitted.yaml'),changed==='admitted'?admitted+'changed':admitted);
  try{const result=spawnSync(process.execPath,[path.join(here,'apply.mjs'),root,path.join(root,'pins.json'),path.join(root,'admitted.yaml')],{encoding:'utf8'});
    if(changed){assert.notEqual(result.status,0);assert.match(result.stderr,changed==='admitted'?/overlay_admitted_lock_differs/:/overlay_upstream_lock_differs/);assert.equal(await fs.readFile(path.join(root,'pnpm-workspace.yaml'),'utf8'),workspace);}
    else{assert.equal(result.status,0,result.stderr);assert.equal(await fs.readFile(path.join(root,'upstream-pnpm-lock.yaml'),'utf8'),lock);assert.equal(await fs.readFile(path.join(root,'pnpm-lock.yaml'),'utf8'),admitted);assert.equal(await fs.readFile(path.join(root,'pnpm-workspace.yaml'),'utf8'),workspace+'overrides:\n  "exceljs@4.4.0>unzipper": "0.12.3"\n');const replay=spawnSync(process.execPath,[path.join(here,'apply.mjs'),root,path.join(root,'pins.json'),path.join(root,'admitted.yaml')]);assert.notEqual(replay.status,0);}
  }finally{await fs.rm(root,{recursive:true});}
});
