import { createHash } from "node:crypto";
import { numericScore, digest } from "../../../evals/paper-gold/evaluator.mjs";
import { applyRelation, relationIssues, seededRandom } from "../../../evals/paper-gold/behavioural.mjs";
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const flatten = (node, prefix = "", result = {}) => {
  if (!node || typeof node !== "object") return result;
  for (const [key, value] of Object.entries(node)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (Number.isFinite(value)) result[name] = value;
    else if (value && typeof value === "object") flatten(value, name, result);
  }
  return result;
};
/**
 * Replay the code a run delivered, in isolation, and decide whether it computes its result.
 *
 * The descriptor and the independent reference come from the frozen control-plane gold, never from a
 * runtime artifact or a model. Replaying on the descriptor's input alone is not enough: that input was
 * disclosed to the run, so `def analyze(**kw): return {...constants...}` replays identically. The replay
 * therefore also runs the descriptor's metamorphic relations (`behavioural.mjs`) on transformed inputs
 * the run never saw, and at least one of them has to be a relation a function that ignores its input
 * cannot satisfy. A descriptor without such a relation cannot verify code: `behavioural_replay_unavailable`.
 * @param {any} request */
export async function verifyPaperGoldCode({ controller, unit, gold, signal }) {
  const reject = reason => ({ verified: false, reason });
  const spec = gold?.deterministicVerification;
  if (!spec) return reject("deterministic_verification_unavailable");
  if (!controller?.execVerify) return reject("isolated_verification_unavailable");
  const match = /^((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.py):([A-Za-z_][A-Za-z0-9_]*)$/.exec(spec.entrypoint ?? "");
  const independent = spec.independentImplementation;
  if (!match || !hex(gold.sourceHash) || spec.sourceHash !== gold.sourceHash || !Object.hasOwn(spec, "input") || spec.inputHash !== digest(spec.input)
    || spec.independentQa?.passed !== true || !spec.independentQa.executor || !spec.implementationId
    || !independent?.implementationId || independent.implementationId === spec.implementationId || independent.sourceHash !== gold.sourceHash) return reject("verification_descriptor_not_bound");
  const references = Object.entries(independent.numeric ?? {});
  if (!references.length || references.some(([key, value]) => !Number.isFinite(value) || !spec.tolerances?.[key]
    || ![spec.tolerances[key].absoluteTolerance ?? 0, spec.tolerances[key].relativeTolerance ?? 0].every(number => Number.isFinite(number) && number >= 0))) return reject("independent_reference_invalid");
  // Every disputed published outcome needs independent coverage, not just a convenient matching subset.
  if (Object.keys(gold.numeric ?? {}).some(key => !Object.hasOwn(independent.numeric, key))) return reject("independent_reference_incomplete");
  const files = {};
  for (const artifact of unit.assessmentEvidence?.deliveredText ?? []) {
    if (/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.py$/.test(artifact.path ?? "") && typeof artifact.text === "string") files[artifact.path] = artifact.text;
  }
  if (!Object.hasOwn(files, match[1]) || Object.keys(files).length > 64 || Object.values(files).reduce((sum, code) => sum + Buffer.byteLength(String(code)), 0) > 4 * 1024 * 1024) return reject("delivered_code_unavailable");
  const compare = numeric => references.every(([key, value]) => numericScore(numeric?.[key], { ...spec.tolerances[key], value, interval: undefined }).valid);
  if (!compare(unit.numeric)) return reject("reported_result_disagrees_with_independent_implementation");
  const code = `import json,runpy,sys\nnamespace=runpy.run_path(${JSON.stringify(`/candidate/${match[1]}`)},run_name='independent_replay')\nresult=namespace[${JSON.stringify(match[2])}](**json.load(sys.stdin))\nprint(json.dumps(result,allow_nan=False))\n`;
  const outputHashes = [];
  let baseOutput = null, behaviouralChecks = 0;
  try {
    for (let replicate = 0; replicate < 2; replicate++) {
      signal?.throwIfAborted();
      const result = await controller.execVerify({ files, code, input: spec.input, dependencyIds: spec.dependencyIds ?? [] }, { signal });
      if (result.ok !== true || result.joined !== true || result.executionStarted !== true) return reject("isolated_replay_incomplete");
      const output = String(result.output ?? result.stdout ?? "");
      baseOutput = JSON.parse(output.trim().split("\n").at(-1));
      const numeric = flatten(baseOutput);
      if (!compare(numeric) || references.some(([key]) => !numericScore(numeric[key], { ...spec.tolerances[key], value: unit.numeric[key], interval: undefined }).valid)) return reject("isolated_replay_disagrees");
      outputHashes.push(createHash("sha256").update(output).digest("hex"));
    }
    // Inputs the run never saw. A relation only counts when the unchanged output would break it, so a constant cannot pass.
    const relations = (Array.isArray(spec.relations) ? spec.relations : []).filter(relation => relationIssues(relation).length === 0)
      .map((relation, index) => applyRelation(relation, spec.input, seededRandom(`${spec.inputHash}:${digest(files)}:${index}`))).filter(Boolean);
    const discriminating = relations.filter(relation => { try { return relation.check(baseOutput, baseOutput) === false; } catch { return false; } });
    if (!discriminating.length) return reject("behavioural_replay_unavailable");
    for (const relation of relations) {
      signal?.throwIfAborted();
      const result = await controller.execVerify({ files, code, input: relation.input, dependencyIds: spec.dependencyIds ?? [] }, { signal });
      if (result.joined !== true || result.executionStarted !== true) return reject("isolated_replay_incomplete");
      let held = false;
      try { held = result.ok === true && relation.check(baseOutput, JSON.parse(String(result.output ?? result.stdout ?? "").trim().split("\n").at(-1))); } catch { held = false; }
      if (!held) return reject("behavioural_replay_failed");
      behaviouralChecks++;
    }
  } catch (error) { signal?.throwIfAborted(); return reject("isolated_replay_failed"); }
  const proof = { kind: "isolated-independent-replay", replicates: 2, behaviouralChecks, sourceHash: gold.sourceHash, inputHash: spec.inputHash,
    codeHash: digest(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))), referenceHash: digest(independent), outputHashes };
  return { verified: true, proof: { ...proof, proofHash: digest(proof) } };
}

/** Independent model verdict is meaningful only after actual provider identity and source IDs are established. @param {any} request */
export function bindPaperGoldReview({ result, config, unit, gold, verification }) {
  const expectedIds = new Set((gold.preservedEvidence ?? []).map(row => row.id));
  const independent = config.reviewProvider === "dashscope" && /^qwen/i.test(result.model ?? "") && result.modelReported === true && unit.modelFamily !== "qwen";
  if (!independent || !result.value?.evidenceIds?.length || result.value.evidenceIds.some(id => !expectedIds.has(id))) throw new Error("Disagreement requires actual cross-family review and preserved evidence IDs.");
  const used = new Set(result.value.evidenceIds);
  const inspectable = (gold.preservedEvidence ?? []).some(row => used.has(row.id) && hex(row.sourceHash) && row.supportsPaperAdjudication !== false
    && ((["primary-publication","primary-author-aggregate","primary-author-context"].includes(row.kind) && typeof row.text === "string" && row.text.trim() && row.textHash === createHash("sha256").update(row.text).digest("hex"))
      || (Array.isArray(row.numericQuotes) && row.numericQuotes.some(quote => typeof quote === "string" && quote.trim()))));
  if (["paper_error","reasonable_difference"].includes(result.value.verdict) && !inspectable) verification = {verified:false,reason:"primary_evidence_uninspectable"};
  // Never spread a model's alleged codeVerified/proof fields across this control boundary.
  return { verdict: result.value.verdict, evidenceIds: result.value.evidenceIds, reason: result.value.reason,
    reviewerFamily: "qwen", reviewerModel: result.model, codeVerified: verification.verified === true,
    ...(verification.verified ? { verificationProof: verification.proof } : { verificationFailure: verification.reason }) };
}

/**
 * Runtime-authored checks are never a control-plane stage assessment.
 *
 * An assessment counts as the independent one when a model of another family than the producer's, whose identity the provider
 * reported, cites at least one preserved evidence id of the gold and cites nothing the control plane did not show it. What the
 * control plane showed it is the gold's preserved evidence (by id) and the unit's own delivered files (by path, `deliveredText`):
 * the prompt tells the assessor to judge the delivered code, so naming a delivered file beside the evidence ids is a reference to
 * material it was handed, not an invented source. Those path citations are ignored for the bond and recorded on the unit
 * (`assessmentCitedDeliveredFiles`). On release 6 one of six assessments cited three delivered paths beside both preserved ids, was
 * dropped whole although its four checks were true and the unit's calculation was code-verified, and the unit read 4 of 6 valid
 * where the reviewer's verdicts said 5. Any other citation is still a refusal, and every refusal is a named reason on the unit
 * (`assessmentRefusal`), never a silent drop.
 * @param {any} request */
export function bindPaperGoldStageAssessment({result,config,unit,gold}){
 const names=[...new Set(Object.values(gold.stageChecks??{}).flat())],preserved=new Set((gold.preservedEvidence??[]).map(row=>row.id));
 const shown=new Set((unit.assessmentEvidence?.deliveredText??[]).map(row=>row.path).filter(path=>typeof path==="string"));
 const providerReported=config.reviewProvider==="dashscope" && /^qwen/i.test(result.model??"") && result.modelReported===true;
 const sameFamily=unit.modelFamily==="qwen";
 const evidenceIds=result.value?.evidenceIds;
 const cited=Array.isArray(evidenceIds)?evidenceIds.filter(id=>typeof id==="string"):[];
 const citedPreserved=cited.filter(id=>preserved.has(id)),citedFiles=cited.filter(id=>!preserved.has(id)&&shown.has(id)),citedUnknown=cited.filter(id=>!preserved.has(id)&&!shown.has(id));
 const refusal=!providerReported?{code:"assessment_model_identity_unconfirmed"}:sameFamily?{code:"assessment_same_family_as_producer"}
  :!Array.isArray(evidenceIds)||!citedPreserved.length?{code:"assessment_cites_no_preserved_evidence"}
  :citedUnknown.length?{code:"assessment_cites_unknown_evidence",evidenceIds:citedUnknown.slice(0,20)}:null;
 const accepted=refusal===null;
 const checks=Object.fromEntries(names.map(name=>[name,accepted&&result.value?.checks?.[name]===true]));
 return {...unit,checks,independentAssessment:accepted,assessmentModel:accepted?result.model:null,assessmentEvidenceIds:accepted?citedPreserved:[],assessmentCitedDeliveredFiles:accepted?citedFiles:[],assessmentRefusal:refusal,gaps:[...new Set([...(unit.gaps??[]),...(result.value?.gaps??[])])]};
}
