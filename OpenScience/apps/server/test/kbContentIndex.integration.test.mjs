import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeBaseIndex } from "../src/kbIndex.mjs";
import { KB_INDEX_METHOD, embeddingInputReceipt, tsvectorLiteral } from "../src/kbChunker.mjs";
import { databaseUrl, ingestCorpus, signedIn } from "./helpers/knowledgeBaseApp.mjs";

const skip = !databaseUrl && "Disposable PostgreSQL required";
const privateTitle = "privatetitlecanary";

async function documentRows(context) {
  return (await context.app.store.database.query("SELECT * FROM evimed_kb.documents WHERE user_id=$1 ORDER BY sha256", [context.user.id])).rows;
}
async function chunksOf(context, document) {
  return (await context.app.store.database.query(`SELECT * FROM evimed_kb.chunks WHERE user_id=$1 AND sha256=$2
    AND parser_revision=$3 AND text_sha256=$4 ORDER BY ordinal`, [context.user.id,document.sha256,document.parser_revision,document.text_sha256])).rows;
}
async function contaminate(context, document, { corrupt = false } = {}) {
  const db = context.app.store.database, args = [context.user.id,document.sha256,document.parser_revision,document.text_sha256];
  await db.query(`UPDATE evimed_kb.documents SET title=$5,index_method=NULL,embedding_input_sha256=NULL
    WHERE user_id=$1 AND sha256=$2 AND parser_revision=$3 AND text_sha256=$4`, [...args,privateTitle]);
  await db.query(`UPDATE evimed_kb.chunks SET context_prefix=$5,heading_path=$5,lexemes=(lexemes || $6::tsvector)
    ${corrupt ? ",end_offset=end_offset+1" : ""} WHERE user_id=$1 AND sha256=$2 AND parser_revision=$3 AND text_sha256=$4`,
  [...args,privateTitle,tsvectorLiteral(privateTitle)]);
}

test("same content indexed from either source exposes only captured context and canonical authorized metadata", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, user, project } = context;
    await app.store.createProject(await app.store.userById(user.id),"private-context","Private context");
    const [privateSource] = await ingestCorpus(context,{ projectId:"private-context",names:["房颤抗凝指南.pdf"] });
    const privatePayload={ ...privateSource.payload,metadata:{ ...privateSource.payload.metadata,title:privateTitle } };
    await app.sourceService.documents.put(user.id,"source",privateSource.id,privatePayload,{ expectedRevision:privateSource.revision,projectId:privateSource.projectId });
    const privateRow=await app.sourceService.get(user.id,privateSource.id);
    await app.kbIndex.indexSource({ user_id:user.id,id:privateRow.id,project_id:privateRow.projectId,revision:privateRow.revision,payload:privateRow.payload });
    const sources = await ingestCorpus(context);
    const source = sources[0];
    assert.equal(source.payload.fingerprint.sha256,privateRow.payload.fingerprint.sha256);
    assert.equal(source.payload.analysis.textSha256,privateRow.payload.analysis.textSha256);
    let libraryCalls=0;
    app.kbIndex.library={ searchScope:async()=>{ libraryCalls+=1; throw new Error("restricted scope must not consult library"); } };
    const seen = [];
    app.kbIndex.rerank = { configured: true, async order(_query, texts) { seen.push(...texts); return texts.map((_, index) => index); } };
    let originalReceipt;
    for (const titles of [[privateTitle,"Public title"],["Public title",privateTitle]]) {
      for (const title of titles) {
        const from=title===privateTitle?privateRow:source;
        await app.kbIndex.indexSource({ user_id:user.id,id:from.id,project_id:from.projectId,
          revision:from.revision,payload:{ ...from.payload,metadata:{ ...from.payload.metadata,title } } });
      }
      const documents = await documentRows(context);
      const document = documents.find(row => row.sha256 === source.payload.fingerprint.sha256);
      assert.equal(document.title, ""); assert.equal(document.index_method, KB_INDEX_METHOD);
      if (originalReceipt) assert.equal(document.embedding_input_sha256, originalReceipt);
      originalReceipt = document.embedding_input_sha256;
      const chunks = await chunksOf(context, document);
      assert.equal(document.embedding_input_sha256, embeddingInputReceipt(chunks.map(c => ({ ordinal:c.ordinal,prefix:c.context_prefix,content:c.content }))));
      for (const chunk of chunks) assert.doesNotMatch(`${chunk.context_prefix}\n${chunk.lexemes}`, /privatetitlecanary|Public title/);
      const noMatch = await app.kbIndex.search({ userId:user.id,projectId:project.id,query:privateTitle,includeLibrary:false,acceptSource:async row => row.id === source.id });
      assert.equal(noMatch.legs.keyword, 0); assert.deepEqual(noMatch.hits, []);
      const body = await app.kbIndex.search({ userId:user.id,projectId:project.id,query:"抗凝",includeLibrary:false,acceptSource:async row=>row.projectId===project.id && row.id===source.id });
      assert.ok(body.hits.length >= 2); assert.doesNotMatch(JSON.stringify(body), /privatetitlecanary/);
    }
    assert.equal(libraryCalls,0);
    assert.ok(seen.length >= 2); assert.doesNotMatch(JSON.stringify(seen), /privatetitlecanary|Public title/);
    const current = await app.sourceService.get(user.id,source.id);
    await app.sourceService.documents.put(user.id,"source",current.id,{ ...current.payload,metadata:{ ...current.payload.metadata,title:"Canonical renamed" } },
      { expectedRevision:current.revision,projectId:current.projectId });
    const renamed = await app.kbIndex.search({ userId:user.id,projectId:project.id,query:"达比加群",includeLibrary:false });
    assert.equal(renamed.hits[0].title,"Canonical renamed");
    assert.equal((await documentRows(context)).find(row => row.sha256 === source.payload.fingerprint.sha256).embedding_input_sha256,originalReceipt);
    // A word that is also a private title remains searchable when it occurs in the body.
    await app.kbIndex.indexSource({ user_id:user.id,id:source.id,project_id:source.projectId,revision:source.revision,
      payload:{ ...source.payload,metadata:{ title:"达比加群" } } });
    assert.ok((await app.kbIndex.search({ userId:user.id,projectId:project.id,query:"达比加群",includeLibrary:false })).hits.length);
  } finally { await context.close(); }
});

test("legacy index is unreadable until bounded local repair; corrupt chunks back off without starving detached copies", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured:false,counters:{} } });
  try {
    const { app,user,project } = context;
    await ingestCorpus(context);
    const documents = await documentRows(context);
    const original = new Map();
    for (const document of documents) { original.set(document.sha256,await chunksOf(context,document)); await contaminate(context,document); }
    const request = { userId:user.id,projectId:project.id,query:"抗凝",includeLibrary:false };
    const before = await app.kbIndex.search(request); assert.equal(before.mode,"indexing"); assert.equal(before.waiting.length,documents.length);
    app.kbIndex.smallLibraryTokens = 150_000;
    const small = await app.kbIndex.search(request); assert.equal(small.mode,"small-library"); assert.equal(small.files.length,documents.length);
    app.kbIndex.smallLibraryTokens = 0;
    assert.equal(await app.kbIndex.passages({ userId:user.id,projectId:project.id,shared:false,q:"抗凝" }),null);
    // The first broken row consumes one budget unit and receives backoff. Next pass still reaches the others.
    await contaminate(context,documents[0],{ corrupt:true });
    const first = await app.kbIndex.sync({ userId:user.id,limit:1 }); assert.equal(first.repaired+first.failed,1);
    for (let pass=0;pass<documents.length+1;pass+=1) {
      const result=await app.kbIndex.sync({ userId:user.id,limit:1 }); assert.ok(result.repaired+result.failed+result.modelReset+result.indexed<=1);
    }
    const after=await documentRows(context);
    assert.equal(after.filter(row=>row.index_method===KB_INDEX_METHOD).length,documents.length-1);
    assert.equal(app.kbIndex.lastError,"kb_legacy_chunks_invalid");
    const mixed=await app.kbIndex.search(request); assert.ok(mixed.hits.length); assert.equal(mixed.waiting.length,1);
    for (const document of after.filter(row=>row.index_method===KB_INDEX_METHOD)) {
      const chunks=await chunksOf(context,document); assert.equal(document.title,"");
      assert.equal(document.embedding_input_sha256,embeddingInputReceipt(chunks.map(c=>({ ordinal:c.ordinal,prefix:"",content:c.content }))));
      assert.deepEqual(chunks.map(c=>[c.content,c.start_offset,c.end_offset,c.page]),original.get(document.sha256).map(c=>[c.content,c.start_offset,c.end_offset,c.page]));
      assert.ok(chunks.every(c=>c.heading_path==="" && c.context_prefix===""));
    }
    // No live capture and no library index.md parsing is needed to sanitize a held document.
    const detached=after.find(row=>row.index_method===KB_INDEX_METHOD); await contaminate(context,detached);
    app.kbIndex.useLibrary({ heldIndexKeys:async()=>[{ userId:user.id,sha256:detached.sha256,parserRevision:detached.parser_revision,textSha256:detached.text_sha256 }],
      syncCopies:async()=>null,searchScope:async()=>[] });
    await app.store.database.query("DELETE FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND payload->'fingerprint'->>'sha256'=$2",[user.id,detached.sha256]);
    app.kbIndex.sources={ loadCapture:async()=>{ throw new Error("must not reconstruct capture"); } };
    const repaired=await app.kbIndex.sync({ userId:user.id,limit:1 }); assert.equal(repaired.repaired,1);
    assert.equal((await documentRows(context)).find(row=>row.sha256===detached.sha256).index_method,KB_INDEX_METHOD);
    const rebuild=await app.kbIndex.rebuild({ userIds:[user.id] }); assert.ok(rebuild.unproven>=0);
    assert.ok((await documentRows(context)).some(row=>row.sha256===detached.sha256));
  } finally { await context.close(); }
});

test("receipt replacement between readiness, ranking and hydration never exposes a different indexed context", { skip }, async () => {
  const context=await signedIn({ kbEmbedder:{ configured:false,counters:{} } });
  try {
    const { app,user,project }=context; await ingestCorpus(context); const db=app.store.database;
    for (const phase of ["readiness","hydration","passages"]) for (const mutation of ["index_method=NULL","embedding_input_sha256=repeat('f',64)"]) {
      await app.kbIndex.rebuild({ userIds:[user.id] });
      let changed=false;
      const proxy={ transaction:fn=>db.transaction(fn),async query(sql,args) {
        const result=await db.query(sql,args);
        const trigger=phase==="readiness" || phase==="passages" ? sql.startsWith("SELECT sha256,parser_revision") : sql.includes("ORDER BY ts_rank(c.lexemes,$6");
        if (!changed && trigger) { changed=true; await db.query(`UPDATE evimed_kb.documents SET ${mutation} WHERE user_id=$1`,[user.id]); }
        return result;
      } };
      const index=new KnowledgeBaseIndex({ database:proxy,sources:app.sourceService,dimension:1024,smallLibraryTokens:0 });
      if (phase==="passages") assert.equal(await index.passages({ userId:user.id,projectId:project.id,shared:false,q:"抗凝" }),null);
      else { const result=await index.search({ userId:user.id,projectId:project.id,query:"抗凝",includeLibrary:false }); assert.deepEqual(result.hits,[]); }
      assert.equal(changed,true,phase);
    }
  } finally { await context.close(); }
});
