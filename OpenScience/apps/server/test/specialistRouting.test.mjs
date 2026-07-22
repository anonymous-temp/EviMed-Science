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
    ["胸口突然发闷发紧，是心绞痛还是胃病？结合速效救心丸形成学术分析", "clinical-evidence-synthesis"],
  ]);
  for (const [query, expected] of cases) {
    assert.equal(routeOpenDomainSpecialist(query, agents)?.agentId, expected, query);
  }
});

test("article-type words under negation do not hijack a clinical evidence question", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  const route = routeOpenDomainSpecialist(
    "分析急性胸痛和速效救心丸，题目里不要写综述、系统评价或 meta 分析",
    agents,
  );
  assert.equal(route?.agentId, "clinical-evidence-synthesis");
});

test("generic conversation stays in the open-domain agent", async () => {
  const agents = (await loadAgentRegistry({ packageDirs: [packageRoot] })).list();
  assert.equal(routeOpenDomainSpecialist("帮我把这一句话润色得更自然", agents), null);
});
