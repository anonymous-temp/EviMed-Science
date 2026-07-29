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

function fetchReturning(content, { ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
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
