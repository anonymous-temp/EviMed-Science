import assert from "node:assert/strict";
import test from "node:test";
import { SpecialistClassifier } from "../src/specialistClassifier.mjs";

const agents = [
  { id: "adr-analysis", version: "1.2.2", runtimeAgent: "evimed-adr-analysis", title: "ADR", description: "pharmacovigilance signal analysis" },
  { id: "meta-analysis", version: "1.0.0", runtimeAgent: "evimed-meta-analysis", title: "Meta", description: "systematic review and meta-analysis" },
];

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
