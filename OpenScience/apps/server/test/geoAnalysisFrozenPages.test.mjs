import assert from "node:assert/strict";
import test from "node:test";
import { geoPlanDigest } from "../src/geoPlanContext.mjs";
import { presentGeoAnalysis } from "../src/geoAnalysis.mjs";
import { computeGeoSelection } from "../src/geoReadScope.mjs";
import {
  freezeGeoAnalysisPages,
  readFrozenGeoAnalysisPage,
} from "../src/geoAnalysisFrozenPages.mjs";
const project = { id: "geo", projectId: "control", userId: "owner" };
test('paged source analysis preserves bounded top-N remainder unions and exact chart member references', async () => {
  const citations = Array.from({ length: 200 }, (_, i) => ({ url: `https://type${i}.example/a` }));
  const rows = ['one', 'two'].map(snapshotId => ({ snapshotId, questionId: snapshotId, engine: 'deepseek', roundId: 'r', status: 'valid', askedAt: '2026-10-01T00:00:00Z', citations, facts: {} }));
  const selected = { scope: {}, selection: { reference: 'gsel_sources_frozen', dataRevision: 'r', methodVersion: 'm', counts: {} }, rows,
    rounds: [{ id: 'r' }], questions: [], computed: { balance: { deduped: rows }, cells: [] } };
  const sources = citations.map((citation, i) => ({ id: `source-${i}`, domain: new URL(citation.url).hostname, kind: `type-${i}`, name: `Type ${i}` }));
  const view = presentGeoAnalysis(selected, { viewId: 'V17', topN: 1 }, { sources, allRows: true, memberItems: new Map() });
  const remainder = view.chart.cells.at(-1);
  assert.equal(remainder.members.total, 2, 'overlapping answer unions cannot be reconstructed by adding type row counts');
  const pack = freezeGeoAnalysisPages(view, { parentId: 'gpc_parent', project, actorId: 'actor' });
  assert.ok(pack.pages.length > 0);
  assert.deepEqual(pack.analysis.chart, view.chart);
  assert.equal(pack.analysis.chart.denominator, 2);
  assert.deepEqual(pack.analysis.chart.cells.at(-1).members, remainder.members);
  const fixture = stored(pack);
  const page = await readFrozenGeoAnalysisPage(fixture.documents, project, fixture.parent, { limit: 10, offset: 10 });
  assert.deepEqual(page.chart, view.chart);
});
test("a 600-group chart pages all canonical values without repeating the entire chart in the native envelope", async () => {
  const rows = Array.from({ length: 600 }, (_, index) => ({ snapshotId: `s${index}`, questionId: `q${index}`, groupId: `g${index}`, engine: "deepseek", roundId: "r", status: "valid", pool: "P2", repeatIndex: 0, askedAt: "2026-10-01T00:00:00Z", facts: { brands: [], statements: [], checks: { judgementCoverage: { status: "complete" } } } }));
  const metricOptions = { engines: ["deepseek"], samplingMode: "web" };
  const selected = { scope: { timeZone: "Asia/Shanghai" }, selection: { reference: "gsel_wide_chart", dataRevision: "one", methodVersion: "method", engines: ["deepseek"], counts: {} }, rows, questions: [], rounds: [{ id: "r", set_version: 1 }], metricOptions, computed: computeGeoSelection(rows, metricOptions), comparison: null };
  const view = presentGeoAnalysis(selected, { viewId: "V05", metricId: "M-01" }, { allRows: true });
  assert.equal(view.rows.length, 600);
  assert.ok(Buffer.byteLength(JSON.stringify(view.chart)) > 200000);
  const pack = freezeGeoAnalysisPages(view, { parentId: "gpc_parent", project, actorId: "actor" });
  assert.ok(Buffer.byteLength(JSON.stringify(pack.analysis)) < 200000);
  assert.equal(pack.analysis.chart.source, "frozen_rows");
  assert.equal(pack.analysis.nativeProjection.chartDigest, geoPlanDigest(view.chart));
  const fixture = stored(pack), restored = [];
  for (let offset = 0; offset < view.rows.length; offset += 37) restored.push(...(await readFrozenGeoAnalysisPage(fixture.documents, project, fixture.parent, { offset, limit: 37 })).rows);
  assert.deepEqual(restored, view.rows);
  assert.equal(pack.analysis.digest, view.digest);
});
function wide() {
  const engines = ["deepseek", "kimi", "doubao", "qwen", "baidu"],
    questions = Array.from({ length: 130 }, (_, i) => ({
      id: `q${i}`,
      set_version: 1,
      text: `Original question ${i}`,
      original_id: String(i).padStart(4, "0"),
      original_row_index: i,
      original_group: "Category",
    }));
  return presentGeoAnalysis(
    {
      scope: { timeZone: "Asia/Shanghai" },
      selection: {
        reference: "gsel_size",
        dataRevision: "size",
        methodVersion: "method",
        engines,
        counts: {},
      },
      questions,
      rows: [],
      rounds: [{ id: "r" }],
      computed: { cells: [] },
    },
    { viewId: "V07" },
    { allRows: true },
  );
}
function stored(pack) {
  const parent = {
    id: "gpc_parent",
    projectId: project.projectId,
    payload: {
      recordType: "geo-plan-context",
      geoId: project.id,
      actorId: "actor",
      mode: "analysis",
      state: "bound",
      basis: { analysis: pack.analysis },
    },
  };
  parent.payload.basisDigest = geoPlanDigest(parent.payload.basis);
  const records = new Map(pack.pages.map((page) => [page.id, page]));
  return {
    parent,
    records,
    documents: {
      get: async (userId, kind, id) =>
        userId === project.userId && kind === "geo-plan-context"
          ? (records.get(id) ?? null)
          : null,
    },
  };
}
test("130 questions x5 engines freezes bounded pages and reconstructs all exact rows once", async () => {
  const view = wide();
  assert.ok(Buffer.byteLength(JSON.stringify(view)) > 200000);
  const pack = freezeGeoAnalysisPages(view, {
    parentId: "gpc_parent",
    project,
    actorId: "actor",
  });
  assert.equal(pack.analysis.rows.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(pack.analysis)) <= 200000);
  assert.ok(pack.pages.length > 1 && pack.pages.length <= 128);
  assert.equal(pack.analysis.digest, view.digest);
  assert.ok(
    pack.pages.every(
      (page) =>
        Buffer.byteLength(JSON.stringify(page.payload)) <= 150000 &&
        !page.payload.basis,
    ),
  );
  const fixture = stored(pack),
    rows = [];
  for (let offset = 0; offset < view.rows.length; offset += 37) {
    const page = await readFrozenGeoAnalysisPage(
      fixture.documents,
      project,
      fixture.parent,
      { limit: 37, offset },
    );
    assert.equal(page.digest, view.digest);
    rows.push(...page.rows);
  }
  assert.deepEqual(rows, view.rows);
  assert.equal(new Set(rows.map((row) => row.key)).size, 650);
});
test("corrupt rows, foreign owner/project/parent or analysis digest fail closed", async () => {
  const pack = freezeGeoAnalysisPages(wide(), {
    parentId: "gpc_parent",
    project,
    actorId: "actor",
  });
  for (const mutate of [
    (page) => (page.payload.rows[0].label = "Corrupt"),
    (page) => (page.payload.ownerId = "foreign"),
    (page) => (page.projectId = "foreign"),
    (page) => (page.payload.parentId = "foreign"),
    (page) => (page.payload.actorId = "foreign"),
    (page) => (page.payload.analysisDigest = "f".repeat(64)),
  ]) {
    const fixture = stored(structuredClone(pack));
    mutate(fixture.records.values().next().value);
    await assert.rejects(
      readFrozenGeoAnalysisPage(fixture.documents, project, fixture.parent, {
        offset: 0,
        limit: 1,
      }),
      (error) => error.status === 409 || error.status === 404,
    );
  }
});
test("individual giant rows and excess total storage never create unbounded pages", () => {
  const view = wide();
  view.rows[0].label = "x".repeat(150000);
  assert.throws(
    () =>
      freezeGeoAnalysisPages(view, {
        parentId: "gpc_parent",
        project,
        actorId: "actor",
      }),
    (error) => error.status === 422,
  );
  const many = wide();
  many.rows = Array.from({ length: 20000 }, () =>
    structuredClone(many.rows[0]),
  );
  many.page = { total: 20000, shown: 20000, nextOffset: null };
  assert.throws(
    () =>
      freezeGeoAnalysisPages(many, {
        parentId: "gpc_parent",
        project,
        actorId: "actor",
      }),
    (error) => error.status === 422,
  );
});

test("missing pages and modified parent manifests never fall back to live or preview-only data", async () => {
  const pack = freezeGeoAnalysisPages(wide(), {
    parentId: "gpc_parent",
    project,
    actorId: "actor",
  });
  const missing = stored(structuredClone(pack));
  missing.records.clear();
  await assert.rejects(
    readFrozenGeoAnalysisPage(missing.documents, project, missing.parent, {
      limit: 1,
    }),
    (error) => error.status === 409,
  );
  for (const mutate of [
    (parent) => (parent.projectId = "foreign"),
    (parent) => (parent.payload.geoId = "foreign"),
    (parent) => parent.payload.basis.analysis.frozenPages.pages[0].count++,
    (parent) => delete parent.payload.basis.analysis.frozenPages,
  ]) {
    const fixture = stored(structuredClone(pack));
    mutate(fixture.parent);
    await assert.rejects(
      readFrozenGeoAnalysisPage(fixture.documents, project, fixture.parent, {
        limit: 1,
      }),
      (error) => error.status === 409,
    );
  }
});

test("the16MiB total budget is enforced even below the128-page count ceiling", () => {
  const view = wide();
  view.rows = view.rows
    .slice(0, 120)
    .map((row) => ({ ...row, label: "x".repeat(140000) }));
  view.page = { total: 120, shown: 120, nextOffset: null };
  assert.throws(
    () =>
      freezeGeoAnalysisPages(view, {
        parentId: "gpc_parent",
        project,
        actorId: "actor",
      }),
    (error) => error.status === 422,
  );
});

function sameClaimObjects(count = 250) {
  const objects = Array.from({length:count}, (_,index)=>({id:`answer-${index}`,snapshotId:`snapshot-${index}`,statement:{text:'Preserved statement '.repeat(90),verdict:'wrong'},position:index}));
  const row={key:'same-claim',label:'Exact same claim',dimensions:{objects},values:{observations:{value:count,state:'known'}}};
  return {digest:geoPlanDigest(objects),rows:[row],page:{total:1,shown:1,nextOffset:null},chart:null,comparison:null};
}
test('large same-row contexts keep aggregate values and page every frozen object without mutating input',async()=>{
  const view=sameClaimObjects(),original=structuredClone(view),pack=freezeGeoAnalysisPages(view,{parentId:'gpc_parent',project,actorId:'actor'});
  assert.deepEqual(view,original);assert.equal(pack.analysis.frozenPages.schemaVersion,2);
  assert.ok(pack.pages.every(page=>Buffer.byteLength(JSON.stringify(page.payload))<=150000));
  assert.ok(Buffer.byteLength(JSON.stringify(pack.analysis))<=200000);
  const fixture=stored(pack),rowPage=await readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{limit:1});
  assert.equal(rowPage.rows[0].key,view.rows[0].key);assert.deepEqual(rowPage.rows[0].values,view.rows[0].values);
  assert.equal(rowPage.rows[0].dimensions.objects,undefined);assert.equal(rowPage.rows[0].dimensions.objectsContext.total,250);
  const all=[];let offset=0;
  while(offset!==null){const page=await readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{rowKey:'same-claim',columnKey:'objects',offset,limit:37});assert.ok(Buffer.byteLength(JSON.stringify(page))<4*1024*1024);all.push(...page.items);offset=page.nextOffset;}
  assert.deepEqual(all,original.rows[0].dimensions.objects);assert.equal(geoPlanDigest(all),rowPage.rows[0].dimensions.objectsContext.digest);
  const arbitrary=await readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{rowKey:'same-claim',columnKey:'objects',offset:121,limit:50});
  assert.deepEqual(arbitrary.items,all.slice(121,121+arbitrary.items.length));
});
test('frozen object pages refuse missing, altered, cross-row and cross-project records',async()=>{
  for(const mode of ['missing','altered','other-row','other-project']){
    const pack=freezeGeoAnalysisPages(sameClaimObjects(),{parentId:'gpc_parent',project,actorId:'actor'}),fixture=stored(pack);
    const descriptor=pack.analysis.frozenPages.objects[0].pages[0],record=fixture.records.get(descriptor.id);
    if(mode==='missing')fixture.records.delete(descriptor.id);
    if(mode==='altered')record.payload.objects[0].statement.text='Changed';
    if(mode==='other-row')record.payload.rowKey='foreign';
    if(mode==='other-project')record.projectId='foreign';
    await assert.rejects(readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{rowKey:'same-claim',columnKey:'objects'}),{code:'geo_plan_basis_unavailable'},mode);
  }
});
test('frozen object selectors preserve inline legacy rows and reject unrelated selectors or oversized single objects',async()=>{
  const view=sameClaimObjects(2),pack=freezeGeoAnalysisPages(view,{parentId:'gpc_parent',project,actorId:'actor'}),fixture=stored(pack);
  assert.deepEqual(pack.analysis,view);assert.equal(pack.pages.length,0);
  const page=await readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{rowKey:'same-claim',columnKey:'objects',offset:1,limit:1});
  assert.deepEqual(page.items,[view.rows[0].dimensions.objects[1]]);
  await assert.rejects(readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{rowKey:'same-claim'}));
  await assert.rejects(readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{rowKey:'missing',columnKey:'objects'}));
  const giant=sameClaimObjects(1);giant.rows[0].dimensions.objects[0].statement.text='x'.repeat(200000);
  assert.throws(()=>freezeGeoAnalysisPages(giant,{parentId:'gpc_parent',project,actorId:'actor'}),{code:'geo_plan_basis_too_large'});
});
