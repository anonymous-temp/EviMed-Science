// End-to-end routing probe: run the exact user prompt through the same two
// stages the server uses — the deterministic regex router first, then the LLM
// classifier when it misses — and report which agent the turn would land on.
//
// The point is to test the pair, not either half. The regex is an enumeration
// and will always be incomplete; what has to hold is that a miss is caught.
import { readFileSync } from "node:fs";
import { loadAgentRegistry } from "../../OpenScience/apps/server/src/agentRegistry.mjs";
import { routeOpenDomainSpecialist } from "../../OpenScience/apps/server/src/specialistRouting.mjs";
import { SpecialistClassifier } from "../../OpenScience/apps/server/src/specialistClassifier.mjs";

const OPEN_DOMAIN_ANSWER_AGENT_ID = "open-domain-answer";
const packageRoot = new URL("../../OpenScience/runtime/skills/evimed", import.meta.url).pathname;
const keyFile = new URL("../../.evimed-local/secrets/deepseek.api-key", import.meta.url).pathname;

const config = {
  llmRoutingEnabled: true,
  llmRoutingConfidenceThreshold: 0.75,
  deepseekProviderEnabled: true,
  deepseekApiKey: readFileSync(keyFile, "utf8").trim(),
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: process.env.OPEN_SCIENCE_DEEPSEEK_MODEL ?? "deepseek-v4-flash",
  production: true,
  modelGatewayTimeoutMs: 60_000,
};

const registry = await loadAgentRegistry({ packageDirs: [packageRoot] });
const routable = registry.list().filter((agent) => agent.id !== OPEN_DOMAIN_ANSWER_AGENT_ID);
const classifier = new SpecialistClassifier(config, {});

const prompts = process.argv.slice(2).map((file) => [file, readFileSync(file, "utf8").trim()]);

for (const [file, prompt] of prompts) {
  console.log("=".repeat(78));
  console.log(file);
  console.log("  提问前 120 字:", prompt.replace(/\s+/g, " ").slice(0, 120));

  const deterministic = routeOpenDomainSpecialist(prompt, routable);
  console.log(`  ① 正则路由: ${deterministic ? `${deterministic.agentId}（${deterministic.reason}）` : "未命中"}`);

  let final = deterministic;
  if (!final) {
    const classified = await classifier.classify(prompt, routable);
    console.log(`  ② 模型兜底: ${classified ? `${classified.agentId}（${classified.reason}）` : `未给出专项${classifier.lastFailure ? `（失败原因: ${classifier.lastFailure}）` : "（判定为 none）"}`}`);
    final = classified;
  } else {
    console.log("  ② 模型兜底: 未调用（正则已命中）");
  }

  const landed = final?.agentId ?? OPEN_DOMAIN_ANSWER_AGENT_ID;
  const produces = landed === OPEN_DOMAIN_ANSWER_AGENT_ID ? "聊天回复，无文件产物" : "报告/分析包，有文件产物";
  console.log(`  → 最终落到: ${landed}    产出形态: ${produces}`);
}
