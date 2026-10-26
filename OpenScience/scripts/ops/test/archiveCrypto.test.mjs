import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { encryptArchiveBuffer, decryptArchiveBuffer } from '../archive-crypto.mjs';
const run = promisify(execFile);
const cli = new URL('../archive-crypto.mjs', import.meta.url);

test('buffer API and streaming CLI share the existing authenticated backup envelope in both directions',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archive-crypto-'));
  const previous=process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE;
  process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE=randomBytes(32).toString('base64');
  const env={...process.env};delete env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE;
  const original=Buffer.concat([Buffer.from('synthetic archive payload\n'),randomBytes(4096)]);
  try{
    const input=path.join(directory,'input'),streamed=path.join(directory,'stream.enc');
    await fs.writeFile(input,original,{mode:0o600});
    const encrypted=await run(process.execPath,[cli.pathname,'encrypt',input,streamed],{env});
    assert.equal(encrypted.stdout,'');assert.equal(encrypted.stderr,'');
    assert.deepEqual(await decryptArchiveBuffer(await fs.readFile(streamed)),original);
    const buffered=path.join(directory,'buffer.enc'),output=path.join(directory,'output');
    await fs.writeFile(buffered,await encryptArchiveBuffer(original),{mode:0o600});
    const decrypted=await run(process.execPath,[cli.pathname,'decrypt',buffered,output],{env});
    assert.equal(decrypted.stdout,'');assert.equal(decrypted.stderr,'');assert.deepEqual(await fs.readFile(output),original);
    const tampered=await fs.readFile(buffered);tampered[tampered.length-1]^=1;
    await assert.rejects(decryptArchiveBuffer(tampered));
    await assert.rejects(decryptArchiveBuffer(Buffer.from('plaintext is refused')));
  }finally{
    if(previous===undefined)delete process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE;else process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE=previous;
    await fs.rm(directory,{recursive:true,force:true});
  }
});
