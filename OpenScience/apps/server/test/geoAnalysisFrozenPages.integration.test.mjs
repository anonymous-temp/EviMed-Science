import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoPlanContext, geoPlanDigest } from "../src/geoPlanContext.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { freezeSelectedGeoAnalysis } from "../src/geoAnalysis.mjs";
import { freezeGeoAnalysisPages, persistFrozenGeoAnalysisContext } from "../src/geoAnalysisFrozenPages.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "",
  options = { skip: !url && "Disposable local PostgreSQL required" };
const user = { id: "wide-owner" },
  engines = ["deepseek", "kimi", "doubao", "qwen", "baidu"];
let isolated,
  database,
  store,
  project,
  service,
  documents,
  adapter,
  view,
  full,
  firstContext;
const body = (requestKey) => ({
  requestKey,
  sessionId: "wide-session",
  mode: "analysis",
  selectionRef: view.selection.reference,
  view: view.view,
  expectedDigest: view.digest,
  intent: "explain",
});
const bind = async (context) => {
  const request = {
    requestId: `request-${context.referenceId}`,
    sessionId: "wide-session",
    content: [{ type: "text", text: "Explain the frozen grid." }],
    geoPlanContext: { referenceId: context.referenceId },
  };
  await adapter.prepare(
    user,
    { id: project.projectId, userId: project.userId },
    request,
  );
  await adapter.bind(
    user,
    { id: project.projectId, userId: project.userId },
    request,
  );
  return request;
};
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geowidepages");
  database = new ControlPlaneDatabase({
    databaseUrl: isolated.url,
    databasePoolMax: 6,
    databaseConnectionTimeoutMs: 3000,
  });
  store = new GeoStore({ database });
  await store.ready();
  await new GeoMeasureStore(database).ready();
  await database.query(
    "INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Wide','development')",
    [user.id],
  );
  await database.query(
    "INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'wide-project','Wide',1048576)",
    [user.id],
  );
  project = await store.createProject({
    userId: user.id,
    projectId: "wide-project",
    coverageDays: 90,
    engines,
    product: { brandName: "Ours" },
  });
  await store.query(
    "INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('wide-group',$1,$2,1,'P2','Original group')",
    [user.id, project.id],
  );
  await store.query(
    `INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,original_id,original_row_index,original_group)
 SELECT 'wide-q-'||n,$1,$2,'wide-group',1,'P2','Original question '||n,lpad(n::text,4,'0'),n,'Category' FROM generate_series(1,130) AS n`,
    [user.id, project.id],
  );
  await store.query(
    `INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES('wide-round',$1,$2,'baseline','done',1,$3::text[],'2026-10-04','{"mode":"web"}')`,
    [user.id, project.id, engines],
  );
  service = new GeoService({
    store,
    config: { geoEnabled: true, geoAudience: "all" },
  });
  documents = new ProductDocuments(database);
  adapter = new GeoPlanContext({
    documents,
    store,
    service,
    authorizeSession: async (_user, _project, session) =>
      assert.equal(session, "wide-session"),
    runs: async () => [],
  });
  service.planContexts = adapter;
  view = await service.analysis(user, project.id, {
    viewId: "V07",
    round: "wide-round",
  });
  full = await freezeSelectedGeoAnalysis(store, project, {
    selectionRef: view.selection.reference,
    view: view.view,
    expectedDigest: view.digest,
  });
});
after(async () => {
  await database?.close();
  await isolated?.drop();
});
test(
  "actual130x5 grid stages and binds compactly; only context reference reconstructs all650 frozen rows",
  options,
  async () => {
    assert.equal(full.rows.length, 650);
    assert.ok(Buffer.byteLength(JSON.stringify(full)) > 3000000);
    firstContext = await adapter.stage(user, project.id, body("wide-first"));
    const parent = await documents.get(
      user.id,
      "geo-plan-context",
      firstContext.referenceId,
    );
    assert.equal(parent.payload.basis.analysis.rows.length, 5);
    assert.equal(parent.payload.basis.analysis.digest, full.digest);
    assert.ok(parent.payload.basis.analysis.frozenPages.pages.length > 1);
    const request = await bind(firstContext);
    assert.ok(Buffer.byteLength(request.content[1].text) < 210000);
    const rows = [];
    let offset = 0;
    do {
      const page = await service.runtimeRead(project, "analysis", {
        planContextRef: firstContext.referenceId,
        limit: 37,
        offset,
      });
      assert.equal(page.digest, full.digest);
      rows.push(...page.rows);
      offset = page.page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(rows, full.rows);
    assert.equal(new Set(rows.map((row) => row.key)).size, 650);
    await assert.rejects(
      service.analysisOf(
        { ...project, userId: "foreign" },
        { planContextRef: firstContext.referenceId },
      ),
      (error) => error.status === 404,
    );
    await assert.rejects(
      service.runtimeRead(project, "analysis", {
        planContextRef: firstContext.referenceId,
        round: "latest",
      }),
      (error) => error.status === 400,
    );
  },
);
test(
  "concurrent staging and a lost batch response reuse one atomic parent/pages generation",
  options,
  async () => {
    const copies = await Promise.all([
      adapter.stage(user, project.id, body("wide-concurrent")),
      adapter.stage(user, project.id, body("wide-concurrent")),
    ]);
    assert.equal(copies[0].referenceId, copies[1].referenceId);
    const parent = await documents.get(
      user.id,
      "geo-plan-context",
      copies[0].referenceId,
    );
    const count = Number(
      (
        await database.query(
          "SELECT count(*) AS n FROM evimed_product.documents WHERE user_id=$1 AND kind='geo-plan-context' AND (id=$2 OR payload->>'parentId'=$2)",
          [user.id, parent.id],
        )
      ).rows[0].n,
    );
    assert.equal(
      count,
      parent.payload.basis.analysis.frozenPages.pages.length + 1,
    );
    const create = documents.createBatch.bind(documents);
    let responseLost = false;
    documents.createBatch = async (...args) => {
      await create(...args);
      responseLost = true;
      throw new Error("Response lost after commit");
    };
    let recovered;
    try {
      recovered = await adapter.stage(
        user,
        project.id,
        body("wide-lost-response"),
      );
    } finally {
      documents.createBatch = create;
    }
    assert.equal(responseLost, true);
    assert.deepEqual(
      await adapter.stage(user, project.id, body("wide-lost-response")),
      recovered,
    );
    await assert.rejects(
      adapter.stage(user, project.id, {
        ...body("wide-lost-response"),
        intent: "compare",
      }),
      (error) => error.status === 409,
    );
  },
);
test(
  "a colliding child causes atomic rollback instead of a partial parent",
  options,
  async () => {
    const input = body("wide-atomic-failure"),
      id = `gpc_${geoPlanDigest([user.id, project.id, input.requestKey])}`,
      pack = freezeGeoAnalysisPages(full, {
        parentId: id,
        project,
        actorId: user.id,
      });
    await documents.put(
      user.id,
      "geo-plan-context",
      pack.pages[0].id,
      { recordType: "collision" },
      { projectId: project.projectId, expectedRevision: 0 },
    );
    await assert.rejects(
      adapter.stage(user, project.id, input),
      (error) => error.status === 409,
    );
    assert.equal(await documents.get(user.id, "geo-plan-context", id), null);
    assert.equal(
      Number(
        (
          await database.query(
            "SELECT count(*) AS n FROM evimed_product.documents WHERE user_id=$1 AND payload->>'parentId'=$2",
            [user.id, id],
          )
        ).rows[0].n,
      ),
      0,
    );
  },
);
test(
  "corrupted frozen pages fail and source changes never replace the saved rows",
  options,
  async () => {
    const parent = await documents.get(
        user.id,
        "geo-plan-context",
        firstContext.referenceId,
      ),
      descriptor = parent.payload.basis.analysis.frozenPages.pages[0],
      page = await documents.get(user.id, "geo-plan-context", descriptor.id);
    await database.query(
      "UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{rows,0,label}','\"Changed\"'::jsonb) WHERE user_id=$1 AND kind='geo-plan-context' AND id=$2",
      [user.id, descriptor.id],
    );
    await assert.rejects(
      service.runtimeRead(project, "analysis", {
        planContextRef: firstContext.referenceId,
        limit: 1,
      }),
      (error) => error.status === 409,
    );
    await database.query(
      "UPDATE evimed_product.documents SET payload=$3::jsonb WHERE user_id=$1 AND kind='geo-plan-context' AND id=$2",
      [user.id, descriptor.id, JSON.stringify(page.payload)],
    );
    await store.query(
      "UPDATE evimed_geo.questions SET text='Current changed question' WHERE id='wide-q-1'",
    );
    await assert.rejects(
      service.analysis(user, project.id, {
        selectionRef: view.selection.reference,
        viewId: "V07",
      }),
      (error) => error.status === 409,
    );
    const frozen = await service.runtimeRead(project, "analysis", {
      planContextRef: firstContext.referenceId,
      limit: 50,
    });
    assert.deepEqual(frozen.rows, full.rows.slice(0, 50));
    assert.deepEqual(
      await adapter.stage(user, project.id, body("wide-first")),
      firstContext,
    );
  },
);

test('an object-page collision rolls back its aggregate and all other frozen children',options,async()=>{
  const id=`gpc_${geoPlanDigest('object-collision')}`;
  const objects=Array.from({length:250},(_,index)=>({id:`observation-${index}`,text:'Preserved text '.repeat(100)}));
  const analysis={digest:geoPlanDigest(objects),rows:[{key:'object-row',dimensions:{objects},values:{observations:{value:250,state:'known'}}}],page:{total:1,shown:1,nextOffset:null},chart:null,comparison:null};
  const pack=freezeGeoAnalysisPages(analysis,{parentId:id,project,actorId:user.id});
  const collision=pack.pages.find(page=>page.payload.recordType==='geo-analysis-object-page');
  await documents.put(user.id,'geo-plan-context',collision.id,{recordType:'unrelated-fixture'},{expectedRevision:0,projectId:project.projectId});
  const basis={analysis:pack.analysis};
  await assert.rejects(persistFrozenGeoAnalysisContext(documents,project,id,{recordType:'geo-plan-context',geoId:project.id,actorId:user.id,mode:'analysis',state:'bound',basis,basisDigest:geoPlanDigest(basis)},pack.pages));
  assert.equal(await documents.get(user.id,'geo-plan-context',id),null);
  for(const page of pack.pages)if(page.id!==collision.id)assert.equal(await documents.get(user.id,'geo-plan-context',page.id),null);
  assert.equal((await documents.get(user.id,'geo-plan-context',collision.id)).payload.recordType,'unrelated-fixture');
});
