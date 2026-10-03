import assert from 'node:assert/strict';
import test from 'node:test';
import {zip} from './fixtures.mjs';
import {validateRequest,validateResource,inspectZip,guardDocument} from './policy.mjs';

test('tool requests address opaque resources and refuse authority, paths and execution knobs',()=>{
  assert.equal(validateRequest({operation:'doc_read',resourceId:'res_public',options:{rows:5}}).resourceId,'res_public');
  for(const field of ['path','file_path','env','command','url','userId','projectId','dataClass'])assert.throws(()=>validateRequest({operation:'doc_read',resourceId:'res_public',[field]:'forged'}));
  assert.throws(()=>validateRequest({operation:'doc_read',resourceId:'../../data-plane'}));
  assert.throws(()=>validateRequest({operation:'doc_read',resourceId:'res_public',options:{rows:100000}}));
});
test('only scoped public or aggregate regular resource manifests are admitted',()=>{
  const resource={file:'input.xlsx',format:'xlsx',bytes:10,sha256:'a'.repeat(64),dataClass:'public'};
  assert.equal(validateResource(resource).format,'xlsx');
  for(const patch of [{file:'../secrets'},{file:'/data-plane/input.xlsx'},{dataClass:'patient'},{format:'xlsm'},{bytes:9000000}])assert.throws(()=>validateResource({...resource,...patch}));
});
test('writes are bounded inert documents, with no formula/link/macros or arbitrary formats',()=>{
  const spec={kind:'create',sheets:[{name:'Data',cells:[{ref:'A1',value:'Public text'},{ref:'B1',value:3}]}]};
  assert.equal(validateRequest({operation:'doc_write',targetId:'out_one',format:'xlsx',spec}).format,'xlsx');
  for(const value of [{formula:'WEBSERVICE("http://private")'},{hyperlink:'http://private'}])assert.throws(()=>validateRequest({operation:'doc_write',targetId:'out_one',format:'xlsx',spec:{...spec,sheets:[{name:'Data',cells:[{ref:'A1',value}]}]}}));
  assert.throws(()=>validateRequest({operation:'doc_write',targetId:'out_one',format:'docx',spec}));
  assert.throws(()=>validateRequest({operation:'doc_write',targetId:'out_one',format:'xlsx',spec:{...spec,sheets:[{name:'Data',cells:[{ref:'XFD1048577',value:1}]}]}}));
});
function directory(names,size=0){const bytes=zip(Object.fromEntries(names.map(name=>[name,''])));if(size){let cursor=bytes.readUInt32LE(bytes.length-6);for(const name of names){bytes.writeUInt32LE(size,cursor+24);cursor+=46+Buffer.byteLength(name);}}return bytes;}
test('archive metadata is checked before codecs: raw traversal, macros, zip bombs and malformed directories',()=>{
  assert.equal(inspectZip(directory(['xl/workbook.xml'])).length,1);
  for(const archive of [directory(['../outside']),directory(['/outside']),directory(['xl/vbaProject.bin']),directory(['a','b'],20000000),Buffer.from('PKbad')])assert.throws(()=>inspectZip(archive));
});
test('request metadata and bounded lists reject accessors and hidden fields before evaluation',()=>{
  let reads=0;const request={operation:'doc_read',resourceId:'res_public'};
  Object.defineProperty(request,'resourceId',{enumerable:true,get(){reads++;return'res_public';}});
  assert.throws(()=>validateRequest(request));assert.equal(reads,0);
  const sheets=Array(1);assert.throws(()=>validateRequest({operation:'doc_write',targetId:'out_one',format:'xlsx',spec:{kind:'create',sheets}}));
});

test('document signatures cannot bypass guards through a renamed extension',()=>{
  const bytes=zip({'word/document.xml':'<document/>','word/_rels/document.xml.rels':'<Relationships><Relationship TargetMode="External" Target="https://example.invalid/"/></Relationships>'});
  assert.throws(()=>guardDocument(bytes,'docx'));
  assert.throws(()=>guardDocument(bytes,'ipynb'));
  assert.throws(()=>guardDocument(Buffer.from('%PDF-1.4\n'),'ipynb'));
});
test('local and central ZIP records must agree before any codec observes them',()=>{
  const original=zip({'word/document.xml':'<document/>'});
  const central=original.readUInt32LE(original.length-6);
  for(const field of ['name','flags','method','crc','compressed','size','overlap']){
    const bytes=Buffer.from(original);
    if(field==='name')bytes[30]=120;
    else if(field==='overlap')bytes.writeUInt32LE(central,central+42);
    else{const offsets={flags:6,method:8,crc:14,compressed:18,size:22};bytes[offsets[field]]^=1;}
    assert.throws(()=>inspectZip(bytes),field);
  }
  const duplicate=zip({'word/document.xml':'a','word/otherdoc.xml':'b'});
  const first=duplicate.readUInt32LE(duplicate.length-6),second=first+46+'word/document.xml'.length;
  duplicate.writeUInt32LE(0,second+42);assert.throws(()=>inspectZip(duplicate));
});
