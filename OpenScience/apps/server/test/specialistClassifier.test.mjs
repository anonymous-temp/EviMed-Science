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

test("gives the model room to answer after it finishes reasoning", async () => {
  const fetchImpl = fetchReturning(JSON.stringify({ agentId: "meta-analysis", confidence: 0.9 }));
  const classifier = new SpecialistClassifier(baseConfig(), { fetchImpl });
  await classifier.classify("请开展一项荟萃分析", agents);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.ok(body.max_tokens >= 1_000, `max_tokens was ${body.max_tokens}; a reasoning model needs room to answer`);
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

  // An HTTP failure is a decline too, and names its status.
  const broken = {};
  await new SpecialistClassifier(baseConfig(), { fetchImpl: fetchReturning("", { ok: false }) })
    .classify("请开展一项荟萃分析", agents, broken);
  assert.match(String(broken.failure), /^http_/);
});
