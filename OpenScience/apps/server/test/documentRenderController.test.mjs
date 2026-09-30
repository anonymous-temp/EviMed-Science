import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDocumentRenderController, documentExportDirectory } from '../src/documentRenderController.mjs';

async function fixture(t, clock = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'render-controller-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'container.json');
  const bin = path.join(root, 'docker.mjs');
  await fs.writeFile(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const state=${JSON.stringify(state)};
const args=process.argv.slice(2);
if(args[0]==='image'){console.log('sha256:image');process.exit(0);}
if(args[0]==='inspect'){
 if(!fs.existsSync(state)){console.error('Error: No such object: evimed-document-render');process.exit(1);}
 console.log(fs.readFileSync(state,'utf8'));process.exit(0);
}
if(args[0]==='create'){
 const labels=Object.fromEntries(args.filter((x,i)=>args[i-1]==='--label').map(x=>{const n=x.indexOf('=');return [x.slice(0,n),x.slice(n+1)];}));
 try{fs.writeFileSync(state,JSON.stringify({Config:{Labels:labels},State:{StartedAt:new Date().toISOString()}}),{flag:'wx'});}catch{console.error('already in use');process.exit(1);}
 console.log('created');process.exit(0);
}
if(args[0]==='rm'){fs.rmSync(state,{force:true});process.exit(0);}
if(args[0]==='start'){setInterval(()=>{if(!fs.existsSync(state))process.exit(1);},20);}
`, { mode: 0o700 });
  const config = { dataDir: root, runtimeContainerBin: bin, runtimeContainerImage: 'runtime:test' };
  const reference = { ownerId: 'alice', projectId: 'project', exportId: 'export', attemptId: 'attempt' };
  const dir = path.join(documentExportDirectory(config, reference), 'attempts', reference.attemptId);
  await fs.mkdir(path.join(dir, 'input'), { recursive: true }); await fs.mkdir(path.join(dir, 'output'));
  const input = JSON.stringify({ rendererImage: 'sha256:image', canonicalMarkdown: '中文' });
  await fs.writeFile(path.join(dir, 'input/document.json'), input);
  reference.inputDigest = createHash('sha256').update(input).digest('hex');
  const controller = createDocumentRenderController(config, { availableMemory: async () => 4 * 1024 ** 3, ...clock });
  t.after(() => controller.close());
  return { controller, config, reference, state, dir };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

test('cancel before launch persists across controller restart and never creates a container', async t => {
  const { controller, config, reference, state } = await fixture(t);
  await controller.cancel(reference);
  await assert.rejects(createDocumentRenderController(config, { availableMemory: async () => 4 * 1024 ** 3 }).render(reference), { name: 'AbortError' });
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});

test('JSONB key reordering cannot turn physical cancellation into a false acknowledgement', async t => {
  const { controller, reference, state } = await fixture(t);
  const result = controller.render(reference).then(() => null, error => error);
  for (let i = 0; i < 100; i++) { if (await fs.stat(state).then(() => true, () => false)) break; await pause(); }
  assert.ok(await fs.stat(state));
  const reordered = Object.fromEntries(Object.entries(reference).reverse());
  await controller.cancel(reordered);
  assert.equal((await result).code, 'document_render_failed');
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});

test('cancel during asynchronous preflight prevents the later fixed create operation', async t => {
  const { controller, reference, state } = await fixture(t);
  const result = controller.render(reference).then(() => null, error => error);
  await controller.cancel(Object.fromEntries(Object.entries(reference).reverse()));
  assert.ok(await result);
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});

test('removing the attempt directory cannot prevent physical container cancellation', async t => {
  const { controller, reference, state, dir } = await fixture(t);
  const result = controller.render(reference).then(() => null, error => error);
  for (let i = 0; i < 100; i++) { if (await fs.stat(state).then(() => true, () => false)) break; await pause(); }
  assert.ok(await fs.stat(state));
  await fs.rm(dir, { recursive: true, force: true });
  await controller.cancel(reference);
  assert.ok(await result);
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});


test('the fixed deadline stops the managed container and releases its physical slot', async t => {
  let expire;
  const { controller, reference, state } = await fixture(t, { setTimer: callback => { expire = callback; return 1; }, clearTimer: () => {} });
  const result = controller.render(reference).then(() => null, error => error);
  for (let i = 0; i < 100; i++) { if (await fs.stat(state).then(() => true, () => false)) break; await pause(); }
  assert.ok(await fs.stat(state));
  expire();
  assert.ok(await result);
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});

test('a frozen request naming an older renderer image cannot start under a different image', async t => {
  const {controller,reference,state,dir}=await fixture(t);
  const bytes=JSON.stringify({rendererImage:'sha256:previous',canonicalMarkdown:'中文'});
  await fs.writeFile(path.join(dir,'input/document.json'),bytes);
  reference.inputDigest=createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(controller.render(reference),{code:'document_renderer_changed'});
  await assert.rejects(fs.stat(state),{code:'ENOENT'});
});
