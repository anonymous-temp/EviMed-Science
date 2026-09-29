import assert from "node:assert/strict";
import test from "node:test";
import { buildAutopilotProgress, renderAutopilotProgress, safeAutopilotArtifactRefs } from "../src/autopilotProgress.mjs";

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
