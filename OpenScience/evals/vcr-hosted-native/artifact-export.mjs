import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const MAX=10*1024*1024;
/** Register every declared file before any download and persist each outcome. */
export async function exportArtifacts({result,caseId,base,headers,projectId,save,fetcher=fetch,root='/data/conversation-artifacts'}) {
  const files=result.run?.outputFiles??[];if(!Array.isArray(files))throw new Error('Invalid declared outputFiles');
  result.artifacts=files.map((file,index)=>({index,path:typeof file==='string'?file:file?.path??null,status:'pending'}));await save();
  for(const record of result.artifacts){
    try {
      const relative=record.path;
      if(typeof relative!=='string'||relative.startsWith('/')||relative.split('/').some(piece=>!piece||piece==='.'||piece==='..'))throw new Error('invalid_path');
      const response=await fetcher(`${base}/api/files/download/${relative.split('/').map(encodeURIComponent).join('/')}`,{headers:{...headers,origin:base,'x-evimed-automated':'1','x-open-science-project':projectId},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`http_${response.status}`);
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>MAX)throw new Error('size_limit');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks),sha256=createHash('sha256').update(bytes).digest('hex'),name=sha256+path.extname(relative).replace(/[^.A-Za-z0-9]/g,'').slice(0,12),folder=path.join(root,caseId);
      await mkdir(folder,{recursive:true,mode:0o700});await writeFile(path.join(folder,name),bytes,{mode:0o600});Object.assign(record,{file:`${caseId}/${name}`,sha256,bytes:size,status:'saved'});
    }catch(error){record.status='export_failed';record.error=String(error?.message??'export_failed').slice(0,200);}
    await save();
  }
}
/** Validate one saved result's declared files against exported bytes. */
export async function validateArtifacts(result,root) {
  const files=result.run?.outputFiles??[];if(!Array.isArray(files))throw new Error('Invalid declared outputFiles');
  const records=result.artifacts??[];if(!Array.isArray(records)||records.length!==files.length)throw new Error('Artifact coverage mismatch');
  for(let index=0;index<files.length;index++){
    const original=typeof files[index]==='string'?files[index]:files[index]?.path??null,record=records[index];
    if(record?.index!==index||record.path!==original||record.status!=='saved'||!/^[a-z0-9-]+\/[a-f0-9]{64}(?:\.[A-Za-z0-9]+)?$/.test(record.file??''))throw new Error('Artifact not saved');
    const bytes=await readFile(path.join(root,record.file));if(bytes.length!==record.bytes||createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new Error('Artifact hash mismatch');
  }
}
