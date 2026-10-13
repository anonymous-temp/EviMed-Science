import assert from "node:assert/strict";
import test from "node:test";
import { SpecialistClassifier } from "../src/specialistClassifier.mjs";
import { createJudgeService } from "../src/judgeService.mjs";
import { buildJudgeRequest, judgePromptFingerprint } from "../src/judgeSites.mjs";

const agents = [
  { id: "adr-analysis", version: "1.2.2", runtimeAgent: "evimed-adr-analysis", title: "ADR", description: "pharmacovigilance signal analysis" },
  { id: "meta-analysis", version: "1.0.0", runtimeAgent: "evimed-meta-analysis", title: "Meta", description: "systematic review and meta-analysis" },
];

test("Jev uncertainty leaves the request on the ordinary line without another model", async () => {
  const fetchImpl = fetchReturning('{"agentId":"meta-analysis","confidence":1}');
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl,
    judgeService: { judge: async () => ({ outcome: "escalated", code: "judge_uncertain" }) } });
  assert.equal(await classifier.classify("这篇Meta文章说了什么？", agents), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("Jev explicit none is preserved while outages restore Flash", async () => {
  const fetchImpl = fetchReturning('{"agentId":"meta-analysis","confidence":1}');
  const trace = {};
  const judgeService = { judge: async () => ({ outcome: "settled", value: { agentId: "none" } }) };
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl, judgeService });
  assert.equal(await classifier.classify("Meta分析是什么意思？", agents, trace), null);
  assert.equal(trace.verdict, "none");
  assert.equal(fetchImpl.calls.length, 0);
  judgeService.judge = async () => ({ outcome: "fallback", code: "judge_timeout" });
  assert.equal((await classifier.classify("请做Meta分析", agents))?.agentId, "meta-analysis");
  assert.equal(fetchImpl.calls.length, 1);
});

test("J3 on the online path: an unsure Jev costs the dispatch no model call, a slow one no more than the online timeout before Flash answers, and an open circuit nothing (JEV-4)", async () => {
  const question = "请做Meta分析";
  const capabilities = agents.map((agent) => ({ id: agent.id, title: agent.title, description: agent.description, requiredInputs: [], starterPrompts: [] }));
  const { questions } = buildJudgeRequest("J3", { question, capabilities });
  const siteConfig = { reviewJevEnabled: true, typesafeApiKey: "test-not-secret", reviewJevModel: "jev-1.13.0", jevOnlineTimeoutMs: 100,
    jevSites: { J3: { calibration: "calibrated", threshold: 0.8, promptFingerprint: judgePromptFingerprint("J3", questions, 0.8, "jev-1.13.0") } } };
  /** Jev's answer to the one question, with these probabilities (none, adr-analysis, meta-analysis). */
  const answering = (/** @type {number[]} */ [none, adr, meta]) => async (/** @type {any} */ _deps, /** @type {any} */ call) => ({ model: "jev-1.13.0", cost: 0, answers: { agentId: {
    type: "choice", choice: [["none", none], ["adr-analysis", adr], ["meta-analysis", meta]].sort((a, b) => /** @type {number} */ (b[1]) - /** @type {number} */ (a[1]))[0][0],
    confidence: (3 * Math.max(none, adr, meta) - 1) / 2, probabilities: { none, "adr-analysis": adr, "meta-analysis": meta } } }, questions: call.questions });

  // Sure: Jev routes, and Flash is not asked.
  const sure = createJudgeService({ config: siteConfig, callImpl: answering([0.02, 0.03, 0.95]) });
  const flash = fetchReturning('{"agentId":"adr-analysis","confidence":1}');
  const routed = await new SpecialistClassifier(baseConfig(), { fetchImpl: flash, judgeService: sure }).classify(question, agents);
  assert.deepEqual([routed?.agentId, flash.calls.length], ["meta-analysis", 0]);
  assert.match(routed?.reason ?? "", /^jev:0\.\d\d$/);
  await sure.close();

  // Unsure: the request stays on the ordinary line, with no model call from the dispatch (the plan: an unsure Jev is a classifier with no verdict).
  const unsure = createJudgeService({ config: siteConfig, callImpl: answering([0.4, 0.3, 0.3]) });
  const asked = fetchReturning('{"agentId":"adr-analysis","confidence":1}');
  assert.equal(await new SpecialistClassifier(baseConfig(), { fetchImpl: asked, judgeService: unsure }).classify(question, agents), null);
  assert.equal(asked.calls.length, 0);
  await unsure.close();

  // Slow: a provider that never answers costs the dispatch the online timeout and no more, then Flash answers.
  let sent = 0;
  const hanging = createJudgeService({ config: siteConfig, callImpl: (_deps, call) => new Promise((_, reject) => { sent += 1; call.signal.addEventListener("abort", () => reject(new Error("aborted"))); }) });
  const fallback = fetchReturning('{"agentId":"meta-analysis","confidence":0.9}');
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl: fallback, judgeService: hanging });
  const started = Date.now();
  assert.equal((await classifier.classify(question, agents))?.agentId, "meta-analysis");
  assert.ok(Date.now() - started < 1500, `waited ${Date.now() - started} ms for a 100 ms online timeout`);
  assert.deepEqual([sent, fallback.calls.length], [1, 1]);
  // Three failures in a row open the circuit: the next dispatch asks Jev nothing and waits for nothing.
  for (let i = 0; i < 2; i += 1) await classifier.classify(question, agents);
  const before = sent;
  const quick = Date.now();
  assert.equal((await classifier.classify(question, agents))?.agentId, "meta-analysis");
  assert.equal(sent, before, "an open circuit asks Jev nothing");
  assert.equal(fallback.calls.length, 4, "and Flash answered every one of the four");
  assert.ok(Date.now() - quick < 100);
  await hanging.close();
});

function baseConfig(overrides = {}) {
  return {
    llmRoutingEnabled: true,
    llmRoutingConfidenceThreshold: 0.75,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-test",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-pro",
    production: false,
    modelGatewayTimeoutMs: 30_000,
    ...overrides,
  };
}

function fetchReturning(content, { ok = true, reasoningContent = undefined } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const message = reasoningContent === undefined
      ? { content }
      : { content, reasoning_content: reasoningContent };
    return {
      ok,
      status: ok ? 200 : 503,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message }] }),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("the request the model reads carries the ids it names as a fact, and the instruction does not presume a domain (2026-10-13)", async () => {
  const fetchImpl = fetchReturning('{"agentId":"none","confidence":0.95}');
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl });
  const trace = {};
  assert.equal(await classifier.classify("Can you review my meta-analysis-style pull request? 《A meta-analysis of remote work》", agents, trace), null);
  assert.equal(trace.verdict, "none");
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  const [system, user] = body.messages;
  // A capability id inside the request is handed over as a fact (outside 《》 titles); what it means is the model's to read.
  assert.deepEqual(JSON.parse(user.content).namedInRequest, ["meta-analysis"]);
  assert.match(system.content, /namedInRequest/);
  assert.match(system.content, /A name appearing is not a request for it/);
  // It routes for a general-purpose assistant: ordinary work is none, and a table the user holds is not research scoping by itself.
  assert.doesNotMatch(system.content, /biomedical research request/);
  assert.match(system.content, /general-purpose/);
  assert.match(system.content, /table or a file[^"]*ordinary work/);
  // No names, no list: an empty feature for a request that names nothing.
  await classifier.classify("把这段话翻成英文", agents);
  assert.deepEqual(JSON.parse(JSON.parse(fetchImpl.calls[1].init.body).messages[1].content).namedInRequest, []);
});

test("is unavailable and never calls the model when routing is disabled", async () => {
  const fetchImpl = fetchReturning(JSON.stringify({ agentId: "adr-analysis", confidence: 0.99 }));
  const classifier = new SpecialistClassifier(baseConfig({ llmRoutingEnabled: false }), { fetchImpl });
  assert.equal(classifier.available, false);
  assert.equal(await classifier.classify("分析某药的不良反应信号", agents), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("is unavailable when the DeepSeek provider or key is missing", async () => {
  const noProvider = new SpecialistClassifier(baseConfig({ deepseekProviderEnabled: false }), { fetchImpl: fetchReturning("{}") });
  assert.equal(noProvider.available, false);
  const noKey = new SpecialistClassifier(baseConfig({ deepseekApiKey: "" }), { fetchImpl: fetchReturning("{}") });
  assert.equal(noKey.available, false);
});

test("routes to a valid specialist when confidence meets the threshold", async () => {
  const fetchImpl = fetchReturning(JSON.stringify({ agentId: "meta-analysis", confidence: 0.9 }));
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl });
  const route = await classifier.classify("Pool these trials into an effect estimate", agents);
  assert.equal(route.agentId, "meta-analysis");
  assert.equal(route.agentVersion, "1.0.0");
  assert.equal(route.runtimeAgent, "evimed-meta-analysis");
  assert.equal(route.reason, "llm:0.90");
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/chat\/completions$/);
});

test("declines a low-confidence classification", async () => {
  const classifier = new SpecialistClassifier(baseConfig(), {
    fetchImpl: fetchReturning(JSON.stringify({ agentId: "meta-analysis", confidence: 0.5 })),
  });
  assert.equal(await classifier.classify("maybe a meta-analysis?", agents), null);
});

test("declines when the model returns none or an unknown id", async () => {
  const none = new SpecialistClassifier(baseConfig(), {
    fetchImpl: fetchReturning(JSON.stringify({ agentId: "none", confidence: 0.99 })),
  });
  assert.equal(await none.classify("hello there", agents), null);
  const unknown = new SpecialistClassifier(baseConfig(), {
    fetchImpl: fetchReturning(JSON.stringify({ agentId: "not-a-real-agent", confidence: 0.99 })),
  });
  assert.equal(await unknown.classify("do something", agents), null);
});

test("fails safe to no route on transport error or a non-ok response", async () => {
  const throwing = new SpecialistClassifier(baseConfig(), {
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(await throwing.classify("analyze adverse events", agents), null);
  const rejected = new SpecialistClassifier(baseConfig(), {
    fetchImpl: fetchReturning(JSON.stringify({ agentId: "adr-analysis", confidence: 0.99 }), { ok: false }),
  });
  assert.equal(await rejected.classify("analyze adverse events", agents), null);
});

test("fails safe on malformed model JSON", async () => {
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl: fetchReturning("not json at all") });
  assert.equal(await classifier.classify("analyze adverse events", agents), null);
});

test("recovers the verdict a reasoning model left in reasoning_content", async () => {
  // The production failure, measured against the live API: six of six calls
  // returned an empty content with 900–1000 characters of reasoning, because
  // max_tokens was 200 and the model spent all of it thinking. The fallback
  // that exists to catch what the regex misses was dead, and every miss looked
  // exactly like "no specialist fits".
  const reasoning = [
    "The user uploaded a dataset and asks which studies are feasible.",
    "They ask for a pooled synthesis, so meta-analysis fits.",
    "Final answer: {\"agentId\": \"meta-analysis\", \"confidence\": 0.9}",
  ].join(" ");
  const fetchImpl = fetchReturning("", { reasoningContent: reasoning });
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl });
  const routed = await classifier.classify("基于上传的数据集能做哪些研究，写出报告", agents);
  assert.equal(routed?.agentId, "meta-analysis");
});

test("asks for a verdict without reasoning, deterministically, with room for the verdict", async () => {
  // Thinking was on (the provider's default), so temperature 0 did nothing and
  // the budget raced the reasoning: at 200 tokens six of six classifications
  // came back empty. Thinking off, both V4 tiers write the verdict and nothing
  // else, and the dispatch waits a second or two instead of the reasoning.
  const fetchImpl = fetchReturning(JSON.stringify({ agentId: "meta-analysis", confidence: 0.9 }));
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl });
  await classifier.classify("请开展一项荟萃分析", agents);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.ok(body.max_tokens >= 256, `max_tokens was ${body.max_tokens}; the verdict needs room for a fence around it`);
  assert.equal(body.response_format.type, "json_object");
});

test("a classification has its own deadline, not the gateway's streaming idle time", async () => {
  assert.equal(new SpecialistClassifier(baseConfig()).timeoutMs, 20_000, "unset, twenty seconds");
  assert.equal(new SpecialistClassifier(baseConfig({ llmRoutingTimeoutMs: 7_000, modelGatewayTimeoutMs: 300_000 })).timeoutMs, 7_000);
  // A deadline that fires is a decline named `timeout`, and the dispatch goes on.
  const hanging = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const trace = {};
  const started = Date.now();
  const verdict = await new SpecialistClassifier(baseConfig({ llmRoutingTimeoutMs: 1_000 }), { fetchImpl: hanging })
    .classify("请开展一项荟萃分析", agents, trace);
  assert.equal(verdict, null);
  assert.equal(trace.failure, "timeout");
  assert.ok(Date.now() - started < 5_000, "the classifier gave up at its own deadline");
});

test("a classifier that produced no verdict is distinguishable from one that said none", async () => {
  // Both send the turn to the answer line. Only the first means the fallback
  // is broken, and it used to be unreportable.
  const broken = new SpecialistClassifier(baseConfig(), { fetchImpl: fetchReturning("") });
  assert.equal(await broken.classify("写一份报告", agents), null);
  assert.equal(broken.lastFailure, "empty_content");

  const decided = new SpecialistClassifier(baseConfig(), {
    fetchImpl: fetchReturning(JSON.stringify({ agentId: "none", confidence: 0.9 })),
  });
  decided.lastFailure = undefined;
  assert.equal(await decided.classify("帮我润色一句话", agents), null);
  assert.equal(decided.lastFailure, undefined, "a verdict of none is not a failure");
});

// A classification that never happened and a question with no specialist both
// return null, and the dispatcher wrote the same route reason for both. After a
// 33-run batch that difference is unrecoverable: you cannot tell which runs
// answered on the open-domain line because they belonged there, and which were
// sent there by a timeout on a slow link. S162 was that failure, once already.
test("a decline says why, and a real verdict says nothing", async () => {
  const aborting = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  const trace = {};
  assert.equal(await new SpecialistClassifier(baseConfig(), { fetchImpl: aborting })
    .classify("请开展一项荟萃分析", agents, trace), null);
  assert.equal(trace.failure, "timeout");

  // "No specialist fits" is a verdict, not a failure, and must leave the trace
  // clean — otherwise every open-domain question reads as a broken router.
  const clean = {};
  const saysNone = new SpecialistClassifier(baseConfig(), {
    fetchImpl: fetchReturning(JSON.stringify({ agentId: "none", confidence: 0.9 })),
  });
  assert.equal(await saysNone.classify("今天天气怎么样", agents, clean), null);
  assert.equal(clean.failure, undefined);

  // An HTTP failure is a decline too, and names the provider's own status.
  const broken = {};
  await new SpecialistClassifier(baseConfig(), { fetchImpl: fetchReturning("", { ok: false }) })
    .classify("请开展一项荟萃分析", agents, broken);
  assert.equal(broken.failure, "http_503");
});

// Every classification is a model call on the dispatch path, one per unrouted
// question. It used to reach the provider with its own fetch, outside the usage
// ledger and the account's caps; now it is reserved and settled like every other
// control-plane call, and the ledger can say what routing costs.
test("a classification is charged to the question's account, as routing", async () => {
  const ledgerCalls = [];
  const usageLedger = {
    async reserveModel(input) { ledgerCalls.push(["reserve", input]); return { id: "res_route" }; },
    async settleModel(...args) { ledgerCalls.push(["settle", ...args]); },
    async markUncertain(...args) { ledgerCalls.push(["uncertain", ...args]); },
    async release(...args) { ledgerCalls.push(["release", ...args]); },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return Response.json({
      id: "provider-route",
      choices: [{ message: { content: JSON.stringify({ agentId: "meta-analysis", confidence: 0.9 }) } }],
      usage: { prompt_tokens: 900, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 100, completion_tokens: 20 },
    });
  };
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl, usageLedger });
  const routed = await classifier.classify("请开展一项荟萃分析", agents, {}, { userId: "user-1", projectId: "project-1" });
  assert.equal(routed?.agentId, "meta-analysis");
  assert.equal(calls.length, 1);
  const reserve = ledgerCalls.find(([kind]) => kind === "reserve")?.[1];
  assert.equal(reserve?.purpose, "routing");
  assert.equal(reserve?.userId, "user-1");
  assert.equal(reserve?.projectId, "project-1");
  const settle = ledgerCalls.find(([kind]) => kind === "settle");
  assert.deepEqual(settle?.[3].usage, { cacheHitTokens: 800, cacheMissTokens: 100, completionTokens: 20 });

  // With a ledger and no owner there is no account to charge: the classifier
  // declines rather than spending off the books, and the dispatch goes on.
  const trace = {};
  const unowned = new SpecialistClassifier(baseConfig(), { fetchImpl, usageLedger: {
    ...usageLedger, async reserveModel() { throw Object.assign(new Error("Invalid user."), { code: "usage_payload_invalid" }); },
  } });
  assert.equal(await unowned.classify("请开展一项荟萃分析", agents, trace), null);
  assert.equal(trace.failure, "error_usage_payload_invalid");
  assert.equal(calls.length, 1, "no provider call without an account to charge it to");
});
