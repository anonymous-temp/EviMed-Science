import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgentRegistry } from "../src/agentRegistry.mjs";
import {
  classifierFailureReason,
  namedSpecialistIds,
  routeOpenDomain,
  routeSafetyMedicine,
  routeSlashCommand,
} from "../src/specialistRouting.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const registry = await loadAgentRegistry({
  packageDirs: [path.join(root, "runtime/skills/evimed")],
  capabilityDirs: [path.join(root, "capabilities")],
});
const agents = registry.list().filter((agent) => agent.id !== "open-domain-answer");
const { cases } = JSON.parse(await readFile(path.join(root, "evals/routing/cases.json"), "utf8"));

/** A classifier that answers with whatever it was told to, and counts what it was asked. @param {string | Error | null} verdict */
function classifier(verdict) {
  const asked = [];
  return {
    asked,
    async classify(/** @type {string} */ query, /** @type {any[]} */ candidates, /** @type {any} */ trace) {
      asked.push(query);
      if (verdict instanceof Error) throw verdict;
      if (verdict === "none") { trace.verdict = "none"; return null; }
      if (verdict === null) { trace.failure = "timeout"; return null; }
      const agent = candidates.find((candidate) => candidate.id === verdict);
      return agent ? { agentId: agent.id, agentVersion: agent.version, runtimeAgent: agent.runtimeAgent, reason: "llm:0.91", confidence: 0.91 } : null;
    },
  };
}

// The probes of the general-agent review (GA14, GA15, GA03) and the baseline wordings (G05, G10, G12, G16, G17) were rerun in
// every state the old router could be in: the model answered none, the model could not answer, and no classifier at all. Each
// one used to route to a medical pipeline in at least one of them. None may route to a specialist now, in any.
test("ordinary work reaches no specialist, whatever state the classifier is in", async () => {
  const ordinary = cases.filter((item) => [item.expect].flat().includes("none"));
  assert.ok(ordinary.length >= 40, `read ${ordinary.length} cases`);
  for (const item of ordinary) {
    for (const [state, model] of [["answered none", classifier("none")], ["timed out", classifier(null)], ["threw", classifier(new Error("boom"))], ["absent", null]]) {
      const trace = {};
      const routed = await routeOpenDomain({ query: item.message, agents, classifier: model, trace });
      assert.equal(routed.specialist, null, `${item.id} (${state}) went to ${routed.specialist?.agentId}: ${item.message}`);
      assert.equal(routed.decidedBy, "default");
    }
  }
});

test("a capability id inside the request is a word of it: the model is asked, and its answer is final", () => {
  const wording = {
    "这篇 meta-analysis 的结论是什么？一句话总结": ["meta-analysis"],
    "Can you peer-review my pull request description?": ["peer-review"],
    "Write a statistical-analysis script in Python for my A/B test": ["statistical-analysis"],
    "帮我把 manuscript-support 这个词翻译成中文": ["manuscript-support"],
    // A paper's own title is the name of a work and not a word of the request.
    "《A meta-analysis of remote work productivity》这篇讲了什么": [],
    "把这段话翻成英文": [],
  };
  for (const [query, ids] of Object.entries(wording)) assert.deepEqual(namedSpecialistIds(query, agents), ids, query);
});

test("the model's answer is final, and it is asked first", async () => {
  for (const [query, id] of [
    ["Can you peer-review my pull request description?", "peer-review"],
    ["分析一下这份数据 sales.xlsx，告诉我哪个地区卖得最好", "dataset-research-scoping"],
    ["帮我写一份消息队列选型报告", "clinical-evidence-synthesis"],
  ]) {
    // The model that claims it routes it (a commission is the model's to recognise)...
    const claimed = await routeOpenDomain({ query, agents, classifier: classifier(id) });
    assert.equal(claimed.specialist?.agentId, id);
    assert.equal(claimed.decidedBy, "model");
    assert.equal(claimed.modelConsulted, true);
    // ...and with the model's none there is no rule left to overrule it.
    assert.equal((await routeOpenDomain({ query, agents, classifier: classifier("none") })).specialist, null);
  }
  // The rules that used to correct a model's none are gone with the net: FAERS vocabulary included.
  assert.equal((await routeOpenDomain({ query: "分析奥希替尼的 FAERS 药物警戒信号", agents, classifier: classifier("none") })).specialist, null);
  // A request is classified once, and a request that a structured choice names is never put to the model.
  const model = classifier("none");
  await routeOpenDomain({ query: "把这段话翻成英文", agents, classifier: model });
  assert.equal(model.asked.length, 1);
});

test("what used to be the net no longer takes a request when the classifier is absent or broken", async () => {
  // Each of these was routed by a vocabulary rule: verb + field, the field's own word, data + 分析一下, a clinical word + 报告.
  for (const query of [
    "开展降压药对卒中结局的 meta 分析",
    "帮我做不良事件信号监测",
    "对 GLP-1 肥胖研究做 CiteSpace 文献计量分析",
    "请对我上传的临床试验论文做同行评审",
    "我手上有一份住院数据，能做什么研究？",
    "冠心病二级预防的循证用药报告",
    "请输出一份阿立哌唑血药浓度的分析报告",
    "完成一份回顾性研究的可行性报告",
    "速效救心丸疗效证据分析",
  ]) {
    for (const model of [null, classifier(null), classifier("none")]) {
      assert.equal((await routeOpenDomain({ query, agents, classifier: model })).specialist, null, query);
    }
  }
});

test("a leading slash command is a structured choice: it routes by name and the model is not asked", async () => {
  const model = classifier("none");
  const routed = await routeOpenDomain({ query: "/meta-analysis 把这些试验合并成一个效应量", agents, classifier: model });
  assert.equal(routed.specialist?.agentId, "meta-analysis");
  assert.equal(routed.specialist?.reason, "command:meta-analysis");
  assert.match(routed.specialist?.reason, /^[a-z][a-z0-9_.:-]{0,63}$/);
  assert.equal(routed.decidedBy, "named");
  assert.equal(routed.modelConsulted, false);
  assert.equal(model.asked.length, 0);
  assert.equal(routeSlashCommand("  /peer-review", agents)?.agentId, "peer-review");
  // Not a command: an id mid-sentence, a longer word, a path, an id that is no capability, the answer line.
  for (const query of ["please /meta-analysis this", "/meta-analysis-x", "/etc/meta-analysis", "/unknown-thing hello", "/open-domain-answer hello", "meta-analysis", ""]) {
    assert.equal(routeSlashCommand(query, agents), null, query);
  }
});

// A high-risk medicine named in clinical-safety-rules.json — a closed vocabulary the pharmacists own — together with an
// explicit request for a report reaches the clinical gate whatever the model said or whether it answered at all. It is
// the only rule left under the model.
test("the one rule that remains is the pharmacists' medicine list together with a request for a report", async () => {
  const medicine = "请就速效救心丸的疗效与安全性做一份循证证据综述报告。";
  const refused = await routeOpenDomain({ query: medicine, agents, classifier: classifier("none") });
  assert.equal(refused.specialist?.agentId, "clinical-evidence-synthesis");
  assert.equal(refused.specialist?.reason, "matched:safety-medicine");
  assert.equal(refused.decidedBy, "rules");
  // Not answered: the ledger says the model never ran, not that the rule overruled it.
  const silent = await routeOpenDomain({ query: medicine, agents, classifier: classifier(null) });
  assert.equal(silent.specialist?.agentId, "clinical-evidence-synthesis");
  assert.match(silent.specialist?.reason ?? "", /^matched:safety-medicine:classifier:timeout$/);
  assert.match(silent.specialist?.reason ?? "", /^[a-z][a-z0-9_.:-]{0,63}$/);
  assert.equal((await routeOpenDomain({ query: medicine, agents, classifier: null })).specialist?.agentId, "clinical-evidence-synthesis");
  // A model that names a specialist is not overruled by it.
  assert.equal((await routeOpenDomain({ query: medicine, agents, classifier: classifier("adr-analysis") })).specialist?.agentId, "adr-analysis");
  // Both halves are needed: the medicine alone is a question, a report alone is not about it, and a medicine off the list is not on it.
  for (const query of ["速效救心丸一次吃几粒", "速效救心丸疗效证据分析", "这篇论文说速效救心丸能长期服用，是真的吗？", "速效救心丸长期吃安全吗",
    "请就某种保健品的口碑做一份综述报告。", "学术论文一般怎么组织结构？"]) {
    assert.equal(routeSafetyMedicine(query, agents), null, query);
  }
  // A commissioned paper is a commissioned document.
  for (const query of [
    "速效救心丸连续用药三个月及以上的有效性与安全性证据评价。交付：一篇面向临床医师与药师的中文学术论文。",
    "Suxiao Jiuxin Wan evidence report",
    "请评估速效救心丸的临床证据并出一份报告",
    "胸口发闷，请结合速效救心丸生成一份临床证据报告",
  ]) {
    assert.equal(routeSafetyMedicine(query, agents)?.agentId, "clinical-evidence-synthesis", query);
  }
});

test("a classifier that throws is a failure named in the trace, never an exception", async () => {
  const trace = {};
  const routed = await routeOpenDomain({ query: "把这段话翻成英文", agents, classifier: classifier(Object.assign(new Error("boom"), { code: "model_gateway_upstream_error" })), trace });
  assert.equal(routed.specialist, null);
  assert.equal(trace.failure, "error_model_gateway_upstream_error");
});

test("classifier failure attribution remains a valid bounded AgentRun reason", () => {
  for (const base of ["matched:safety-medicine", "unrouted:open-domain"]) {
    const reason = classifierFailureReason(base, "empty_content");
    assert.match(reason, /^[a-z][a-z0-9_.:-]{0,63}$/);
    assert.match(reason, /:classifier:empty_content$/);
  }
});

test("the routing eval cases are well formed: every expectation is none or a specialist the catalog offers", () => {
  const ids = new Set(agents.map((agent) => agent.id));
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, "case ids are unique");
  for (const item of cases) {
    for (const accepted of [item.expect].flat()) assert.ok(accepted === "none" || ids.has(accepted), `${item.id} expects ${accepted}`);
    assert.ok(typeof item.message === "string" && item.message.trim(), item.id);
  }
  // Ordinary work and commissions are both there, and the review's baseline wordings are in.
  for (const id of ["ga14-01", "ga15-02", "ga03-01", "g05", "g10", "g12", "g16", "g17a", "g17b", "m04", "meta-named", "pv-1", "slash-1"]) {
    assert.ok(cases.some((item) => item.id === id), id);
  }
  assert.ok(cases.filter((item) => ![item.expect].flat().includes("none")).length >= 20);
});
