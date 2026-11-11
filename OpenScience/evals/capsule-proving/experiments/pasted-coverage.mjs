// Expand frozen replay results to every changed line, including lines the old category/cap filter never offered.
// Read-only development archives; no engine API writes, ingestion, model calls or database connection.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { serialJsonlWriter, recordingInput } from './pasted-recording.mjs';
import { removalLines } from '../../../apps/server/src/nativeMemoryRejections.mjs';
import { lineFingerprint } from '../../../apps/server/src/nativeMemoryOverlay.mjs';
import { instructionSourceMessage } from '../../../apps/server/src/nativeMemoryInstructionOrigin.mjs';
const [input,out]=process.argv.slice(2);if(!input||!out)throw Error('input_and_output_required');
await mkdir(out,{recursive:true});
const write=serialJsonlWriter(path.join(out,'rows.jsonl')), cache=new Map(),runs=new Map();
const containers=JSON.parse(execFileSync('docker',['inspect','ovcand1','ovcand2','ovcand3','ovcand4'],{encoding:'utf8'}));
const roots=new Map(containers.flatMap(c=>Object.values(c.NetworkSettings.Ports).flatMap(p=>(p??[]).map(port=>[Number(port.HostPort),c.Mounts.find(m=>m.Destination==='/app/.openviking')?.Source]))));
let jobs=0,lines=0,offered=0;
for await(const raw of createInterface({input:recordingInput(path.join(input,'rows.jsonl')),crlfDelay:Infinity})){
 const row=JSON.parse(raw);if(!/^(r3-|r4-|p29-)/.test(row.run))throw Error('recorded_candidate_run_required');
 if(!runs.has(row.run))runs.set(row.run,JSON.parse(await readFile(`/srv/evimed/runs/${row.run}/run.json`,'utf8')));
 const run=runs.get(row.run);if(run.split!=='dev')throw Error('development_only');
 if(!cache.has(row.archiveUri)){
  const match=/^viking:\/\/user\/(u-[a-f0-9]+)\/(sessions\/[^/]+\/history\/archive_\d+)$/.exec(row.archiveUri);if(!match)throw Error('archive_uri_invalid');
  let archive=null;
  for(const url of run.engine.urls??[run.engine.url]){
   const root=roots.get(Number(new URL(url).port));if(!root)throw Error('candidate_mount_missing');
   const folder=path.join(root,'data/viking',run.engine.account,'user',match[1],match[2]);
   try{archive={diff:JSON.parse(await readFile(path.join(folder,'memory_diff.json'),'utf8')),messages:(await readFile(path.join(folder,'messages.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>instructionSourceMessage(JSON.parse(l),row.archiveUri)).filter(Boolean)};break;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(!archive)throw Error('recorded_archive_missing');cache.set(row.archiveUri,archive);
 }
 const archive=cache.get(row.archiveUri),requests=row.requests?.length?row.requests:row.request?[row.request]:[],conversation=[],candidates=[];
 for(const operation of [...(archive.diff.operations?.adds??[]),...(archive.diff.operations?.updates??[])]){
  if(!operation.uri.startsWith(row.archiveUri.split('/sessions/')[0]+'/memories/'))throw Error('memory_scope_invalid');
  for(const text of removalLines(operation.after??'',operation.before??'')){
   const match=requests.find(r=>r.candidates.some(c=>c.text===text));
   const binding=match?.candidates.find(c=>c.text===text);
   const sources=match?(binding.sourceMessages??match.conversation.map((_,i)=>i)).map(i=>match.conversation[i]):archive.messages;
   const indices=[];
   for(const source of sources){let index=conversation.findIndex(s=>JSON.stringify(s)===JSON.stringify(source));if(index<0){index=conversation.length;conversation.push(source);}indices.push(index);}
   const key=operation.uri+'\u0000'+lineFingerprint(text);
   candidates.push({candidate:candidates.length,key,text,sourceMessages:indices,offered:!!match,memoryContext:{uri:operation.uri.split('/memories/')[1],before:operation.before??'',after:operation.after??''}});
   lines++;if(match)offered++;
  }
 }
 await write({...row,request:{conversation,candidates},requests:[],coverage:{lines:candidates.length,offered:candidates.filter(c=>c.offered).length}});jobs++;
}
const manifest=JSON.parse(await readFile(path.join(input,'manifest.json'),'utf8'));
await writeFile(path.join(out,'manifest.json'),JSON.stringify({...manifest,input,jobs,coverage:{lines,offered,unoffered:lines-offered},scope:'Every changed line in selected recorded commits. Unoffered lines remain allowed unless a recorded refusal/pending key says otherwise; no new checker calls.'},null,2));
console.log(JSON.stringify({jobs,lines,offered,unoffered:lines-offered}));
