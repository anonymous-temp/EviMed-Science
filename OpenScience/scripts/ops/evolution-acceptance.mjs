import { recheckEvolutionAcceptanceCandidate } from './evolution-candidate-recheck.mjs';
import { prepareEvolutionConversationSession } from './evolution-conversation-session.mjs';
import { conversationReceipts } from './evolution-conversation-receipts.mjs';
// Explicit, isolated live acceptance. The operator supplies an empty data volume and a test database.
// Provider credentials stay in the control plane. The report contains facts and artifact hashes only.
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createWebApiApp } from "../../apps/server/src/server.mjs";
import { loadConfig } from "../../apps/server/src/config.mjs";
import { createRuntimeController } from "../../apps/server/src/runtimeControllerServer.mjs";
import { RuntimeControllerClient } from "../../apps/server/src/runtimeControllerClient.mjs";
import { createEvolutionConfiguration } from "./evolution-acceptance-config.mjs";
import { runEvolutionDecisionAcceptance } from "./evolution-decision-acceptance.mjs";

const inputFile = process.env.EVIMED_EVOLUTION_ACCEPTANCE_INPUT;
if (!inputFile) throw new Error("EVIMED_EVOLUTION_ACCEPTANCE_INPUT must name an isolated acceptance input file.");
const input = JSON.parse(await fs.readFile(inputFile, "utf8"));
if (!String(input.databaseUrl).includes("evimed_test_evolution") || input.dataDir !== "/acceptance"
  || !String(input.runtimeImage).startsWith("evimed-evolution-acceptance:") || !String(input.network).startsWith("evimed-evolution-acceptance")) throw new Error("Refusing an unscoped acceptance environment.");
await fs.mkdir("/control-state", { recursive: true, mode: 0o700 });
const credentialFile = "/control-state/acceptance-credentials.json";
const generated = { password: randomBytes(32).toString("hex"), modelSecret: randomBytes(32).toString("hex"), workloadSecret: randomBytes(32).toString("hex") };
try { await fs.writeFile(credentialFile, JSON.stringify(generated), { mode: 0o600, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
const credentials = JSON.parse(await fs.readFile(credentialFile, "utf8")), password = credentials.password;
const overrides = createEvolutionConfiguration(input, credentials);
const config = loadConfig(overrides), controller = createRuntimeController(config);
const reportFile = path.join(input.dataDir, "acceptance-report.json");
let report = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceRevision: input.sourceRevision, stages: [], passed: false };
try { report = JSON.parse(await fs.readFile(reportFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const previousExecution = report.executions?.at(-1);
if (previousExecution && report.finishedAt && !previousExecution.finishedAt) Object.assign(previousExecution, { finishedAt: report.finishedAt, passed: report.passed, failure: report.failure ?? null });
report.passed = false; delete report.failure;
report.resumedAt = new Date().toISOString();
report.sourceArtifactHash = input.sourceArtifactHash ?? null;
const resumedStageCount = report.stages.length;
report.executions = [...(report.executions ?? []), { startedAt: report.resumedAt, sourceArtifactHash: report.sourceArtifactHash, resumedStageCount }];
const completed = (stage, methodId) => report.stages.findLast(item => item.stage === stage && (methodId === undefined || item.methodId === methodId));
const save = async () => {
  for (const stage of report.stages.slice(resumedStageCount)) stage.sourceArtifactHash ??= report.sourceArtifactHash;
  await fs.writeFile(path.join(input.dataDir, "acceptance-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
};
let app;
try {
  await controller.listen();
  app = createWebApiApp({ ...overrides, evolutionController: new RuntimeControllerClient(config) });
  await app.listen(8787, "0.0.0.0");
  app.evolution.worker.stop();
  await app.store.bootstrapUserState();
  const ownerId = await app.evolution.service.owner();
  report.stages.push({ stage: "composition", enabled: true, ownerId }); await save();
  if (input.decisions && !completed("real-decision-models")) { report.stages.push({ stage: "real-decision-models", result: await runEvolutionDecisionAcceptance(app) }); await save(); }
  for (const reference of input.methodCalibration ?? []) {
    if (completed("existing-engine-methods", reference.methodId)) continue;
    const evaluation = await app.evolution.worker.perform({ id: `acceptance-existing-${reference.methodId}`, kind: "evolution-evaluate",
      payload: { action: "import-existing-methods", methodId: reference.methodId, reportHash: reference.reportHash } });
    // The ruler has to have scored five published sources. Whether the engine agreed with them is its finding, recorded below, not a condition for the ruler to count.
    if (!evaluation?.payload?.summary?.scored || evaluation.payload.summary.scoredPublishedSources < 5) throw new Error("Existing-engine method calibration lacks five scored published sources.");
    report.stages.push({ stage: "existing-engine-methods", methodId: reference.methodId, result: evaluation.payload.summary }); await save();
  }
  const awaitCapacity = async () => {
    const deadline = Date.now() + config.evolutionEvaluationTimeoutMs;
    while (!(await controller.evolutionAdmissionAvailable()).available) {
      if (Date.now() >= deadline) throw new Error("Acceptance waits for host capacity with one research slot reserved.");
      await delay(15000);
    }
  };
  const buildMethod = async (methodId, demand, metadata = {}) => {
    const previous = completed("hidden-published-cases", methodId);
    if (previous) {
      const tool = await app.evolution.service.get(previous.toolId);
      if (!["active", "alias"].includes(tool?.payload.status) || tool.payload.artifactDigest !== previous.digest) throw new Error("The checkpoint's immutable publication changed.");
      return tool;
    }
    await awaitCapacity();
    let scoutResult = completed("real-scout", methodId)?.result;
    if (!scoutResult || scoutResult.waiting) {
      const lead = await app.evolution.service.addLead({ source: "literature", track: "M", gapCode: "method-missing", method: methodId,
        papers: demand.papers, features: demand, origin: "literature" });
      scoutResult = await app.evolution.worker.perform({ id: `acceptance-scout-${methodId}`, kind: "evolution-scout", payload: { leadId: lead.id } });
      report.stages.push({ stage: "real-scout", methodId, result: scoutResult }); await save();
    }
    let dossier = await app.evolution.service.get(scoutResult.dossierId);
    if (!dossier?.payload.eligibility?.eligible || dossier.payload.methodId !== methodId) throw new Error("The real scout did not independently admit this missing method.");
    if (Object.entries(metadata).some(([key, value]) => JSON.stringify(dossier.payload[key]) !== JSON.stringify(value))) {
      const previousScope = Object.fromEntries(Object.keys(metadata).map(key => [key, dossier.payload[key] ?? null]));
      dossier = await app.evolution.service.save("dossier", dossier.id, { ...dossier.payload, ...metadata }, dossier);
      report.stages.push({ stage: "acceptance-development-scope", methodId, dossierId: dossier.id,
        revision: dossier.revision, previous: previousScope, selected: metadata,
        reason: "Exercise a standalone calculator inside an existing capability; preserve prior development attempts and reviews." });
      await save();
    }
    let built;
    const lastBuild = completed("real-build", methodId);
    for (let previousAttempt = 0; dossier.payload.status !== "published" && previousAttempt < Number(dossier.payload.buildAttempts ?? 0)
      && lastBuild?.sourceArtifactHash !== report.sourceArtifactHash; previousAttempt++) {
      if (report.stages.some(item => item.stage === "rechecked-existing-candidate" && item.methodId === methodId && item.attempt === previousAttempt && item.sourceArtifactHash === report.sourceArtifactHash)) continue;
      built = await recheckEvolutionAcceptanceCandidate(job => app.evolution.worker.perform(job), { id: `acceptance-recheck-${methodId}-${report.sourceArtifactHash}`, kind: "evolution-build",
        payload: { dossierId: dossier.id, action: "recheck-candidate", attempt: previousAttempt } });
      report.stages.push({ stage: "rechecked-existing-candidate", methodId, attempt: previousAttempt, status: built.status, feedback: built.feedback ?? null, ...(built.skipped ? { skipped: true, reasonCode: built.reasonCode, productionCode: built.productionCode } : {}) }); await save();
      dossier = await app.evolution.service.get(dossier.id);
    }
    while (dossier.payload.status !== "published" && Number(dossier.payload.buildAttempts ?? 0) < config.evolutionMaxBuildAttempts) {
      await awaitCapacity();
      const attempt = Number(dossier.payload.buildAttempts ?? 0);
      built = await app.evolution.worker.perform({ id: `acceptance-build-${methodId}-${attempt}`, kind: "evolution-build", payload: { dossierId: dossier.id } });
      report.stages.push({ stage: "real-build", methodId, attempt, status: built.status, feedback: built.feedback }); await save();
      dossier = await app.evolution.service.get(dossier.id);
      if (built.status !== "repair") break;
    }
    if (dossier.payload.status !== "published") throw new Error("The actual builder did not pass independent publication evaluation.");
    const tool = await app.evolution.service.get(dossier.payload.toolId);
    if (tool.payload.validationLevel !== "V2" || tool.payload.status !== "active") throw new Error("Published tool has not earned V2.");
    report.stages.push({ stage: "hidden-published-cases", methodId, toolId: tool.id, validationLevel: tool.payload.validationLevel, digest: tool.payload.artifactDigest,
      assessments: tool.payload.assessments.map(item => ({ id: item.id, caseId: item.caseId, passed: item.passed, exposed: item.exposed })) }); await save();
    return tool;
  };
  const tool = await buildMethod("cohort-state-transition", input.demand, { publicationKind: "isolated-tool", toolKind: "calculation" });
  const development = JSON.parse(await fs.readFile(new URL("../../evals/paper-gold/development-contract.json", import.meta.url), "utf8"));
  const publicInput = development.cases[0].input;

  const user = await app.store.userById(ownerId), project = await app.store.projectFor(user, "evolution-tool-demonstration", "循证进化工具实测");
  const login = await fetch("http://127.0.0.1:8787/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: ownerId, password }) });
  const identity = await login.json(), headers = { "content-type": "application/json", "x-evimed-automated": "1", Cookie: login.headers.get("set-cookie").split(";")[0], "X-Open-Science-CSRF": identity.data.csrfToken, "X-Open-Science-Project": project.id };
  const request = async (url, body, method = "POST") => {
    const response = await fetch("http://127.0.0.1:8787" + url, { method, headers, body: JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw new Error(`Acceptance request failed: ${response.status} ${value.code ?? value.error?.code ?? "unknown"}`); return value.data;
  };
  const sessionCheckpoint=[...report.stages].reverse().find(item=>item.stage==='real-conversation-session');
  const preparedSession=await prepareEvolutionConversationSession({checkpoint:sessionCheckpoint,runs:await app.agentRuns.list(project),request});
  const session=preparedSession.session;
  if(preparedSession.created){report.stages.push({stage:'real-conversation-session',session,createdThroughPublicApi:true,replacedSessionId:preparedSession.replacedSessionId});await save();}
  const prompts = [
    `使用统计分析能力和已安装的平台工具 ${tool.payload.nativeName ?? tool.id}，实际调用隔离计算器，计算这个公开教学模型的成本和QALY。明确说明它是合成示例，不是临床证据。输入：${JSON.stringify(publicInput)}`,
    "继续上个教学模型。解释如何改变折现权重，而不改变主要研究问题；清楚区分已计算结果与尚未计算的假设。",
    "补充输入：现在只讨论0折现的情况。需要哪些字段才能重新计算？如果原始数据不足，请明确列出，不能假造数字。",
    "换个问题：系统综述中异质性I²和τ²有什么区别？不要沿用上个经济学模型的结果。",
    `再次使用平台工具 ${tool.id} 检查输入边界：给成本效用模型负的初始人群和转移概率总和大于1的输入。必须真实执行并如实说明工具返回的拒绝或问题，不要把失败说成成功，不要重新定义模型绕过验证。`,
    "目前没有这个疾病的真实转移率和效用值。请直接指出哪些实证结论因此不能得到；可以说明模拟用途，但不要虚构患者数据或临床建议。",
  ];
  const verifyReceipts = async (index,runId) => {
    const deadline=Date.now()+30000;
    let checked;
    do {
      checked=conversationReceipts(await app.evolution.service.list("use",ownerId), {userId:ownerId,projectId:project.id,runId,toolId:tool.id,digest:tool.payload.artifactDigest,revision:tool.payload.revision,index});
      if(checked.passed) return checked;
      await delay(500);
    } while(Date.now()<deadline);
    throw new Error(`Conversation ${index} lacks its required actual pinned execution receipt.`);
  };
  for (let index = 0; index < prompts.length; index++) {
    const checkpoint=report.stages.find(item => item.stage === "real-conversation" && item.index === index && item.status === "succeeded");
    if(checkpoint){await verifyReceipts(index,checkpoint.runId);continue;}
    const dispatched = await request("/api/agent-runs/dispatch", { sessionId: session.id, dispatchId: `acceptance_evolution_scoped_${index}`,
      ...([0, 4].includes(index) ? { line: "statistical-analysis" } : {}), text: prompts[index], automated: true });
    const runId = dispatched.id ?? dispatched.run?.id;
    const deadline = Date.now() + config.evolutionEvaluationTimeoutMs;
    let run;
    do { await delay(3000); run = (await app.agentRuns.list(project)).find(item => item.id === runId); } while (Date.now() < deadline && (!run || ["queued", "dispatching", "running"].includes(run.status)));
    if (run?.status !== "succeeded") throw new Error("A real conversation did not complete.");
    const receipts=await verifyReceipts(index,runId);
    report.stages.push({ stage: "real-conversation", index, runId, status: run.status, effectiveAgentId: run.effectiveAgentId, verification: run.verification, receiptIds:receipts.receiptIds }); await save();
  }
  for (const run of (await app.agentRuns.list(project)).filter(row => row.automated === true && !["queued", "dispatching", "running"].includes(row.status))) {
    await app.evolution.finishRun(project, run);
  }
  const usage = await app.evolution.service.list("use", ownerId);
  const executed = usage.filter(row => row.payload.projectId === project.id && row.payload.toolId === tool.id);
  if (!executed.length) throw new Error("No authenticated runtime invocation of the published tool was recorded.");
  const ledger = await app.usageLedger.summary(ownerId, { purposes: ["evolution"] });
  report.stages.push({ stage: "actual-tool-use", calls: executed.length, revisions: executed.map(row => row.payload.revision), accounting: ledger });
  await app.runtimeManager.stop(project);
  const { repairEvolutionPublicBoundary, runEvolutionBoundaryAcceptance } = await import("./evolution-boundary-acceptance.mjs");
  let boundary = completed("actual-boundary-validation")?.result;
  if (!boundary) {
    boundary = await repairEvolutionPublicBoundary({ app, controller: new RuntimeControllerClient(config), tool, contract: development,
      checkpoint: async stage => { report.stages.push(stage); await save(); } });
    report.stages.push({ stage: "actual-boundary-validation", result: boundary }); await save();
  }
  const currentTool = await app.evolution.service.get(boundary.toolId);
  if (!completed("actual-natural-tool-routing")?.result?.transcriptHash) {
    const { runEvolutionNaturalToolAcceptance } = await import("./evolution-natural-tool-acceptance.mjs");
    const result = await runEvolutionNaturalToolAcceptance({ app, ownerId, password, tool: currentTool, capabilityId: "statistical-analysis", publicInput, probeId: input.naturalProbeId ?? "live-v2" });
    const naturalProject = await app.store.requireProject(await app.store.userById(ownerId), result.projectId);
    const naturalRun = (await app.agentRuns.list(naturalProject)).find(row => row.id === result.runId);
    if (naturalRun?.automated === true) await app.evolution.finishRun(naturalProject, naturalRun);
    report.stages.push({ stage: "actual-natural-tool-routing", result }); await save();
    await app.runtimeManager.stop(naturalProject);
  }
  if (!completed("actual-pinned-boundary-refusals")?.result?.transcriptHash) {
    const result = await runEvolutionBoundaryAcceptance({ app, ownerId, password, tool: currentTool, contract: development });
    report.stages.push({ stage: "actual-pinned-boundary-refusals", result }); await save();
  }
  if (!completed("live-workflow")) {
    const { runEvolutionWorkflowAcceptance } = await import("./evolution-workflow-acceptance.mjs");
    const result = await runEvolutionWorkflowAcceptance({ app, probeId: "v1", stagePublication: true });
    report.stages.push({ stage: "live-workflow", result }); await save();
  }
  if (input.isolation === true && !completed("live-source-isolation")) {
    const { runEvolutionIsolationAcceptance } = await import("./evolution-isolation-acceptance.mjs");
    const result = await runEvolutionIsolationAcceptance({ app, probeId: input.isolationProbeId ?? "live-v2" });
    report.stages.push({ stage: "live-source-isolation", result }); await save();
  }
  if (input.extended !== false) {
    const aggregate = JSON.parse(await fs.readFile(new URL("../../evals/paper-gold/aggregate-candidate-cards.json", import.meta.url), "utf8"));
    for (const card of aggregate.cards) {
      const metadata = card.methodId === "decision-net-benefit" ? {
        capabilityIds: ["statistical-analysis", "dataset-research-scoping"], form: "rewrite", publicationKind: "isolated-tool", toolKind: "calculation",
        selfCheck: { kind: "decision-net-benefit", covariates: ["age", "bmi"], replicates: 200, knownSignal: 1, negativeControl: true, seed: "fixed-protocol-v1" },
        dataRequirements: { schema: { fields: [
          { name: "age", type: "number", unit: "a", constraints: { required: true } },
          { name: "bmi", type: "number", unit: "kg/m2", constraints: { required: true } },
          { name: "type", type: "string", constraints: { required: true, enum: ["Yes", "No"] } },
        ] }, researchRules: { requiredSemanticsChecks: ["drift"] },
          description: "Anonymous observed outcomes and numeric covariates for self-check. Confusion counts for the callable must be derived from a declared classifier and threshold; no model is fitted by this tool." },
      } : { capabilityIds: ["statistical-analysis"], form: "rewrite", publicationKind: "isolated-tool", toolKind: "calculation" };
      const additional = await buildMethod(card.methodId, card, metadata);
      if (card.methodId === "decision-net-benefit" && input.publicDataDir && !completed("actual-autopilot-computation")) {
        const { runEvolutionUploadAcceptance, uploadedComputationReceipts } = await import("./evolution-upload-acceptance.mjs");
        const result = completed("actual-upload-and-wake")?.result ?? await runEvolutionUploadAcceptance(app, { toolId: additional.id,
          csvBytes: await fs.readFile(path.join(input.publicDataDir, "pima-training.csv")),
          sourceEvidence: JSON.parse(await fs.readFile(path.join(input.publicDataDir, "provenance.json"), "utf8")),
        });
        if (!completed("actual-upload-and-wake")) { report.stages.push({ stage: "actual-upload-and-wake", result }); await save(); }
        const researcher = await app.store.userById(result.userId), uploadedProject = await app.store.requireProject(researcher, result.projectId);
        const deadline = Date.now() + config.evolutionEvaluationTimeoutMs;
        let episode, episodeRun;
        do {
          const queued = await app.evolution.service.documents.database.query("SELECT payload FROM evimed_product.jobs WHERE id=$1", [result.episodeJobId]);
          const episodeId = queued.rows[0]?.payload?.episodeId;
          episode = episodeId ? await app.evolution.service.documents.get(result.userId, "episode", episodeId) : null;
          const runId = episode?.payload.runId;
          if (runId) episodeRun = (await app.agentRuns.list(uploadedProject)).find(row => row.id === runId);
          if (episodeRun && !["queued", "dispatching", "running"].includes(episodeRun.status)) break;
          await delay(3000);
        } while (Date.now() < deadline);
        if (episodeRun?.status !== "succeeded") throw new Error("The resumed real research episode did not complete.");
        const observed = uploadedComputationReceipts(await app.evolution.service.list("use", result.userId), { result, run: episodeRun, tool: additional });
        if (!observed.length) throw new Error("The resumed agenda needs a substantive pinned execution on the actual uploaded data counts.");
        const { waitForEvolutionTranscript, evolutionTranscriptHash } = await import("./evolution-transcript-wait.mjs");
        const transcript = await waitForEvolutionTranscript(uploadedProject, episodeRun.id);
        report.stages.push({ stage: "actual-autopilot-computation", runId: episodeRun.id, episodeId: episode.id,
          toolId: additional.id, calls: observed.length, aggregateInput: result.aggregateInput,
          receiptIds: observed.map(row => row.id), csvSha256: result.csvSha256, transcriptHash: evolutionTranscriptHash(transcript),
          artifacts: episodeRun.artifacts, verification: episodeRun.verification }); await save();
        await app.runtimeManager.stop(uploadedProject);
      }
      if (card.methodId === "decision-net-benefit" && !completed("actual-tool-publication-wake")) {
        const { runEvolutionToolWakeAcceptance } = await import("./evolution-tool-wake-acceptance.mjs");
        const contract = JSON.parse(await fs.readFile(new URL("../../evals/paper-gold/decision-net-benefit-development.json", import.meta.url), "utf8"));
        const result = await runEvolutionToolWakeAcceptance({ app, sourceToolId: additional.id, ownerId,
          publicInput: contract.cases[0].input, execute: true });
        report.stages.push({ stage: "actual-tool-publication-wake", result }); await save();
        await app.runtimeManager.stop(await app.store.requireProject(await app.store.userById(ownerId), result.projectId));
      }
    }
  }
  report.passed = true;
} catch (error) {
  report.failure = { code: typeof error.code === "string" ? error.code : error.name, message: String(error.message).slice(0, 500) };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  Object.assign(report.executions.at(-1), { finishedAt: report.finishedAt, passed: report.passed, failure: report.failure ?? null });
  await save();
  await app?.close(); await controller.close();
  process.stdout.write(JSON.stringify({ passed: report.passed, stages: report.stages.map(item => item.stage), reportHash: createHash("sha256").update(JSON.stringify(report)).digest("hex"), failure: report.failure ?? null }) + "\n");
}
