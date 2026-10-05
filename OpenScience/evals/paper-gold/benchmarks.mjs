import { digest } from './evaluator.mjs';
/** Derive the three executable rulers from admitted control-plane evidence without more model calls.
 * Method inputs are intentionally disclosed; reference outputs stay in the evaluator.
 * @param {any} definition @param {any[]} [methodDefinitions]
 */
export function deriveBenchmarkDefinition(definition, methodDefinitions = []) {
  const cases = [], gaps = (definition.unavailable ?? []).flatMap(row => ['method', 'research', 'question'].map(type => ({ caseId: row.id, type, reason: row.reason ?? 'independent_primary_qa_unavailable' })));
  for (const original of definition.cases ?? []) {
    if (original.type === 'question') {
      cases.push(original);
      cases.push({ ...original, id: `${original.id}-research-input-unavailable`, type: 'research', gold: { ...original.gold, benchmarkScope: 'research-input-unavailable', inputAvailable: false } });
      gaps.push(...(original.unsupportedRulers ?? []).map(row => ({ caseId: original.id, ...row })));
      continue;
    }
    const question = { ...original, id: `${original.id}-question`, type: 'question', input: original.rewrite.question,
      gold: { ...original.gold, applicableStages: original.gold.inputAvailable === false ? ['question','method','certainty','writing'] : undefined } };
    cases.push(question);
    if (original.gold.inputAvailable === true) cases.push({ ...original, type: 'research' });
    else {
      cases.push({ ...original, id: `${original.id}-research-input-unavailable`, type: 'research', gold: { ...original.gold, benchmarkScope: 'research-input-unavailable', inputAvailable: false, applicableStages: ['question','method','certainty','writing'] } });
      gaps.push({ caseId: original.id, type: 'research', reason: 'same_version_inputs_unavailable' });
    }
    gaps.push({ caseId: original.id, type: 'method', reason: 'published_inputs_not_independently_reproduced' });
  }
  for (const method of methodDefinitions) {
    if (method.frozen !== true) throw new Error('Method references must already be frozen.');
    for (const reference of method.cases ?? []) {
      if (reference.kind !== 'published' || reference.independentQa?.passed !== true || !reference.independentImplementation || !reference.sourceHash || !reference.input || !reference.numeric) continue;
      const question = `Prepare a numerical methods report applying ${method.methodId.replaceAll('-', ' ')} to the supplied published input specification. State assumptions and compute the specified analysis outputs.`;
      const variants = [question, `Produce a numerical methods report for ${method.methodId.replaceAll('-', ' ')} using the supplied inputs; explain assumptions and analysis outputs.`, `Analyze the supplied input specification with ${method.methodId.replaceAll('-', ' ')} and deliver a methods report with assumptions and numerical outputs.`];
      const engine = /^meta-reml-published-data/.test(method.methodId) ? { track: 'E', engineId: 'meta', capabilityId: 'meta-analysis' }
        : /^mr-ivw-published-data/.test(method.methodId) ? { track: 'P', engineId: 'mr', capabilityId: 'mendelian-randomization' }
          : (method.methodId === 'faers-ror-aggregate' || /^faers-ror-published-data/.test(method.methodId)) ? { track: 'P', engineId: 'pharmacovigilance', capabilityId: 'adr-analysis' } : { track: 'M', engineId: null, capabilityId: 'statistical-analysis' };
      const track = reference.track ?? method.track ?? engine.track;
      cases.push({ id: `method-${reference.id}`, publicationId: reference.publicationId, sourceHash: reference.sourceHash, type: 'method', track: ({ meta: 'E', pharmacovigilance: 'P', mr: 'P' }[track] ?? track), group: 'calibration', engineId: engine.engineId, capabilityId: engine.capabilityId,
        rewrite: { writer: 'deterministic-method-template-v1', qaExecutor: 'frozen-independent-reference-qa', qaPassed: true, question, variants },
        input: `${question}\nPublished analysis inputs: ${JSON.stringify(reference.input)}\nDeliver scripts/analysis.py with callable analyze(**arguments) accepting the supplied input object's keyword fields and returning a JSON-compatible object with these output fields: ${Object.keys(reference.numeric).join(', ')}. Also write its actual numeric JSON receipt.`,
        policy: { aliases: [...new Set([reference.publicationId,...(reference.aliases ?? [])])], titles: reference.title ? [reference.title] : [] },
        dois: /^10\.\d{4,9}\//.test(reference.publicationId) ? [reference.publicationId] : [],
        gold: { numeric: reference.numeric, inputAvailable: true, applicableStages: ['method','calculation'], stageChecks: { method: ['method_supported'] },
          sourceHash: reference.sourceHash, independentImplementation: reference.independentImplementation,
          deterministicVerification: { entrypoint: 'scripts/analysis.py:analyze', implementationId: 'runtime-method-analysis', input: reference.input,
            inputHash: digest(reference.input), sourceHash: reference.sourceHash, independentQa: reference.independentQa,
            independentImplementation: { ...reference.independentImplementation, sourceHash: reference.sourceHash },
            tolerances: Object.fromEntries(Object.entries(reference.numeric).map(([key, value]) => [key, { absoluteTolerance: value.absoluteTolerance ?? 0, relativeTolerance: value.relativeTolerance ?? 0 }])) },
          preservedEvidence: [{ id: reference.id, sourceHash: reference.sourceHash }], reachableEvidenceIds: [], unreachableEvidenceIds: [] } });
    }
  }
  return { ...definition, schemaVersion: 1, derivedFrom: definition.sourceManifestHash ?? null, cases, benchmarkGaps: gaps, status: 'derived_from_admitted_evidence_not_live_scored' };
}
