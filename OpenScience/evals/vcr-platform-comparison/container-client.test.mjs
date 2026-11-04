import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {dockerClientArchitecture,readDockerClient} from './container-client.mjs';

function elf(machine){
  const bytes=Buffer.alloc(64);Buffer.from([0x7f,0x45,0x4c,0x46,2,1,1,0]).copy(bytes);
  bytes.writeUInt16LE(2,16);bytes.writeUInt16LE(machine,18);return bytes;
}
test('Linux aarch64 and amd64 ELF clients are identified; Mach-O and incompatible formats are rejected',()=>{
  assert.equal(dockerClientArchitecture(elf(183)),'arm64');
  assert.equal(dockerClientArchitecture(elf(62)),'amd64');
  for(const bytes of [Buffer.from([0xcf,0xfa,0xed,0xfe]),Buffer.alloc(64),elf(3)]){
    assert.throws(()=>dockerClientArchitecture(bytes));
  }
  const elf32=elf(183);elf32[4]=1;assert.throws(()=>dockerClientArchitecture(elf32));
  const bigEndian=elf(183);bigEndian[5]=2;assert.throws(()=>dockerClientArchitecture(bigEndian));
});
test('client architecture must match image before copy and validated bytes are retained',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-linux-client-'));
  try{
    const file=path.join(tmp,'docker');await fs.writeFile(file,elf(183),{mode:0o700});
    const result=await readDockerClient(file,'arm64');assert.equal(result.architecture,'arm64');
    await assert.rejects(readDockerClient(file,'amd64'),/differs/);
    await fs.writeFile(file,elf(62));
    assert.equal(dockerClientArchitecture(result.bytes),'arm64','caller copies validated snapshot rather than reopening source');
    await fs.symlink(file,path.join(tmp,'link'));
    await assert.rejects(readDockerClient(path.join(tmp,'link'),'amd64'));
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('launcher validates client against image architecture before creating state/resources',async()=>{
  const source=await fs.readFile(new URL('./container-launch.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf('await readDockerClient(')<source.indexOf('await fs.mkdir(state'));
  assert.match(source,/writeFile\(path\.join\(audit, 'docker'\), client\.bytes/);
  assert.doesNotMatch(source,/copyFile\(dockerClient/);
});
