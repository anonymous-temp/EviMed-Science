// What survives of compaction in the port: the settings both sides of the container boundary derive, and the request-size
// guard's measurement and trigger. The compaction itself is the kernel's own engine, which is not in this workspace's
// lockfile (the runtime image installs it), so nothing here needs a kernel.
import assert from 'node:assert/strict'
import test from 'node:test'
import SEAMS from '../seam-manifest.json' with { type: 'json' }
import {
  COMPACTION_DEFAULTS,
  COMPACTION_ENV_KEYS,
  REQUEST_BYTES_GUARD,
  compactionConfigFromEnv,
  compactionRuntimeEnv,
  forceCompaction,
  nextRequestBytes,
} from '../src/compaction.mjs'

test('an empty env yields the upstream defaults', () => {
  const derived = compactionConfigFromEnv({})

  assert.deepEqual(derived, {
    config: { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192 },
    // Three quarters of the model gateway's default 12 MiB body limit.
    maxRequestBytes: 9_437_184,
    invalid: [],
  })
  assert.deepEqual(derived.config.thresholdRatio, COMPACTION_DEFAULTS.thresholdRatio)
  assert.deepEqual(compactionConfigFromEnv(), derived, 'a missing env argument is an empty env')
})

test('the in-container names win over the control-plane names for the same setting', () => {
  const derived = compactionConfigFromEnv({
    EVIMED_COMPACTION_THRESHOLD_RATIO: '0.5',
    OPEN_SCIENCE_RUNTIME_COMPACTION_THRESHOLD_RATIO: '0.9',
    OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_RATIO: '0.3',
    OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_TOKENS: '4096',
  })

  assert.deepEqual(derived, {
    config: { thresholdRatio: 0.5, retainRatio: 0.3, maxTokens: 4096 },
    maxRequestBytes: 9_437_184,
    invalid: [],
  })
})

test('a malformed knob is reported by name and loses to the default, and never throws', () => {
  const derived = compactionConfigFromEnv({
    EVIMED_COMPACTION_THRESHOLD_RATIO: '1.4',
    EVIMED_COMPACTION_RETAIN_RATIO: '0',
    EVIMED_COMPACTION_MAX_TOKENS: '8192.5',
  })

  assert.deepEqual(derived.config, { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192 })
  assert.deepEqual(derived.invalid, [
    'EVIMED_COMPACTION_THRESHOLD_RATIO=1.4 (must be a number in (0, 1])',
    'EVIMED_COMPACTION_RETAIN_RATIO=0 (must be a number in (0, 1])',
    'EVIMED_COMPACTION_MAX_TOKENS=8192.5 (must be a positive integer)',
  ])
})

test('every knob the derivation reads is forwarded into the container under one name', () => {
  const forwarded = compactionRuntimeEnv(compactionConfigFromEnv({ OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_RATIO: '0.3' }))

  assert.deepEqual(forwarded, {
    EVIMED_COMPACTION_THRESHOLD_RATIO: '0.8',
    EVIMED_COMPACTION_RETAIN_RATIO: '0.3',
    EVIMED_COMPACTION_MAX_TOKENS: '8192',
    EVIMED_COMPACTION_MAX_REQUEST_BYTES: '9437184',
  })
  // A knob the container reads that the control plane never forwards does
  // nothing and says nothing, so the two lists are checked against each other
  // rather than trusted to agree.
  for (const key of Object.keys(forwarded)) {
    assert.ok(
      Object.values(COMPACTION_ENV_KEYS).some((names) => names[0] === key),
      `${key} is forwarded but is not a name the derivation reads`,
    )
  }
  for (const names of Object.values(COMPACTION_ENV_KEYS)) {
    assert.ok(names[0] in forwarded, `${names[0]} is read in the container but never forwarded`)
  }
})

test('the recorded provider seam names the package, the one method the guard calls, and the defaults', () => {
  assert.deepEqual(SEAMS.providers.compaction.package, '@deepseek-ai/dsh-compaction-basic')
  assert.equal(SEAMS.packages['@deepseek-ai/dsh-compaction-basic'], 'config-row',
    'nothing here subclasses the engine any more: the preset mounts it as a row')
  assert.deepEqual(SEAMS.providers.compaction.methods, ['compactIfNeeded'])
  assert.deepEqual(SEAMS.providers.compaction.defaults, { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192 })
  // The defaults in code are a copy of the recorded ones, and a copy that is
  // not checked is a copy that drifts.
  assert.equal(COMPACTION_DEFAULTS.thresholdRatio, SEAMS.providers.compaction.defaults.thresholdRatio)
  assert.equal(COMPACTION_DEFAULTS.retainRatio, SEAMS.providers.compaction.defaults.retainRatio)
  assert.equal(COMPACTION_DEFAULTS.maxTokens, SEAMS.providers.compaction.defaults.maxTokens)
})

test('the request-size guard is a share of the gateway limit, can be set outright, and 0 turns it off', () => {
  assert.equal(compactionConfigFromEnv({ OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES: '4194304' }).maxRequestBytes, 3_145_728)
  assert.equal(compactionConfigFromEnv({ OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_REQUEST_BYTES: '1000000' }).maxRequestBytes, 1_000_000)
  assert.equal(compactionConfigFromEnv({ EVIMED_COMPACTION_MAX_REQUEST_BYTES: '0' }).maxRequestBytes, 0)
  const malformed = compactionConfigFromEnv({ EVIMED_COMPACTION_MAX_REQUEST_BYTES: '-1', OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES: 'lots' })
  assert.equal(malformed.maxRequestBytes, 9_437_184, 'both malformed values lose to the default')
  assert.deepEqual(malformed.invalid, [
    'OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES=lots (must be a positive integer)',
    'EVIMED_COMPACTION_MAX_REQUEST_BYTES=-1 (must be a non-negative integer)',
  ])
  assert.equal(REQUEST_BYTES_GUARD.ratio, 0.75)
})

test('the next request is measured from the kernel\'s own history, each message once', () => {
  const first = Object.freeze({ role: 'user', content: [{ type: 'text', text: '题面' }] })
  const second = Object.freeze({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
  /** @type {any[]} */
  let history = [first]
  const tools = [{ name: 'read', description: 'Read a file.', parameters: {} }]
  const agent = { session: { deriveMessages: () => [...history], requestHeader: () => ({ tools }) } }
  const bytes = (/** @type {unknown} */ value) => new TextEncoder().encode(JSON.stringify(value)).byteLength
  const sizes = new WeakMap()
  assert.equal(nextRequestBytes(agent, [], sizes), bytes(first) + bytes(tools))
  assert.equal(sizes.get(first), bytes(first), 'a UTF-8 count: the brief is two CJK characters, six bytes')
  history = [first, second]
  const claimed = [{ role: 'user', content: [{ type: 'text', text: 'steer' }] }]
  assert.equal(nextRequestBytes(agent, claimed, sizes), bytes(first) + bytes(second) + bytes(claimed[0]) + bytes(tools))
  assert.equal(nextRequestBytes({}, []), 0, 'no session, nothing to measure')
})

test('a forced compaction goes through the backend\'s context-overflow path, and is null without a backend', async () => {
  /** @type {any[]} */
  const calls = []
  const compaction = { compactIfNeeded: async (/** @type {any[]} */ ...args) => { calls.push(args); return { shadowedTokenCount: 10 } } }
  const agent = { id: 'a' }
  const signal = AbortSignal.timeout(1000)
  assert.deepEqual(await forceCompaction({ get: (/** @type {string} */ key) => (key === 'compaction' ? compaction : undefined) }, agent, signal), { shadowedTokenCount: 10 })
  assert.deepEqual(calls, [[agent, 'context-overflow', signal]])
  assert.equal(await forceCompaction({ get: () => undefined }, agent, signal), null)
})
