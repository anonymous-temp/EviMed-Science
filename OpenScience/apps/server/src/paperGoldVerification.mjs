import { createHash } from "node:crypto";
import { numericScore, digest } from "../../../evals/paper-gold/evaluator.mjs";
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
/** Descriptor and independent reference must come from the frozen control-plane gold, never a runtime artifact or LLM.
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
  try {
    for (let replicate = 0; replicate < 2; replicate++) {
      signal?.throwIfAborted();
      const result = await controller.execVerify({ files, code, input: spec.input, dependencyIds: spec.dependencyIds ?? [] }, { signal });
      if (result.ok !== true || result.joined !== true || result.executionStarted !== true) return reject("isolated_replay_incomplete");
      const output = String(result.output ?? result.stdout ?? "");
      const numeric = flatten(JSON.parse(output.trim().split("\n").at(-1)));
      if (!compare(numeric) || references.some(([key]) => !numericScore(numeric[key], { ...spec.tolerances[key], value: unit.numeric[key], interval: undefined }).valid)) return reject("isolated_replay_disagrees");
      outputHashes.push(createHash("sha256").update(output).digest("hex"));
    }
  } catch (error) { signal?.throwIfAborted(); return reject("isolated_replay_failed"); }
  const proof = { kind: "isolated-independent-replay", replicates: 2, sourceHash: gold.sourceHash, inputHash: spec.inputHash,
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

/** Runtime-authored checks are never a control-plane stage assessment. @param {any} request */
export function bindPaperGoldStageAssessment({result,config,unit,gold}){
 const names=[...new Set(Object.values(gold.stageChecks??{}).flat())],allowed=new Set((gold.preservedEvidence??[]).map(row=>row.id));
 const independent=config.reviewProvider==="dashscope" && /^qwen/i.test(result.model??"") && result.modelReported===true && unit.modelFamily!=="qwen";
 const evidenceIds=result.value?.evidenceIds;
 const bonded=Array.isArray(evidenceIds)&&evidenceIds.length>0&&evidenceIds.every(id=>allowed.has(id));
 const checks=Object.fromEntries(names.map(name=>[name,independent&&bonded&&result.value?.checks?.[name]===true]));
 return {...unit,checks,independentAssessment:independent&&bonded,assessmentModel:independent&&bonded?result.model:null,assessmentEvidenceIds:independent&&bonded?evidenceIds:[],gaps:[...new Set([...(unit.gaps??[]),...(result.value?.gaps??[])])]};
}
