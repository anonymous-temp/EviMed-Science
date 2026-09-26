// What one question would do, asked before it is sent: which line, which
// capability, how long, how much — and that a classifier which is off, broken or
// unsure lands on the quick line instead of on an error.
import assert from "node:assert/strict";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgentRegistry } from "../src/agentRegistry.mjs";
import { runEstimate } from "../src/runRoute.mjs";
import {
  ROUTING_DECIDED_BY,
  ROUTING_DECISION_PATH,
  createRoutingDecisionRoutes,
  decideRouting,
} from "../src/routingDecision.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPromise = loadAgentRegistry({
  packageDirs: [path.resolve(here, "../../../runtime/skills/evimed")],
  capabilityDirs: [path.resolve(here, "../../../capabilities")],
});

/** @returns {Promise<any[]>} the public capability catalogue the dispatch routes over */
async function agents() {
  return (await registryPromise).list();
}

/** A request as the route reads one. @param {string} method @param {string} url @param {{ body?: any }} [options] */
function request(method, url, { body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}

function response() {
  return {
    status: 0, headers: {}, body: "",
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
    end(chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

/** A classifier that answers with whatever it was told to. @param {any} verdict */
function classifierStub(verdict, { available = true } = {}) {
  const calls = [];
  return {
    calls,
    available,
    async classify(question, candidates, trace) {
      calls.push(question);
      if (verdict instanceof Error) throw verdict;
      if (verdict === "none") {
        if (trace) trace.verdict = "none";
        return null;
      }
      if (verdict === "declined") {
        if (trace) trace.failure = "timeout";
        return null;
      }
      if (!verdict) return null;
      const agent = candidates.find((candidate) => candidate.id === verdict);
      return agent
        ? { agentId: agent.id, agentVersion: agent.version, runtimeAgent: agent.runtimeAgent, reason: "llm:0.91", confidence: 0.91 }
        : null;
    },
  };
}

/** @param {{ classifier?: any, estimateCredits?: any }} [options] */
function fixture({ classifier = classifierStub(null, { available: false }), estimateCredits = null } = {}) {
  const contexts = [];
  const routes = createRoutingDecisionRoutes({
    config: { maxJsonBytes: 65_536 },
    context: async (req) => {
      contexts.push(req.url);
      return { user: { id: "researcher" }, project: { id: "default", userId: "researcher" } };
    },
    agentRegistry: registryPromise,
    classifier,
    estimateCredits,
  });
  return { routes, contexts, classifier };
}

/** @param {any} body */
async function ask(body, options) {
  const { routes, contexts, classifier } = fixture(options);
  const res = response();
  assert.equal(await routes(request("POST", ROUTING_DECISION_PATH, { body }), res), true);
  assert.equal(res.status, 200);
  return { data: res.json().data, contexts, classifier };
}

test("a plain clinical question is the quick line, and nothing about it is charged or consulted", async () => {
  for (const question of ["速效救心丸长期吃安全吗", "阿托伐他汀的作用机制是什么？", "hello"]) {
    const decision = await decideRouting({ question, agents: await agents(), classifier: null });
    assert.deepEqual(decision, {
      mode: "quick",
      capability: null,
      minutes: null,
      credits: null,
      summary: "快速回答 · 几秒内出结果",
      decidedBy: "default",
      modelConsulted: false,
    }, question);
  }
});

test("naming a capability is an instruction, and it outranks everything else", async () => {
  const decision = await decideRouting({
    question: "请按 dataset-research-scoping 出一份报告",
    agents: await agents(),
    classifier: classifierStub("peer-review"),
  });
  assert.equal(decision.mode, "deep");
  assert.equal(decision.decidedBy, "named");
  assert.equal(decision.capability?.id, "dataset-research-scoping");
  assert.equal(decision.capability?.title, "数据集科研可行性勘查");
  assert.equal(decision.modelConsulted, false, "the model is not asked about a question that named its own capability");
});

test("the model decides, and the regex rules are the net under an absent decision", async () => {
  const catalogue = await agents();
  // The model claims it: `decidedBy` says so and the capability is the model's.
  const byModel = await decideRouting({
    question: "帮我把这批稿件过一遍",
    agents: catalogue,
    classifier: classifierStub("peer-review"),
  });
  assert.equal(byModel.decidedBy, "model");
  assert.equal(byModel.capability?.id, "peer-review");
  assert.equal(byModel.modelConsulted, true);

  // The model declines; the rules still catch a commissioned deliverable.
  const byRules = await decideRouting({
    question: "开展降压药对卒中结局的 meta 分析",
    agents: catalogue,
    classifier: classifierStub("none"),
  });
  assert.equal(byRules.decidedBy, "rules");
  assert.equal(byRules.capability?.id, "meta-analysis");

  // And a clean `none` narrows the net exactly as it does on the dispatch path:
  // after the model has said "no specialist fits", only a medicine on the
  // pharmacists' own safety list still reaches the clinical line.
  const question = "患者胸痛的治疗证据，请写一份报告";
  assert.equal((await decideRouting({ question, agents: catalogue, classifier: null })).capability?.id,
    "clinical-evidence-synthesis", "with no model answer the same question keeps the full net");
  assert.equal((await decideRouting({ question, agents: catalogue, classifier: classifierStub("none") })).mode, "quick");
  // A named high-risk medicine reaches it either way — the property the net exists for.
  const medicine = "速效救心丸的有效性与安全性，请写一份报告";
  for (const classifier of [null, classifierStub("none")]) {
    assert.equal((await decideRouting({ question: medicine, agents: catalogue, classifier })).capability?.id,
      "clinical-evidence-synthesis");
  }
});

test("a classifier that is off, unconfigured, slow or broken fails safe to the quick line", async () => {
  const catalogue = await agents();
  const question = "帮我把这批稿件过一遍";
  for (const classifier of [
    null,
    classifierStub("peer-review", { available: false }),
    classifierStub("declined"),
    classifierStub(Object.assign(new Error("upstream exploded"), { code: "model_gateway_upstream_error" })),
  ]) {
    const decision = await decideRouting({ question, agents: catalogue, classifier });
    assert.equal(decision.mode, "quick", JSON.stringify({ available: classifier?.available }));
    assert.equal(decision.decidedBy, "default");
    assert.equal(decision.summary, "快速回答 · 几秒内出结果");
  }
  // A disabled classifier is not called at all; a broken one is called once.
  const off = classifierStub("peer-review", { available: false });
  await decideRouting({ question, agents: catalogue, classifier: off });
  assert.deepEqual(off.calls, []);
  const broken = classifierStub(new Error("nope"));
  await decideRouting({ question, agents: catalogue, classifier: broken });
  assert.deepEqual(broken.calls, [question]);
});

test("consultModel: false keeps the answer free and deterministic", async () => {
  const classifier = classifierStub("peer-review");
  const decision = await decideRouting({
    question: "帮我把这批稿件过一遍",
    agents: await agents(),
    classifier,
    consultModel: false,
  });
  assert.deepEqual(classifier.calls, []);
  assert.equal(decision.modelConsulted, false);
  assert.equal(decision.mode, "quick");
  // The deterministic half still routes everything the rules can decide.
  const ruled = await decideRouting({
    question: "用孟德尔随机化分析 BMI 对冠心病的因果作用",
    agents: await agents(),
    classifier,
    consultModel: false,
  });
  assert.equal(ruled.capability?.id, "mendelian-randomization");
  assert.deepEqual(classifier.calls, []);
});

test("a deep decision carries the duration the dispatch would record, not a second estimate", async () => {
  const catalogue = await agents();
  const registry = await registryPromise;
  for (const [question, id] of [
    ["开展降压药对卒中结局的 meta 分析", "meta-analysis"],
    ["对 GLP-1 肥胖研究做 CiteSpace 文献计量分析", "bibliometric-analysis"],
  ]) {
    const decision = await decideRouting({ question, agents: catalogue, classifier: null });
    assert.equal(decision.capability?.id, id);
    // The same function the run ledger uses, so the line shown before the send
    // and the one on the run row cannot disagree.
    assert.deepEqual(decision.minutes, runEstimate(registry.get(id)));
  }
  assert.equal(
    (await decideRouting({ question: "对 GLP-1 肥胖研究做 CiteSpace 文献计量分析", agents: catalogue, classifier: null })).summary,
    "会做深度研究 · 文献计量分析 · 约 20–120 分钟",
  );
});

test("credits come from the injected estimator, and its absence costs the caller only the price", async () => {
  const catalogue = await agents();
  const seen = [];
  const withCredits = await decideRouting({
    question: "对 GLP-1 肥胖研究做 CiteSpace 文献计量分析",
    agents: catalogue,
    classifier: null,
    estimateCredits: async (input) => {
      seen.push(input);
      return { min: 80, max: 240 };
    },
  });
  assert.deepEqual(seen, [{ mode: "deep", capabilityId: "bibliometric-analysis", minutes: { min: 20, max: 120 } }]);
  assert.deepEqual(withCredits.credits, { min: 80, max: 240 });
  assert.equal(withCredits.summary, "会做深度研究 · 文献计量分析 · 约 20–120 分钟 · 约 80–240 灵豆");

  // A quick answer is EviMed's own line: its seconds and its price are not ours
  // to quote, so the estimator is never asked about one.
  const quiet = [];
  const quick = await decideRouting({
    question: "阿托伐他汀的作用机制是什么？",
    agents: catalogue,
    classifier: null,
    estimateCredits: (input) => { quiet.push(input); return { min: 1, max: 2 }; },
  });
  assert.deepEqual(quiet, []);
  assert.equal(quick.credits, null);

  // The credits service answers in its own words (`low`/`high`), which the
  // seam reads as it stands so wiring it straight through cannot blank the price.
  const service = await decideRouting({
    question: "对 GLP-1 肥胖研究做 CiteSpace 文献计量分析",
    agents: catalogue,
    classifier: null,
    estimateCredits: async ({ capabilityId }) => ({ capabilityId, unit: "灵豆", low: 46, high: 118, basis: "manifest" }),
  });
  assert.deepEqual(service.credits, { min: 46, max: 118 });
  assert.equal(service.summary, "会做深度研究 · 文献计量分析 · 约 20–120 分钟 · 约 46–118 灵豆");

  // A settlement service that is down costs the reader the price, never the
  // prediction.
  const down = await decideRouting({
    question: "对 GLP-1 肥胖研究做 CiteSpace 文献计量分析",
    agents: catalogue,
    classifier: null,
    estimateCredits: async () => { throw Object.assign(new Error("pool exhausted"), { code: "evimed_credits_unavailable" }); },
  });
  assert.equal(down.mode, "deep");
  assert.equal(down.credits, null);
  assert.equal(down.summary, "会做深度研究 · 文献计量分析 · 约 20–120 分钟");

  // An estimator that answers with something that is not a range is ignored
  // rather than forwarded half-filled.
  for (const answer of [null, undefined, {}, { min: 5 }, { min: 9, max: 2 }, "120"]) {
    const decision = await decideRouting({
      question: "对 GLP-1 肥胖研究做 CiteSpace 文献计量分析",
      agents: catalogue,
      classifier: null,
      estimateCredits: () => answer,
    });
    assert.equal(decision.credits, null, JSON.stringify(answer));
    assert.equal(decision.summary, "会做深度研究 · 文献计量分析 · 约 20–120 分钟");
  }
});

test("the answer line is never offered as a capability to route to", async () => {
  const catalogue = await agents();
  assert.ok(catalogue.some((agent) => agent.id === "open-domain-answer"), "the registry does list it");
  const named = await decideRouting({
    question: "请按 open-domain-answer 回答",
    agents: catalogue,
    classifier: classifierStub("open-domain-answer"),
  });
  assert.equal(named.mode, "quick", "naming the answer line is the quick line, not a deep capability");
  assert.equal(named.capability, null);
});

test("the route answers its own path only, on POST, to a caller the store recognises", async () => {
  const { routes, contexts } = fixture();
  assert.equal(await routes(request("POST", "/api/agent-runs/dispatch"), response()), false);
  assert.equal(await routes(request("POST", `${ROUTING_DECISION_PATH}/extra`), response()), false);
  assert.deepEqual(contexts, [], "a path this factory does not own must not authenticate anybody");
  for (const method of ["GET", "PUT", "DELETE"]) {
    await assert.rejects(routes(request(method, ROUTING_DECISION_PATH), response()), { status: 405, code: "method_not_allowed" });
  }

  const asked = await ask({ question: "开展降压药对卒中结局的 meta 分析" });
  assert.equal(asked.data.mode, "deep");
  assert.equal(asked.data.capability.id, "meta-analysis");
  assert.deepEqual(asked.contexts, [ROUTING_DECISION_PATH]);
});

test("a malformed request is a 400 and not a prediction", async () => {
  const { routes } = fixture();
  for (const body of [{}, { question: "" }, { question: "   " }, { question: 7 }]) {
    await assert.rejects(routes(request("POST", ROUTING_DECISION_PATH, { body }), response()), { status: 400, code: "invalid_payload" });
  }
  await assert.rejects(
    routes(request("POST", ROUTING_DECISION_PATH, { body: { question: "x", mode: "deep" } }), response()),
    { status: 400, code: "invalid_payload", message: /Unknown routing decision field\(s\): mode\./ },
  );
  await assert.rejects(
    routes(request("POST", ROUTING_DECISION_PATH, { body: { question: "x", consultModel: "yes" } }), response()),
    { status: 400, code: "invalid_payload", message: /consultModel must be a boolean\./ },
  );
});

test("over HTTP the classification is charged to the caller's own account and project", async () => {
  const seen = [];
  const classifier = {
    available: true,
    async classify(question, candidates, trace, owner) {
      seen.push(owner);
      return null;
    },
  };
  const { data } = await ask({ question: "帮我把这批稿件过一遍" }, { classifier });
  assert.deepEqual(seen, [{ userId: "researcher", projectId: "default" }]);
  assert.equal(data.mode, "quick");

  // And `consultModel: false` reaches the decision, so nothing is charged.
  const quiet = [];
  await ask({ question: "帮我把这批稿件过一遍", consultModel: false }, {
    classifier: { available: true, async classify(...args) { quiet.push(args); return null; } },
  });
  assert.deepEqual(quiet, []);
});

test("every way the decision can be reached is one the published vocabulary names", async () => {
  const catalogue = await agents();
  const reached = new Set();
  for (const [question, classifier] of [
    ["请按 dataset-research-scoping 出一份报告", null],
    ["帮我把这批稿件过一遍", classifierStub("peer-review")],
    ["开展降压药对卒中结局的 meta 分析", null],
    ["阿托伐他汀的作用机制是什么？", null],
  ]) {
    reached.add((await decideRouting({ question, agents: catalogue, classifier })).decidedBy);
  }
  assert.deepEqual([...reached].sort(), [...ROUTING_DECIDED_BY].sort(), "a decision route nothing names is one no caller can switch on");
});

test("it is advice: no question is refused, however long, odd or empty of intent", async () => {
  const catalogue = await agents();
  for (const question of [
    "？",
    "《… a large-scale meta-analysis of 192 epidemiological studies》这篇讲了什么",
    "x".repeat(20_000),
    "不要做 meta 分析，只要一句话结论",
  ]) {
    const decision = await decideRouting({ question, agents: catalogue, classifier: null });
    assert.ok(["quick", "deep"].includes(decision.mode));
    assert.equal(typeof decision.summary, "string");
    assert.ok(decision.summary.length > 0);
  }
  // A catalogue that failed to load is still an answer, not an exception.
  assert.equal((await decideRouting({ question: "开展 meta 分析", agents: /** @type {any} */ (null), classifier: null })).mode, "quick");
});
