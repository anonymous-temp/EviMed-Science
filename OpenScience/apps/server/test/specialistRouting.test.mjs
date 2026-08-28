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

test("a commissioned paper is a commissioned document, and the net catches it", async () => {
  // The regex net exists so that a high-risk medicine asked about in a report
  // request always reaches the clinical gate when the classifier declines or is
  // unavailable. RQ-03's brief is titled
  // 《速效救心丸连续用药三个月及以上的有效性与安全性证据评价》 and its 交付
  // section asks for 「一篇面向临床医师与药师的中文学术论文」. The clinical
  // subject matched; the report intent did not, because the pattern knew 报告
  // and 综述 and not 论文. The net returned null, the classifier then timed out
  // on a slow link, and the request became an open-domain chat answer with no
  // report and no gate — `effectiveRouteReason: "unrouted:open-domain"`.
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  for (const query of [
    "速效救心丸连续用药三个月及以上的有效性与安全性证据评价。交付：一篇面向临床医师与药师的中文学术论文。",
    "胸口突然发闷发紧，请就速效救心丸的证据写一篇学术论文",
    "速效救心丸的证据评价，输出一份论文",
  ]) {
    assert.equal(routeOpenDomainSpecialist(query, agents)?.agentId, "clinical-evidence-synthesis", query);
  }

  // Negative controls. A quantifier is what separates commissioning a paper
  // from talking about one, and the subject requirement still holds.
  for (const query of [
    "这篇论文说速效救心丸能长期服用，是真的吗？",
    "速效救心丸长期吃安全吗",
    "学术论文一般怎么组织结构？",
  ]) {
    assert.notEqual(
      routeOpenDomainSpecialist(query, agents)?.agentId,
      "clinical-evidence-synthesis",
      `must not commission a report: ${query}`,
    );
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
})

test("a dataset in hand outranks the review vocabulary", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  // The final scoping request asked for a mini-review per topic and a
  // literature landscape. Both phrases belong to clinical-evidence-synthesis,
  // which never opens the file, and it took the request away from the one
  // skill that had to read it.
  const withData = [
    "上传的 20260803TDM.xlsx 是住院治疗药物监测数据抽取，请出一份分析报告，每个题目配一个小综述和研究方案",
    "针对我上传的数据集做选题分析，并给出证据综述与文献检索范围",
    "profile the uploaded hospital dataset and give each topic a mini-review of the evidence",
  ];
  for (const query of withData) {
    assert.equal(routeOpenDomainSpecialist(query, agents)?.agentId, "dataset-research-scoping", query);
  }
  // Without a dataset the same review vocabulary still reaches the evidence skill.
  assert.equal(
    routeOpenDomainSpecialist("胸口发闷，请结合速效救心丸生成一份临床证据报告", agents)?.agentId,
    "clinical-evidence-synthesis",
  );
});

// The net fires on the vocabulary a field's own review necessarily uses, and
// that is how six of thirty-three briefs commissioning a clinical evidence
// review ended up in the meta-analysis, pharmacovigilance, off-label and
// dataset-scoping pipelines, each producing a deliverable nobody asked for.
// Every sentence below is lifted from one of those briefs.
test("a review that discusses a specialty is not a request for it", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  const discussing = [
    // Appraising published syntheses, not commissioning one.
    "事件的昼夜分布优先采用大样本前瞻队列、注册登记及其 meta 分析，并说明混杂控制方式",
    "现有网络 meta 分析或其他间接比较在传递性、一致性上表现如何",
    // Asking whether pharmacovigilance evidence exists, not asking for a signal run.
    "有无毒理学研究、不良反应监测记录或可定位的病例报告作为支撑",
    // An enumeration inside a search-scope sentence, where a verb and a
    // specialty term sit either side of a comma.
    "国内外指南索引（含胸痛评估、医疗机构用药与超说明书用药相关规范文件）及临床试验注册库",
    // The methods section of every clinical paper names databases and 资料.
    "中文全文数据库（CNKI、万方等）无法访问，中文文献仅能通过国际数据库的收录部分获得",
    "证据不足时结论须相应降级表述：现有资料只能\"提示\"某种关联",
  ];
  for (const query of discussing) {
    const routed = routeOpenDomainSpecialist(query, agents);
    assert.equal(
      routed?.agentId ?? null,
      null,
      `the net claimed ${routed?.agentId} for a sentence that only discusses the field: ${query}`,
    );
  }
});

test("asking for a specialty's own deliverable still reaches it", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  const commissioning = [
    ["开展降压药对卒中结局的 meta 分析", "meta-analysis"],
    ["帮我做不良事件信号监测", "adr-analysis"],
    ["分析奥希替尼的 FAERS 药物警戒信号", "adr-analysis"],
    ["评估某药超说明书用于儿童感染的证据", "off-label-analysis"],
    ["我上传了一份住院数据，能做哪些科学性研究？", "dataset-research-scoping"],
    ["帮我做一篇论文审稿", "peer-review"],
  ];
  for (const [query, expected] of commissioning) {
    assert.equal(routeOpenDomainSpecialist(query, agents)?.agentId, expected, query);
  }
});
