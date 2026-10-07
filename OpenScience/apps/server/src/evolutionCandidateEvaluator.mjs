import { createEvolutionConfirmationLedger } from './evolutionConfirmationLedger.mjs';
import { mkdir, readFile, realpath } from "node:fs/promises";
import {canonicalJson, MCP_TOOL_BASE_NAMES, MCP_TOOL_NAMES} from "@evimed/domain";
import {writeFileExclusiveNoFollow} from "./security.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createEvolutionCasePreparation } from "./evolutionCasePreparation.mjs";
import { numericScore, simulationScore, crossImplementationScore, screenRetractions } from "../../../evals/paper-gold/evaluator.mjs";
import { behaviourPlan, deriveBehaviouralInputs, freshCaseAgrees, referenceOutputsDiffer, BEHAVIOUR_LIMITS } from "../../../evals/paper-gold/behavioural.mjs";
import { reviewSuddenPerfect } from "./candidateSuddenPerfectReview.mjs";
import { referenceRecallNotices } from "./evolutionExposureChain.mjs";

/** Every numeric constant of the candidate's Python, read with Python's own parser in the disposable
 * container. The values are compared with the hidden references in the control plane, where the
 * references are; the container never sees one. */
export const PYTHON_NUMERIC_LITERALS = String.raw`
import ast,json,pathlib
found={}
for file in pathlib.Path('/candidate').rglob('*.py'):
    name=str(file.relative_to('/candidate'))
    try: tree=ast.parse(file.read_text(encoding="utf-8-sig"),filename=name)
    except SyntaxError: continue
    values=set()
    for node in ast.walk(tree):
        if isinstance(node,ast.Constant) and isinstance(node.value,(int,float)) and not isinstance(node.value,bool):
            value=float(node.value)
            if value==value and abs(value)!=float('inf'): values.add(value)
    found[name]=sorted(values)[:20000]
print(json.dumps({'literals':found}))
`;
/** A reference value is worth looking for as a literal only when it is specific: three or more
 * significant digits, and not a small whole number every program contains. @param {number} value */
export const specificValue = value => Number.isFinite(value) && !(Number.isInteger(value) && Math.abs(value) < 1000) && String(Math.abs(value)).replace(/e.*$/i, "").replace(/^0\.0*|\./g, "").replace(/0+$/, "").length >= 3;

/** Gold is admitted by the operator into the control-plane directory, never by the candidate.
 * Each definition binds method ID, publication identity, inputs, immutable reference numbers,
 * source hash, independent extraction QA and exactly the published callable interface.
 * @param {any} deps */
export function createEvolutionCandidateEvaluator({ config, controller, fetchImpl = fetch, auditCandidateExposure = null, curateReferences = null, evaluateWorkflowSmoke = null, withReviewLock = null }) {
  const dataDir = config.evaluationDataDir || path.join(config.dataDir, "evaluation-control");
  const directory = path.join(dataDir, "paper-gold", "candidate-cases");
  const confirmationLedger = createEvolutionConfirmationLedger(config);
  const reviewToken = Symbol("sudden-perfect-held-out-review");
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
    }catch(error){evidence.push({caseId,replicate,executed,outputDigest,ok:false,code:["extension_contract_invalid","runtime_limit_exceeded","runtime_capacity_full","product_state_unavailable","usage_budget_exceeded","runtime_controller_timeout"].includes(error?.code)?error.code:"candidate_execution_failed"});throw error;}
  };
  /** Run the published callable on several inputs in one disposable execution. A raise or a non-finite
   * result on one input is that input's failure, not the batch's; `keys` keeps only those fields of each result.
   * @returns {Promise<{ok:boolean,output?:any}[]>} */
  const callCandidateBatch = async (candidate, inputs, signal, evidence, caseId, purpose, keys = null) => {
    const match = /^(scripts\/[A-Za-z0-9_-]+\.py):([A-Za-z_][A-Za-z0-9_]*)$/.exec(candidate.entrypoint ?? "");
    if (!match || !Object.hasOwn(candidate.files ?? {}, match[1])) throw new Error("Candidate has no admitted published callable.");
    const code = `import runpy,json,sys\nnamespace=runpy.run_path(${JSON.stringify(`/candidate/${match[1]}`)},run_name='published_callable')\nfunction=namespace[${JSON.stringify(match[2])}]\nkeys=${keys ? JSON.stringify(keys) : "None"}\nresults=[]\nfor arguments in json.load(sys.stdin)['batch']:\n try:\n  output=function(**arguments)\n  if keys is not None: output={key:output.get(key) for key in keys}\n  results.append({'ok':True,'output':json.loads(json.dumps(output,allow_nan=False))})\n except Exception:\n  results.append({'ok':False})\nprint(json.dumps({'batch':results}))\n`;
    const rows = [];
    // The controller admits 1 MiB of input and returns the last 64 KiB of output.
    for (let start = 0; start < inputs.length;) {
      let end = start, bytes = 0;
      while (end < inputs.length && end - start < (keys ? 250 : 6)) { const size = Buffer.byteLength(JSON.stringify(inputs[end])); if (end > start && bytes + size > 700 * 1024) break; bytes += size; end++; }
      let outputDigest = null, executed = null;
      try {
        const result = await controller.execVerify({ files: candidate.files, dependencyIds: candidate.dependencies ?? [], code, input: { batch: inputs.slice(start, end) } }, { signal });
        executed = result.executionStarted === true ? true : null;
        const output = String(result.output ?? result.stdout ?? "");
        outputDigest = `sha256:${createHash("sha256").update(output).digest("hex")}`;
        if (result.ok !== true || result.joined !== true) throw new Error("Candidate execution did not complete successfully.");
        const parsed = JSON.parse(output.trim().split("\n").at(-1)).batch;
        if (!Array.isArray(parsed) || parsed.length !== end - start) throw new Error("Candidate batch execution returned an incomplete result.");
        evidence.push({ caseId, replicate: null, purpose, executed: true, ok: true, outputDigest });
        rows.push(...parsed);
      } catch (error) { evidence.push({ caseId, replicate: null, purpose, executed, outputDigest, ok: false, code: "candidate_execution_failed" }); throw error; }
      start = end;
    }
    return rows;
  };
  /** The reference's numbers on one input, or null when the reference refuses the input. @param {any} plan @param {any} input @param {AbortSignal} [signal] */
  const runReference = async (plan, input, signal) => {
    let numeric;
    if (plan.reference.kind === "evaluator") { try { numeric = plan.reference.run(input); } catch { return null; } }
    else {
      const executed = await controller.execVerify({ files: {}, code: plan.reference.code, input }, { signal });
      if (executed.joined !== true) throw new Error("Reference execution did not complete.");
      if (executed.ok !== true) return null;
      try { numeric = JSON.parse(String(executed.output ?? "").trim().split("\n").at(-1)).numeric; } catch { return null; }
    }
    const values = Object.values(numeric ?? {});
    return values.length > 0 && values.every(Number.isFinite) ? numeric : null;
  };
  /**
   * The behavioural checks of `behavioural.mjs` for the hidden cases a candidate has just reproduced.
   * `passed` needs every executed check to pass and every case to have had at least one; `unavailable`
   * means nothing could be derived for this method, which is never read as a pass.
   */
  const behaviouralChecks = async ({ candidate, cases, plan, seed, signal, evidence, purpose, known = new Set() }) => {
    const summary = { status: "unavailable", referenceImplementation: plan.reference?.implementationId ?? null, relationChecks: 0, relationFailures: 0, freshCases: 0, freshFailures: 0, casesWithoutChecks: 0, cases: [] };
    if (!plan.relations.length && !plan.reference) return { ...summary, casesWithoutChecks: cases.length };
    for (const testCase of cases) {
      const derived = deriveBehaviouralInputs(plan, testCase.input, createHash("sha256").update(`${seed}:${testCase.id}`).digest("hex"));
      const fresh = [];
      let referenceState = plan.reference ? "agrees" : "none";
      if (plan.reference) {
        const base = await runReference(plan, testCase.input, signal);
        // A reference that does not reproduce the published numbers of this very case cannot referee fresh ones.
        const shared = Object.entries(testCase.numeric ?? {}).filter(([key]) => Object.hasOwn(base ?? {}, key));
        if (!base || !shared.length || !shared.every(([key, reference]) => numericScore(base[key], reference).valid)) referenceState = "disagrees-with-published";
        else for (const item of derived.fresh) {
          if (fresh.length >= BEHAVIOUR_LIMITS.freshPerCase) break;
          // A perturbation that lands on another hidden case's input is not a case the candidate was never scored on.
          if (known.has(canonicalJson(item.input))) continue;
          const reference = await runReference(plan, item.input, signal);
          if (reference && referenceOutputsDiffer(reference, base)) fresh.push({ ...item, reference });
        }
      }
      const row = { caseId: testCase.id, reference: referenceState, relationChecks: derived.relations.length, relationFailures: 0, freshCases: fresh.length, freshFailures: 0 };
      if (derived.relations.length + fresh.length > 0) {
        const outputs = await callCandidateBatch(candidate, [testCase.input, ...derived.relations.map(item => item.input), ...fresh.map(item => item.input)], signal, evidence, testCase.id, purpose);
        const base = outputs[0];
        derived.relations.forEach((relation, index) => { const output = outputs[1 + index]; let held = false; try { held = base.ok && output.ok && relation.check(base.output, output.output); } catch { held = false; } if (!held) row.relationFailures++; });
        fresh.forEach((item, index) => { const output = outputs[1 + derived.relations.length + index]; if (!(output.ok && freshCaseAgrees(output.output, item.reference, key => testCase.numeric?.[key]?.outputPath ?? key))) row.freshFailures++; });
      } else summary.casesWithoutChecks++;
      summary.cases.push(row);
      for (const key of ["relationChecks", "relationFailures", "freshCases", "freshFailures"]) summary[key] += row[key];
    }
    summary.status = summary.relationFailures + summary.freshFailures > 0 ? "failed" : summary.casesWithoutChecks === 0 && cases.length > 0 ? "passed" : "unavailable";
    return summary;
  };
  /** A decidable static fact, kept as a notice: a hidden expected value appearing as a literal in the
   * candidate's source. A value match, not a name match, and never the verdict: the behavioural checks are. */
  const referenceLiteralNotices = async (candidate, cases, signal) => {
    const wanted = new Set();
    for (const testCase of cases) for (const value of [...Object.values(testCase.numeric ?? {}).map(reference => reference?.value), ...Object.values(testCase.independentImplementation?.numeric ?? {})]) if (specificValue(value)) { wanted.add(value); wanted.add(-value); }
    if (!wanted.size || !Object.keys(candidate.files ?? {}).some(name => /\.py$/i.test(name))) return [];
    let literals;
    try {
      const result = await controller.execVerify({ files: candidate.files, dependencyIds: [], code: PYTHON_NUMERIC_LITERALS, input: {} }, { signal });
      literals = result.ok === true ? JSON.parse(String(result.output ?? "").trim().split("\n").at(-1)).literals : null;
    } catch { literals = null; }
    if (!literals) return [{ code: "reference_literal_scan_unavailable" }];
    return Object.entries(literals).map(([file, values]) => ({ code: "candidate_source_contains_reference_value", path: file, count: values.filter(value => wanted.has(value)).length })).filter(row => row.count > 0);
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
    freezeCandidate: confirmationLedger.freezeCandidate,
    recordFeedback: confirmationLedger.recordFeedback,
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
    evaluate: async function evaluateCandidate(candidate, { card = {}, signal = undefined, purpose = "development" } = {}, token = undefined) {
      const startedAt=new Date().toISOString(),executionEvidence=[],runIds=new Set();
      const evaluatorCodeHash = createHash("sha256").update(canonicalJson(await Promise.all(["./evolutionCandidateEvaluator.mjs", "./candidateSuddenPerfectReview.mjs", "../../../evals/paper-gold/evaluator.mjs", "../../../evals/paper-gold/behavioural.mjs", "../../../evals/paper-gold/tolerance.mjs", "../../../evals/paper-gold/simulation.mjs"].map(file => readFile(new URL(file, import.meta.url), "utf8"))))).digest("hex");
      let frozenSourceDigest = null, caseSelection = null;
      const finish=async result=>{
        const receipt={schemaVersion:1,candidateId:candidate.id??null,methodId:card.methodId??card.id??candidate.methodId??candidate.id,sourceArtifactDigest:`sha256:${createHash("sha256").update(canonicalJson(candidate.files??{})).digest("hex")}`,evaluatorHash:result.evaluatorHash??null,startedAt,measuredAt:new Date().toISOString(),runIds:[...runIds],developmentRunIds:candidate.lineage?.developmentRuns??[],ok:result.ok===true,status:result.status,resourceCode:result.resourceCode??null,assessments:(result.assessments??[]).map(item=>({caseId:item.caseId,kind:item.kind??null,replicate:item.replicate??null,passed:item.passed===true,reason:item.reason??(item.passed?"within_reference_tolerance":"outside_reference_tolerance")})),executionEvidence};
        Object.assign(receipt, { evaluatorCodeHash, frozenSourceDigest, executionContractDigest: createHash("sha256").update(canonicalJson({ entrypoint: candidate.entrypoint ?? null, dependencies: candidate.dependencies ?? [], toolKind: card.toolKind ?? candidate.toolKind ?? "calculation", executionTools: candidate.executionTools ?? [] })).digest("hex"), exposureTier: result.exposureTier ?? "unknown", purpose: token === reviewToken ? "sudden-perfect-held-out-review" : "candidate-validation",
          // Counts and closed codes only: which derived input failed, and by how much, stays in this process.
          behaviour: result.behaviour ? { status: result.behaviour.status, referenceImplementation: result.behaviour.referenceImplementation, relationChecks: result.behaviour.relationChecks, relationFailures: result.behaviour.relationFailures, freshCases: result.behaviour.freshCases, freshFailures: result.behaviour.freshFailures, casesWithoutChecks: result.behaviour.casesWithoutChecks } : null,
          caseGroups: caseSelection?.groups ?? [], candidateFreeze: caseSelection?.frozen ?? null, confirmationBatchHash: caseSelection?.batchHash ?? null, firstAttempt: purpose === "confirmation", heldOut: result.heldOut ?? null, notices: result.notices ?? [] });
        const identity=createHash("sha256").update(canonicalJson(receipt)).digest("hex");
        await mkdir(dataDir,{recursive:true,mode:0o700});
        await writeFileExclusiveNoFollow(dataDir,path.join(dataDir,"paper-gold","candidate-evaluations",identity+".json"),canonicalJson(receipt)+"\n",{mode:0o444}).catch(error=>{if(error.code!=="EEXIST")throw error;});
        const completed = { ...result, evaluationReceiptHash: identity, caseGroups: caseSelection?.groups ?? [], candidateFreeze: caseSelection?.frozen ?? null, confirmatory: caseSelection?.confirmatory ?? false };
        if (token === reviewToken || result.ok !== true) return completed;
        const review = await reviewSuddenPerfect({ dataDir, currentReceiptHash: identity, signal, withReviewLock,
          replay: () => evaluateCandidate(candidate, { card, signal, purpose: "audit" }, reviewToken) });
        // A review that could not be done is not a review that passed: the candidate waits for held-out material.
        if (review.triggered && review.passed !== true) return { ...completed, ok: false, verificationLevel: "V0",
          status: review.status === "repair" ? "repair" : "waiting_resource", resourceCode: review.status === "not-performed" ? "sudden_perfect_review_not_performed" : "sudden_perfect_review_not_passed", suddenPerfectReview: review };
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
      const frozenDefinition=definition;
      const frozen = await confirmationLedger.freezeCandidate(candidate, { card });
      caseSelection = await confirmationLedger.assemble(definition, frozen, { purpose: token === reviewToken ? 'audit' : purpose, minimumCases: token===reviewToken?1:definition.noPublishedExamples===true?1:2, requireTemporal:token!==reviewToken&&definition.noPublishedExamples!==true&&(card.toolKind??candidate.toolKind??'calculation')!=='workflow' });
      if (caseSelection.confirmatory && token!==reviewToken && caseSelection.cases.length < (definition.noPublishedExamples===true?1:2)) return finish({ ok: false, verificationLevel: 'V0', status: 'waiting_resource', resourceCode: 'fresh_confirmation_cases_incomplete', failedCaseIds: [], assessments: [] });
      definition = { ...definition, cases: caseSelection.cases };
      const scriptFreeWorkflow = (card.toolKind ?? candidate.toolKind) === "workflow" && !Object.keys(candidate.files ?? {}).some(name => /\.py$/i.test(name));
      if (scriptFreeWorkflow && !evaluateWorkflowSmoke) return finish({ ok: false, smokePassed: false, verificationLevel: "V0", status: "waiting_resource", resourceCode: "workflow_smoke_executor_unavailable", failedCaseIds: [], assessments: [] });
      const evaluatorHash = createHash("sha256").update(JSON.stringify(frozenDefinition)).digest("hex");
      const publicationIds = [...new Set((definition.cases ?? []).filter(row => row.kind === "published").map(row => row.publicationId).filter(id => /^10\.\d{4,9}\//.test(id)))];
      const screens = await screenRetractions(publicationIds, fetchImpl);
      if (screens.some(row => !row.admissible)) return finish({ ok: false, verificationLevel: "V0", status: "waiting_resource", resourceCode: "published_reference_screen_failed", failedCaseIds: [], assessments: [], evaluatorHash });
      const policy = await exclusionPolicyFor(frozenDefinition, methodId);
      const exposure = auditCandidateExposure ? await auditCandidateExposure(candidate, { policy, signal }) : { tier: "unknown" };
      const assessments = [];
      const published = new Set();
      const failedCaseIds = new Set();
      const simulationScores = [];
      let workflowResourcePending = false;
      const reviewing = token === reviewToken;
      for (const testCase of definition.cases ?? []) {
        // A reserved case is held out of every ordinary evaluation, so no repair round ever learns whether
        // the candidate passes it; the sudden-perfect review is the only reader, and reads nothing else.
        // Case selection is sealed by the first-use ledger before any execution.
        if (testCase.hidden !== true || testCase.independentQa?.passed !== true || !testCase.sourceHash || (testCase.kind === "published" && (!testCase.publicationId || !testCase.numeric))) {
          assessments.push({ caseId: testCase.id, passed: false, reason: "reference_not_admitted" }); failedCaseIds.add(testCase.id); continue;
        }
        if (scriptFreeWorkflow && testCase.kind !== "workflow-smoke") { failedCaseIds.add(testCase.id); continue; }
        if (testCase.kind === "simulation") {
          if (!Number.isFinite(Date.parse(testCase.preregistered?.at)) || !Array.isArray(testCase.inputs) || testCase.preregistered?.hash !== createHash("sha256").update(JSON.stringify({ inputs: testCase.inputs, specification: testCase.specification })).digest("hex")) { failedCaseIds.add(testCase.id); continue; }
          // One row per preregistered dataset, whatever the tool did with it: a raise, a missing field and a
          // non-finite number are failed outputs that `simulationScore` keeps in every denominator.
          const outputs = await callCandidateBatch(candidate, testCase.inputs, signal, executionEvidence, testCase.id, "simulation", ["estimate", "lower", "upper", "p"]);
          const score = simulationScore(outputs.map(row => row.ok && row.output ? row.output : {}), testCase.specification);
          simulationScores.push(score);
          assessments.push({ caseId: testCase.id, kind: "simulation", independent: true, exposed: false, retracted: false, preRegistered: true, passed: score.valid, replicates: score.n, failedOutputs: score.failures, reasons: score.reasons,
            monteCarloError: { bias: score.mcseBias, coverage: score.mcseCoverage, falsePositive: score.mcseFalsePositive } });
          if (!score.valid) failedCaseIds.add(testCase.id);
          continue;
        }
        let passed = true;
        for (let replicate = 0; replicate < (["release-replay", "development"].includes(purpose) && !scriptFreeWorkflow ? 2 : 1); replicate++) {
          let valid = false;
          let reason = "outside_reference_tolerance";
          try {
            let actual;
            if (scriptFreeWorkflow) {
              if (testCase.kind !== "workflow-smoke") throw new Error("Script-free workflows require independent workflow smoke cases.");
              const receipt = await evaluateWorkflowSmoke({ candidate: structuredClone(candidate), input: structuredClone(testCase.input), caseId: testCase.id, methodId, replicate, signal });
              if (!receipt?.runId || receipt.executed !== true) workflowResourcePending = true;
              if (receipt?.independent !== true || receipt.executed !== true || typeof receipt.runId !== "string" || !receipt.runId || !Array.isArray(candidate.executionTools) || !candidate.executionTools.length || !Array.isArray(receipt.toolsCalled) || !candidate.executionTools.every(tool => [...MCP_TOOL_BASE_NAMES,...MCP_TOOL_NAMES].includes(tool) && receipt.toolsCalled.includes(tool))) throw new Error("Workflow has no independently observed execution receipt.");
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
          // Whether the tool's own code started in the sandbox and then failed, as opposed to the sandbox not running it:
          // the first is the tool's defect (a release replay reads it as a regression), the second is a resource.
          const attempted = /** @type {any} */ (executionEvidence.findLast(row => row.caseId === testCase.id && row.replicate === replicate));
          assessments.push({ caseId: testCase.id, kind: testCase.kind, independent: true, exposed: exposure.tier !== "unexposed", retracted: false, crossImplementationPassed: testCase.independentImplementation ? valid : null, replicate, passed: valid, reason,
            ...(reason === "candidate_execution_failed" ? { candidateStarted: attempted?.executed === true && attempted.code === "candidate_execution_failed" } : {}) });
          passed = passed && valid;
        }
        if (!passed) failedCaseIds.add(testCase.id);
        else if (testCase.kind === "published") published.add(testCase.publicationId);
      }
      const kind = card.toolKind ?? candidate.toolKind ?? "calculation";
      const workflowSmoke = kind === "workflow" && assessments.some(row => row.kind === "workflow-smoke" && row.passed) && !failedCaseIds.size;
      // Reproducing the hidden numbers is necessary and not sufficient: a table of them does it too. The
      // behavioural checks run on inputs derived here and now, seeded by the frozen definition (which the
      // builder never sees), this candidate's bytes and the purpose, so no two candidates and no two
      // purposes meet the same derived inputs.
      const admittedPublished = (frozenDefinition.cases ?? []).filter(row => row.kind === "published" && row.hidden === true && row.independentQa?.passed === true && row.sourceHash && row.publicationId && row.numeric && row.input && typeof row.input === "object");
      const behaviourCases = reviewing ? admittedPublished : admittedPublished.filter(row=>caseSelection.cases.some(selected=>selected.id===row.id));
      let behaviour = null, notices = [];
      if (!scriptFreeWorkflow && behaviourCases.length && !failedCaseIds.size && (reviewing || published.size > 0)) {
        const seed = createHash("sha256").update(canonicalJson([evaluatorHash, candidate.files ?? {}, reviewing ? `sudden-perfect-review:${startedAt}` : "candidate-validation"])).digest("hex");
        const plan = behaviourPlan({ methodId, methodFamily: card.methodFamily ?? candidate.methodFamily ?? null, definition });
        try { behaviour = await behaviouralChecks({ candidate, cases: behaviourCases, plan, seed, signal, evidence: executionEvidence, purpose: "behavioural", known: new Set((definition.cases ?? []).filter(row => row.input).map(row => canonicalJson(row.input))) }); }
        catch (error) { signal?.throwIfAborted(); behaviour = { status: "unavailable", reason: "behavioural_execution_unavailable", referenceImplementation: plan.reference?.implementationId ?? null, relationChecks: 0, relationFailures: 0, freshCases: 0, freshFailures: 0, casesWithoutChecks: behaviourCases.length, cases: [] }; }
        if (!reviewing) notices = await referenceLiteralNotices(candidate, admittedPublished, signal);
      }
      if (reviewing) {
        // What the review adds to the evaluation it reviews: reserved cases no repair round has run, and
        // derived inputs drawn under another seed. With neither, the review module records that it could not be done.
        const reserved = new Set(assessments.filter(row => row.kind === "published").map(row => row.caseId));
        const heldOut = { reservedCases: reserved.size, reservedFailures: [...reserved].filter(id => failedCaseIds.has(id)).length, freshCases: behaviour?.freshCases ?? 0, relationChecks: behaviour?.relationChecks ?? 0 };
        const reviewed = !failedCaseIds.size && behaviour?.status === "passed";
        return finish({ ok: reviewed, verificationLevel: "V0", smokePassed: false, status: reviewed ? "verified" : failedCaseIds.size || behaviour?.status === "failed" ? "repair" : "waiting_resource", failedCaseIds: [...failedCaseIds], assessments, evaluatorHash, publishedReferenceCount: published.size, exposureTier: exposure.tier, behaviour, heldOut });
      }
      // A simulation establishes V1 only when every scenario passes and at least one of them could tell
      // the method from an estimator that always answers the null.
      const simulationPassed = simulationScores.length > 0 && simulationScores.every(score => score.valid) && simulationScores.some(score => score.discriminatesTrivial);
      const verificationLevel = published.size >= 2 && !failedCaseIds.size && exposure.tier === "unexposed" && behaviour?.status === "passed" ? "V2" : simulationPassed && !failedCaseIds.size ? "V1" : "V0";
      const ok = kind === "workflow" ? workflowSmoke : verificationLevel === "V2" || (definition.noPublishedExamples === true && verificationLevel === "V1");
      const generalisationFailed = behaviour?.status === "failed";
      // The last branch: every published case and behavioural check passed, and what keeps the candidate from V2 is the
      // exposure tier of its development chain. That wait used to carry no code at all (live acceptance, 2026-10-05: a
      // candidate that passed everything waited under `resourceCode: null`), and it is not a wait any validation material
      // ends — the chain keeps its worst tier, so only a new branch can publish.
      // A reference the builder named from its own memory is not in `exposure.tier` (evolutionExposureChain.mjs): it
      // changes neither the level nor the status. It is reported with the result, as a notice and as the list itself.
      const recall = referenceRecallNotices(exposure.recalled);
      const resourceCode = ok || failedCaseIds.size || generalisationFailed ? undefined : behaviour?.status === "unavailable" ? "behavioural_checks_unavailable"
        : simulationScores.length > 0 && simulationScores.every(score => score.valid) && !simulationPassed ? "simulation_cannot_discriminate_trivial_estimator"
        : kind !== "workflow" && published.size >= 2 && behaviour?.status === "passed" && exposure.tier !== "unexposed"
          ? (["exposed_uncited", "cited"].includes(exposure.tier) ? "development_chain_exposed" : "development_chain_exposure_unknown") : undefined;
      return finish({ ok, verificationLevel, smokePassed: workflowSmoke, status: ok ? "verified" : workflowResourcePending ? "waiting_resource" : failedCaseIds.size || generalisationFailed ? "repair" : "waiting_resource", failedCaseIds: [...failedCaseIds], assessments, evaluatorHash, publishedReferenceCount: published.size, exposureTier: exposure.tier,
        behaviour, notices: [...notices, ...recall], ...(recall.length ? { referenceRecall: exposure.recalled } : {}), ...(resourceCode ? { resourceCode } : {}), ...(generalisationFailed ? { issueCodes: ["candidate_generalisation_failed"] } : {}) });
      }catch(error){await finish({ok:false,status:"error",assessments:executionEvidence.map(item=>({caseId:item.caseId,replicate:item.replicate,passed:false,reason:"candidate_execution_failed"}))});throw error;}
    },
  };
}
