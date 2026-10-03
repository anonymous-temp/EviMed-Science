import assert from 'node:assert/strict';
import test from 'node:test';
import {validateOverlayClosure} from './closure.mjs';
const packages=[{name:'unzipper',version:'0.12.3',license:'MIT',manifest:'unzipper/package.json'},{name:'fs-extra',version:'11.3.4',license:'MIT',manifest:'fs-extra/package.json'}];
test('admitted closure requires one exact replacement and rejects every forbidden or unlicensed manifest',()=>{
  assert.equal(validateOverlayClosure({packages}),true);
  for(const rows of [[...packages,{name:'buffers',version:'0.1.1',license:'MIT'}],[...packages,{name:'binary',version:'0.3.0',license:'MIT'}],packages.map(row=>({...row,license:null})),[{...packages[0],version:'0.10.1'}],[{...packages[0],license:'UNKNOWN'}],[...packages,packages[0]]])assert.throws(()=>validateOverlayClosure({packages:rows}));
});
