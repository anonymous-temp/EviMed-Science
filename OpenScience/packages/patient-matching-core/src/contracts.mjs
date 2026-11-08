import { array, check, digest, identifier, integer, object, oneOf, schema, strings, text, unique } from './validation.mjs'
import { assertScope, contentDigest, sourceIdentity, validateScope, validateSourceRef, validateSourceRefs } from './identity.mjs'
import { validateCriterionLogic } from './criterionLogic.mjs'

export const CLINICAL_ELIGIBILITY = Object.freeze(['eligible', 'ineligible', 'uncertain', 'not-assessed'])
export const WORK_STATES = Object.freeze(['complete', 'pending', 'failed', 'unsupported'])

export function pairIdentity(pair) {
  identifier(pair.subjectKey, 'pair.subjectKey')
  identifier(pair.trialId, 'pair.trialId')
  if (pair.armId !== undefined) identifier(pair.armId, 'pair.armId')
  return JSON.stringify([pair.subjectKey, pair.trialId, pair.armId ?? null])
}

function scoped(value, path) {
  object(value, path)
  schema(value, path)
  validateScope(value.scope, `${path}.scope`)
}

function span(value, path) {
  object(value, path, ['start', 'end'])
  integer(value.start, `${path}.start`)
  integer(value.end, `${path}.end`, value.start + 1)
}

function coverage(value, path) {
  object(value, path, ['state', 'limitations'])
  oneOf(value.state, ['complete', 'partial', 'unavailable'], `${path}.state`)
  strings(value.limitations, `${path}.limitations`)
}

export function validateMatchingTask(task) {
  scoped(task, 'task')
  identifier(task.taskId, 'task.taskId')
  oneOf(task.direction, ['patient-to-trials', 'protocol-to-patients', 'specified-pair'], 'task.direction')
  text(task.objective, 'task.objective')
  identifier(task.pluginGeneration, 'task.pluginGeneration')
  validateSourceRefs(task.sources, 'task.sources')
  array(task.selectedPairs, 'task.selectedPairs', pairIdentity)
  unique(task.selectedPairs, 'task.selectedPairs', pairIdentity)
  object(task.budgets, 'task.budgets', ['maxPairs', 'maxEvidenceReads', 'maxModelCalls'])
  integer(task.budgets.maxPairs, 'task.budgets.maxPairs', 1)
  integer(task.budgets.maxEvidenceReads, 'task.budgets.maxEvidenceReads')
  integer(task.budgets.maxModelCalls, 'task.budgets.maxModelCalls')
  check(task.selectedPairs.length <= task.budgets.maxPairs, 'task.selectedPairs', 'selected scope exceeds pair budget', 'budget_exceeded')
  if (task.direction === 'specified-pair') check(task.selectedPairs.length === 1, 'task.selectedPairs', 'specified-pair task needs exactly one pair')
  // The requester's assessment guide: labelling conventions configured for the study (or a benchmark's own task definition),
  // never a rule of the platform's. Absent by default.
  if (task.guide !== undefined) {
    object(task.guide, 'task.guide', ['title', 'text'])
    text(task.guide.title, 'task.guide.title')
    text(task.guide.text, 'task.guide.text')
    check(task.guide.text.length <= 12000, 'task.guide.text', 'assessment guide exceeds 12000 characters', 'budget_exceeded')
  }
  return task
}

export function validateClinicalContext(context) {
  scoped(context, 'context')
  identifier(context.contextId, 'context.contextId')
  identifier(context.subjectKey, 'context.subjectKey')
  text(context.revision, 'context.revision')
  validateSourceRefs(context.sources, 'context.sources')
  array(context.observations, 'context.observations', (item, path) => {
    object(item, path)
    identifier(item.observationId, `${path}.observationId`)
    oneOf(item.kind, ['stated', 'inferred', 'computed', 'conflicting', 'unavailable'], `${path}.kind`)
    check(Object.hasOwn(item, 'value'), `${path}.value`, 'explicit value or null required')
    strings(item.evidenceIds, `${path}.evidenceIds`)
    if (item.experiencer !== undefined) oneOf(item.experiencer, ['patient', 'family', 'other', 'unknown'], `${path}.experiencer`)
    if (item.negated !== undefined) check(typeof item.negated === 'boolean', `${path}.negated`, 'expected boolean')
    if (item.observedAt !== undefined && item.observedAt !== null) text(item.observedAt, `${path}.observedAt`)
    if (item.uncertainty !== undefined) text(item.uncertainty, `${path}.uncertainty`)
  })
  unique(context.observations, 'context.observations', (item) => item.observationId)
  coverage(context.coverage, 'context.coverage')
  return context
}

/** Validates addressing and graph references; it does not interpret clinical text or solve the graph. */
export function validateTrialProfile(profile) {
  scoped(profile, 'trialProfile')
  identifier(profile.trialId, 'trialProfile.trialId')
  validateSourceRef(profile.source, 'trialProfile.source')
  check(['protocol', 'registry'].includes(profile.source.kind), 'trialProfile.source.kind', 'expected protocol or registry')
  digest(profile.profileDigest, 'trialProfile.profileDigest')
  array(profile.criteria, 'trialProfile.criteria', (criterion, path) => {
    object(criterion, path)
    identifier(criterion.criterionId, `${path}.criterionId`)
    oneOf(criterion.kind, ['inclusion', 'exclusion', 'unclassified'], `${path}.kind`)
    text(criterion.text, `${path}.text`)
    span(criterion.span, `${path}.span`)
    // The words that introduce a group of bullets ("Cohort 2 must also have:") travel with each bullet as its premise.
    if (criterion.premise !== undefined) check(typeof criterion.premise === 'string' && criterion.premise.trim().length > 0 && criterion.premise.length <= 500, `${path}.premise`, 'expected text of at most 500 characters')
  })
  unique(profile.criteria, 'trialProfile.criteria', (criterion) => criterion.criterionId)
  const ids = new Set(profile.criteria.map((criterion) => criterion.criterionId))
  array(profile.arms, 'trialProfile.arms', (arm, path) => {
    object(arm, path)
    identifier(arm.armId, `${path}.armId`)
    strings(arm.criterionIds, `${path}.criterionIds`)
    unique(arm.criterionIds, `${path}.criterionIds`)
    for (const id of arm.criterionIds) check(ids.has(id), `${path}.criterionIds`, 'unknown criterion', 'invalid_id_mapping')
  })
  unique(profile.arms, 'trialProfile.arms', (arm) => arm.armId)
  if (profile.logic !== undefined) {
    const visited = new Set()
    const node = function(value, path, depth = 0) {
      check(depth < 64, path, 'criterion graph too deep')
      object(value, path)
      check(!visited.has(value), path, 'cyclic criterion graph')
      visited.add(value)
      oneOf(value.operator, ['and', 'or', 'not', 'criterion'], `${path}.operator`)
      if (value.operator === 'criterion') check(ids.has(value.criterionId), `${path}.criterionId`, 'unknown criterion', 'invalid_id_mapping')
      else {
        array(value.children, `${path}.children`)
        check(value.operator === 'not' ? value.children.length === 1 : value.children.length > 0, `${path}.children`, 'invalid operator arity')
        value.children.forEach((child, index) => node(child, `${path}.children[${index}]`, depth + 1))
      }
      visited.delete(value)
    }
    node(profile.logic, 'trialProfile.logic')
  }
  return profile
}

export function validateEvidenceBundle(bundle) {
  scoped(bundle, 'evidenceBundle')
  identifier(bundle.bundleId, 'evidenceBundle.bundleId')
  validateSourceRefs(bundle.sources, 'evidenceBundle.sources')
  const sources = new Map(bundle.sources.map((source) => [source.sourceId, sourceIdentity(source)]))
  /** @type {Array<[string, string[]]>} */
  const collections = [['patientPassages', ['patient']], ['knowledgePassages', ['knowledge', 'protocol', 'registry']]]
  for (const [collection, kinds] of collections) {
    array(bundle[collection], `evidenceBundle.${collection}`, (passage, path) => {
      object(passage, path)
      identifier(passage.evidenceId, `${path}.evidenceId`)
      validateSourceRef(passage.source, `${path}.source`)
      check(kinds.includes(passage.source.kind), `${path}.source.kind`, 'source class does not match collection')
      check(sources.get(passage.source.sourceId) === sourceIdentity(passage.source), `${path}.source`, 'passage source is absent or mismatched', 'source_mismatch')
      text(passage.text, `${path}.text`)
      span(passage.span, `${path}.span`)
      check(passage.span.end - passage.span.start === passage.text.length, `${path}.span`, 'UTF-16 span length differs from text')
      if (collection === 'patientPassages') identifier(passage.subjectKey, `${path}.subjectKey`)
      // Optional passage context (patient passages): position among the records, the record's date and the nearest heading.
      if (passage.recordIndex !== undefined) integer(passage.recordIndex, `${path}.recordIndex`, 1)
      if (passage.recordDate !== undefined && passage.recordDate !== null) check(typeof passage.recordDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(passage.recordDate), `${path}.recordDate`, 'expected an ISO date or null')
      if (passage.section !== undefined && passage.section !== null) check(typeof passage.section === 'string' && passage.section.length > 0 && passage.section.length <= 60, `${path}.section`, 'expected a heading of at most 60 characters or null')
    })
  }
  unique([...bundle.patientPassages, ...bundle.knowledgePassages], 'evidenceBundle.passages', (passage) => passage.evidenceId)
  strings(bundle.limitations, 'evidenceBundle.limitations')
  return bundle
}

/** Literal quote identity check only; an exact quote does not prove clinical entailment. */
export function verifyEvidencePassage(passage, { source, sourceText }) {
  validateSourceRef(source)
  validateSourceRef(passage.source)
  span(passage.span, 'passage.span')
  check(typeof sourceText === 'string', 'sourceText', 'expected decoded preserved source text')
  check(sourceIdentity(source) === sourceIdentity(passage.source) && contentDigest(sourceText) === source.digest, 'passage.source', 'source bytes or identity differ', 'source_mismatch')
  check(sourceText.slice(passage.span.start, passage.span.end) === passage.text, 'passage.span', 'passage differs from preserved source', 'quote_mismatch')
  return true
}

export function validateEvidenceNeed(need) {
  scoped(need, 'evidenceNeed')
  identifier(need.needId, 'evidenceNeed.needId')
  identifier(need.subjectKey, 'evidenceNeed.subjectKey')
  identifier(need.criterionId, 'evidenceNeed.criterionId')
  text(need.concept, 'evidenceNeed.concept')
  text(need.question, 'evidenceNeed.question')
  integer(need.maxReads, 'evidenceNeed.maxReads', 1)
  if (need.armId !== undefined) identifier(need.armId, 'evidenceNeed.armId')
  return need
}

export function validateDefinitionCard(card) {
  scoped(card, 'definitionCard')
  identifier(card.definitionId, 'definitionCard.definitionId')
  text(card.concept, 'definitionCard.concept')
  text(card.applicableScope, 'definitionCard.applicableScope')
  text(card.version, 'definitionCard.version')
  validateSourceRef(card.source, 'definitionCard.source')
  span(card.span, 'definitionCard.span')
  text(card.passage, 'definitionCard.passage')
  return card
}

export function validateComputationReceipt(receipt) {
  scoped(receipt, 'computation')
  identifier(receipt.receiptId, 'computation.receiptId')
  object(receipt.calculator, 'computation.calculator', ['id', 'version', 'digest'])
  identifier(receipt.calculator.id, 'computation.calculator.id')
  text(receipt.calculator.version, 'computation.calculator.version')
  digest(receipt.calculator.digest, 'computation.calculator.digest')
  oneOf(receipt.state, [...WORK_STATES, 'missing'], 'computation.state')
  array(receipt.operands, 'computation.operands', (operand, path) => {
    object(operand, path)
    identifier(operand.name, `${path}.name`)
    check(typeof operand.value === 'number' && Number.isFinite(operand.value), `${path}.value`, 'expected finite number')
    text(operand.unit, `${path}.unit`)
    validateSourceRef(operand.source, `${path}.source`)
    identifier(operand.evidenceId, `${path}.evidenceId`)
  })
  unique(receipt.operands, 'computation.operands', (operand) => operand.name)
  strings(receipt.missingInputs, 'computation.missingInputs')
  oneOf(receipt.exactCheck, ['verified', 'unverified', 'not-run'], 'computation.exactCheck')
  digest(receipt.cacheIdentity, 'computation.cacheIdentity')
  if (receipt.state === 'complete') {
    check(receipt.missingInputs.length === 0, 'computation.missingInputs', 'completed computation has missing inputs')
    object(receipt.result, 'computation.result', ['value', 'unit'])
    check((typeof receipt.result.value === 'number' && Number.isFinite(receipt.result.value)) || typeof receipt.result.value === 'boolean', 'computation.result.value', 'expected finite numeric or Boolean result')
    text(receipt.result.unit, 'computation.result.unit')
  } else check(receipt.result === null, 'computation.result', 'unfinished computation must not carry a result')
  return receipt
}

export function validateClinicalAssessment(assessment) {
  scoped(assessment, 'assessment')
  identifier(assessment.assessmentId, 'assessment.assessmentId')
  identifier(assessment.subjectKey, 'assessment.subjectKey')
  oneOf(assessment.kind, ['semantic-grade', 'computed'], 'assessment.kind')
  check(Object.hasOwn(assessment, 'value'), 'assessment.value', 'explicit value or null required')
  strings(assessment.evidenceIds, 'assessment.evidenceIds')
  strings(assessment.unresolvedAlternatives, 'assessment.unresolvedAlternatives')
  digest(assessment.profileDigest, 'assessment.profileDigest')
  if (assessment.kind === 'computed') identifier(assessment.receiptId, 'assessment.receiptId')
  else {
    identifier(assessment.definitionId, 'assessment.definitionId')
    identifier(assessment.executionId, 'assessment.executionId')
  }
  return assessment
}

export function validateCriterionMapping(criteria, expectedIds, { allowPartial = false } = {}) {
  array(criteria, 'criteria')
  array(expectedIds, 'expectedCriterionIds', identifier)
  unique(expectedIds, 'expectedCriterionIds')
  unique(criteria, 'criteria', (criterion) => criterion.criterionId)
  const expected = new Set(expectedIds)
  for (const criterion of criteria) check(expected.has(criterion.criterionId), 'criteria.criterionId', 'unrecognized criterion identity', 'invalid_id_mapping')
  if (!allowPartial) check(criteria.length === expected.size, 'criteria', 'criterion mapping is incomplete', 'invalid_id_mapping')
  return criteria
}

/** Clinical labels arrive from the model. Code checks their shape and support identities only.
 * @param {any} decision @param {{task?:any,trialProfile?:any,evidenceBundle?:any}} [options]
 */
export function validatePairDecision(decision, { task, trialProfile, evidenceBundle } = {}) {
  scoped(decision, 'decision')
  identifier(decision.decisionId, 'decision.decisionId')
  text(decision.revision, 'decision.revision')
  pairIdentity(decision)
  oneOf(decision.state, WORK_STATES, 'decision.state')
  oneOf(decision.clinicalEligibility, CLINICAL_ELIGIBILITY, 'decision.clinicalEligibility')
  if (decision.state !== 'complete') check(decision.clinicalEligibility === 'not-assessed', 'decision.clinicalEligibility', 'unfinished work cannot claim an eligibility verdict')
  object(decision.recommendation, 'decision.recommendation', ['priority', 'rationale'])
  const priority = decision.recommendation.priority
  check(priority === null || (typeof priority === 'number' && Number.isFinite(priority) && priority >= 0 && priority <= 1), 'decision.recommendation.priority', 'expected null or priority in [0, 1]')
  check(typeof decision.recommendation.rationale === 'string', 'decision.recommendation.rationale', 'expected text')
  array(decision.criteria, 'decision.criteria', (criterion, path) => {
    object(criterion, path)
    identifier(criterion.criterionId, `${path}.criterionId`)
    oneOf(criterion.kind, ['inclusion', 'exclusion'], `${path}.kind`)
    oneOf(criterion.verdict, ['satisfied', 'not-satisfied', 'unknown', 'not-applicable'], `${path}.verdict`)
    oneOf(criterion.basis, ['stated', 'silent', 'inferred', 'computed'], `${path}.basis`)
    strings(criterion.evidenceIds, `${path}.evidenceIds`)
    strings(criterion.assumptions, `${path}.assumptions`)
    text(criterion.reason, `${path}.reason`)
    validateCriterionLogic(criterion, path)
  })
  unique(decision.criteria, 'decision.criteria', (criterion) => criterion.criterionId)
  validateSourceRefs(decision.sourceRefs, 'decision.sourceRefs')
  const boundSources = new Map(decision.sourceRefs.map((source) => [source.sourceId, sourceIdentity(source)]))
  if (decision.state === 'complete') check(decision.sourceRefs.length > 0, 'decision.sourceRefs', 'completed decision requires source identity')
  digest(decision.profileDigest, 'decision.profileDigest')
  object(decision.producer, 'decision.producer', ['kind', 'modelProfileDigest', 'executionId'])
  oneOf(decision.producer.kind, ['model', 'runtime'], 'decision.producer.kind')
  if (decision.producer.kind === 'runtime') {
    object(decision, 'decision', ['schemaVersion','decisionId','revision','scope','subjectKey','trialId','armId','state','clinicalEligibility','recommendation','criteria','sourceRefs','profileDigest','producer','unresolvedFacts','assumptions','evidenceBundleId'])
    check(decision.state !== 'complete' && decision.clinicalEligibility === 'not-assessed' && priority === null && decision.recommendation.rationale === '' && decision.criteria.length === 0 && decision.unresolvedFacts?.length === 0 && decision.assumptions?.length === 0, 'decision.producer', 'runtime records cannot carry clinical judgments or facts')
  }
  digest(decision.producer.modelProfileDigest, 'decision.producer.modelProfileDigest')
  identifier(decision.producer.executionId, 'decision.producer.executionId')
  strings(decision.unresolvedFacts, 'decision.unresolvedFacts')
  strings(decision.assumptions, 'decision.assumptions')
  identifier(decision.evidenceBundleId, 'decision.evidenceBundleId')
  if (task) {
    validateMatchingTask(task)
    assertScope(task.scope, decision.scope, 'decision.scope')
    check(task.selectedPairs.some((pair) => pairIdentity(pair) === pairIdentity(decision)), 'decision', 'pair is outside selected scope', 'invalid_id_mapping')
  }
  if (trialProfile) {
    validateTrialProfile(trialProfile)
    assertScope(decision.scope, trialProfile.scope, 'trialProfile.scope')
    check(trialProfile.trialId === decision.trialId, 'decision.trialId', 'trial profile differs', 'invalid_id_mapping')
    if (decision.state === 'complete') check(boundSources.get(trialProfile.source.sourceId) === sourceIdentity(trialProfile.source), 'decision.sourceRefs', 'trial profile source is not bound to decision', 'source_mismatch')
    let criteria = trialProfile.criteria
    if (decision.armId !== undefined) {
      const arm = trialProfile.arms.find((item) => item.armId === decision.armId)
      check(arm, 'decision.armId', 'arm absent from trial profile', 'invalid_id_mapping')
      criteria = criteria.filter((criterion) => arm.criterionIds.includes(criterion.criterionId))
    }
    validateCriterionMapping(decision.criteria, criteria.map((criterion) => criterion.criterionId), { allowPartial: decision.state !== 'complete' })
    for (const criterion of decision.criteria) check(['unclassified', criterion.kind].includes(criteria.find((item) => item.criterionId === criterion.criterionId)?.kind), 'decision.criteria.kind', 'criterion kind differs from source profile', 'invalid_id_mapping')
  }
  if (evidenceBundle) {
    validateEvidenceBundle(evidenceBundle)
    assertScope(decision.scope, evidenceBundle.scope, 'evidenceBundle.scope')
    check(decision.evidenceBundleId === evidenceBundle.bundleId, 'decision.evidenceBundleId', 'evidence bundle differs', 'invalid_id_mapping')
    if (decision.state === 'complete') for (const source of evidenceBundle.sources) {
      check(boundSources.get(source.sourceId) === sourceIdentity(source), 'decision.sourceRefs', 'evidence context source is not bound to decision', 'source_mismatch')
    }
    if (decision.criteria.some(criterion => criterion.basis === 'computed')) {
      const computations = evidenceBundle.computations ?? []
      array(computations, 'evidenceBundle.computations')
      check(computations.some(receipt => { validateComputationReceipt(receipt); assertScope(decision.scope, receipt.scope); return receipt.state === 'complete' }), 'decision.criteria.basis', 'computed judgment requires a preserved complete computation', 'missing_computation')
    }
    const evidence = new Map([...evidenceBundle.patientPassages, ...evidenceBundle.knowledgePassages].map((passage) => [passage.evidenceId, passage]))
    for (const criterion of decision.criteria) for (const id of [...criterion.evidenceIds, ...(criterion.parts ?? []).flatMap((part) => part.evidenceIds)]) {
      const passage = evidence.get(id)
      check(passage, 'decision.criteria.evidenceIds', 'unknown evidence identity', 'invalid_id_mapping')
      check(passage.subjectKey === undefined || passage.subjectKey === decision.subjectKey, 'decision.criteria.evidenceIds', 'evidence belongs to another subject', 'scope_mismatch')
      check(boundSources.get(passage.source.sourceId) === sourceIdentity(passage.source), 'decision.sourceRefs', 'evidence source is not bound to decision', 'source_mismatch')
    }
  }
  return decision
}
