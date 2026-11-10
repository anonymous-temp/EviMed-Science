import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { snapshotSource } from './snapshot.mjs';
test('source snapshot changes with source bytes and ignores dependency installs',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'native-snapshot-'));
  try{await mkdir(path.join(root,'node_modules'));await writeFile(path.join(root,'source.mjs'),'one');const first=await snapshotSource(root);await writeFile(path.join(root,'node_modules','ignored'),'ignored');assert.equal(await snapshotSource(root),first);await writeFile(path.join(root,'source.mjs'),'two');assert.notEqual(await snapshotSource(root),first);}
  finally{await rm(root,{recursive:true,force:true});}
});
