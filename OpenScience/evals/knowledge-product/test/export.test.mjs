import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPath,mapSourceIdentities } from '../compile_export.mjs';
test('official export never traverses out of its owned tree',()=>{
 assert.equal(exportPath('/tmp/owned','entity/a.md'),'/tmp/owned/entity/a.md');
 for(const p of ['../a','/tmp/a','a/../../b','a\\b'])assert.throws(()=>exportPath('/tmp/owned',p),/Unsafe/);
});
test('export source identity adapter leaves quotation and prose unchanged',()=>{
 const actual='src_'+'a'.repeat(32), original='src_'+'b'.repeat(32);
 const text=`[Trial](viking://resources/sources/${actual}.md "Exact quotation 24 weeks")`;
 assert.equal(mapSourceIdentities(text,{[actual]:original}),text.replace(actual,original));
});
