import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createNativeInputFixture } from './geoNativeInputFixture.mjs';
import { ResultProvenanceService } from '../../src/resultProvenanceService.mjs';
import { ResultRevisionService } from '../../src/resultRevision.mjs';
import { GeoArticleResults } from '../../src/geoArticleResults.mjs';
import { GeoNativeSelections } from '../../src/geoNativeSelections.mjs';
import { GeoPlanContext } from '../../src/geoPlanContext.mjs';
export async function createNativeSelectionFixture(t) {
  const f = await createNativeInputFixture(t);
  let mirrors = 0;
  const results = new ResultProvenanceService({ documents: f.documents, config: f.config,
    authorizeProject: async (actor,id) => f.accounts.requireProject(await f.accounts.userById(actor),id) });
  const revisions = new ResultRevisionService({ results, documents: f.documents, mirror: async () => { mirrors += 1; } });
  const articles = new GeoArticleResults({ store:f.store,service:f.service,results,revisions,documents:f.documents,cards:{},parser:{} });
  const contexts = new GeoPlanContext({ store:f.store,service:f.service,documents:f.documents,
    authorizeSession:async (user,geo,sessionId)=>f.authority.resolve(user,{kind:'geo',geoProjectId:geo.id,sessionId}),runs:async()=>[] });
  const authorizeRequest = async (user,project,request) => {
    const identity = await f.authority.resolve(user,{kind:'geo',geoProjectId:f.geo.id,sessionId:request.sessionId});
    assert.equal(identity.project.userId,project.userId); assert.equal(identity.project.id,project.id);
    return identity;
  };
  const selections = new GeoNativeSelections({contexts,revisions,articles,authorizeRequest});
  f.journal.contexts=contexts;f.journal.revisions=revisions;
  if (!process.env.N12_RED_BASELINE) f.journal.previewSelections=(...args)=>selections.preview(...args);
  const capture = async (filename='article.md',text='# Original\nSupported finding.',supersedesVersionId=undefined) => {
    await mkdir(f.project.workspaceDir,{recursive:true});await mkdir(f.project.metaDir,{recursive:true});
    await writeFile(path.join(f.project.workspaceDir,filename),text);
    return results.captureFile({userId:f.users.owner.id,project:f.project,relativePath:filename,
      producer:{kind:'tool',runId:`run-${filename}`,sessionId:'root',callId:`call-${filename}`},supersedesVersionId});
  };
  const version=await capture();
  const [articleId]=await f.store.registerArticles(f.users.owner.id,f.geo.id,[{path:version.path,layer:'popular',title:'Original',claimIds:[],gate:'unverified',safety:'open',contentSha256:version.digest,runId:'run-article.md'}]);
  await f.store.linkArticleVersion(f.geo.id,articleId,{version});
  const prepare = async (request,user=f.users.editor) => {
    if (!process.env.N12_RED_BASELINE) await selections.prepare(user,f.project,request);
    return f.prepare(request,user);
  };
  const submit = async (request,frame,user=f.users.editor,state='accepted') => f.execute(request,frame,async()=>{
    if (request.geoPlanContext) await contexts.bind(user,f.project,request);
    if (process.env.N12_RED_BASELINE) await articles.bind(user,f.project,request);
    else await selections.bindResult(user,f.project,request);
    await f.journal.beforeForward(request);
    if(state==='accepted')f.journal.observe(request,{state:'accepted',authority:'fixture'});
  });
  return {...f,results,revisions,articles,contexts,selections,capture,version,articleId,prepare,submit,mirrors:()=>mirrors};
}
