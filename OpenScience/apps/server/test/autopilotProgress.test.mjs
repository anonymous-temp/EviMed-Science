import assert from "node:assert/strict";
import test from "node:test";
import { buildAutopilotProgress, claimCheck, loadAutopilotProgress, projectResearchState, renderAutopilotProgress, safeAutopilotArtifactRefs } from "../src/autopilotProgress.mjs";

const agenda = { id: "agenda", projectId: "p", payload: { followUps: [{ digestId: "digest", claimId: "c", note: "Check the remaining subgroup", at: "2026-09-29T01:00:00Z" }] } };
const episode = (id, date, status, extra = {}) => ({ id, ownerId: "alice", projectId: "p", revision: 2, createdAt: `${date}T01:00:00Z`,
  payload: { agendaId: "agenda", date, status, taskType: "evidence-update", claims: [], ...extra } });
const input = { userId: "alice", agenda, date: "2026-09-30", episodeId: "current", asOf: "2026-09-30T01:00:00Z", episodes: [], digests: [] };

test("prior progress retains actual claims, failed work, rejected directions and unanswered follow-ups", () => {
  const result = buildAutopilotProgress({ ...input, episodes: [
    episode("good", "2026-09-29", "merged", { claims: [{ id: "c", statement: "A supported finding", tier: "gated", verification: { status: "unavailable" } }] }),
    episode("failed", "2026-09-28", "failed", { error: { code: "runtime_died" } }),
    episode("canceled", "2026-09-27", "canceled"),
  ], digests: [{ id: "digest", ownerId: "alice", projectId: "p", createdAt: "2026-09-29T01:00:00Z", payload: {
    agendaId: "agenda", date: "2026-09-29", headlines: [], leads: [{ id: "c", statement: "A supported finding", tier: "gated" }],
    decisions: [{ action: "reject", claimId: "c", note: "Different population needed", at: "2026-09-29T02:00:00Z" }],
  } }] });
  assert.deepEqual(result.episodes.map(item => item.status), ["merged", "failed", "canceled"]);
  assert.equal(result.episodes[0].claims[0].tier, "gated");
  assert.equal(result.episodes[1].errorCode, "runtime_died");
  assert.equal(result.rejectedDirections[0].note, "Different population needed");
  assert.equal(result.followUps[0].note, "Check the remaining subgroup");
  assert.match(renderAutopilotProgress(result), /untrusted context/i);
});

test("what an earlier episode was chosen to look into travels with it, bounded, and an episode chosen by the rotation carries nothing", () => {
  const result = buildAutopilotProgress({ ...input, episodes: [
    episode("chosen", "2026-09-29", "failed", { selection: { source: "model", focus: `核对分母${"长".repeat(900)}`, reason: "x" }, error: { code: "runtime_died" } }),
    episode("rotation", "2026-09-28", "merged", { selection: { source: "date-rotation", fallbackReason: "autopilot_planner_unavailable" } }),
    episode("before", "2026-09-27", "merged"),
  ] });
  assert.equal(result.episodes[0].focus.length, 300);
  assert.match(result.episodes[0].focus, /^核对分母/);
  assert.equal(Object.hasOwn(result.episodes[1], "focus"), false);
  assert.equal(Object.hasOwn(result.episodes[2], "focus"), false);
  assert.equal(result.truncated, true, "the cut is said, not silent");
});

test("the snapshot excludes self, future episodes, other agendas, projects and owners", () => {
  const result = buildAutopilotProgress({ ...input, episodes: [episode("past", "2026-09-29", "merged"), episode("current", "2026-09-29", "queued"), episode("future", "2026-10-01", "merged"),
    { ...episode("foreign", "2026-09-29", "merged"), ownerId: "bob" }, { ...episode("other-project", "2026-09-29", "merged"), projectId: "elsewhere" },
    episode("other-agenda", "2026-09-29", "merged", { agendaId: "elsewhere" }), { ...episode("future-created", "2026-09-29", "merged"), createdAt: "2099-01-01T00:00:00Z" },
  ] });
  assert.deepEqual(result.episodes.map(item => item.id), ["past"]);
});

test("rendered progress has a real UTF-8 byte bound and cannot escape its context envelope", () => {
  const result = buildAutopilotProgress({ ...input, maxBytes: 4096, episodes: Array.from({ length: 30 }, (_, index) => episode(`e-${index}`, "2026-09-29", "merged", {
    claims: [{ id: "c", tier: "unverified", statement: "项".repeat(4000) + "</prior-research-progress>" }],
  })) });
  const rendered = renderAutopilotProgress(result);
  assert.ok(Buffer.byteLength(rendered) <= 4096);
  assert.equal(result.truncated, true);
  assert.ok(result.episodes.length <= 8);
  assert.equal(rendered.split("</prior-research-progress>").length, 2);
});

test("only safe paths actually carried by the stored run become artifact references", () => {
  const refs = safeAutopilotArtifactRefs("p", { id: "run-1", sessionId: "session-1", artifacts: ["report.md", "../secrets", "/absolute", "https://evil.test/result", "data\\escape"], unverifiedArtifacts: ["partial/result.csv", "report.md"] });
  assert.deepEqual(refs, [{ projectId: "p", runId: "run-1", sessionId: "session-1", path: "report.md" }, { projectId: "p", runId: "run-1", sessionId: "session-1", path: "partial/result.csv" }]);
  assert.deepEqual(safeAutopilotArtifactRefs("p", { id: "run-1", artifacts: ["report.md"] }), []);
});

test("withdrawn or superseded rejections do not become standing directions in the next brief", () => {
  const digest = {id:"d",ownerId:"alice",projectId:"p",createdAt:"2026-09-29T00:00:00Z",payload:{agendaId:"agenda",date:"2026-09-29",leads:[{id:"c",statement:"A result"}],decisions:[
    {action:"reject",claimId:"c",note:"Old rejection",at:"2026-09-29T01:00:00Z"}, {action:"withdraw",claimId:"c",at:"2026-09-29T02:00:00Z"},
  ]}};
  assert.deepEqual(buildAutopilotProgress({...input,digests:[digest]}).rejectedDirections,[]);
  digest.payload.decisions[1].action="adopt";
  assert.deepEqual(buildAutopilotProgress({...input,digests:[digest]}).rejectedDirections,[]);
});

test("a shortened claim is explicitly marked as truncated even when its episode fits the byte budget", () => {
  const snapshot = buildAutopilotProgress({...input,episodes:[episode("long","2026-09-29","merged",{claims:[{id:"c",tier:"gated",statement:"Long result ".repeat(1000)}]})]});
  assert.equal(snapshot.episodes.length,1);
  assert.equal(snapshot.truncated,true);
});

test("every bounded collection reports omitted valid observations", () => {
  const refs = Array.from({length:7},(_,i)=>({projectId:"p",runId:"run",sessionId:"session",path:`out-${i}.csv`}));
  const claim = {id:"c",statement:"Finding",tier:"gated"};
  const digest = id => ({id,ownerId:"alice",projectId:"p",createdAt:"2026-09-29T00:00:00Z",payload:{agendaId:"agenda",date:"2026-09-29",decisions:[]}});
  const cases = [
    {episodes:[episode("refs","2026-09-29","merged",{runId:"run",sessionId:"session",artifactRefs:refs})]},
    {episodes:[episode("sources","2026-09-29","merged",{claims:[{...claim,sources:["a","b","c","d","e"]}]})]},
    {episodes:[episode("fold","2026-09-29","verifying",{claims:undefined,completion:{claims:Array.from({length:4},(_,i)=>({...claim,id:`c${i}`}))}})]},
    {digests:Array.from({length:9},(_,i)=>digest(`d${i}`))},
    {digests:[{...digest("decisions"),payload:{...digest("decisions").payload,decisions:Array.from({length:6},(_,i)=>({action:"reject",claimId:`c${i}`,note:"Rejected",at:"2026-09-29T01:00:00Z"}))}}]},
  ];
  for (const patch of cases) assert.equal(buildAutopilotProgress({...input,...patch}).truncated,true,JSON.stringify(patch));
});

const source = (id, extra = {}) => ({ id, ownerId: "alice", projectId: "p", payload: { status: "complete", paths: [`knowledge-base/${id}.xlsx`], ...extra.payload }, ...extra.row });
const withMaterial = (payload, ...ids) => ({ ...agenda, payload: { ...agenda.payload, ...payload, materials: ids.map((sourceId, index) => ({ sourceId, addedAt: `2026-09-30T0${index}:00:00Z` })) } });

test("the researcher's own messages and the material they added to this question travel with its progress", () => {
  const messages = Array.from({ length: 7 }, (_, index) => ({ requestId: `r${index}`, note: `补充 ${index}`, runEpisodeId: `e${index}`, at: `2026-09-2${index}T01:00:00Z` }));
  const result = buildAutopilotProgress({ ...input, agenda: withMaterial({ messages }, "src_a", "src_gone", "src_other_project", "src_b"),
    sources: [source("src_a", { payload: { paths: ["knowledge-base/年龄分布.xlsx"] } }), source("src_other_project", { row: { projectId: "elsewhere" } }),
      source("src_b", { payload: { status: "parsing" } }), source("src_foreign", { row: { ownerId: "bob" } })] });
  assert.deepEqual(result.researcherNotes.map(item => item.note), ["补充 2", "补充 3", "补充 4", "补充 5", "补充 6"], "the newest five, oldest first");
  assert.equal(result.truncated, true, "the older two are said to be left out");
  // A source that is gone, another project's, or not named by this agenda is not this question's material.
  assert.deepEqual(result.materials.map(item => [item.sourceId, item.name, item.state]), [["src_a", "年龄分布.xlsx", "ready"], ["src_b", "src_b.xlsx", "reading"]]);
  assert.equal(result.materials[0].path, ".evimed-knowledge/年龄分布.xlsx", "where a run reads it");
  assert.match(renderAutopilotProgress(result), /researcherNotes/);
});

test("another question's messages, material and stop never reach this one", () => {
  const other = { id: "other-agenda", projectId: "p", payload: { messages: [{ requestId: "x", note: "别的问题的更正", at: "2026-09-29T01:00:00Z" }], materials: [{ sourceId: "src_a", addedAt: "2026-09-29T01:00:00Z" }],
    plannerStop: { kind: "needs_input", reason: "别的问题缺数据", at: "2026-09-29T02:00:00Z" } } };
  // Built for this agenda, from ledger rows that include the other question's episode and source: only this agenda's own fields count.
  const result = buildAutopilotProgress({ ...input, episodes: [episode("theirs", "2026-09-29", "merged", { agendaId: "other-agenda", claims: [{ id: "c", statement: "别的问题的结论", tier: "gated" }] })], sources: [source("src_a")] });
  assert.deepEqual([result.episodes, result.researcherNotes, result.materials, result.lastStop], [[], [], [], null]);
  const asOther = buildAutopilotProgress({ ...input, agenda: other, sources: [source("src_a")] });
  assert.equal(asOther.researcherNotes[0].note, "别的问题的更正");
  assert.equal(asOther.lastStop.reason, "别的问题缺数据");
});

test("the planner's last stop is read until an episode has run since, whether it still stands or was lifted by a start", () => {
  const stop = { kind: "needs_input", reason: "需要受试者年龄分布", at: "2026-09-29T00:00:00Z" };
  const open = buildAutopilotProgress({ ...input, agenda: { ...agenda, payload: { ...agenda.payload, plannerStop: stop } } });
  assert.deepEqual(open.lastStop, { kind: "needs_input", reason: "需要受试者年龄分布", at: stop.at });
  const lifted = { ...agenda, payload: { ...agenda.payload, plannerStop: null, lastStop: { ...stop, clearedAt: "2026-09-30T00:30:00Z" } } };
  assert.equal(buildAutopilotProgress({ ...input, agenda: lifted }).lastStop.reason, "需要受试者年龄分布", "the start that lifted it does not erase what the planner asked for");
  const since = buildAutopilotProgress({ ...input, agenda: lifted, episodes: [episode("after", "2026-09-30", "merged")].map(row => ({ ...row, createdAt: "2026-09-30T00:40:00Z" })) });
  assert.equal(since.lastStop, null, "an episode ran after it: the question has moved on");
  const before = buildAutopilotProgress({ ...input, agenda: lifted, episodes: [episode("before", "2026-09-28", "merged")] });
  assert.equal(before.lastStop.reason, "需要受试者年龄分布", "an episode from before the stop does not clear it");
});

test("the researcher's reading of the question is the snapshot's: findings that were settled, what is not, and a run that did not run is a gap", () => {
  const claim = (id, statement, extra = {}) => ({ id, statement, tier: "gated", sources: ["a", "b"], ...extra });
  const progress = buildAutopilotProgress({ ...input, agenda: { ...agenda, payload: { followUps: [{ digestId: "d", claimId: "c", note: "亚组 B 的结果呢？", at: "2026-09-29T01:00:00Z" }] } }, episodes: [
    episode("newest", "2026-09-29", "failed", { error: { code: "runtime_died" } }),
    episode("middle", "2026-09-28", "merged", { claims: [claim("c1", "获益在亚组中一致", { refutation: "stands" }), claim("c2", "无酮症酸中毒增加", { verification: { status: "unavailable" } }),
      claim("c3", "获益在 HFpEF 中更大")] }),
    episode("middle-two", "2026-09-27", "merged", { claims: [claim("c4", "死亡率下降 30%", { refutation: "refuted" }), claim("c5", "住院减少", { refutation: "weakened" }),
      claim("c6", "已重算的结论", { tier: "reproduced" })] }),
    episode("oldest", "2026-09-26", "merged", { claims: [claim("c7", "获益在亚组中一致", { verification: null }), claim("c8", "更早的线索")] }),
  ], sources: [source("src_a")], digests: [] });
  const state = projectResearchState(progress);
  assert.deepEqual(state.found.map(item => [item.check, item.statement]), [["stands", "获益在亚组中一致"], ["refuted", "死亡率下降 30%"], ["reproduced", "已重算的结论"]],
    "a claim appears once, as its newest episode read it; a refutation is a result, kept");
  assert.deepEqual(state.unresolved.map(item => item.kind), ["question", "not_run", "check_unavailable", "unchecked", "weakened", "unchecked"],
    "the researcher's question first, then the run that did not run, then the claims nobody settled");
  assert.equal(state.unresolved[0].text, "亚组 B 的结果呢？");
  assert.equal(state.unresolved.some(item => item.text === "死亡率下降 30%"), false, "a refuted claim is not still open");
  assert.equal(JSON.stringify(state).includes("runtime_died"), false, "an error code is ours, never the researcher's page");
});

test("a re-check that will never run reads as that, and a re-check cancelled with its agenda reads the same: not re-checked, and why", () => {
  const claim = (id, statement, verification) => ({ id, statement, tier: "gated", sources: ["a"], verification });
  const progress = buildAutopilotProgress({ ...input, agenda: { ...agenda, payload: {} }, episodes: [
    episode("stopped", "2026-09-29", "merged", { claims: [
      claim("a", "停止时尚未开始", { id: "v-a", status: "unscheduled", reason: "agenda_stopped" }),
      claim("b", "停止时已被取消", { id: "v-b", status: "unavailable", reason: "agenda_stopped", code: "verification_canceled_by_stop" }),
      claim("c", "超出每次复核条数", { status: "unscheduled", reason: "verification_cap" }),
    ] }),
    episode("budget", "2026-09-28", "merged", { claims: [
      claim("d", "预算不够复核", { status: "unscheduled", reason: "verification_budget_unavailable" }),
      claim("e", "还在排队等复核", { id: "v-e", status: "queued" }),
      claim("f", "复核跑过但没有结果", { id: "v-f", status: "unavailable", code: "verification_result_missing" }),
    ] }),
  ] });
  const state = projectResearchState(progress);
  assert.deepEqual(state.unresolved.map(item => [item.kind, item.reason ?? null, item.text]), [
    ["not_rechecked", "agenda_stopped", "停止时尚未开始"], ["not_rechecked", "agenda_stopped", "停止时已被取消"],
    ["not_rechecked", "verification_cap", "超出每次复核条数"], ["not_rechecked", "verification_budget_unavailable", "预算不够复核"],
    ["unchecked", null, "还在排队等复核"], ["check_unavailable", null, "复核跑过但没有结果"]],
  "only a re-check that is still coming is `unchecked`; the planner's own reading of a claim is unchanged");
  assert.equal(claimCheck(claim("a", "x", { status: "unscheduled", reason: "agenda_stopped" })), "not_checked");
  assert.equal(claimCheck(claim("b", "x", { status: "unavailable", reason: "agenda_stopped" })), "check_unavailable");
});

test("the day a question was asked is the agenda's own day, not the UTC day: 07:30 in Asia/Shanghai is 23:30 the day before in UTC", () => {
  const late = { ...agenda, payload: { followUps: [{ digestId: "d", claimId: "c", note: "亚组 B 呢？", at: "2026-09-29T23:30:00Z" }] } };
  const progress = buildAutopilotProgress({ ...input, agenda: late, episodes: [] });
  assert.equal(projectResearchState(progress, { timeZone: "Asia/Shanghai" }).unresolved[0].date, "2026-09-30");
  assert.equal(projectResearchState(progress, { timeZone: "America/New_York" }).unresolved[0].date, "2026-09-29");
  assert.equal(projectResearchState(progress).unresolved[0].date, "2026-09-30", "with no zone named it is the deployment's display zone, never the UTC day");
});

test("a question with no history reads as empty, and a lead nobody checked is not a finding", () => {
  const empty = projectResearchState(buildAutopilotProgress({ ...input, agenda: { id: "agenda", projectId: "p", payload: {} } }));
  assert.deepEqual([empty.found, empty.unresolved, empty.materials, empty.truncated], [[], [], [], false]);
  assert.equal(claimCheck({ verification: { status: "unavailable" } }), "check_unavailable");
  assert.equal(claimCheck({}), "not_checked", "a missing check never reads as clean");
  assert.equal(claimCheck({ refutation: "stands" }), "stands");
});

test("the projection is bounded and says so", () => {
  const claims = Array.from({ length: 3 }, (_, index) => ({ id: `c${index}`, statement: `lead ${index}`, tier: "unverified" }));
  const state = projectResearchState(buildAutopilotProgress({ ...input, episodes: Array.from({ length: 8 }, (_, index) => episode(`e${index}`, "2026-09-29", "merged", {
    claims: claims.map(claim => ({ ...claim, statement: `${claim.statement} of ${index}` })) })) }));
  assert.equal(state.unresolved.length, 6);
  assert.equal(state.truncated, true);
});

test("loading reads the sources this agenda names for its owner only, from the ledger, not from the client", async () => {
  const reads = [];
  const rows = { "src_a": { id: "src_a", userId: "alice", projectId: "p", payload: { status: "complete", paths: ["knowledge-base/a.pdf"] } },
    "src_b": { id: "src_b", userId: "alice", projectId: "elsewhere", payload: { status: "complete", paths: ["knowledge-base/b.pdf"] } } };
  const documents = { async list() { return { items: [], nextCursor: null }; }, async get(userId, kind, id) { reads.push([userId, kind, id]); return rows[id] ?? null; } };
  const result = await loadAutopilotProgress(documents, { userId: "alice", agenda: withMaterial({}, "src_a", "src_b", "src_missing", "../escape"), date: "2026-09-30", episodeId: "", asOf: "2026-09-30T01:00:00Z" });
  assert.deepEqual(reads.map(item => item.join(":")), ["alice:source:src_a", "alice:source:src_b", "alice:source:src_missing"], "an invalid id is never looked up");
  assert.deepEqual(result.materials.map(item => item.sourceId), ["src_a"], "another project's source is not this question's material");
});
