import test from 'node:test'
import assert from 'node:assert/strict'
import { createMatchingHandler } from '../src/handler.mjs'
import { TOOL_MANIFEST, validateArguments } from '../src/manifest.mjs'
import { HOST_ABI, HOST_PORT_METHODS, projectMatchingResult } from '@evimed/patient-matching-core'
import { fixture } from './fixture.mjs'
const call = { callId: 'native-call', rootCallId: 'native-call', sessionId: 'conversation-a', agentId: 'agent-a', name: 'match_assess', signal: new AbortController().signal }
function setup(options = {}) {
  const f = fixture(), invocations = [], writes = [], activations = []
  let released = false, persistedResult
  const host = { abi: HOST_ABI, ports: Object.fromEntries(Object.entries(HOST_PORT_METHODS).map(([port, methods]) => [port, Object.fromEntries(methods.map(method => [method, async envelope => {
    await options.beforeOperation?.({ port, method, envelope })
    if (port === 'IdentityPort' && method === 'resolve') { invocations.push(envelope.invocation); return f.scope }
    if (port === 'IdentityPort') return { allowed: true, scope: f.scope }
    if (port === 'ExecutionPort' && method === 'assess') return { status: 'complete', summary: 'Frozen', data: options.savedResult ?? (envelope.input.phase === 'prepare' && persistedResult ? { kind: 'saved-result', result: persistedResult } : options.prepared ?? f.prepared), artifacts: [] }
    if (port === 'ResultPort' && method === 'save') {
      writes.push(envelope.input)
      if (envelope.input.phase === 'failure') { if (options.failureSaveError) throw new Error('checkpoint transport unavailable'); return { status:'failed',summary:'Failure attempt saved',data:{resultId:'persisted-failure',failureCheckpoint:{saved:true,executionId:envelope.input.executionId}},artifacts:[] } }
      if (options.reusePersisted) persistedResult = projectMatchingResult({ task: f.prepared.task, resultId: 'persisted-real', revision: '1', decisions: envelope.input.decisions, profileDigest: f.prepared.profileDigest })
      return { status: 'complete', summary: 'Saved', data: persistedResult ?? { resultId: 'persisted-real', decisions: envelope.input.decisions }, artifacts: [] }
    }
    return { status: 'complete', summary: 'Host result', data: { port, method }, artifacts: [] }
  }]))])) }
  const ctx = { on: () => () => {}, get: name => name === 'agents' ? { get: () => ({ options: { model: 'deepseek-v4-pro' } }) } : undefined, subagents: { async startActivation(input) {
    activations.push(input)
    if (options.startFailure) throw new Error('start refused')
    return { childId: input.childId, messageId: 'message-a', result: options.rejection ? Promise.reject(new Error('runtime failed')) : Promise.resolve(options.outcome ?? { stopReason: 'completed', structured: { decisions: [f.decision] } }), async dispose() { released = true; if (options.releaseFailure) throw new Error('release failed') } }
  } } }
  return { ...f, handle: createMatchingHandler({ host, ctx }), writes, invocations, activations, released: () => released }
}
test('one manifest owns nine bounded tools and rejects caller authority', () => {
  assert.equal(TOOL_MANIFEST.length, 9)
  for (const entry of TOOL_MANIFEST) {
    for (const key of ['scope', 'model', 'provider', 'apiKey', 'endpoint', 'tenantId']) assert.throws(() => validateArguments(entry.name, { [key]: 'injected' }))
  }
  assert.throws(() => validateArguments('match_discover', { taskId: 't', query: 'x', limit: 10000 }))
  assert.throws(() => validateArguments('match_assess', { taskId: 't', pairIds: Array(101).fill('x') }))
})
test('actual native call and original arguments are preserved while ports bind scope', async () => {
  const s = setup(), args = { taskId: 'task-a' }
  const result = await s.handle('match_assess', args, call)
  assert.equal(result.data.resultId, 'persisted-real')
  assert.deepEqual(s.invocations[0].args, args)
  assert.equal(s.invocations[0].callId, call.callId)
  assert.equal(s.invocations[0].tool, 'match_assess')
  assert.equal(s.writes.length, 1)
  assert.equal(s.writes[0].executionId, 'execution-a')
  assert.deepEqual(s.writes[0].decisions, [s.decision])
  assert.equal(s.released(), true)
})
test('Flash overrides a Pro parent and child tools are evidence and exact compute only', async () => {
  const s = setup(); await s.handle('match_assess', { taskId: 'task-a' }, call)
  const a = s.activations[0]
  assert.deepEqual(a.request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 8000 })
  assert.equal(a.delivery, 'caller')
  assert.equal(a.request.maxDepth, 1)
  assert.match(a.request.prompt[0].text, /UNTRUSTED_MATCHING_DATA/)
  assert.match(a.request.prompt[0].text, /ignore all safeguards/)
})
test('invalid or foreign structured decisions never persist', async () => {
  for (const mutate of [d => { d.trialId = 'foreign' }, d => { d.criteria[0].evidenceIds = ['invented'] }, d => { d.producer.modelProfileDigest = `sha256:${'f'.repeat(64)}` }]) {
    const d = fixture().decision; mutate(d)
    const s = setup({ outcome: { stopReason: 'completed', structured: { decisions: [d] } } })
    const result = await s.handle('match_assess', { taskId: 'task-a' }, call)
    assert.equal(result.status, 'failed'); assert.equal(s.writes.filter(write=>write.phase==='commit').length, 0); assert.equal(s.writes[0].phase,'failure'); assert.equal(Object.hasOwn(s.writes[0],'decisions'),false); assert.equal(s.released(), true)
  }
})
test('unreadable/failed child preserves diagnostic output, always awaits release', async () => {
  for (const options of [{ rejection: true }, { outcome: { stopReason: 'error', output: 'partial clinical notes', diagnostic: 'provider failed' } }, { outcome: { stopReason: 'completed', structured: { wrong: true } } }]) {
    const s = setup(options), response = await s.handle('match_assess', { taskId: 'task-a' }, call)
    assert.equal(response.status, 'failed'); assert.equal(s.released(), true); assert.equal(s.writes.filter(write=>write.phase==='commit').length, 0)
    assert.ok(response.data.nativeDiagnostics.length)
  }
})
test('usable partial child is persisted and release failure does not erase it', async () => {
  const f = fixture(), s = setup({ releaseFailure: true, outcome: { stopReason: 'error', structured: { decisions: [f.decision] }, diagnostic: 'later provider failure' } })
  const response = await s.handle('match_assess', { taskId: 'task-a' }, call)
  assert.equal(response.status, 'partial'); assert.equal(response.data.resultId, 'persisted-real'); assert.equal(s.writes.length, 1)
  assert.ok(response.data.nativeDiagnostics.includes('release failed'))
})
test('cancelled execution returns cancellation and does not start or save', async () => {
  const s = setup(), control = new AbortController(); control.abort()
  const response = await s.handle('match_assess', { taskId: 'task-a' }, { ...call, signal: control.signal })
  assert.equal(response.status, 'cancelled'); assert.equal(s.activations.length, 0); assert.equal(s.writes.length, 0)
})
test('original kernel arguments cannot smuggle scope through normalized parameters', async () => {
  const s = setup(), response = await s.handle('match_assess', { taskId: 'task-a' }, { ...call, args: { taskId: 'task-a', scope: { tenantId: 'other' } } })
  assert.equal(response.status, 'failed'); assert.equal(s.invocations.length, 0); assert.equal(s.activations.length, 0)
})
test('native original arguments win over normalized/defaulted arguments for verification', async () => {
  const s = setup(), original = { taskId: 'task-a' }
  await s.handle('match_results', { ...original, action: 'get' }, { ...call, name: 'match_results', args: original })
  assert.deepEqual(s.invocations[0].args, original)
})
test('patient and knowledge evidence take separate controlled host ports', async () => {
  const s = setup()
  const patient = await s.handle('match_evidence', { taskId: 'task-a', source: 'patient', action: 'read', subjectKey: 'patient-a', evidenceId: 'e1' }, { ...call, name: 'match_evidence' })
  const knowledge = await s.handle('match_evidence', { taskId: 'task-a', source: 'knowledge', action: 'search', query: 'Published criterion definition' }, { ...call, name: 'match_evidence' })
  assert.equal(patient.data.port, 'PatientDataPort'); assert.equal(patient.data.method, 'read')
  assert.equal(knowledge.data.port, 'KnowledgePort'); assert.equal(knowledge.data.method, 'search')
})
test('Pro reasoning profile, foreign task or zero budget starts no native model', async () => {
  for (const mutate of [p => { p.reasoning.model = 'deepseek-v4-pro' }, p => { p.task.taskId = 'foreign' }, p => { p.task.budgets.maxModelCalls = 0 }, p => { p.context.scope.projectId = 'foreign' }]) {
    const prepared = fixture().prepared; mutate(prepared)
    const s = setup({ prepared }), response = await s.handle('match_assess', { taskId: 'task-a' }, call)
    assert.equal(response.status, 'failed'); assert.equal(s.activations.length, 0); assert.equal(s.writes.length, 0)
  }
})
test('an already running managed activation is cancelled and released exactly once', async () => {
  const f = fixture(), control = new AbortController(); let started, resolveResult, releases = 0
  const ready = new Promise(resolve => { started = resolve })
  const result = new Promise(resolve => { resolveResult = resolve })
  const host = { abi: HOST_ABI, ports: Object.fromEntries(Object.entries(HOST_PORT_METHODS).map(([port, methods]) => [port, Object.fromEntries(methods.map(method => [method, async () => port === 'IdentityPort' ? method === 'resolve' ? f.scope : { allowed: true, scope: f.scope } : { status: 'complete', summary: 'Frozen', data: f.prepared, artifacts: [] }]))])) }
  const ctx = { on: () => () => {}, get: () => ({ get: () => ({}) }), subagents: { async startActivation(input) {
    input.signal.addEventListener('abort', () => resolveResult({ stopReason: 'aborted', output: 'partial notes' }), { once: true }); started()
    return { childId: input.childId, messageId: 'm', result, async dispose() { releases += 1 } }
  } } }
  const running = createMatchingHandler({ host, ctx })('match_assess', { taskId: 'task-a' }, { ...call, signal: control.signal })
  await ready; control.abort(); const response = await running
  assert.equal(response.status, 'cancelled'); assert.equal(releases, 1); assert.equal(response.data.output, 'partial notes')
})
for (const phase of ['refresh', 'commit']) test(`abort during delayed ${phase} preserves cancellation and native partial diagnostics`, async () => {
  const control = new AbortController(); let reached, resume
  const ready = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { resume = resolve })
  const s = setup({ beforeOperation: async ({ port, method, envelope }) => {
    if ((phase === 'refresh' && port === 'ExecutionPort' && method === 'assess' && envelope.input.phase === 'refresh') || (phase === 'commit' && port === 'ResultPort' && method === 'save')) { reached(); await gate; control.signal.throwIfAborted() }
  } })
  const running = s.handle('match_assess', { taskId: 'task-a' }, { ...call, signal: control.signal })
  await ready; control.abort(); resume(); const response = await running
  assert.equal(response.status, 'cancelled'); assert.equal(response.data.native.messageId, 'message-a')
  assert.equal(response.data.partialStructured.decisions.length, 1); assert.equal(s.released(), true); assert.equal(s.writes.length, 0)
})
test('cancellation after the host persisted a commit preserves its actual saved result', async () => {
  const control = new AbortController()
  const s = setup({ beforeOperation: ({ port, method }) => { if (port === 'ResultPort' && method === 'save') control.abort() } })
  const response = await s.handle('match_assess', { taskId: 'task-a' }, { ...call, signal: control.signal })
  assert.equal(response.status, 'cancelled'); assert.equal(s.writes.length, 1); assert.equal(response.data.resultId, 'persisted-real')
})

test('repeat assessment returns the validated saved projection without a new child or duplicate write', async () => {
  const s = setup({ reusePersisted: true }), args = { taskId: 'task-a' }
  const first = await s.handle('match_assess', args, call)
  const second = await s.handle('match_assess', args, { ...call, callId: 'repeat-native-call', rootCallId: 'repeat-native-call' })
  assert.equal(first.status, 'complete'); assert.equal(second.status, 'complete')
  assert.deepEqual(second.data, first.data)
  assert.equal(second.data.resultId, 'persisted-real'); assert.equal(second.data.taskId, args.taskId)
  assert.equal(s.activations.length, 1); assert.equal(s.writes.length, 1)
  assert.equal(s.invocations.at(-1).callId, 'repeat-native-call')
})
test('saved-result prepare rejects foreign task/scope and malformed saved projections without starting a child', async () => {
  const f = fixture()
  const saved = projectMatchingResult({ task: f.prepared.task, resultId: 'saved-a', revision: '1', decisions: [f.decision], profileDigest: f.prepared.profileDigest })
  for (const mutate of [result => { result.taskId = 'other-task' }, result => { result.scope.projectId = 'foreign' }, result => { result.counts.complete += 1 }]) {
    const invalid = structuredClone(saved); mutate(invalid)
    const s = setup({ savedResult: { kind: 'saved-result', result: invalid } })
    const response = await s.handle('match_assess', { taskId: 'task-a' }, call)
    assert.equal(response.status, 'failed'); assert.equal(s.activations.length, 0); assert.equal(s.writes.length, 0)
  }
})
test('unclassified source criteria reach the native child for semantic kind classification', async () => {
  const prepared = fixture().prepared
  prepared.trialProfiles[0].criteria[0].kind = 'unclassified'
  const s = setup({ prepared }), response = await s.handle('match_assess', { taskId: 'task-a' }, call)
  assert.equal(response.status, 'complete'); assert.equal(s.writes.length, 1)
  assert.equal(s.writes[0].decisions[0].criteria[0].kind, 'inclusion')
  assert.match(s.activations[0].request.prompt[0].text, /Semantically classify any unclassified source criterion/)
})
function cancellableExecution({ rejectJob = false } = {}) {
  const f = fixture(); let started, resolveResult, releases = 0, signal
  const ready = new Promise(resolve => { started = resolve }), result = new Promise(resolve => { resolveResult = resolve })
  const host = { abi: HOST_ABI, ports: Object.fromEntries(Object.entries(HOST_PORT_METHODS).map(([port, methods]) => [port, Object.fromEntries(methods.map(method => [method, async () => {
    if (port === 'IdentityPort') return method === 'resolve' ? f.scope : { allowed: true, scope: f.scope }
    if (port === 'JobPort' && method === 'cancel') return { status: rejectJob ? 'failed' : 'cancelled', summary: rejectJob ? 'Cancellation refused' : 'Cancellation accepted', data: {}, artifacts: [] }
    return { status: 'complete', summary: 'Frozen', data: f.prepared, artifacts: [] }
  }]))])) }
  const ctx = { on: () => () => {}, get: () => ({ get: () => ({}) }), subagents: { async startActivation(input) {
    signal = input.signal
    input.signal.addEventListener('abort', () => resolveResult({ stopReason: 'aborted', output: 'Preserved partial native assessment' }), { once: true }); started()
    return { childId: input.childId, messageId: 'managed-child-message', result, async dispose() { await Promise.resolve(); releases += 1 } }
  } } }
  const handle = createMatchingHandler({ host, ctx })
  return { handle, ready, released: () => releases, aborted: () => signal?.aborted }
}
test('accepted local match_job cancellation aborts its running native assessment and awaits disposal', async () => {
  const s = cancellableExecution(), running = s.handle('match_assess', { taskId: 'task-a' }, call)
  await s.ready
  const cancellation = await s.handle('match_job', { taskId: 'task-a', jobId: 'job-a', action: 'cancel' }, { ...call, name: 'match_job', callId: 'cancel-call' })
  assert.equal(cancellation.status, 'cancelled')
  const response = await running
  assert.equal(response.status, 'cancelled'); assert.equal(s.aborted(), true); assert.equal(s.released(), 1)
  assert.equal(response.data.output, 'Preserved partial native assessment'); assert.equal(s.handle.cancel('task-a'), false)
})
test('trusted task cancellation is exact, and host-refused local cancellation cannot abort a child', async () => {
  const s = cancellableExecution({ rejectJob: true }), running = s.handle('match_assess', { taskId: 'task-a' }, call)
  await s.ready
  assert.equal(s.handle.cancel('different-task'), false); assert.equal(s.aborted(), false)
  const refusal = await s.handle('match_job', { taskId: 'task-a', jobId: 'job-a', action: 'cancel' }, { ...call, name: 'match_job', callId: 'denied-cancel' })
  assert.equal(refusal.status, 'failed'); assert.equal(s.aborted(), false)
  assert.equal(s.handle.cancel('task-a'), true)
  assert.equal((await running).status, 'cancelled'); assert.equal(s.released(), 1)
})

test('knowledge source reads have bounded continuation cursors and cannot apply them to patient data or search', () => {
  const read = { taskId: 'task-a', source: 'knowledge', action: 'read', sourceId: 'source-a', offset: 1800, maxChars: 12000 }
  assert.deepEqual(validateArguments('match_evidence', read), read)
  for (const extra of [{ offset: -1 }, { offset: 32000001 }, { offset: 1.5 }, { maxChars: 0 }, { maxChars: 12001 }, { source: 'patient' }, { action: 'search' }, { sourceId: undefined }]) assert.throws(() => validateArguments('match_evidence', { ...read, ...extra }))
})
test('a malformed optional priority cannot discard a valid clinical sibling', async () => {
  const { patientMatchingOutputSchema } = await import('../../../apps/server/src/patientMatchingOutputSchema.mjs')
  const f=fixture(),prepared=structuredClone(f.prepared)
  prepared.task.direction='patient-to-trials';prepared.task.budgets.maxPairs=2
  prepared.task.selectedPairs.push({subjectKey:'patient-a',trialId:'trial-b'})
  prepared.trialProfiles.push({...structuredClone(prepared.trialProfiles[0]),trialId:'trial-b'})
  prepared.outputSchema=patientMatchingOutputSchema({scope:f.scope,profileDigest:prepared.profileDigest,executionId:prepared.executionId,maxPairs:2})
  const invalid={...structuredClone(f.decision),recommendation:{priority:90,rationale:'Invalid auxiliary scale'}}
  const valid={...structuredClone(f.decision),decisionId:'decision-b',trialId:'trial-b',recommendation:{priority:0.75,rationale:'Valid advisory priority'}}
  const run=setup({prepared,outcome:{stopReason:'completed',structured:{decisions:[invalid,valid]}}})
  const answer=await run.handle('match_assess',{taskId:'task-a'},call)
  assert.equal(run.writes.length,1);assert.equal(run.writes[0].decisions.length,1);assert.equal(run.writes[0].decisions[0].trialId,'trial-b');assert.equal(run.writes[0].decisions[0].recommendation.priority,0.75)
  assert.equal(answer.status,'partial');assert.ok(answer.data.nativeDiagnostics.length)
})

test('unknown formal criterion identity is rejected per decision while a valid sibling persists', async()=>{
 const {patientMatchingOutputSchema}=await import('../../../apps/server/src/patientMatchingOutputSchema.mjs');
 const f=fixture(),prepared=structuredClone(f.prepared);prepared.task.direction='patient-to-trials';prepared.task.budgets.maxPairs=2;prepared.task.selectedPairs.push({subjectKey:'patient-a',trialId:'trial-b'});prepared.trialProfiles.push({...structuredClone(prepared.trialProfiles[0]),trialId:'trial-b'});
 prepared.outputSchema=patientMatchingOutputSchema({scope:f.scope,profileDigest:prepared.profileDigest,executionId:prepared.executionId,maxPairs:2,criterionIds:['c1']});
 const invalid=structuredClone(f.decision);invalid.criteria[0].criterionId='demographics-age';const valid={...structuredClone(f.decision),decisionId:'decision-b',trialId:'trial-b'};
 const run=setup({prepared,outcome:{stopReason:'completed',structured:{decisions:[invalid,valid]}}});const answer=await run.handle('match_assess',{taskId:'task-a'},call);
 assert.equal(run.writes.length,1);assert.equal(run.writes[0].decisions.length,1);assert.equal(run.writes[0].decisions[0].trialId,'trial-b');assert.equal(answer.status,'partial');
});

test('a failed checkpoint transport preserves partial native diagnostics and never claims persistence', async () => {
  const s=setup({failureSaveError:true,outcome:{stopReason:'error',output:'Preserved raw partial output',diagnostic:'invalid provider JSON'}})
  const response=await s.handle('match_assess',{taskId:'task-a'},call)
  assert.equal(response.status,'failed');assert.equal(response.data.output,'Preserved raw partial output')
  assert.ok(response.data.diagnostics.some(item=>item.includes('checkpoint transport unavailable')))
  assert.equal(response.data.failureCheckpoint,undefined);assert.equal(s.released(),true)
})
test('a refused child start saves no invented failed clinical attempt', async () => {
  const s=setup({startFailure:true}),response=await s.handle('match_assess',{taskId:'task-a'},call)
  assert.equal(response.status,'failed');assert.equal(s.writes.length,0)
})
test('discovery accepts a focused query at200 characters and rejects201',()=>{
  assert.equal(validateArguments('match_discover',{taskId:'t',query:'x'.repeat(200)}).query.length,200)
  assert.throws(()=>validateArguments('match_discover',{taskId:'t',query:'x'.repeat(201)}))
})
test('one call runs a task\'s executions in concurrent lanes, keeps host writes in order and answers with the last saved result', async () => {
  const f = fixture(), writes = [], prepares = []
  let open = 0, widest = 0, hostBusy = 0, overlapped = false, served = 0
  const executionFor = id => ({ ...f.prepared, kind: 'prepared', executionId: id })
  const host = { abi: HOST_ABI, ports: Object.fromEntries(Object.entries(HOST_PORT_METHODS).map(([port, methods]) => [port, Object.fromEntries(methods.map(method => [method, async envelope => {
    if (port === 'IdentityPort' && method === 'resolve') return f.scope
    if (port === 'IdentityPort') return { allowed: true, scope: f.scope }
    const write = (port === 'ExecutionPort' && envelope.input.phase === 'prepare') || port === 'ResultPort'
    if (write) { if (hostBusy) overlapped = true; hostBusy++; await new Promise(resolve => setTimeout(resolve, 2)); hostBusy-- }
    if (port === 'ExecutionPort' && envelope.input.phase === 'prepare') {
      prepares.push(envelope.input)
      return { status: 'complete', summary: 'Frozen', data: served < 3 ? executionFor(`exec-${served++}`) : { kind: 'busy', taskId: 'task-a' }, artifacts: [] }
    }
    if (port === 'ExecutionPort') return { status: 'complete', summary: 'Frozen', data: executionFor(envelope.input.executionId), artifacts: [] }
    if (port === 'ResultPort') { writes.push(envelope.input); return { status: 'complete', summary: 'Saved', data: { resultId: `result-${writes.length}` }, artifacts: [] } }
    return { status: 'complete', summary: 'Host result', data: {}, artifacts: [] }
  }]))])) }
  const ctx = { on: () => () => {}, get: name => name === 'agents' ? { get: () => ({}) } : undefined, subagents: { async startActivation(input) {
    const executionId = /exec-\d+/.exec(JSON.stringify(input.request.prompt))[0]
    open++; widest = Math.max(widest, open)
    const decision = { ...f.decision, producer: { ...f.decision.producer, executionId } }
    return { childId: input.childId, messageId: `message-${executionId}`, result: new Promise(resolve => setTimeout(() => { open--; resolve({ stopReason: 'completed', structured: { decisions: [decision] } }) }, 20)), async dispose() {} }
  } } }
  const result = await createMatchingHandler({ host, ctx })('match_assess', { taskId: 'task-a' }, call)
  assert.equal(widest, 3, 'the three prepared executions ran at the same time')
  assert.deepEqual(writes.map(write => write.executionId).sort(), ['exec-0', 'exec-1', 'exec-2'])
  assert.equal(overlapped, false, 'no prepare or commit overlapped another host write')
  assert.deepEqual(prepares[0], { taskId: 'task-a', phase: 'prepare' }, 'the first preparation carries the original arguments')
  assert.ok(prepares.slice(1).every(input => Object.keys(input).sort().join() === 'lane,phase,taskId' && input.taskId === 'task-a'))
  assert.equal(result.status, 'complete')
  assert.equal(result.data.executions, 3)
  assert.match(result.data.resultId, /^result-\d$/)
})
test('a child answer that fails the decision schema is asked once more on the same execution', async () => {
  const f = fixture()
  let starts = 0
  const ctx = { on: () => () => {}, get: name => name === 'agents' ? { get: () => ({}) } : undefined, subagents: { async startActivation(input) {
    starts++
    const outcome = starts === 1 ? { stopReason: 'completed', structured: { wrong: true } } : { stopReason: 'completed', structured: { decisions: [f.decision] } }
    return { childId: input.childId, messageId: `message-${starts}`, result: Promise.resolve(outcome), async dispose() {} }
  } } }
  const writes = []
  const host = { abi: HOST_ABI, ports: Object.fromEntries(Object.entries(HOST_PORT_METHODS).map(([port, methods]) => [port, Object.fromEntries(methods.map(method => [method, async envelope => {
    if (port === 'IdentityPort' && method === 'resolve') return f.scope
    if (port === 'IdentityPort') return { allowed: true, scope: f.scope }
    if (port === 'ExecutionPort') return { status: 'complete', summary: 'Frozen', data: f.prepared, artifacts: [] }
    if (port === 'ResultPort') { writes.push(envelope.input); return { status: 'complete', summary: 'Saved', data: { resultId: 'persisted-real' }, artifacts: [] } }
    return { status: 'complete', summary: 'Host result', data: {}, artifacts: [] }
  }]))])) }
  const result = await createMatchingHandler({ host, ctx })('match_assess', { taskId: 'task-a' }, call)
  assert.equal(starts, 2)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].phase, 'commit')
  assert.deepEqual(writes[0].decisions, [f.decision])
  assert.ok(writes[0].diagnostics.includes('native_response_retried'))
  assert.equal(result.data.resultId, 'persisted-real')
})
