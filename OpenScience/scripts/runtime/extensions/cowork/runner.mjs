/** Runs only inside the isolated artifact image. This file is never imported by the serving web/kernel process. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {LIMITS,validateRequest,validateResource,guardDocument} from './policy.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function readResource(id,sniff){
  const manifest=JSON.parse(await fs.readFile('/input/manifest.json','utf8'));
  const resource=validateResource(manifest.resources?.[id]);
  const file=await fs.open('/input/'+resource.file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==resource.bytes||stat.size>LIMITS.inputBytes)throw new Error('cowork_input_refused');
    const bytes=await file.readFile();if(hash(bytes)!==resource.sha256)throw new Error('cowork_input_refused');
    guardDocument(bytes,resource.format);
    const detected=await sniff(bytes);if(detected.format!==resource.format)throw new Error('cowork_input_refused');return{resource,bytes};
  }finally{await file.close();}
}
async function main(){
  let bytes=0;const chunks=[];
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>65536)throw new Error('cowork_input_refused');chunks.push(chunk);}
  const request=validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const {readDocument,writeDocument,sniff}=await import('./vendor/node_modules/@dsh-cowork/core/lib/index.js');
  if(request.operation==='doc_read'){
    const input=await readResource(request.resourceId,sniff);
    const result=await readDocument({data:input.bytes,path:input.resource.file,options:request.options,
      safetyCaps:{maxInputBytes:LIMITS.inputBytes,maxDecompressedBytes:LIMITS.decompressedBytes,maxZipEntries:LIMITS.zipEntries},
      windowCaps:{maxBytes:LIMITS.windowBytes,maxPages:5,maxSheetRows:100,maxSheets:1,maxSlides:5,maxCells:100}});
    delete result.path;
    // Notebook HTML/output widgets are data, never a viewer/action surface.
    if(result.ipynb)for(const cell of result.ipynb.cells)cell.outputs=cell.outputs.filter(output=>output.type==='text/plain');
    return{ok:true,data:{resourceId:request.resourceId,inputSha256:input.resource.sha256,...result}};
  }
  const output=Buffer.from(await writeDocument({...request.spec,format:request.format}));
  if(output.length>LIMITS.outputBytes)throw new Error('cowork_output_limit');
  guardDocument(output,request.format);
  if((await sniff(output)).format!==request.format)throw new Error('cowork_input_refused');
  return{ok:true,data:{targetId:request.targetId,format:request.format,bytes:output.length,sha256:hash(output),contentBase64:output.toString('base64'),codeExecuted:false}};
}
try{
  const result=await main(),encoded=JSON.stringify(result);
  if(Buffer.byteLength(encoded)>(result.data?.contentBase64?12*1024*1024:LIMITS.windowBytes))throw new Error('cowork_output_limit');
  process.stdout.write(encoded+'\n');
}catch(error){
  const code=error?.message==='cowork_output_limit'?'cowork_output_limit':'cowork_input_refused';
  process.stdout.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;
}
