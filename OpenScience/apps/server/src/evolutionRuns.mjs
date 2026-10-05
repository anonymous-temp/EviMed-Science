import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HttpError, assertNoSymlinkPath } from "./security.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import { issueModelGatewayBudgetMarker } from "./modelGateway.mjs";
import { EVOLUTION_PROJECT_ID } from "./internalProjects.mjs";
import { evolutionKey } from "./evolutionService.mjs";

/** Read only a file named by this run's delivery; another run's loose files are not results.
 * @param {any} project @param {any} run @param {string} name @param {number} limit */
export async function readEvolutionArtifact(project, run, name, limit = 2_000_000) {
  const files = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])]
    .map(item => typeof item === "string" ? item : item.path).filter(Boolean))];
  const candidates = files.filter(file => path.posix.basename(file) === name);
  if (candidates.length !== 1) throw new HttpError(409, "evolution_output_missing", "The run did not deliver exactly one requested artifact.");
  const root = path.resolve(project.workspaceDir), target = path.resolve(root, candidates[0]);
  if (!target.startsWith(root + path.sep)) throw new HttpError(400, "evolution_output_invalid", "Artifact escaped its workspace.");
  await assertNoSymlinkPath(root, target);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new HttpError(413, "evolution_output_invalid", "Artifact exceeds its bounded read.");
    const bytes = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new HttpError(413, "evolution_output_invalid", "Artifact grew beyond its bounded read.");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

/** Resolve explicit filePaths or the exact all-values-equal-keys reference convention.
 * Inline files remain bytes; references must be delivered by this very run.
 * @param {any} project @param {any} run @param {any} candidate @param {number} limit */
export async function hydrateCandidateFiles(project,run,candidate,limit=2_000_000){
  const inline=candidate.files??{},explicit=candidate.filePaths;
  if(!inline||typeof inline!=='object'||Array.isArray(inline)||explicit!==undefined&&(!explicit||typeof explicit!=='object'||Array.isArray(explicit)))throw new HttpError(422,'evolution_output_invalid','Candidate files must be a named map.');
  const legacy=explicit===undefined&&Object.keys(inline).length>0&&Object.entries(inline).every(([name,value])=>value===name);
  if(explicit===undefined&&!legacy)return candidate;
  const references=explicit??inline,files=legacy?{}:{...inline},deliveries=[...new Set([...(run.artifacts??[]),...(run.unverifiedArtifacts??[])].map(item=>typeof item==='string'?item:item.path).filter(Boolean))];
  const manifests=deliveries.filter(file=>path.posix.basename(file)==='tool-candidate.json');
  if(manifests.length!==1)throw new HttpError(422,'evolution_output_invalid','Candidate manifest delivery is ambiguous.');
  const root=path.resolve(project.workspaceDir),base=path.dirname(path.resolve(root,manifests[0]));
  if(base!==root&&!base.startsWith(root+path.sep))throw new HttpError(422,'evolution_output_invalid','Candidate manifest escaped its workspace.');
  if(Object.keys(files).length+Object.keys(references).length>128)throw new HttpError(413,'evolution_output_invalid','Candidate file count exceeds its limit.');
  let total=Object.values(files).reduce((size,value)=>size+Buffer.byteLength(String(value)),0);
  if(total>limit)throw new HttpError(413,'evolution_output_invalid','Candidate files exceed their total limit.');
  for(const [name,relative]of Object.entries(references)){
    const safe=value=>typeof value==='string'&&/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');
    if(!safe(name)||!safe(relative)||Object.hasOwn(files,name))throw new HttpError(422,'evolution_output_invalid','Candidate file reference is invalid.');
    const target=path.resolve(base,relative);if(!target.startsWith(root+path.sep)||!deliveries.some(file=>path.resolve(root,file)===target))throw new HttpError(422,'evolution_output_invalid','Candidate file was not delivered by this run.');
    await assertNoSymlinkPath(root,target);const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size+total>limit)throw new HttpError(413,'evolution_output_invalid','Candidate files exceed their bounded read.');
      const buffer=Buffer.alloc(Math.min(limit-total+1,stat.size+1)),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
      if(bytesRead!==stat.size||bytesRead+total>limit)throw new HttpError(413,'evolution_output_invalid','Candidate file changed during read.');
      try{files[name]=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,bytesRead));}catch{throw new HttpError(422,'evolution_output_invalid','Candidate files must be UTF-8.');}total+=bytesRead;
    }finally{await handle.close();}
  }
  if(total>limit)throw new HttpError(413,'evolution_output_invalid','Candidate files exceed their total limit.');
  const result={...candidate,files};delete result.filePaths;return result;
}

/** The normal run ledger and DSH dispatch, in platform-owned isolated projects.
 * @param {any} dependencies */
export function createEvolutionRuns({ config, store, registry, runtimeManager, researchSessions, agentRuns, usageLedger, evaluationIsolation, service }) {
  async function dispatch({ userId, projectId = EVOLUTION_PROJECT_ID, capabilityId, dispatchId, brief, evaluationPolicy = null, jobId = null }) {
    if (config.evolutionEnabled !== true || !config.operatorUsers.includes(userId)
      || !(projectId === EVOLUTION_PROJECT_ID || /^eval-paper-[a-z0-9_-]+$/.test(projectId))) {
      throw new HttpError(403, "evolution_scope_invalid", "Evolution runs require an enabled operator-owned internal project.");
    }
    const user = await store.userById(userId);
    if (!user) throw new HttpError(404, "project_not_found", "The evolution account is unavailable.");
    const project = await store.projectFor(user, projectId, "EviMed 循证进化");
    if (jobId && service) {
      const id = `evolution-runtime-work-${evolutionKey(jobId)}`, previous = await service.get(id);
      if (previous?.payload.dispatchId !== dispatchId) await service.save("runtime-work", id, { jobId, userId, projectId, dispatchId }, previous);
    }
    if (evaluationPolicy) await evaluationIsolation.registerPending({ userId, projectId }, evaluationPolicy);
    const runs = await agentRuns.list(project), existing = runs.find(run => run.dispatchId === dispatchId);
    if (existing) {
      if (evaluationPolicy) await evaluationIsolation.bindRun({ userId, projectId }, existing.id);
      return existing;
    }
    if (runs.some(run => run.status === "running")) throw new HttpError(409, "runtime_busy", "Evolution waits for its preceding run.");
    const selected = (await registry).get(capabilityId);
    if (!selected) throw new HttpError(503, "evolution_capability_missing", "The requested evolution capability is not installed.");
    if (!evaluationPolicy && !["evolution-scout", "tool-builder"].includes(capabilityId)) throw new HttpError(403, "evolution_scope_invalid", "A scientific evaluation requires an exclusion policy.");
    await usageLedger.assertWithinLimits(userId, { dailyLimit: config.evolutionDailyBudgetCny, weeklyLimit: 0, purposes: ["evolution"] });
    const scope = { dailyLimit: config.evolutionDailyBudgetCny, weeklyLimit: 1_000_000, runLimit: config.evolutionRunBudgetCny };
    const session = await runtimeManager.reserveBoundedRuntimeSession(project, { runId: dispatchId, capabilityId: selected.id, ...scope });
    try {
      await researchSessions.put(project, session.id, { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
      return await agentRuns.dispatch(project, { sessionId: session.id, dispatchId, automated: true, question: brief,
        effectiveAgentId: selected.id, effectiveAgentVersion: selected.version, effectiveRuntimeAgent: selected.runtimeAgent,
        effectiveRouteReason: "platform-evolution" }, async (binding, run, repairText = null) => {
        if (evaluationPolicy) await evaluationIsolation.bindRun({ userId, projectId }, run.id);
        const prepared = await prepareResearchContext(project, binding, config, { query: brief, memories: [], specialists: [],
          routedSpecialist: { agentId: selected.id, agentVersion: selected.version, runtimeAgent: selected.runtimeAgent,
            skill: selected.skill, companionSkills: selected.companionSkills } });
        const marker = issueModelGatewayBudgetMarker({ secret: config.modelGatewaySigningSecret, userId, projectId, runId: dispatchId, ...scope });
        return runtimeManager.dispatchPrompt(project, session.id, { text: `${repairText || brief}\n\n<evimed-evolution>${dispatchId}</evimed-evolution>\n\n${marker}`,
          system: prepared.system, memoryContext: prepared.memoryContext, residentProfile: true, strictContext: true,
          agent: selected.runtimeAgent, model: "deepseek/deepseek-flash", runId: run.id, allowBounded: true,
          requestId: run.kernelRequestIds?.at(-1) });
      });
    } catch (error) {
      const recorded = (await agentRuns.list(project)).find(run => run.dispatchId === dispatchId);
      if (recorded) return recorded;
      await runtimeManager.endBoundedRuntime(project, dispatchId);
      throw error;
    }
  }
  return {
    dispatch,
    /** A recovered job may inspect its existing run even when no new runtime slot is available. */
    async canResume(job) {
      if (!job?.id || !service) return false;
      const record = await service.get(`evolution-runtime-work-${evolutionKey(job.id)}`);
      if (!record || record.payload.jobId !== job.id || record.payload.userId !== job.userId) return false;
      const user = await store.userById(record.payload.userId);
      const project = await store.requireProject(user, record.payload.projectId);
      return (await agentRuns.list(project)).some(run => run.dispatchId === record.payload.dispatchId);
    },
    /** @param {any} request @param {{signal?:AbortSignal}} options */
    async execute(request, { signal } = {}) {
      const started = await dispatch(request), user = await store.userById(request.userId);
      const project = await store.requireProject(user, request.projectId ?? EVOLUTION_PROJECT_ID);
      const deadline = Date.now() + config.evolutionEvaluationTimeoutMs;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const run = (await agentRuns.list(project)).find(item => item.id === started.id);
        if (run && run.status !== "running") {
          if (run.status !== "succeeded") throw new HttpError(409, run.errorCode ?? "evolution_run_failed", "The development run did not complete.");
          await runtimeManager.workspaceRootForDelivery(project);
          const output=await readEvolutionArtifact(project, run, request.outputName, config.evolutionMaxArtifactBytes);
          return { run, output: request.outputName==='tool-candidate.json'?await hydrateCandidateFiles(project,run,output,config.evolutionMaxArtifactBytes):output };
        }
        await delay(1500, undefined, { signal });
      }
      throw new HttpError(408, "evolution_run_timeout", "The development run exceeded its deadline; its ledger remains resumable.");
    },
  };
}
