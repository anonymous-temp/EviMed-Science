// "New literature" for every agenda comes from the frontier (evidence-flywheel F04, 2026-10-05): the planner is shown the feed items that
// match the agenda's entities since its last episode, for a researcher's agenda as for the platform's, so it chooses `literature-sentinel`
// or `evidence-update` from what the feed already holds instead of having each agenda crawl it again. With the feed off it is shown none.
import assert from "node:assert/strict";
import test from "node:test";
import { AutopilotService } from "../src/autopilotService.mjs";
import { PLANNER_FRONTIER_ITEMS_MAX, buildPlannerContext, plannerFrontierItems, plannerInstructions } from "../src/autopilotNextAction.mjs";

const match = (n, over = {}) => ({ id: String(n), publicId: `item${String(n).padStart(10, "0")}`, titleRaw: `Trial ${n} of apixaban`, titleZh: n % 2 ? `阿哌沙班试验 ${n}` : null,
  timelineAt: `2026-10-0${(n % 5) + 1}T08:00:00.000Z`, evidenceType: "rct", safetyAlert: false, summaryZh: "全文摘要不应进入决策", ...over });
const agenda = (entityKeys) => ({ id: "agenda-1", projectId: "p", payload: { title: "Q", prompt: "Q", topics: ["Q"], taskTypes: ["literature-sentinel", "evidence-update"], entityKeys,
  maxEpisodeCny: 8, dailyBudgetCny: 20, weeklyBudgetCny: 80, outcomes: [] } });

/** A service over doubles, the planner recording what it was shown. */
function serviceWith(entityVocabulary, now = new Date("2026-10-05T08:00:00Z")) {
  const decisions = [];
  const planner = { decide: async (input) => { decisions.push(input); return { action: "run", taskType: "literature-sentinel", focus: "f", reason: "r", model: "deepseek-flash" }; } };
  const service = new AutopilotService({ documents: {}, jobs: {}, planner, entityVocabulary, now: () => now });
  return { service, decisions };
}
const ask = (service, subject, progress = { episodes: [] }) => service.chooseNextAction("u", subject, { episodeId: "e1", date: "2026-10-05", trigger: "scheduled", progress,
  eligible: ["literature-sentinel", "evidence-update"], reduced: false, manual: false, envelopeCny: 8 });

test("the feed's items are projected to an id, a title, a date, an evidence type and a safety flag, bounded, with none of their text", () => {
  const shown = plannerFrontierItems([match(1, { safetyAlert: true }), match(2), ...Array.from({ length: 12 }, (_, index) => match(index + 3))]);
  assert.equal(shown.length, PLANNER_FRONTIER_ITEMS_MAX);
  assert.deepEqual(shown[0], { id: "item0000000001", title: "阿哌沙班试验 1", date: "2026-10-02", evidenceType: "rct", safetyAlert: true });
  assert.equal(shown[1].title, "Trial 2 of apixaban", "the Chinese title when there is one, the original otherwise");
  assert.equal(shown[1].safetyAlert, undefined);
  assert.ok(!JSON.stringify(shown).includes("全文摘要"), "no text of the item reaches the decision");
  assert.equal(plannerFrontierItems([match(1, { titleZh: "x".repeat(400) })])[0].title.length, 160);
  assert.deepEqual(plannerFrontierItems(undefined), []);
});

test("the decision is shown the items, and the line that says what to do with them is in the prompt only when there are items", () => {
  const base = { agenda: agenda(["drug:apixaban"]), progress: { episodes: [] }, eligible: ["literature-sentinel"], date: "2026-10-05", trigger: "scheduled", reducedPriority: false, stopAllowed: false };
  const withItems = buildPlannerContext({ ...base, frontier: plannerFrontierItems([match(1)]) });
  assert.equal(withItems.frontierItems.length, 1);
  assert.match(plannerInstructions(withItems), /frontierItems are what the platform's screened feed/);
  const without = buildPlannerContext(base);
  assert.equal(Object.hasOwn(without, "frontierItems"), false, "a field with nothing in it is left out of the data");
  assert.doesNotMatch(plannerInstructions(without), /frontierItems/, "and out of the prompt, which stays what it was");
});

test("a researcher's agenda is shown the feed's items that match its entities, since its last episode", async () => {
  const queries = [];
  const { service, decisions } = serviceWith({ frontierItemsMatching: async (query) => { queries.push(query); return [match(1), match(2)]; } });
  await ask(service, agenda(["drug:apixaban", "disease:atrial fibrillation"]), { episodes: [{ date: "2026-10-02", taskType: "evidence-update", status: "merged", claims: [] }] });
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].context.frontierItems.map((item) => item.id), ["item0000000001", "item0000000002"]);
  assert.deepEqual(queries[0].entityKeys, ["drug:apixaban", "disease:atrial fibrillation"], "matched by the agenda's own entity keys");
  assert.equal(new Date(queries[0].since).toISOString(), "2026-10-02T00:00:00.000Z", "the period is the time since the last episode");
  assert.equal(queries[0].limit, 8);
});

test("without an episode the period is two weeks, and never longer than the feed keeps", async () => {
  const queries = [];
  const { service } = serviceWith({ frontierItemsMatching: async (query) => { queries.push(query); return []; } });
  await ask(service, agenda(["drug:apixaban"]));
  assert.equal(new Date(queries[0].since).toISOString(), "2026-09-21T08:00:00.000Z");
  await ask(service, agenda(["drug:apixaban"]), { episodes: [{ date: "2026-06-01", taskType: "evidence-update", status: "merged", claims: [] }] });
  assert.equal(new Date(queries[1].since).toISOString(), "2026-09-05T08:00:00.000Z", "thirty days at most");
});

test("with the frontier off the decision is shown none, as it was before the feed existed", async () => {
  // The vocabulary answers [] when the module is off (entityVocabulary.mjs); an absent vocabulary or an agenda with no keys asks nothing.
  for (const [what, vocabulary, subject] of [
    ["the frontier off", { frontierItemsMatching: async () => [] }, agenda(["drug:apixaban"])],
    ["no vocabulary", null, agenda(["drug:apixaban"])],
    ["no entity keys", { frontierItemsMatching: async () => { throw new Error("must not be asked"); } }, agenda([])],
    ["an untagged agenda", { frontierItemsMatching: async () => { throw new Error("must not be asked"); } }, agenda(undefined)],
    ["a lookup that fails", { frontierItemsMatching: async () => { throw new Error("database down"); } }, agenda(["drug:apixaban"])],
  ]) {
    const { service, decisions } = serviceWith(vocabulary);
    const choice = await ask(service, subject);
    assert.equal(choice.action, "run", `${what}: the research goes on`);
    assert.equal(Object.hasOwn(decisions[0].context, "frontierItems"), false, what);
  }
});
