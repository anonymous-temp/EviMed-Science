import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_INTENT_PURPOSE, ChannelIntentClassifier, verifiedIntent } from "../src/channels/intent.mjs";
import { createJudgeService } from "../src/judgeService.mjs";
import { buildJudgeRequest, judgePromptFingerprint } from "../src/judgeSites.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-key", deepseekModel: "deepseek-flash", modelGatewayTimeoutMs: 5_000 };
const projects = [{ id: "default", name: "我的研究" }, { id: "p-onc", name: "肿瘤免疫" }, { id: "p-dm", name: "糖尿病" }];

test("Jev project selection is still checked against account projects", async () => {
  const classifier = new ChannelIntentClassifier({}, { judgeService: { judge: async () => ({
    outcome: "settled", value: { switch_to: "another-account", has_request: false, continues_running_task: true },
  }) } });
  assert.deepEqual(await classifier.classify({ userId: "u", projectId: "default", text: "切换项目", projects }),
    { switchTo: null, hasRequest: true, continuesRunningTask: false, source: "judge" });
});

test("Jev that does not settle hands the message to the original classifier, which decides as it did before Jev (JEV-5)", async () => {
  // Measured 2026-10-10 on 100 scenarios: 33 were not settled, and answering them with the default intent (stay here, a new request)
  // left the site at 85 right of 100 against the original classifier's 89; handing them on lifts it to 92. Jev's own guess still
  // never moves the chat: only a settled answer does, and everything else is the original classifier's, as before Jev.
  const unsettled = [
    { outcome: "escalated", code: "judge_uncertain", value: null },
    { outcome: "fallback", code: "judge_timeout", value: null },
    { outcome: "fallback", code: "judge_provider_failure", value: null },
    { outcome: "fallback", code: "judge_circuit_open", value: null },
    { outcome: "fallback", code: "judge_budget_exceeded", value: null },
    { outcome: "fallback", code: "judge_background_busy", value: null },
    { outcome: "fallback", code: "judge_disabled", value: null },
    // Settled, but not a verdict the code can use: dropped, not softened, and the original classifier asked.
    { outcome: "settled", value: { switch_to: 3, has_request: "yes", continues_running_task: false } },
  ];
  for (const decision of unsettled) {
    const fake = model({ switch_to: "p-onc", has_request: false, continues_running_task: true });
    const classifier = new ChannelIntentClassifier(config, { callModel: fake.callModel, judgeService: { judge: async () => decision } });
    const result = await classifier.classify({ userId: "u", projectId: "default", text: "再看看", projects, runningTask: { question: "研究问题" } });
    assert.deepEqual(result, { switchTo: "p-onc", hasRequest: false, continuesRunningTask: true, source: "model" }, `${decision.outcome} ${decision.code ?? ""}`);
    assert.equal(fake.calls.length, 1, "the original classifier was asked once");
  }
  // A judge that throws decided nothing either.
  const fake = model({ switch_to: null, has_request: true, continues_running_task: false });
  const throwing = new ChannelIntentClassifier(config, { callModel: fake.callModel, judgeService: { judge: async () => { throw new Error("boom"); } } });
  assert.equal((await throwing.classify({ userId: "u", projectId: "default", text: "你好", projects })).source, "model");
  assert.equal(fake.calls.length, 1);
  // And when the original classifier cannot answer either, the one safe reading stands: stay here, a new request.
  const down = new ChannelIntentClassifier({ ...config, deepseekApiKey: "" }, { callModel: fake.callModel, judgeService: { judge: async () => ({ outcome: "escalated", code: "judge_uncertain", value: null }) } });
  assert.deepEqual(await down.classify({ userId: "u", projectId: "default", text: "换到肿瘤免疫", projects }),
    { switchTo: null, hasRequest: true, continuesRunningTask: false, source: "fallback", failure: "model_unavailable" });
});

test("a Jev that is slow costs a person waiting no more than the online timeout before the original classifier answers (JEV-5)", async () => {
  const message = "换到肿瘤免疫项目";
  const input = { message, currentProjectId: "default", projects, currentTask: null };
  const { questions } = buildJudgeRequest("J2", input);
  const siteConfig = { reviewJevEnabled: true, typesafeApiKey: "test-not-secret", reviewJevModel: "jev-1.13.0", jevOnlineTimeoutMs: 100,
    jevSites: { J2: { calibration: "calibrated", threshold: 0.8, promptFingerprint: judgePromptFingerprint("J2", questions, 0.8, "jev-1.13.0") } } };
  let asked = 0;
  // A provider that never answers until it is cut off.
  const hanging = createJudgeService({ config: siteConfig, callImpl: (_deps, call) => new Promise((_, reject) => {
    asked += 1;
    call.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }) });
  const fake = model({ switch_to: "p-onc", has_request: false, continues_running_task: false });
  const classifier = new ChannelIntentClassifier(config, { callModel: fake.callModel, judgeService: hanging });
  const started = Date.now();
  const intent = await classifier.classify({ userId: "u", projectId: "default", text: message, projects });
  const waited = Date.now() - started;
  assert.deepEqual(intent, { switchTo: "p-onc", hasRequest: false, continuesRunningTask: false, source: "model" });
  assert.equal(asked, 1);
  assert.ok(waited < 1500, `waited ${waited} ms for a 100 ms online timeout`);
  assert.equal(fake.calls.length, 1, "the original classifier answered");
  // Three slow answers in a row open the circuit: the next message does not wait for Jev at all.
  for (let i = 0; i < 2; i += 1) await classifier.classify({ userId: "u", projectId: "default", text: message, projects });
  const before = asked;
  const quick = Date.now();
  await classifier.classify({ userId: "u", projectId: "default", text: message, projects });
  assert.equal(asked, before, "an open circuit asks Jev nothing");
  assert.ok(Date.now() - quick < 50, "and does not wait");
  await hanging.close();
});

test("the J2 off switch restores the incumbent classifier", async () => {
  const fake = model({ switch_to: "p-onc", has_request: false, continues_running_task: false });
  const classifier = new ChannelIntentClassifier(config, { callModel: fake.callModel,
    judgeService: { judge: async () => ({ outcome: "fallback", code: "judge_disabled" }) } });
  assert.equal((await classifier.classify({ userId: "u", projectId: "default", text: "换到肿瘤免疫", projects })).switchTo, "p-onc");
  assert.equal(fake.calls.length, 1);
});

/** A model that answers with `content`, and remembers what it was asked. */
function model(content) {
  const calls = [];
  return {
    calls,
    callModel: async (deps, call) => {
      calls.push(call);
      return { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] };
    },
  };
}

test("one project and nothing running leaves nothing to decide, and no model is called", async () => {
  const fake = model({ switch_to: null, has_request: true, continues_running_task: false });
  const classifier = new ChannelIntentClassifier(config, { callModel: fake.callModel });
  const intent = await classifier.classify({ userId: "u1", projectId: "default", text: "你好", projects: [projects[0]] });
  assert.deepEqual(intent, { switchTo: null, hasRequest: true, continuesRunningTask: false, source: "skipped" });
  assert.equal(fake.calls.length, 0);
});

test("the call is a thinking-off JSON classification, metered as channel-intent", async () => {
  const fake = model({ switch_to: "p-onc", has_request: false, continues_running_task: false });
  const classifier = new ChannelIntentClassifier(config, { callModel: fake.callModel });
  const intent = await classifier.classify({ userId: "u1", projectId: "default", text: "换到肿瘤那个项目", projects });
  assert.deepEqual(intent, { switchTo: "p-onc", hasRequest: false, continuesRunningTask: false, source: "model" });
  const [call] = fake.calls;
  assert.equal(call.purpose, CHANNEL_INTENT_PURPOSE);
  assert.equal(call.purpose, "channel-intent");
  assert.equal(call.userId, "u1");
  assert.equal(call.projectId, "default");
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.equal(call.body.temperature, 0);
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  const asked = JSON.parse(call.body.messages[1].content);
  assert.deepEqual(asked.projects.map((project) => project.id), ["default", "p-onc", "p-dm"]);
  assert.equal(asked.running_task, null);
});

test("code re-verifies what it can: a real project other than the current one, and the three fields", () => {
  const context = { projectIds: projects.map((project) => project.id), currentProjectId: "default", running: false };
  assert.equal(verifiedIntent({ switch_to: "p-unknown", has_request: false, continues_running_task: false }, context).switchTo, null);
  assert.equal(verifiedIntent({ switch_to: "default", has_request: false, continues_running_task: false }, context).switchTo, null);
  // "Nothing to answer" only when the chat moved: a greeting still gets a reply.
  assert.equal(verifiedIntent({ switch_to: null, has_request: false, continues_running_task: false }, context).hasRequest, true);
  // A supplement only when something is running.
  assert.equal(verifiedIntent({ switch_to: null, has_request: true, continues_running_task: true }, context).continuesRunningTask, false);
  assert.equal(verifiedIntent({ switch_to: null, has_request: true, continues_running_task: true }, { ...context, running: true })
    .continuesRunningTask, true);
  assert.equal(verifiedIntent({ switch_to: 3, has_request: true, continues_running_task: false }, context), null);
  assert.equal(verifiedIntent({ switch_to: null, has_request: "yes", continues_running_task: false }, context), null);
});

test("every failure is the same safe reading: stay here, treat it as a new request", async () => {
  const expected = { switchTo: null, hasRequest: true, continuesRunningTask: false, source: "fallback" };
  const cases = [
    ["model_unavailable", new ChannelIntentClassifier({ ...config, deepseekApiKey: "" }, { callModel: model({}).callModel })],
    ["verdict_missing", new ChannelIntentClassifier(config, { callModel: model("我觉得应该换项目").callModel })],
    ["verdict_invalid", new ChannelIntentClassifier(config, { callModel: model({ switch_to: "p-onc", has_request: 1, continues_running_task: 0 }).callModel })],
    ["timeout", new ChannelIntentClassifier(config, { callModel: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } })],
    ["usage_budget_exceeded", new ChannelIntentClassifier(config, { callModel: async () => { throw Object.assign(new Error("cap"), { code: "usage_budget_exceeded" }); } })],
  ];
  for (const [failure, classifier] of cases) {
    const intent = await classifier.classify({ userId: "u1", projectId: "default", text: "换到肿瘤项目", projects,
      runningTask: { question: "二甲双胍证据报告" } });
    assert.deepEqual(intent, { ...expected, failure }, failure);
  }
});

test("a running task is offered to the model, which may call the message a supplement", async () => {
  const fake = model({ switch_to: null, has_request: true, continues_running_task: true });
  const classifier = new ChannelIntentClassifier(config, { callModel: fake.callModel });
  const intent = await classifier.classify({ userId: "u1", projectId: "default", text: "对了，再加上老年人群", projects: [projects[0]],
    runningTask: { question: "二甲双胍与乳酸酸中毒的证据报告" } });
  assert.equal(intent.continuesRunningTask, true);
  assert.equal(JSON.parse(fake.calls[0].body.messages[1].content).running_task.question, "二甲双胍与乳酸酸中毒的证据报告");
});
