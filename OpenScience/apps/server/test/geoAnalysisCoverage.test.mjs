import assert from "node:assert/strict";
import test from "node:test";
import {
  presentGeoAnalysis,
  freezeGeoAnalysisDocument,
} from "../src/geoAnalysis.mjs";
const question = (id, group = null, tags = []) => ({
  id,
  set_version: 1,
  text: `Original ${id}`,
  original_id: `00${id}`,
  original_row: 3,
  original_group: group,
  client_tags: tags,
});
const answer = (id, questionId, status = "valid", extra = {}) => ({
  snapshotId: id,
  questionId,
  engine: "deepseek",
  roundId: "r1",
  repeatIndex: 0,
  status,
  askedAt: "2026-10-01T00:00:00Z",
  citations: [],
  facts: {
    statements: [
      {
        text: "Same claim",
        verdict: "correct",
        topic: "dosage",
        claimId: "c",
        claimVersion: 1,
        applicability: {
          population: "adults",
          elements: null,
          inLabel: true,
          validUntil: null,
          evidenceLevel: "A",
        },
        evidence: "Exact source quote",
      },
    ],
    checks: { judgementCoverage: { status: "complete" } },
    judgedAt: "2026-10-01T00:01:00Z",
  },
  ...extra,
});
const selected = () => ({
  scope: { timeZone: "Asia/Shanghai" },
  selection: {
    reference: "gsel_test",
    dataRevision: "one",
    methodVersion: "test",
    engines: ["deepseek", "kimi"],
    counts: {},
    timeCoverage: { unknownTime: 0, plannedRounds: 1 },
  },
  questions: [question("q1", "A, B", ["x", "y"]), question("q2", null, ["x"])],
  rows: [
    answer("a1", "q1"),
    answer("a2", "q1", "refusal", {
      roundId: "r2",
      repeatIndex: 1,
      facts: null,
    }),
    answer("a3", "q2", "valid", { facts: null }),
  ],
  rounds: [
    { id: "r1", set_version: 1 },
    { id: "r2", set_version: 1 },
  ],
  computed: { cells: [] },
  metricOptions: { engines: ["deepseek", "kimi"] },
});
const context = () => ({
  allRows: true,
  jobs: [
    {
      id: "j1",
      question_id: "q1",
      round_id: "r1",
      engine: "kimi",
      repeat_index: 0,
      status: "failed",
      error_code: "timeout",
    },
    {
      id: "j2",
      question_id: "q2",
      round_id: "r2",
      engine: "kimi",
      repeat_index: 0,
      status: "queued",
      error_code: null,
    },
  ],
  snapshots: [],
});
test("V06 preserves comma categories, explicit uncategorized and deduped multi-tag totals", () => {
  const input = selected(),
    groups = presentGeoAnalysis(
      input,
      { viewId: "V06", categoryMode: "original_group" },
      context(),
    );
  assert.ok(groups.rows.some((row) => row.dimensions.category === "A, B"));
  assert.ok(
    groups.rows.some(
      (row) => row.dimensions.category === null && !row.dimensions.overall,
    ),
  );
  assert.equal(
    groups.rows.find((row) => row.dimensions.overall).values.questions.value,
    2,
  );
  const tags = presentGeoAnalysis(
    input,
    { viewId: "V06", categoryMode: "client_tags" },
    context(),
  );
  assert.equal(
    tags.rows.find((row) => row.dimensions.overall).values.questions.value,
    2,
  );
  assert.equal(
    tags.rows.find(
      (row) =>
        row.dimensions.category === "x" && row.dimensions.engine === "deepseek",
    ).values.questions.value,
    2,
  );
  assert.notEqual(tags.digest, groups.digest);
});
test("V07 retains mixed actual rounds/repeats and missing-job dispositions", () => {
  const view = presentGeoAnalysis(selected(), { viewId: "V07" }, context());
  const row = view.rows.find(
    (row) =>
      row.dimensions.questionId === "q1" &&
      row.dimensions.engine === "deepseek",
  );
  assert.equal(row.values.returned.value, 1);
  assert.equal(row.values.refused.value, 1);
  assert.equal(
    view.rows.find(
      (row) =>
        row.dimensions.questionId === "q1" && row.dimensions.engine === "kimi",
    ).values.failed.value,
    1,
  );
  assert.equal(
    view.rows.find(
      (row) =>
        row.dimensions.questionId === "q2" && row.dimensions.engine === "kimi",
    ).values.pending.value,
    1,
  );
  assert.equal(row.values.returned.members.unit, "answers");
});
test("V11 keeps observed days and planned-job context separate and reports unknown time", () => {
  const input = selected();
  input.rows.push(answer("unknown", "q2", "valid", { askedAt: null }));
  const view = presentGeoAnalysis(input, { viewId: "V11" }, context());
  assert.ok(view.rows.some((row) => row.dimensions.basis === "scheduled_jobs"));
  assert.ok(
    view.rows.some(
      (row) =>
        row.dimensions.basis === "observed" && row.dimensions.date === null,
    ),
  );
  assert.equal(
    view.rows
      .filter((row) => row.dimensions.basis === "observed")
      .reduce((n, row) => n + row.values.returned.value, 0),
    3,
  );
});
test("V12 separates answer and statement units and preserves unknown applicability and partial coverage", () => {
  const input = selected();
  input.rows.push(
    answer("partial", "q2", "valid", {
      facts: {
        statements: [{ text: "Partial", verdict: "correct" }],
        checks: { judgementCoverage: { status: "partial" } },
      },
    }),
  );
  const view = presentGeoAnalysis(input, { viewId: "V12" }, context());
  assert.equal(
    view.rows.find((row) => row.dimensions.unit === "answers").values.partial
      .value,
    1,
  );
  assert.equal(
    view.rows.find((row) => row.dimensions.unit === "answers").values
      .not_applicable.value,
    null,
  );
  assert.equal(
    view.rows.find((row) => row.dimensions.unit === "statements").values
      .unverifiable.value,
    0,
  );
  assert.equal(
    view.rows.find((row) => row.dimensions.unit === "statements").values.correct
      .members.unit,
    "statements",
  );
});
test("V14 exact conditions/version stay distinct and all rows bind export/member identity", () => {
  const input = selected();
  input.rows.push(
    answer("a4", "q2", "valid", {
      facts: {
        statements: [
          {
            ...input.rows[0].facts.statements[0],
            verdict: "wrong",
            claimVersion: 2,
            applicability: {
              population: "children",
              elements: null,
              inLabel: false,
              validUntil: "2027-01-01",
              evidenceLevel: "B",
            },
          },
        ],
        checks: { judgementCoverage: { status: "complete" } },
      },
    }),
  );
  const view = presentGeoAnalysis(input, { viewId: "V14" }, context());
  assert.equal(view.rows.length, 2);
  assert.equal(
    view.rows.reduce((n, row) => n + row.values.wrong.value, 0),
    1,
  );
  assert.notEqual(view.rows[0].key, view.rows[1].key);
  const frozen = freezeGeoAnalysisDocument(view);
  assert.equal(frozen.typedTable.rows.length, 2);
  assert.ok(
    frozen.typedTable.rows.some((row) =>
      String(row.dimensions).includes("children"),
    ),
  );
  assert.equal(
    view.rows[0].values.assessed.members.expectedDigest,
    view.digest,
  );
  assert.equal(
    view.digest,
    presentGeoAnalysis(
      input,
      { viewId: "V14" },
      { ...context(), readAt: "2099-01-01" },
    ).digest,
  );
});

test('validated no-clinical-assertion answers have explicit N/A; legacy applicability stays visible and statement N/A stays unknown',()=>{
 const input=selected();input.rows.push(answer('no-clinical','q2','valid',{facts:{statements:[],checks:{judgementCoverage:{status:'complete'},clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'not_applicable',validated:true,quote:'Open help.',reason:'Navigation only.'}}}}));
 const view=presentGeoAnalysis(input,{viewId:'V12'},context());
 const answers=view.rows.find(row=>row.dimensions.unit==='answers'),statements=view.rows.find(row=>row.dimensions.unit==='statements');
 assert.equal(answers.values.not_applicable.value,1);assert.ok(answers.values.applicability_unknown.value>0);
 assert.equal(statements.values.not_applicable.value,null);assert.equal(statements.values.unknown.value,null);
 assert.equal(answers.values.not_applicable.members.unit,'answers');
 assert.ok(freezeGeoAnalysisDocument(view).typedTable.columns.length<=40);
});

test('a done task linked to an outside-scope snapshot is distinct from a genuinely missing snapshot',()=>{
 const input=selected(),ctx=context();ctx.jobs.push({id:'outside',question_id:'q1',round_id:'r1',engine:'kimi',status:'done',snapshot_id:'outside-answer',linked_snapshot_id:'outside-answer'});
 const members=new Map();presentGeoAnalysis(input,{viewId:'V07'},{...ctx,memberItems:members});
 const item=[...members.values()].flat().find(item=>item.id==='outside');assert.equal(item.reason,'snapshot_outside_selected_observations');
});

test('partial and legacy unknown coverage preserve extracted verdicts without claiming zero unknown statements',()=>{
 for(const checks of [{judgementCoverage:{status:'partial'}},{}]){
 const input=selected();input.rows=[answer('partial','q1','valid',{facts:{statements:[{text:'Preserved statement',verdict:'correct'}],checks}})];
 const view=presentGeoAnalysis(input,{viewId:'V12'},context());const statements=view.rows.find(row=>row.dimensions.unit==='statements');
 assert.equal(statements.values.correct.value,1);assert.equal(statements.values.unknown.value,null);assert.equal(statements.values.unknown.state,'unknown');
 }
});

test('missing imported categories preserve uncategorized data with an explicit import remedy',()=>{
 const input=selected();input.questions=input.questions.map(question=>({...question,original_group:null,client_tags:[]}));const view=presentGeoAnalysis(input,{viewId:'V06'},context());
 assert.equal(view.availability.status,'unsupported');assert.equal(view.availability.remedy.href,'questions');assert.ok(view.rows.length>0);assert.equal(view.rows.find(row=>row.dimensions.overall).values.questions.value,2);
});

test('zero-count empty answer cohorts retain answer units rather than inferring task units from an empty array',()=>{
 const view=presentGeoAnalysis(selected(),{viewId:'V07'},context());const row=view.rows.find(row=>row.dimensions.questionId==='q1'&&row.dimensions.engine==='kimi');assert.equal(row.values.returned.value,0);assert.equal(row.values.returned.unit,'answers');assert.equal(row.values.returned.members.unit,'answers');
});
