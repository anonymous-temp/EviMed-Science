import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgentRegistry } from "../src/agentRegistry.mjs";
import { routeOpenDomainSpecialist } from "../src/specialistRouting.mjs";


const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/skills/evimed",
);

test("open-domain research questions deterministically route to every registered specialty", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  const cases = new Map([
    ["分析奥希替尼的 FAERS 药物警戒信号", "adr-analysis"],
    ["对 GLP-1 肥胖研究做 CiteSpace 文献计量分析", "bibliometric-analysis"],
    ["综合评价达格列净治疗慢性肾病的临床价值", "comprehensive-drug-evaluation"],
    ["为院内目录做候选药品遴选评分", "drug-selection"],
    ["用孟德尔随机化分析 BMI 对冠心病的因果作用", "mendelian-randomization"],
    ["开展降压药对卒中结局的 meta 分析", "meta-analysis"],
    ["评估某药超说明书用于儿童感染的证据", "off-label-analysis"],
    ["请对我上传的临床试验论文做同行评审", "peer-review"],
    ["为 ICU 抗菌药精准给药设计科研选题", "research-topic-selection"],
    ["我手上这份住院数据集能支撑哪些研究课题", "dataset-research-scoping"],
    ["胸口突然发闷发紧，是心绞痛还是胃病？请结合速效救心丸生成一份证据报告", "clinical-evidence-synthesis"],
  ]);
  for (const [query, expected] of cases) {
    assert.equal(routeOpenDomainSpecialist(query, agents)?.agentId, expected, query);
  }
});

test("the heavy clinical report pipeline only engages on explicit report intent", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  // Explicit report / deep-synthesis requests route to the clinical gate —
  // including for high-risk medicines carried by routingEntities.
  assert.equal(
    routeOpenDomainSpecialist("请评估速效救心丸的临床证据并出一份报告", agents)?.agentId,
    "clinical-evidence-synthesis",
  );
  assert.equal(
    routeOpenDomainSpecialist("Suxiao Jiuxin Wan evidence report", agents)?.agentId,
    "clinical-evidence-synthesis",
  );
  assert.equal(
    routeOpenDomainSpecialist("冠心病二级预防的循证用药报告", agents)?.agentId,
    "clinical-evidence-synthesis",
  );
});

test("asking for a report routes to the report line whichever verb carries it", async () => {
  // The production prompt that exposed this: "给我写出所有的分析结果和报告".
  // 写出 was not among the verbs the pattern listed, so a request for a report
  // was answered as a chat message with no file produced at all.
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  const asked = [
    "请把阿立哌唑血药浓度的证据整理好，并给我写出所有的分析结果和报告",
    "请输出一份阿立哌唑血药浓度的分析报告",
    "帮我形成关于抗精神病药 TDM 的综述",
    "完成一份回顾性研究的可行性报告",
  ];
  for (const query of asked) {
    assert.equal(
      routeOpenDomainSpecialist(query, agents)?.agentId,
      "clinical-evidence-synthesis",
      `should route to the report line: ${query}`,
    );
  }
});

test("a question that starts from the researcher's own data reaches the scoping line", async () => {
  // The production prompt that motivated the skill. It went to
  // clinical-evidence-synthesis, which synthesises literature and never profiles
  // a file, so the five-table extract it was handed had no bearing on the answer.
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  const scoping = [
    "请你基于上传的数据集，来分析能做哪些科学性研究……并给我写出所有的分析结果和报告",
    "我手上有一份住院数据，能做什么研究？",
    "这份数据集能支撑哪些课题",
    "评估我上传的数据集的研究可行性",
    "profile my uploaded dataset and tell me what research it can support",
    // The object is a model rather than a 研究, which the enumeration missed
    // entirely: only the LLM fallback reached it.
    "这份住院 TDM 数据集能不能支撑一个个体化用药的预测模型？",
    "用我上传的数据集建一个剂量预测模型可行吗",
    "assess the feasibility of a dose prediction model on my uploaded dataset",
    // 科研选题 is research-topic-selection's own trigger, but a researcher who
    // says it while holding data wants the topic analysis grounded in that data.
    "基于我上传的这份住院数据集做一次完整的科研选题分析，判断它能支撑哪些课题",
  ];
  for (const query of scoping) {
    assert.equal(
      routeOpenDomainSpecialist(query, agents)?.agentId,
      "dataset-research-scoping",
      `should route to the scoping line: ${query}`,
    );
  }

  // Both halves are required, so neither a dataset alone nor a feasibility
  // question alone diverts a request that belongs elsewhere.
  assert.equal(
    routeOpenDomainSpecialist("对我的数据集做 meta 分析", agents)?.agentId,
    "meta-analysis",
    "meta analysis keeps its own line even when a dataset is named",
  );
  assert.equal(
    routeOpenDomainSpecialist("完成一份回顾性研究的可行性报告", agents)?.agentId,
    "clinical-evidence-synthesis",
    "a feasibility report with no dataset in hand is not scoping",
  );
  assert.equal(
    routeOpenDomainSpecialist("为 ICU 抗菌药精准给药设计科研选题", agents)?.agentId,
    "research-topic-selection",
    "direction-first topic selection with no data in hand is unaffected",
  );
  assert.equal(
    routeOpenDomainSpecialist("请输出一份阿立哌唑血药浓度的分析报告", agents)?.agentId,
    "clinical-evidence-synthesis",
    "a clinical report request is unaffected",
  );
});

test("plain clinical questions stay on the open-domain answer line", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  // No explicit report intent: analysis/efficacy questions — including ones
  // about high-risk medicines — are answered directly by the open-domain
  // answer agent, whose skill carries the same safety framing. The heavy
  // clinical gate is reserved for explicit report requests.
  assert.equal(routeOpenDomainSpecialist("速效救心丸疗效证据分析", agents), null);
  assert.equal(routeOpenDomainSpecialist("分析急性胸痛的鉴别诊断思路", agents), null);
  assert.equal(routeOpenDomainSpecialist("二甲双胍的临床疗效研究进展如何", agents), null);
});

test("generic conversation stays in the open-domain agent", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  assert.equal(routeOpenDomainSpecialist("帮我把这一句话润色得更自然", agents), null);
  // A bare medicine mention without an evidence/analysis intent is not a
  // research request and stays open-domain, exactly as before this change.
  assert.equal(routeOpenDomainSpecialist("速效救心丸一次吃几粒", agents), null);
});

test("a pharmacovigilance report reaches the ADR specialist however it is phrased", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  for (const text of [
    "请出具一份阿托伐他汀横纹肌溶解的药物安全性信号分析报告，基于 openFDA 计算 ROR 与 PRR",
    "帮我做不良事件信号监测",
    "run a disproportionality analysis on this drug",
  ]) {
    assert.equal(routeOpenDomainSpecialist(text, agents)?.agentId, "adr-analysis", text);
  }
  // A plain safety question is still a conversation, not a signal-analysis package.
  assert.equal(routeOpenDomainSpecialist("二甲双胍的安全性怎么样？", agents), null);
});
