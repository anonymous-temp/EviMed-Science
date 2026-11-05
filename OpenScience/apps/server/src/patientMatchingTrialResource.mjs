/** Protected immutable NDJSON registry resource. A runtime supplies no filename or collection authority. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {createPatientMatchingIndexPorts} from './patientMatchingIndex.mjs';
const fail=()=>Object.assign(new Error('The matching trial resource is unavailable.'),{code:'patient_matching_index_resource_invalid'});
const BATCH_SIZE=1000;
const MAX_LINE_BYTES=256*1024;

/** Scan bounded UTF-8 lines while preserving their absolute byte positions (including CRLF and blank lines).
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {{start?:number,onChunk?:(chunk:Buffer)=>void}} [options]
 */
async function* recordLines(handle,{start=0,onChunk}={}){
  const stream=handle.createReadStream({start,autoClose:false});
  const decoder=new TextDecoder('utf-8',{fatal:true});
  /** @type {Buffer[]} */ let parts=[];
  let bytes=0,lineStart=start;
  try{
    for await(const chunk of stream){
      onChunk?.(chunk);
      let from=0;
      for(let end=chunk.indexOf(10,from);end>=0;end=chunk.indexOf(10,from)){
        const segment=chunk.subarray(from,end);parts.push(segment);bytes+=segment.length;
        if(bytes>MAX_LINE_BYTES)throw fail();
        yield {text:decoder.decode(Buffer.concat(parts,bytes)),start:lineStart};
        lineStart+=bytes+1;parts=[];bytes=0;from=end+1;
      }
      if(from<chunk.length){const segment=chunk.subarray(from);parts.push(segment);bytes+=segment.length;if(bytes>MAX_LINE_BYTES)throw fail();}
    }
    if(bytes)yield {text:decoder.decode(Buffer.concat(parts,bytes)),start:lineStart};
  }finally{stream.destroy();}
}
/** @param {{manifestPath:string,database:any,models:any,authorize:any,createIndex?:any}} dependencies */
export async function createPatientMatchingTrialResource({manifestPath,database,models,authorize,createIndex=createPatientMatchingIndexPorts}){
  if(!manifestPath)return null;
  const handle=await fsp.open(manifestPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let manifest;
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>16384||(stat.mode&0o022)!==0)throw fail();manifest=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
  if(!manifest||Object.keys(manifest).some(key=>!['collectionId','recordsPath','recordsSha256','expectedRecords'].includes(key))||typeof manifest.collectionId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(manifest.collectionId)
    ||!path.isAbsolute(manifest.recordsPath??'')||!/^[a-f0-9]{64}$/.test(manifest.recordsSha256??'')||!Number.isSafeInteger(manifest.expectedRecords)||manifest.expectedRecords<1)throw fail();
  const input=await fsp.open(manifest.recordsPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let stamp;
  /** @type {number[]} */ const offsets=[];
  try{const stat=await input.stat();if(!stat.isFile()||stat.size>8*1024**3||(stat.mode&0o022)!==0)throw fail();stamp=[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
    const hash=createHash('sha256');let count=0;
    for await(const line of recordLines(input,{onChunk:chunk=>{hash.update(chunk);}})){
      if(!line.text.trim())continue;
      if(count%BATCH_SIZE===0)offsets.push(line.start);
      if(++count>manifest.expectedRecords)throw fail();
    }
    if(count!==manifest.expectedRecords||hash.digest('hex')!==manifest.recordsSha256)throw fail();
  }finally{await input.close();}
  async function current(){const stat=await fsp.lstat(manifest.recordsPath);if(!stat.isFile()||[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':')!==stamp)throw fail();}
  await current();
  return createIndex({database,models,authorize:async(envelope,{operation})=>{await current();await authorize(envelope);return {collectionId:manifest.collectionId,sourceDigest:`sha256:${manifest.recordsSha256}`,expectedRecords:manifest.expectedRecords,publicRegistry:true,buildAllowed:operation==='build'&&envelope.operatorBuild===true};},
    loadRecords:async envelope=>{await current();const offset=envelope.input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw fail();
      if(offset>=manifest.expectedRecords)return [];
      const block=Math.floor(offset/BATCH_SIZE),selected=[];let row=block*BATCH_SIZE;
      const recordFile=await fsp.open(manifest.recordsPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{for await(const line of recordLines(recordFile,{start:offsets[block]})){if(!line.text.trim())continue;if(row++<offset)continue;const record=JSON.parse(line.text);if(!/^NCT\d{8}$/.test(record.registryId??'')||typeof record.text!=='string'||record.text.length>30000)throw fail();selected.push({registryId:record.registryId,text:record.text,sourceDigest:`sha256:${createHash('sha256').update(record.text).digest('hex')}`});if(selected.length>=BATCH_SIZE)break;}}finally{await recordFile.close();}await current();return selected;}
  });
}
