import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeBaseIndex } from "../src/kbIndex.mjs";
import { KbEmbedder } from "../src/kbEmbedding.mjs";
import { KB_INDEX_METHOD, tsvectorLiteral } from "../src/kbChunker.mjs";
import { DIMENSION, databaseUrl, fixture, ingestCorpus, signedIn } from "./helpers/knowledgeBaseApp.mjs";

const skip = !databaseUrl && "Disposable PostgreSQL required";
const modelA = `held-model-a@${DIMENSION}`, modelB = `model-b@${DIMENSION}`;
const vector = () => Array.from({ length:DIMENSION },(_,i)=>i===0?1:0);
function deferred() { let resolve; const promise=new Promise(done=>{ resolve=done; }); return { promise,resolve }; }
async function legacy(context) {
  const db=context.app.store.database,userId=context.user.id;
  await db.query("UPDATE evimed_kb.documents SET index_method=NULL,embedding_input_sha256=NULL,title='privateprefix' WHERE user_id=$1",[userId]);
  await db.query("UPDATE evimed_kb.chunks SET context_prefix='privateprefix',heading_path='privateprefix',lexemes=(lexemes || $2::tsvector) WHERE user_id=$1",[userId,tsvectorLiteral("privateprefix")]);
}

test("real pgvector rejects held responses after body repair, model reset and changed-input replacement; accepts exact input", { skip }, async t => {
  const context=await signedIn({ kbEmbedder:{ configured:false,modelKey:modelA,counters:{} },
    documentParserFetch:async (_url,init)=>{
      const document=fixture.documents.find(row=>row.name===init.body.get("filename"));
      let content="";
      const pages=document.pages.map((body,index)=>{ const start=content.length; content+=`# Captured heading ${index+1}\n${body}`; return { index:index+1,start,end:content.length,status:"ok" }; });
      return new Response(JSON.stringify({ code:200,data:{ title:document.title,content,pages } }),{ status:200 });
    } });
  try {
    const { app,user }=context;
    if (!(await app.kbIndex.ready()).vector) { t.skip("pgvector unavailable: actual vector CAS remains pending"); return; }
    const [source]=await ingestCorpus(context,{ names:["房颤抗凝指南.pdf"] });
    const db=app.store.database;
    const original={ user_id:user.id,id:source.id,project_id:source.projectId,revision:source.revision,payload:source.payload };
    const worker=embedder=>new KnowledgeBaseIndex({ database:db,sources:app.sourceService,dimension:DIMENSION,embedder });
    for (const mutation of ["repair","model-reset","delete-reinsert-changed","delete-reinsert-exact","exact"]) {
      app.kbIndex.embedder={ configured:false,modelKey:modelA,counters:{} };
      await app.kbIndex.indexSource(original);
      if (mutation==="delete-reinsert-changed") { await legacy(context); await app.kbIndex.sync({ userId:user.id }); }
      const started=deferred(),release=deferred(),inputs=[];
      const held={ configured:true,modelKey:modelA,counters:{},async embedDocuments(texts) { inputs.push(...texts); started.resolve(); await release.promise; return texts.map(vector); } };
      const old=worker(held),before=(await db.query("SELECT * FROM evimed_kb.documents WHERE user_id=$1",[user.id])).rows[0];
      const outstanding=old.sync({ userId:user.id }); await started.promise;
      assert.ok(inputs.length>0); assert.doesNotMatch(JSON.stringify(inputs),/privateprefix/);
      if (mutation==="repair") {
        await legacy(context); const repaired=await worker({ configured:false,modelKey:modelA,counters:{} }).sync({ userId:user.id }); assert.equal(repaired.repaired,1);
      } else if (mutation==="model-reset") {
        const reset=await worker({ configured:false,modelKey:modelB,counters:{} }).sync({ userId:user.id }); assert.equal(reset.modelReset,1);
      } else if (mutation.startsWith("delete-reinsert")) {
        await db.query("DELETE FROM evimed_kb.documents WHERE user_id=$1",[user.id]); await app.kbIndex.indexSource(original);
      }
      const after=(await db.query("SELECT * FROM evimed_kb.documents WHERE user_id=$1",[user.id])).rows[0];
      if (mutation==="repair" || mutation==="delete-reinsert-changed") assert.notEqual(after.embedding_input_sha256,before.embedding_input_sha256);
      release.resolve(); const result=await outstanding;
      const expected=mutation==="exact" || mutation==="delete-reinsert-exact" ? inputs.length : 0;
      assert.equal(result.embedded,expected,mutation); assert.equal(old.counters.embeddedChunks,expected,mutation);
      const count=(await db.query("SELECT count(*)::integer AS n FROM evimed_kb.chunks WHERE user_id=$1 AND embedding IS NOT NULL",[user.id])).rows[0].n;
      assert.equal(count,expected,mutation);
      if (!expected) {
        const model=mutation==="model-reset"?modelB:modelA;
        const valid=worker({ configured:true,modelKey:model,counters:{},async embedDocuments(texts) { assert.doesNotMatch(JSON.stringify(texts),/privateprefix/); return texts.map(vector); } });
        const filled=await valid.sync({ userId:user.id }); assert.ok(filled.embedded>0); assert.equal(valid.counters.embeddedChunks,filled.embedded);
      }
    }
    // A legacy private prefix cannot reach the provider even before migration completes.
    await ingestCorpus(context,{ names:["肾功能与抗凝.pdf"] });
    await legacy(context); let called=0;
    const repairFirst=worker({ configured:true,modelKey:modelA,counters:{},async embedDocuments(texts) { called+=1; assert.doesNotMatch(JSON.stringify(texts),/privateprefix/); return texts.map(vector); } });
    const repaired=await repairFirst.sync({ userId:user.id,limit:1 }); assert.equal(repaired.repaired,1); assert.ok(repaired.embedded>0); assert.equal(called,1); assert.equal(repaired.unproven,1);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_kb.documents WHERE user_id=$1 AND index_method=$2",[user.id,KB_INDEX_METHOD])).rows[0].n,1);
  } finally { await context.close(); }
});


test("partial vector batches reset every old-model chunk and count only current-target writes", { skip }, async t => {
  const context=await signedIn({ kbEmbedder:{ configured:false,modelKey:modelA,counters:{} },
    documentParserFetch:async()=>{
      let content="";
      const pages=Array.from({ length:101 },(_,index)=>{ const start=content.length; content+=`# Part ${index}\nverifiedbody chunk ${index}\n`; return { index:index+1,start,end:content.length,status:"ok" }; });
      return new Response(JSON.stringify({ code:200,data:{ title:"Canonical title",content,pages } }),{ status:200 });
    } });
  try {
    const { app,user,project }=context,db=app.store.database;
    if (!(await app.kbIndex.ready()).vector) { t.skip("pgvector unavailable: actual vector batch reset remains pending"); return; }
    await ingestCorpus(context,{ names:["房颤抗凝指南.pdf"] });
    const base={ database:db,sources:app.sourceService,dimension:DIMENSION,smallLibraryTokens:0 };
    const first=new KnowledgeBaseIndex({ ...base,embedder:{ configured:true,modelKey:modelA,counters:{},async embedDocuments(texts) { return texts.map(vector); } } });
    assert.equal((await first.sync({ userId:user.id })).embedded,100);
    assert.equal((await db.query("SELECT embedding_model FROM evimed_kb.documents WHERE user_id=$1",[user.id])).rows[0].embedding_model,modelA,"target label is set while one chunk remains unembedded");
    const started=deferred(),release=deferred();
    const old=new KnowledgeBaseIndex({ ...base,embedder:{ configured:true,modelKey:modelA,counters:{},async embedDocuments(texts) { assert.equal(texts.length,1); started.resolve(); await release.promise; return texts.map(vector); } } });
    const pending=old.sync({ userId:user.id }); await started.promise;
    let queries=0;
    const newer=new KnowledgeBaseIndex({ ...base,embedder:{ configured:false,modelKey:modelB,counters:{},async embedQuery() { queries+=1; return vector(); } } });
    const reset=await newer.sync({ userId:user.id }); assert.equal(reset.modelReset,1);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_kb.chunks WHERE user_id=$1 AND embedding IS NOT NULL",[user.id])).rows[0].n,0);
    release.resolve(); assert.equal((await pending).embedded,0); assert.equal(old.counters.embeddedChunks,0);
    newer.embedder={ configured:true,modelKey:modelB,counters:{},async embedDocuments(texts) { return texts.map(vector); },async embedQuery() { queries+=1; return vector(); } };
    await newer.search({ userId:user.id,projectId:project.id,query:"verifiedbody" }); assert.equal(queries,0,"query embedding is skipped until a valid B vector exists");
    assert.equal((await newer.sync({ userId:user.id })).embedded,100); assert.equal((await newer.sync({ userId:user.id })).embedded,1);
    assert.equal(newer.counters.embeddedChunks,101);
    const result=await newer.search({ userId:user.id,projectId:project.id,query:"verifiedbody" });
    assert.equal(result.mode,"hybrid"); assert.ok(result.legs.vector>0); assert.equal(queries,1);
  } finally { await context.close(); }
});

test("incomplete successful embedding responses preserve keyword search and pending work through rebuild", { skip }, async t => {
  const context = await signedIn({ kbEmbedder: { configured: false, modelKey: modelA, counters: {} } });
  try {
    const { app, user, project } = context;
    if (!(await app.kbIndex.ready()).vector) { t.skip("pgvector required for incomplete vector responses"); return; }
    await ingestCorpus(context, { names: ["房颤抗凝指南.pdf"] });
    let complete = false;
    const embedder = new KbEmbedder({ apiKey: "fixture-key", model: "shape-model", dimension: DIMENSION, apiBase: "https://embedding.invalid" }, {
      fetchImpl: async (_url, init) => {
        const { input: { texts } } = JSON.parse(init.body);
        const embeddings = texts.map((_, index) => ({ text_index: index, embedding: vector() }));
        return Response.json({ output: { embeddings: complete ? embeddings : embeddings.slice(1) } });
      },
    });
    const index = new KnowledgeBaseIndex({ database: app.store.database, sources: app.sourceService, dimension: DIMENSION, smallLibraryTokens: 0, embedder });
    const result = await index.sync({ userId: user.id });
    assert.equal(result.embedded, 0);
    assert.ok(result.pendingEmbedding > 0);
    assert.equal(index.lastError, "kb_embedding_response_invalid");
    const rebuilt = await index.rebuild({ userIds: [user.id] });
    assert.equal(rebuilt.embedded, 0);
    assert.equal(rebuilt.pendingEmbedding, result.pendingEmbedding);
    assert.equal(index.lastError, "kb_embedding_response_invalid");
    const count = (await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_kb.chunks WHERE user_id=$1 AND embedding IS NOT NULL", [user.id])).rows[0].n;
    assert.equal(count, 0);
    const fallback = await index.search({ userId: user.id, projectId: project.id, query: "抗凝", includeLibrary: false });
    assert.ok(fallback.hits.length > 0);
    assert.ok(fallback.legs.keyword > 0);
    assert.equal(fallback.mode, "keyword");
    assert.equal(fallback.legs.vector ?? 0, 0);
    complete = true;
    const recovered = await index.sync({ userId: user.id });
    assert.equal(recovered.embedded, result.pendingEmbedding);
    assert.equal(recovered.pendingEmbedding, 0);
    assert.equal(index.lastError, null);
  } finally { await context.close(); }
});
