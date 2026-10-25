import assert from "node:assert/strict";
import test from "node:test";
import { createAutopilotRunScope, episodeContextBlock, episodePlacementCounts, episodeVisibleText } from "../src/autopilotEpisodeScope.mjs";

const EPISODE = "episode-0123456789abcdef0123456789abcdef";

test("the first message of an execution is the researcher's own words: the instruction, or the follow-up note", () => {
  const brief = "Run the literature-sentinel proactive research episode for agenda \"X\".\nEpisode ID: e1.";
  assert.equal(episodeVisibleText({ trigger: "scheduled", instruction: "每周检索 SGLT2 抑制剂的新证据。" }, brief), "每周检索 SGLT2 抑制剂的新证据。");
  assert.equal(episodeVisibleText({ trigger: "manual", instruction: "每周检索 SGLT2 抑制剂的新证据。" }, brief), "每周检索 SGLT2 抑制剂的新证据。");
  assert.equal(episodeVisibleText({ trigger: "follow-up", instruction: "每周检索。", followUpNote: "只看随机对照试验。" }, brief), "只看随机对照试验。",
    "a follow-up shows what they wrote this time; the original instruction is in the brief");
  // An execution that predates the split has no instruction to show; it shows what it always showed.
  assert.equal(episodeVisibleText({ trigger: "scheduled" }, brief), brief);
  assert.equal(episodeVisibleText({ trigger: "follow-up", instruction: "x", followUpNote: "   " }, brief), brief);
  assert.equal(episodeVisibleText(undefined, brief), brief);
});

test("every execution carries the brief in its run context; only a bounded one carries the episode tag and its signed scope", () => {
  const brief = "Run the literature-sentinel proactive research episode.\nEpisode ID: e1.";
  assert.equal(episodeContextBlock({ brief, episodeId: EPISODE, marker: null }), `\n\n<evimed-autopilot-brief>\n${brief}\n</evimed-autopilot-brief>`,
    "the gateway refuses the tag and the marker in an interactive runtime");
  const block = episodeContextBlock({ brief, episodeId: EPISODE, marker: "<evimed-budget-scope>a.b</evimed-budget-scope>" });
  assert.equal(block, `\n\n<evimed-autopilot-brief>\n${brief}\n</evimed-autopilot-brief>\n<evimed-autopilot-episode>${EPISODE}</evimed-autopilot-episode>\n<evimed-budget-scope>a.b</evimed-budget-scope>`);
});

function scopeFixture({ ledger, episodes = {}, users = ["u1"], listCalls = [] } = {}) {
  const store = {
    userById: async (id) => (users.includes(id) ? { id } : null),
    requireProject: async (user, id) => ({ userId: user.id, id }),
  };
  const agentRuns = { list: async (project) => { listCalls.push(project.id); return ledger; } };
  const service = { getEpisode: async (userId, id) => { const found = episodes[id]; if (!found) throw Object.assign(new Error("missing"), { status: 404, code: "autopilot_episode_not_found" }); return found; } };
  return createAutopilotRunScope({ store, agentRuns, service });
}

const interactiveEpisode = { id: EPISODE, projectId: "p1", payload: { interactive: true, runLimitCny: 6.5 } };
const episodeRun = { id: "run_a", effectiveRouteReason: "autopilot:literature-sentinel", dispatchId: `${EPISODE}-a2` };

test("an interactive execution's run is scoped to its episode and the episode's limit", async () => {
  const scope = scopeFixture({ ledger: [episodeRun], episodes: { [EPISODE]: interactiveEpisode } });
  assert.deepEqual(await scope({ userId: "u1", projectId: "p1", runId: "run_a" }), { usageRunId: EPISODE, runLimit: 6.5 },
    "booked under the episode (the id the task's own caps and the episode's cost read), against the episode's limit");
});

test("an ordinary run, and a bounded execution's run, are not scoped here, and the first answer is remembered", async () => {
  const listCalls = [];
  const scope = scopeFixture({ listCalls, ledger: [
    { id: "run_chat", effectiveRouteReason: "choice:answer", dispatchId: "dispatch-1" },
    { id: "run_bounded", effectiveRouteReason: "autopilot:literature-sentinel", dispatchId: EPISODE },
  ], episodes: { [EPISODE]: { id: EPISODE, projectId: "p1", payload: { interactive: false, runLimitCny: 6.5 } } } });
  assert.equal(await scope({ userId: "u1", projectId: "p1", runId: "run_chat" }), null);
  assert.equal(await scope({ userId: "u1", projectId: "p1", runId: "run_chat" }), null);
  assert.deepEqual(listCalls, ["p1"], "an ordinary run's route never changes: it is asked about once");
  // A dead bounded run still listed as running is no reason to refuse the researcher's own call.
  assert.equal(await scope({ userId: "u1", projectId: "p1", runId: "run_bounded" }), null);
  await scope({ userId: "u1", projectId: "p1", runId: "run_bounded" });
  assert.equal(listCalls.length, 3, "but a bounded execution is asked again each time: its mark is written just before its prompt");
});

test("a scheduled execution whose cap cannot be read is refused, never run without one", async () => {
  const request = { userId: "u1", projectId: "p1", runId: "run_a" };
  const unreadableBefore = episodePlacementCounts().unreadable;
  // Its episode is not there.
  await assert.rejects(() => scopeFixture({ ledger: [episodeRun], episodes: {} })(request), { code: "autopilot_episode_not_found" });
  // The episode says it is interactive and records no limit.
  for (const runLimitCny of [undefined, 0, -1, Number.NaN]) {
    await assert.rejects(() => scopeFixture({ ledger: [episodeRun], episodes: { [EPISODE]: { id: EPISODE, projectId: "p1", payload: { interactive: true, runLimitCny } } } })(request),
      { code: "autopilot_episode_state_conflict" }, String(runLimitCny));
  }
  // It names no episode, or another project's.
  await assert.rejects(() => scopeFixture({ ledger: [{ ...episodeRun, dispatchId: "dispatch-by-hand" }] })(request), { code: "autopilot_episode_state_conflict" });
  await assert.rejects(() => scopeFixture({ ledger: [episodeRun], episodes: { [EPISODE]: { ...interactiveEpisode, projectId: "elsewhere" } } })(request), { code: "autopilot_episode_state_conflict" });
  // The account is gone: the call is not the episode's to make.
  await assert.rejects(() => scopeFixture({ ledger: [episodeRun], episodes: { [EPISODE]: interactiveEpisode }, users: [] })(request), { code: "autopilot_account_unavailable" });
  // A run that is not in the ledger (deleted between attribution and here) is nobody's, and is not an execution.
  assert.equal(await scopeFixture({ ledger: [], episodes: {} })(request), null);
  assert.equal(episodePlacementCounts().unreadable - unreadableBefore, 8, "each refusal is counted (open_science_autopilot_interactive_scope_unreadable_total)");
});
