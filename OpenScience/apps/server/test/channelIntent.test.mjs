import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_INTENT_PURPOSE, ChannelIntentClassifier, verifiedIntent } from "../src/channels/intent.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-key", deepseekModel: "deepseek-flash", modelGatewayTimeoutMs: 5_000 };
const projects = [{ id: "default", name: "我的研究" }, { id: "p-onc", name: "肿瘤免疫" }, { id: "p-dm", name: "糖尿病" }];

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
