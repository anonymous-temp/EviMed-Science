import { mkdir, readFile, realpath } from "node:fs/promises";
import {canonicalJson} from "@evimed/domain";
import {writeFileExclusiveNoFollow} from "./security.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createEvolutionCasePreparation } from "./evolutionCasePreparation.mjs";
import { numericScore, simulationScore, crossImplementationScore, screenRetractions } from "../../../evals/paper-gold/evaluator.mjs";
import { reviewSuddenPerfect } from "./candidateSuddenPerfectReview.mjs";

/** Gold is admitted by the operator into the control-plane directory, never by the candidate.
 * Each definition binds method ID, publication identity, inputs, immutable reference numbers,
 * source hash, independent extraction QA and exactly the published callable interface.
 * @param {any} deps */
export function createEvolutionCandidateEvaluator({ config, controller, fetchImpl = fetch, auditCandidateExposure = null, curateReferences = null, evaluateWorkflowSmoke = null, withReviewLock = null }) {
  const dataDir = config.evaluationDataDir || path.join(config.dataDir, "evaluation-control");
  const directory = path.join(dataDir, "paper-gold", "candidate-cases");
  const reviewToken = Symbol("sudden-perfect-independent-review");
  const callCandidate = async (candidate, input, signal, evidence = [], caseId = null, replicate = null) => {
    let outputDigest=null,executed=null;
    try {
    const match = /^(scripts\/[A-Za-z0-9_-]+\.py):([A-Za-z_][A-Za-z0-9_]*)$/.exec(candidate.entrypoint ?? "");
    if (!match || !Object.hasOwn(candidate.files ?? {}, match[1])) throw new Error("Candidate has no admitted published callable.");
    const code = `import runpy,json,sys\nnamespace=runpy.run_path(${JSON.stringify(`/candidate/${match[1]}`)},run_name='published_callable')\narguments=json.load(sys.stdin)\nresult=namespace[${JSON.stringify(match[2])}](**arguments)\nprint(json.dumps(result,allow_nan=False))\n`;
    const result = await controller.execVerify({ files: candidate.files, dependencyIds: candidate.dependencies ?? [], code, input }, { signal });
    executed=result.executionStarted===true?true:null;
    outputDigest=`sha256:${createHash("sha256").update(String(result.output??result.stdout??"")).digest("hex")}`;
    if (result.ok !== true || result.joined !== true) throw new Error("Candidate execution did not complete successfully.");
    const output=String(result.output ?? result.stdout ?? "");
    const parsed=JSON.parse(output.trim().split("\n").at(-1));
    evidence.push({caseId,replicate,executed:true,ok:true,outputDigest:`sha256:${createHash("sha256").update(output).digest("hex")}`});
    return parsed;
    }catch(error){evidence.push({caseId,replicate,executed,outputDigest,ok:false,code:["extension_contract_invalid","runtime_limit_exceeded","product_state_unavailable","usage_budget_exceeded","runtime_controller_timeout"].includes(error?.code)?error.code:"candidate_execution_failed"});throw error;}
  };
  const exclusionPolicyFor = async (definition, methodId) => {
    const publicationIds = (definition.cases ?? []).filter(row => row.kind === "published").map(row => row.publicationId);
    const policy = { aliases: [...publicationIds], titles: definition.publicationTitles ?? [] };
    if (methodId === "cohort-state-transition") {
      const manifest = JSON.parse(await readFile(new URL("../../../evals/paper-gold/economics-reference-manifest.json", import.meta.url), "utf8"));
      for (const record of manifest.cases.filter(item => publicationIds.includes(item.doi))) {
        policy.aliases.push(...[record.pmid ? `PMID:${record.pmid}` : null, record.pmcid, record.preprint, record.code].filter(Boolean));
        if (record.title) policy.titles.push(record.title);
      }
    }
    for (const reference of definition.cases ?? []) {
      policy.aliases.push(...(reference.aliases ?? []));
      if (reference.title) policy.titles.push(reference.title);
    }
    try {
      const identities = JSON.parse(await readFile(path.join(directory, `${methodId}.identities.json`), "utf8"));
      if (identities.referenceHash !== createHash("sha256").update(JSON.stringify(definition)).digest("hex") || identities.methodId !== methodId) throw new Error("Evaluation identity manifest no longer matches frozen references.");
      for (const record of identities.identities) {
        policy.aliases.push(...record.aliases);
        policy.titles.push(...record.titles);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { aliases: [...new Set(policy.aliases)], titles: [...new Set(policy.titles)] };
  };
  return {
    async developmentContract(card) {
      const methodId = card.methodId ?? card.id;
      const filename = methodId === "cohort-state-transition" || card.methodFamily === "cohort-state-transition" ? "development-contract.json" : `${methodId}-development.json`;
      if (!/^[A-Za-z0-9_.-]{1,140}$/.test(filename)) return null;
      try { return JSON.parse(await readFile(new URL(`../../../evals/paper-gold/${filename}`, import.meta.url), "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        try { return JSON.parse(await readFile(path.join(directory, `${methodId}.development.json`), "utf8")); }
        catch (missing) { if (missing.code !== "ENOENT") throw missing; return null; }
      }
    },
    async exclusionPolicy(card) {
      const methodId = card.methodId ?? card.id;
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(String(methodId))) throw new Error("Invalid method identity.");
      const definition = JSON.parse(await readFile(path.join(directory, `${methodId}.json`), "utf8"));
      if (definition.methodId !== methodId || definition.frozen !== true) throw new Error("Unfrozen evaluator cases.");
      return exclusionPolicyFor(definition, methodId);
    },
    async prepareCases(card, options = {}) {
      const prepared = await createEvolutionCasePreparation({ config, controller, fetchImpl }).prepareCases(card, options);
      return !prepared.ok && prepared.resourceCode === "independent_published_reference_curation_unavailable" && curateReferences
        ? curateReferences(card, options) : prepared;
    },
    /** Return no expected numbers or hidden inputs to a development run. @param {any} candidate @param {any} [options] @param {symbol} [token] */
    evaluate: async function evaluateCandidate(candidate, { card = {}, signal = undefined } = {}, token = undefined) {
      const startedAt=new Date().toISOString(),executionEvidence=[],runIds=new Set();
      const evaluatorCodeHash = createHash("sha256").update(canonicalJson(await Promise.all(["./evolutionCandidateEvaluator.mjs", "./candidateSuddenPerfectReview.mjs", "../../../evals/paper-gold/evaluator.mjs"].map(file => readFile(new URL(file, import.meta.url), "utf8"))))).digest("hex");
      let frozenSourceDigest = null;
      const finish=async result=>{
        const receipt={schemaVersion:1,candidateId:candidate.id??null,methodId:card.methodId??card.id??candidate.methodId??candidate.id,sourceArtifactDigest:`sha256:${createHash("sha256").update(canonicalJson(candidate.files??{})).digest("hex")}`,evaluatorHash:result.evaluatorHash??null,startedAt,measuredAt:new Date().toISOString(),runIds:[...runIds],developmentRunIds:candidate.lineage?.developmentRuns??[],ok:result.ok===true,status:result.status,resourceCode:result.resourceCode??null,assessments:(result.assessments??[]).map(item=>({caseId:item.caseId,kind:item.kind??null,replicate:item.replicate??null,passed:item.passed===true,reason:item.reason??(item.passed?"within_reference_tolerance":"outside_reference_tolerance")})),executionEvidence};
        Object.assign(receipt, { evaluatorCodeHash, frozenSourceDigest, executionContractDigest: createHash("sha256").update(canonicalJson({ entrypoint: candidate.entrypoint ?? null, dependencies: candidate.dependencies ?? [], toolKind: card.toolKind ?? candidate.toolKind ?? "calculation", executionTools: candidate.executionTools ?? [] })).digest("hex"), exposureTier: result.exposureTier ?? "unknown", purpose: token === reviewToken ? "sudden-perfect-independent-review" : "candidate-validation" });
        const identity=createHash("sha256").update(canonicalJson(receipt)).digest("hex");
        await mkdir(dataDir,{recursive:true,mode:0o700});
        await writeFileExclusiveNoFollow(dataDir,path.join(dataDir,"paper-gold","candidate-evaluations",identity+".json"),canonicalJson(receipt)+"\n",{mode:0o444}).catch(error=>{if(error.code!=="EEXIST")throw error;});
        const completed = { ...result, evaluationReceiptHash: identity };
        if (token === reviewToken || result.ok !== true) return completed;
        const review = await reviewSuddenPerfect({ dataDir, currentReceiptHash: identity, signal, withReviewLock,
          replay: () => evaluateCandidate(candidate, { card, signal }, reviewToken) });
        if (review.triggered && review.passed !== true) return { ...completed, ok: false, verificationLevel: "V0",
          status: review.status === "pending" ? "waiting_resource" : "repair", resourceCode: "sudden_perfect_review_not_passed", suddenPerfectReview: review };
        return { ...completed, suddenPerfectReview: review };
      };
      const methodId = card.methodId ?? card.id ?? candidate.methodId ?? candidate.id;
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(String(methodId))) throw new Error("Invalid evaluation method identity.");
      try {
      let definition;
      try {
        const root = await realpath(directory);
        const file = await realpath(path.join(root, `${methodId}.json`));
        if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Hidden case path escaped evaluator storage.");
        definition = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return finish({ ok: false, verificationLevel: "V0", status: "waiting_resource", resourceCode: "hidden_reference_cases_missing", failedCaseIds: [], assessments: [] });
      }
      if (definition.methodId !== methodId || definition.frozen !== true) throw new Error("Hidden evaluator definition must be frozen and method-bound.");
      frozenSourceDigest = (definition.cases ?? []).every(row => /^[a-f0-9]{64}$/.test(row.sourceHash ?? ""))
        ? createHash("sha256").update(canonicalJson((definition.cases ?? []).map(row => ({ id: row.id, sourceHash: row.sourceHash })).sort((a, b) => String(a.id).localeCompare(String(b.id))))).digest("hex") : null;
      const scriptFreeWorkflow = (card.toolKind ?? candidate.toolKind) === "workflow" && !Object.keys(candidate.files ?? {}).some(name => /\.py$/i.test(name));
      if (scriptFreeWorkflow && !evaluateWorkflowSmoke) return finish({ ok: false, smokePassed: false, verificationLevel: "V0", status: "waiting_resource", resourceCode: "workflow_smoke_executor_unavailable", failedCaseIds: [], assessments: [] });
      const evaluatorHash = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
      const publicationIds = [...new Set((definition.cases ?? []).filter(row => row.kind === "published").map(row => row.publicationId).filter(id => /^10\.\d{4,9}\//.test(id)))];
      const screens = await screenRetractions(publicationIds, fetchImpl);
      if (screens.some(row => !row.admissible)) return finish({ ok: false, verificationLevel: "V0", status: "waiting_resource", resourceCode: "published_reference_screen_failed", failedCaseIds: [], assessments: [], evaluatorHash });
      const policy = await exclusionPolicyFor(definition, methodId);
      const exposure = auditCandidateExposure ? await auditCandidateExposure(candidate, { policy, signal }) : { tier: "unknown" };
      const assessments = [];
      const published = new Set();
      const failedCaseIds = new Set();
      let simulationPassed = false;
      let workflowResourcePending = false;
      for (const testCase of definition.cases ?? []) {
        if (testCase.hidden !== true || testCase.independentQa?.passed !== true || !testCase.sourceHash || (testCase.kind === "published" && (!testCase.publicationId || !testCase.numeric))) {
          assessments.push({ caseId: testCase.id, passed: false, reason: "reference_not_admitted" }); failedCaseIds.add(testCase.id); continue;
        }
        if (scriptFreeWorkflow && testCase.kind !== "workflow-smoke") { failedCaseIds.add(testCase.id); continue; }
        if (testCase.kind === "simulation") {
          if (!Number.isFinite(Date.parse(testCase.preregistered?.at)) || !Array.isArray(testCase.inputs) || testCase.preregistered?.hash !== createHash("sha256").update(JSON.stringify({ inputs: testCase.inputs, specification: testCase.specification })).digest("hex")) { failedCaseIds.add(testCase.id); continue; }
          const results = [];
          for (const input of testCase.inputs) results.push(await callCandidate(candidate, input, signal, executionEvidence, testCase.id, results.length));
          const score = simulationScore(results, testCase.specification);
          simulationPassed = score.valid;
          assessments.push({ caseId: testCase.id, kind: "simulation", independent: true, exposed: false, retracted: false, preRegistered: true, passed: score.valid, replicates: score.n, monteCarloError: { bias: score.mcseBias, coverage: score.mcseCoverage, falsePositive: score.mcseFalsePositive } });
          if (!score.valid) failedCaseIds.add(testCase.id);
          continue;
        }
        let passed = true;
        for (let replicate = 0; replicate < (scriptFreeWorkflow ? 1 : 2); replicate++) {
          let valid = false;
          let reason = "outside_reference_tolerance";
          try {
            let actual;
            if (scriptFreeWorkflow) {
              if (testCase.kind !== "workflow-smoke") throw new Error("Script-free workflows require independent workflow smoke cases.");
              const receipt = await evaluateWorkflowSmoke({ candidate: structuredClone(candidate), input: structuredClone(testCase.input), caseId: testCase.id, methodId, replicate, signal });
              if (!receipt?.runId || receipt.executed !== true) workflowResourcePending = true;
              if (receipt?.independent !== true || receipt.executed !== true || typeof receipt.runId !== "string" || !receipt.runId || !Array.isArray(candidate.executionTools) || !candidate.executionTools.length || !Array.isArray(receipt.toolsCalled) || !candidate.executionTools.every(tool => receipt.toolsCalled.includes(tool))) throw new Error("Workflow has no independently observed execution receipt.");
              runIds.add(receipt.runId);executionEvidence.push({caseId:testCase.id,replicate,executed:true,ok:true,outputDigest:`sha256:${createHash("sha256").update(canonicalJson(receipt.output)).digest("hex")}`});
              actual = receipt.output;
            } else actual = await callCandidate(candidate, testCase.input, signal, executionEvidence, testCase.id, replicate);
            const values = {};
            for (const [key, reference] of Object.entries(testCase.numeric)) {
              const value = String(reference.outputPath ?? key).split(".").reduce((node, field) => node?.[field], actual);
              values[key] = value;
            }
            valid = Object.entries(testCase.numeric).every(([key, reference]) => numericScore(values[key], reference).valid);
            if (testCase.independentImplementation) valid = valid && Object.values(crossImplementationScore({ implementationId: candidate.id, numeric: values }, testCase.independentImplementation, testCase.numeric)).every(row => row.valid);
            reason = valid ? "within_reference_tolerance" : reason;
          } catch { reason = "candidate_execution_failed"; }
          assessments.push({ caseId: testCase.id, kind: testCase.kind, independent: true, exposed: exposure.tier !== "unexposed", retracted: false, crossImplementationPassed: testCase.independentImplementation ? valid : null, replicate, passed: valid, reason });
          passed = passed && valid;
        }
        if (!passed) failedCaseIds.add(testCase.id);
        else if (testCase.kind === "published") published.add(testCase.publicationId);
      }
      const kind = card.toolKind ?? candidate.toolKind ?? "calculation";
      const workflowSmoke = kind === "workflow" && assessments.some(row => row.kind === "workflow-smoke" && row.passed) && !failedCaseIds.size;
      const verificationLevel = published.size >= 2 && !failedCaseIds.size && exposure.tier === "unexposed" ? "V2" : simulationPassed && !failedCaseIds.size ? "V1" : "V0";
      const ok = kind === "workflow" ? workflowSmoke : verificationLevel === "V2" || (definition.noPublishedExamples === true && verificationLevel === "V1");
      return finish({ ok, verificationLevel, smokePassed: workflowSmoke, status: ok ? "verified" : workflowResourcePending ? "waiting_resource" : failedCaseIds.size ? "repair" : "waiting_resource", failedCaseIds: [...failedCaseIds], assessments, evaluatorHash, publishedReferenceCount: published.size, exposureTier: exposure.tier });
      }catch(error){await finish({ok:false,status:"error",assessments:executionEvidence.map(item=>({caseId:item.caseId,replicate:item.replicate,passed:false,reason:"candidate_execution_failed"}))});throw error;}
    },
  };
}
