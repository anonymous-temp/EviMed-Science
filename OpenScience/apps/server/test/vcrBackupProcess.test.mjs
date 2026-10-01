import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runVcrBackupProcess } from '../../../scripts/ops/vcr-backup-process.mjs';

async function waitFor(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await stat(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Nested process fixture did not start');
}

test('cancel waits until the real foreground grandchild stops writing, even when it ignores TERM', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'marker'); const ready = path.join(root, 'ready');
  const grandchild = `const fs=require('fs'); const [marker,ready]=process.argv.slice(1); process.on('SIGTERM',()=>{}); fs.writeFileSync(ready,String(process.pid)); setInterval(()=>fs.appendFileSync(marker,'x'),10);`;
  const parent = `const {spawn}=require('child_process'); spawn(process.execPath,['-e',process.argv[1],process.argv[2],process.argv[3]],{stdio:'inherit'}); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const task = runVcrBackupProcess(process.execPath, ['-e', parent, grandchild, marker, ready], { signal: controller.signal, stopGraceMs: 50 });
  const rejected = assert.rejects(task, { code: 'vcr_backup_canceled' });
  await waitFor(ready); await waitFor(marker);
  controller.abort(); await rejected;
  const before = await readFile(marker, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await readFile(marker, 'utf8'), before, 'the physical writer must stop before cancellation acknowledges');
});

test('a successful parent cannot leave its background descendant writing after the operation returns', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-process-success-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'marker'); await mkdir(path.dirname(marker), { recursive: true });
  const child = `const fs=require('fs'); process.on('SIGTERM',()=>{}); fs.appendFileSync(process.argv[1],'x'); setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10);`;
  const parent = `require('child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'inherit'}); setTimeout(()=>process.exit(0),50);`;
  await runVcrBackupProcess(process.execPath, ['-e', parent, child, marker], { stopGraceMs: 50 });
  const before = await readFile(marker, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await readFile(marker, 'utf8'), before);
});
