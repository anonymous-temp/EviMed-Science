// Official OpenViking compile through the product service, exported for the historical C harness.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checked } from './provision.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function exportPath(root,relative) {
  if(typeof relative!=='string'||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(relative))throw new Error('Unsafe export path');
  return path.join(root,relative);
}
export function mapSourceIdentities(markdown,mapping) {
  return markdown.replace(/src_[a-f0-9]{32}/g,id=>mapping[id]??id);
}
export async function compileExport({api,projectId,sourceMap,outDir,topicId,repetition,timeoutMs=600_000}) {
  if(!Number.isInteger(repetition)||repetition<1||repetition>3)throw new Error('Invalid repetition');
  api.project=projectId;
  const before=await checked(api,'GET',`/api/knowledge-pages?projectId=${encodeURIComponent(projectId)}`);
  if(!before.enabled||before.engine?.ok!==true)throw new Error(`Official engine unavailable: ${before.state}/${before.engine?.code??'not-ready'}`);
  const started=await checked(api,'POST','/api/knowledge-pages/compile',{projectId,language:'en'},[202]);
  const deadline=Date.now()+timeoutMs;let status;
  while(Date.now()<deadline){
    status=await checked(api,'GET',`/api/knowledge-pages?projectId=${encodeURIComponent(projectId)}`);
    if(status.state==='compiled'&&status.round>before.round&&status.compiledAt!==before.compiledAt)break;
    if(['failed','engine_unavailable','disabled'].includes(status.state))throw new Error(`Official compile ended ${status.state}`);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(status?.state!=='compiled'||status.round<=before.round)throw new Error('Official compile timed out; old mirror is not a new repetition');
  const tree=await checked(api,'GET',`/api/knowledge-pages/tree?projectId=${encodeURIComponent(projectId)}`);
  const pages=tree.pages.filter(p=>p.tree==='wiki');
  if(!pages.length)throw new Error('Official compile returned no wiki pages');
  const dest=exportPath(outDir,`${topicId}/rep${repetition}`);await fs.mkdir(dest,{recursive:true});
  const reverse=Object.fromEntries(Object.entries(sourceMap).map(([original,actual])=>[actual,original]));
  const receipt={producer:'OpenViking official llm-wiki through KnowledgePageService',projectId,topicId,repetition,started,status,sourceMap,pages:[]};
  for(const p of pages){
    const view=await checked(api,'GET',`/api/knowledge-pages/page?sourceId=${encodeURIComponent(p.sourceId)}`);
    const normalized=mapSourceIdentities(view.markdown,reverse);
    const target=exportPath(dest,p.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,normalized);
    receipt.pages.push({path:p.path,sourceId:p.sourceId,rawSha256:hash(view.markdown),exportSha256:hash(normalized),identityNormalizationOnly:true});
  }
  await fs.writeFile(path.join(dest,'_listing.json'),JSON.stringify(receipt,null,2));
  return receipt;
}
