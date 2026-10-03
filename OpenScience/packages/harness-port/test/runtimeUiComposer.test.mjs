import assert from 'node:assert/strict';
import test from 'node:test';
import {createComposerUploadStore} from '../src/runtimeUiComposer.mjs';

test('native owner receives original ordered files and retains upload/removal/retry authority',()=>{
 const store=createComposerUploadStore('session-a');
/** @type {any[]} */const batches=[];const files=[{name:'证据.pdf'},{name:'结果.csv'}];
 const owner={canAcceptDrop:true,onAddFiles:(/** @type {any} */ batch)=>batches.push(batch),uploads:{id:{status:'uploading'}},onRetryFile:()=>{},onRemoveAttachment:()=>{}};
 store.publish(owner);const selection=store.open();assert.equal(store.deliver(selection,files),true);assert.equal(batches[0],files);assert.equal(store.getSnapshot(),owner);
});
test('file dialog results cannot move to a different session, unmounted owner or locked intake',()=>{
 const a=createComposerUploadStore('a'),b=createComposerUploadStore('b');let added=0;const owner={canAcceptDrop:true,onAddFiles:()=>added++};a.publish(owner);b.publish(owner);const picked=a.open();
 assert.equal(b.deliver(picked,[{}]),false);a.publish({...owner,canAcceptDrop:false});assert.equal(a.deliver(picked,[{}]),false);a.clear(owner);assert.equal(a.open(),null);
 a.publish(owner);const next=a.open();a.clear(owner);assert.equal(a.deliver(next,[{}]),false);assert.equal(added,0);
});
test('cancel and empty selection preserve draft/attachments without native side effects',()=>{
 const store=createComposerUploadStore('a');let called=0;store.publish({canAcceptDrop:true,onAddFiles:()=>called++});assert.equal(store.deliver(store.open(),[]),false);assert.equal(store.deliver(null,[{}]),false);assert.equal(called,0);
});

test('absent public slot observation leaves the complete native composer as fallback',async()=>{
 const {apply}=await import('../src/runtimeUiComposer.mjs');let registered=0;
 apply({slots:{entries:()=>[]}}, {}, {}, null, {ours:false,react:{createContext:()=>({})},h:()=>{},occupy:()=>registered++});assert.equal(registered,0);
});
