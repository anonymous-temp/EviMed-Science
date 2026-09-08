// The engine is driven through its injection seam, with no kernel anywhere:
// `@deepseek-ai/dsh-compaction-basic` is not in this workspace's lockfile at
// all (the runtime image installs it), so a suite that needed the real base
// class would not run here. `createEvimedCompactionEngine` takes the base as an
// argument for exactly that reason, and the fake below is the smallest thing
// that is still a class the subclass can extend.
import assert from 'node:assert/strict'
import test from 'node:test'
import SEAMS from '../seam-manifest.json' with { type: 'json' }
import { loadHarnessModule } from '../index.mjs'
import {
  COMPACTION_DEFAULTS,
  COMPACTION_ENV_KEYS,
  COMPACTION_HANDLE_LOST,
  COMPACTION_OBSERVATIONS,
  correctionHandles,
  COMPACTION_PLUGIN,
  COMPACTION_POLICIES,
  buildStateHandlePacket,
  compactionConfigFromEnv,
  compactionProviderIssues,
  compactionRuntimeEnv,
  createEvimedCompactionEngine,
  missingHandles,
  probeCompactionProvider,
  summaryResultText,
} from '../src/compaction.mjs'

/** The upstream shape the subclass depends on, and nothing else. */
class FakeBase {
  static inject = ['llm']
  static Config = { fake: true }
  /** @param {any} ctx @param {any} [config] */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }
  /** @param {any} _input @param {any} _agent @param {AbortSignal} [_signal] @returns {Promise<any>} */
  async summarize(_input, _agent, _signal) {
    return summaryOf('base summary with no handles in it')
  }
  async compactIfNeeded() { return null }
  async compactRegion() { return null }
  async compactNow() { return null }
}

/** @param {string} text @returns {any} */
function summaryOf(text) {
  return { summary: [{ type: 'text', text }], provider: 'deepseek', model: 'deepseek-chat' }
}

const HANDLES = [
  { kind: 'deliverable', id: 'deliverables/report.md', detail: 'sha256:9f2c' },
  { kind: 'plan', id: 'task-plan.json', detail: 'step 4 of 7 active' },
  { kind: 'source', id: 'src_4b1e', detail: 'read at level 2' },
]

/** @param {StateHandleLike[]} handles @returns {string} */
function summaryNaming(handles) {
  return `1. carried forward: ${handles.map((handle) => handle.id).join(' and ')}.`
}

/** @typedef {{ kind: string, id: string, detail?: string }} StateHandleLike */

/**
 * A cordis context stub with the one method the engine uses: `on`, which is how
 * the requested-compaction handler reaches `agent/pre-step`. Deliberately not
 * optional in the engine — a real context always has it, and a guard there
 * would turn "the hook never registered" into silence, which is the failure
 * this whole subsystem keeps being bitten by.
 * @returns {{ ctx: any, hooks: Map<string, Function[]>, fire: (event: string, payload: any) => Promise<any> }}
 */
function fakeCtx() {
  /** @type {Map<string, Function[]>} */
  const hooks = new Map()
  const ctx = {
    on: (/** @type {string} */ event, /** @type {Function} */ handler) => {
      hooks.set(event, [...(hooks.get(event) ?? []), handler])
    },
  }
  const fire = async (/** @type {string} */ event, /** @type {any} */ payload) => {
    let last
    for (const handler of hooks.get(event) ?? []) last = await handler(payload, () => 'next')
    return last
  }
  return { ctx, hooks, fire }
}

/**
 * @param {{ summarise: (input: any) => Promise<any>, handles?: StateHandleLike[],
 *   takeCompactRequest?: (agent: any) => any, compactIfNeeded?: (agent: any, trigger: string, signal: any) => Promise<any> }} deps
 * @returns {{ engine: any, observed: any[], calls: any[], fire: (event: string, payload: any) => Promise<any>, hooks: Map<string, Function[]>, compactions: any[] }}
 */
function engineWith(deps) {
  /** @type {any[]} */
  const observed = []
  /** @type {any[]} */
  const calls = []
  /** @type {any[]} */
  const compactions = []
  const Engine = createEvimedCompactionEngine(FakeBase, {
    readHandles: () => (deps.handles === undefined ? HANDLES : deps.handles),
    observe: (observation) => observed.push(observation),
    summarise: async (input) => {
      calls.push(input)
      return deps.summarise(input)
    },
    ...(deps.takeCompactRequest ? { takeCompactRequest: deps.takeCompactRequest } : {}),
  })
  const { ctx, hooks, fire } = fakeCtx()
  const engine = new Engine(ctx, {})
  // The base's own `compactIfNeeded` is not present on the stub, so the test
  // supplies one and records what the handler asked it for.
  engine.compactIfNeeded = async (/** @type {any} */ agent, /** @type {string} */ trigger, /** @type {any} */ signal) => {
    compactions.push({ trigger, signal })
    return deps.compactIfNeeded ? deps.compactIfNeeded(agent, trigger, signal) : { shadowedSeqs: [1] }
  }
  return { engine, observed, calls, fire, hooks, compactions }
}

const AGENT = { session: { id: 'ses_compaction' } }
const INPUT = {
  system: 'you are a research agent',
  tools: [{ name: 'evimed_plan' }],
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'run the review' }] }],
}

/** The text of whatever message the engine put last, which for an unaugmented
 *  call is the conversation's own final message.
 *  @param {any} input @returns {string} */
function appendedText(input) {
  const last = input.messages[input.messages.length - 1]
  return (last?.content ?? []).map((/** @type {any} */ block) => block.text).join('')
}

test('a summary that keeps every handle is returned on the first call, with no retry', async () => {
  const { engine, observed, calls } = engineWith({ summarise: async () => summaryOf(summaryNaming(HANDLES)) })

  const result = await engine.summarize(INPUT, AGENT)

  assert.equal(summaryResultText(result), summaryNaming(HANDLES))
  assert.equal(calls.length, 1, 'a preserved summary must not cost a second model call')
  assert.deepEqual(observed, [{
    event: COMPACTION_OBSERVATIONS.preserved,
    reason: 'ok',
    sessionId: 'ses_compaction',
    handles: 3,
    missing: [],
    attempts: 1,
  }])
  // The augmented call is the conversation plus exactly one trailing message,
  // stamped as ours: the backend's cache reuse depends on the prefix being
  // untouched, and the durable log needs to tell this turn from the run's own.
  const augmented = calls[0]
  assert.equal(augmented.system, INPUT.system)
  assert.deepEqual(augmented.tools, INPUT.tools)
  assert.equal(augmented.messages.length, INPUT.messages.length + 1)
  assert.deepEqual(augmented.messages[0], INPUT.messages[0])
  assert.deepEqual(augmented.messages[1].source, { kind: 'plugin', plugin: COMPACTION_PLUGIN })
  assert.ok(appendedText(augmented).includes('task-plan.json'))
})

test('a summary that dropped one handle is retried once, naming only the handle it dropped', async () => {
  const kept = HANDLES.filter((handle) => handle.id !== 'src_4b1e')
  let attempt = 0
  const { engine, observed, calls } = engineWith({
    summarise: async () => {
      attempt += 1
      return summaryOf(attempt === 1 ? summaryNaming(kept) : summaryNaming(HANDLES))
    },
  })

  const result = await engine.summarize(INPUT, AGENT)

  assert.equal(summaryResultText(result), summaryNaming(HANDLES))
  assert.equal(calls.length, 2)
  assert.deepEqual(observed, [{
    event: COMPACTION_OBSERVATIONS.preserved,
    reason: 'ok',
    sessionId: 'ses_compaction',
    handles: 3,
    missing: [],
    attempts: 2,
  }])
  const retry = appendedText(calls[1])
  assert.ok(retry.includes('dropped 1 required identifier'), retry)
  assert.ok(retry.includes('- src_4b1e'))
  assert.ok(!retry.includes('- task-plan.json'), 'the retry must name what was lost, not everything')
})

test('a handle still missing after the retry degrades to the plain base result rather than failing', async () => {
  const kept = HANDLES.filter((handle) => handle.id !== 'src_4b1e')
  const { engine, observed, calls } = engineWith({
    summarise: async (input) => (appendedText(input).includes('STATE HANDLES')
      ? summaryOf(summaryNaming(kept))
      : summaryOf('plain base checkpoint')),
  })

  const result = await engine.summarize(INPUT, AGENT)

  assert.equal(summaryResultText(result), 'plain base checkpoint')
  assert.equal(calls.length, 3, 'two augmented attempts, then the unaugmented fallback')
  assert.equal(calls[2].messages.length, INPUT.messages.length, 'the fallback carries no packet')
  assert.deepEqual(observed, [{
    event: COMPACTION_OBSERVATIONS.degraded,
    reason: COMPACTION_HANDLE_LOST,
    sessionId: 'ses_compaction',
    handles: 3,
    missing: ['src_4b1e'],
    attempts: 2,
  }])
})

test('a summariser that throws degrades to the base path instead of aborting the compaction', async () => {
  let seen = 0
  const { engine, observed } = engineWith({
    summarise: async (input) => {
      seen += 1
      if (appendedText(input).includes('STATE HANDLES')) throw new Error('provider refused')
      return summaryOf('plain base checkpoint')
    },
  })

  const result = await engine.summarize(INPUT, AGENT)

  assert.equal(summaryResultText(result), 'plain base checkpoint')
  assert.equal(seen, 2)
  assert.deepEqual(observed.map((entry) => [entry.event, entry.reason, entry.attempts]), [
    [COMPACTION_OBSERVATIONS.degraded, 'summarizer_failed', 1],
  ])
})

test('a cancelled turn is re-raised rather than retried into the same rejection', async () => {
  const cancelled = AbortSignal.abort()
  const { engine, observed, calls } = engineWith({
    summarise: async () => { throw new Error('aborted') },
  })

  await assert.rejects(engine.summarize(INPUT, AGENT, cancelled), /aborted/)
  assert.equal(calls.length, 1, 'a cancelled compaction must not spend a second doomed call')
  assert.deepEqual(observed, [], 'cancellation is not a policy degradation')
})

test('a handle reader that throws is a degradation, not a lost compaction', async () => {
  /** @type {any[]} */
  const observed = []
  const Engine = createEvimedCompactionEngine(FakeBase, {
    readHandles: () => { throw new Error('projection unavailable') },
    observe: (observation) => observed.push(observation),
  })

  // No `summarise` injected: this also proves `super.summarize` is what the
  // engine falls through to when the seam is left at its default.
  const result = await new Engine(fakeCtx().ctx, {}).summarize(INPUT, AGENT)

  assert.equal(summaryResultText(result), 'base summary with no handles in it')
  assert.deepEqual(observed.map((entry) => entry.reason), ['handles_unavailable'])
})

test('an observation sink that throws cannot fail the compaction it is recording', async () => {
  const Engine = createEvimedCompactionEngine(FakeBase, {
    readHandles: () => HANDLES,
    observe: () => { throw new Error('metrics down') },
    summarise: async () => summaryOf(summaryNaming(HANDLES)),
  })

  const result = await new Engine(fakeCtx().ctx, {}).summarize(INPUT, AGENT)

  assert.equal(summaryResultText(result), summaryNaming(HANDLES))
})

test('with no handles to protect the engine is the base engine, at no extra cost', async () => {
  const { engine, observed, calls } = engineWith({ handles: [], summarise: async () => summaryOf('base') })

  const result = await engine.summarize(INPUT, AGENT)

  assert.equal(summaryResultText(result), 'base')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].messages, INPUT.messages)
  assert.deepEqual(observed, [])
})

test('the packet is deterministic: same handles in any order, deduplicated, sorted by kind then id', () => {
  const forward = buildStateHandlePacket([
    { kind: 'source', id: 'src_b' },
    { kind: 'plan', id: 'task-plan.json', detail: 'step 4 of 7' },
    { kind: 'source', id: 'src_a' },
    { kind: 'budget', id: '412000 tokens remaining' },
  ])
  const shuffled = buildStateHandlePacket([
    { kind: 'budget', id: '412000 tokens remaining' },
    { kind: 'source', id: 'src_a' },
    { kind: 'source', id: 'src_b' },
    { kind: 'source', id: '  src_a  ' },
    { kind: 'plan', id: 'task-plan.json', detail: 'step 4\n  of 7' },
    { kind: 'plan', id: '' },
  ])

  assert.equal(forward, shuffled, 'a reordered handle set must not change the prompt prefix')
  assert.deepEqual(forward.split('\n').filter((line) => line.startsWith('[')), [
    '[plan] task-plan.json - step 4 of 7',
    '[source] src_a',
    '[source] src_b',
    '[budget] 412000 tokens remaining',
  ])
})

test('an unknown handle kind is kept and sorted after every known one', () => {
  const packet = buildStateHandlePacket([
    { kind: 'zeta', id: 'z1' },
    { kind: 'alpha', id: 'a1' },
    { kind: 'budget', id: 'b1' },
  ])

  assert.deepEqual(packet.split('\n').filter((line) => line.startsWith('[')), ['[budget] b1', '[alpha] a1', '[zeta] z1'])
})

test('a handle wrapped across lines in the summary still counts, but a case-changed digest does not', () => {
  const handles = [{ kind: 'deliverable', id: 'deliverables/report.md' }, { kind: 'method', id: 'sha256:9f2cAB' }]

  assert.deepEqual(missingHandles('kept deliverables/report.md and\n   sha256:9f2cAB here', handles), [])
  assert.deepEqual(missingHandles('kept deliverables/report.md and sha256:9f2cab here', handles), ['sha256:9f2cAB'])
  assert.deepEqual(missingHandles('', handles), ['deliverables/report.md', 'sha256:9f2cAB'])
})

test('an empty env yields the upstream defaults and the basic policy', () => {
  const derived = compactionConfigFromEnv({})

  assert.deepEqual(derived, {
    policy: 'basic',
    config: { thresholdRatio: 0.8, maxTokens: 8192, retainRatio: 0.16 },
    invalid: [],
  })
  assert.deepEqual(derived.config.thresholdRatio, COMPACTION_DEFAULTS.thresholdRatio)
  assert.deepEqual(compactionConfigFromEnv(), derived, 'a missing env argument is an empty env')
})

test('the in-container names win over the control-plane names for the same setting', () => {
  const derived = compactionConfigFromEnv({
    EVIMED_COMPACTION_POLICY: 'structured',
    OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY: 'basic',
    EVIMED_COMPACTION_THRESHOLD_RATIO: '0.5',
    OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_RATIO: '0.3',
    OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_TOKENS: '4096',
  })

  assert.deepEqual(derived, {
    policy: 'structured',
    config: { thresholdRatio: 0.5, maxTokens: 4096, retainRatio: 0.3 },
    invalid: [],
  })
  assert.ok(COMPACTION_POLICIES.includes(derived.policy))
})

test('a malformed knob is reported by name and loses to the default, and never throws', () => {
  const derived = compactionConfigFromEnv({
    EVIMED_COMPACTION_POLICY: 'aggressive',
    EVIMED_COMPACTION_THRESHOLD_RATIO: '1.4',
    EVIMED_COMPACTION_RETAIN_RATIO: '0',
    EVIMED_COMPACTION_MAX_TOKENS: '8192.5',
  })

  assert.deepEqual(derived.config, { thresholdRatio: 0.8, maxTokens: 8192, retainRatio: 0.16 })
  assert.equal(derived.policy, 'basic')
  assert.deepEqual(derived.invalid, [
    'EVIMED_COMPACTION_POLICY=aggressive (not one of basic, structured)',
    'EVIMED_COMPACTION_THRESHOLD_RATIO=1.4 (must be a number in (0, 1])',
    'EVIMED_COMPACTION_MAX_TOKENS=8192.5 (must be a positive integer)',
    'EVIMED_COMPACTION_RETAIN_RATIO=0 (must be a number in (0, 1])',
  ])
})

test('an absolute retain budget replaces the ratio, because upstream refuses to load with both', () => {
  const derived = compactionConfigFromEnv({
    EVIMED_COMPACTION_RETAIN_TOKENS: '20000',
    EVIMED_COMPACTION_RETAIN_RATIO: '0.3',
  })

  assert.deepEqual(derived.config, { thresholdRatio: 0.8, maxTokens: 8192, retainTokens: 20000 })
  assert.deepEqual(derived.invalid, ['EVIMED_COMPACTION_RETAIN_RATIO=0.3 (ignored: an absolute retain budget is also set)'])
  assert.deepEqual(compactionRuntimeEnv(derived), {
    EVIMED_COMPACTION_POLICY: 'basic',
    EVIMED_COMPACTION_THRESHOLD_RATIO: '0.8',
    EVIMED_COMPACTION_MAX_TOKENS: '8192',
    EVIMED_COMPACTION_RETAIN_TOKENS: '20000',
  })
})

test('every knob the derivation reads is forwarded into the container under one name', () => {
  const forwarded = compactionRuntimeEnv(compactionConfigFromEnv({ OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY: 'structured' }))

  assert.deepEqual(forwarded, {
    EVIMED_COMPACTION_POLICY: 'structured',
    EVIMED_COMPACTION_THRESHOLD_RATIO: '0.8',
    EVIMED_COMPACTION_MAX_TOKENS: '8192',
    EVIMED_COMPACTION_RETAIN_RATIO: '0.16',
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
})

test('the seam probe fails a renamed hook, an inherited hook, and a changed arity', () => {
  assert.deepEqual(compactionProviderIssues(FakeBase), [])

  // What a rename actually looks like from here: the class is still exported,
  // still mounts, still compacts, and the hook we override is simply not the
  // one it calls any more.
  class Renamed {
    /** @type {string[]} */
    static inject = ['llm']
    static Config = { fake: true }
    /** @param {any} _input @param {any} _agent @param {AbortSignal} [_signal] @returns {Promise<any>} */
    async condense(_input, _agent, _signal) { return null }
    async compactIfNeeded() { return null }
    async compactRegion() { return null }
    async compactNow() { return null }
  }
  assert.deepEqual(compactionProviderIssues(Renamed), [
    'BasicCompactionEngine.prototype.summarize is gone; the sole customization hook was renamed or removed',
  ])

  // The failure this probe exists for: the hook still resolves, because a base
  // class further up still has one, so an override compiles, mounts, and is
  // never called.
  class Inherited extends FakeBase {}
  assert.deepEqual(compactionProviderIssues(Inherited), [
    "BasicCompactionEngine.prototype.summarize is inherited rather than this class's own hook; overriding it may no longer be what the backend calls",
  ])

  class WrongArity {
    /** @type {string[]} */
    static inject = []
    static Config = { fake: true }
    /** @param {any} _input */
    async summarize(_input) { return null }
    async compactIfNeeded() { return null }
    async compactRegion() { return null }
    async compactNow() { return null }
  }
  assert.deepEqual(compactionProviderIssues(WrongArity), [
    'BasicCompactionEngine.prototype.summarize takes 1 arguments, not 3',
  ])

  assert.deepEqual(compactionProviderIssues(undefined), [
    '@deepseek-ai/dsh-compaction-basic no longer exports `BasicCompactionEngine` as a class',
  ])
})

test('the recorded provider seam names the package, the hook, and the methods the subclass leaves alone', () => {
  assert.deepEqual(SEAMS.providers.compaction.package, '@deepseek-ai/dsh-compaction-basic')
  assert.equal(SEAMS.packages['@deepseek-ai/dsh-compaction-basic'], 'provider-base')
  assert.deepEqual(SEAMS.providers.compaction.methods, ['compactIfNeeded', 'compactRegion', 'compactNow'])
  assert.deepEqual(SEAMS.providers.compaction.defaults, { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192 })
  // The defaults in code are a copy of the recorded ones, and a copy that is
  // not checked is a copy that drifts.
  assert.equal(COMPACTION_DEFAULTS.thresholdRatio, SEAMS.providers.compaction.defaults.thresholdRatio)
  assert.equal(COMPACTION_DEFAULTS.retainRatio, SEAMS.providers.compaction.defaults.retainRatio)
  assert.equal(COMPACTION_DEFAULTS.maxTokens, SEAMS.providers.compaction.defaults.maxTokens)
})

test('the probe reports the pinned backend when it is installed, and names it when it is not', async () => {
  // This workspace's lockfile carries no compaction package: the runtime image
  // installs them. Rather than skip, assert whichever of the two situations is
  // real, so the check runs in the image build too.
  let installed = true
  try {
    await loadHarnessModule('@deepseek-ai/dsh-compaction-basic')
  } catch (error) {
    installed = false
    assert.match(String(error), /seam package @deepseek-ai\/dsh-compaction-basic is unavailable/)
  }
  if (!installed) return
  const probe = await probeCompactionProvider()
  assert.equal(probe.checked, '@deepseek-ai/dsh-compaction-basic#BasicCompactionEngine.summarize')
  assert.deepEqual(probe.issues, [])
})

/* ------------------------------------------------- the manager's compaction request */

test("a requested compaction runs at the step boundary and consumes its own marker", async () => {
  // Verified live before it was written (probe V-2, 2026-09-07): the pinned
  // engine calls `compactRegion` from this same hook, and the region compactor
  // requires an *open turn* rather than an idle agent — which is why the
  // request is served here and not through `compactNow`.
  let taken = 0;
  const { engine, fire, observed, compactions } = engineWith({
    summarise: async () => ({ text: "unused" }),
    takeCompactRequest: () => (taken++ === 0 ? { reason: "the plan and the ledger are all I still need" } : null),
  });
  assert.ok(engine);

  await fire(SEAMS.events.preStep, { agent: AGENT, signal: { aborted: false } });
  assert.deepEqual(compactions.map((call) => call.trigger), ["context-overflow"],
    "the on-demand branch: no pressure threshold, no retention, and it picks its own balanced range");
  const requested = observed.filter((entry) => entry.event === COMPACTION_OBSERVATIONS.requested);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].reason, "compacted");
  assert.match(requested[0].note, /the plan and the ledger/);

  // The marker is consumed, so the next step does not compact again — a request
  // that survived what it asked for would compact until nothing was left.
  await fire(SEAMS.events.preStep, { agent: AGENT, signal: { aborted: false } });
  assert.equal(compactions.length, 1);
  assert.equal(taken, 2, "the consumer is still asked; it simply has nothing to give");
});

test("a step with no request, an aborted step, and no consumer all compact nothing", async () => {
  // Annotated, because inference over a heterogeneous literal array widens each
  // position to a union of every row's shape — after which `label` is not a
  // string and `deps` is not spreadable.
  /** @type {[string, Record<string, any>, Record<string, any>][]} */
  const cases = [
    ["no request", { takeCompactRequest: () => null }, { agent: AGENT, signal: { aborted: false } }],
    ["aborted step", { takeCompactRequest: () => ({ reason: "x" }) }, { agent: AGENT, signal: { aborted: true } }],
    ["no consumer wired", {}, { agent: AGENT, signal: { aborted: false } }],
    ["no agent", { takeCompactRequest: () => ({ reason: "x" }) }, { signal: { aborted: false } }],
  ];
  for (const [label, deps, payload] of cases) {
    const { fire, compactions } = engineWith({ summarise: async () => ({ text: "unused" }), ...deps });
    await fire(SEAMS.events.preStep, payload);
    assert.equal(compactions.length, 0, label);
  }
});

test("a compaction that finds nothing, or throws, still lets the step run", async () => {
  const nothing = engineWith({
    summarise: async () => ({ text: "unused" }),
    takeCompactRequest: () => ({ reason: "please" }),
    compactIfNeeded: async () => null,
  });
  const proceeded = await nothing.fire(SEAMS.events.preStep, { agent: AGENT, signal: { aborted: false } });
  assert.equal(proceeded, "next", "the waterfall continues");
  assert.equal(nothing.observed.at(-1).reason, "nothing_to_compact",
    "the request was heard and there was no safe range; that is an answer, not a failure");

  const failing = engineWith({
    summarise: async () => ({ text: "unused" }),
    takeCompactRequest: () => ({ reason: "please" }),
    compactIfNeeded: async () => { throw new Error("start seq 8 is not a balanced boundary"); },
  });
  const stillRan = await failing.fire(SEAMS.events.preStep, { agent: AGENT, signal: { aborted: false } });
  assert.equal(stillRan, "next", "a failed request must not fail somebody's turn");
  assert.equal(failing.observed.at(-1).reason, "request_failed");
  assert.match(failing.observed.at(-1).detail, /balanced boundary/);
});

test("a consumer that throws, and a sink that throws, are both survivable", async () => {
  const { fire, compactions } = engineWith({
    summarise: async () => ({ text: "unused" }),
    takeCompactRequest: () => { throw new Error("mirror unavailable"); },
  });
  assert.equal(await fire(SEAMS.events.preStep, { agent: AGENT, signal: { aborted: false } }), "next");
  assert.equal(compactions.length, 0);

  const Engine = createEvimedCompactionEngine(FakeBase, {
    readHandles: () => HANDLES,
    takeCompactRequest: () => ({ reason: "x" }),
    observe: () => { throw new Error("metrics down"); },
  });
  const { ctx, fire: fire2 } = fakeCtx();
  const engine = new Engine(ctx, {});
  engine.compactIfNeeded = async () => ({ shadowedSeqs: [1] });
  assert.equal(await fire2(SEAMS.events.preStep, { agent: AGENT, signal: { aborted: false } }), "next",
    "a metrics sink must not be able to fail a step");
});

/* ---------------------------------------------- a correction survives a compaction */

test("a mid-run correction is lifted out of the conversation and into the packet", () => {
  // The failure every published mid-run-steering implementation names: a
  // steered instruction treated as an ordinary user message gets summarised
  // away while the assistant turn it modified is kept, and the model then reads
  // the original task with the correction removed. A run that loses a
  // correction does not fail — it confidently does the thing it was told to
  // stop doing.
  const handles = correctionHandles([
    { role: "user", content: [{ type: "text", text: "review the evidence on empagliflozin" }] },
    { role: "assistant", content: [{ type: "text", text: "searching" }] },
    { role: "user", content: [{ type: "text", text: "<evimed-correction>only randomised trials, drop the registries</evimed-correction>" }] },
    { role: "user", content: [{ type: "text", text: "<evimed-correction>and cap it at 2020 onwards</evimed-correction>" }] },
  ]);
  assert.deepEqual(handles, [
    { kind: "correction", id: "correction-1", detail: "only randomised trials, drop the registries" },
    { kind: "correction", id: "correction-2", detail: "and cap it at 2020 onwards" },
  ], "numbered in the order they were given, because which came second is the operative one");

  // Repeated because the conversation replays it, not because it was said twice.
  const once = correctionHandles([
    { content: [{ text: "<evimed-correction>same words</evimed-correction>" }] },
    { content: [{ text: "<evimed-correction>same words</evimed-correction>" }] },
  ]);
  assert.equal(once.length, 1);

  // Nothing to find is not an error, and unmarked prose is never a correction.
  assert.deepEqual(correctionHandles([]), []);
  assert.deepEqual(correctionHandles(undefined), []);
  assert.deepEqual(correctionHandles([{ content: [{ text: "please correct course and drop the registries" }] }]), []);
  assert.deepEqual(correctionHandles([{ content: [{ text: "<evimed-correction>   </evimed-correction>" }] }]), []);
});

test("a correction reaches the summary packet ahead of the sources it constrains", async () => {
  const { engine, calls } = engineWith({ summarise: async () => ({ text: "summary" }), handles: [] });
  await engine.summarize({
    ...INPUT,
    messages: [{ role: "user", content: [{ type: "text", text: "<evimed-correction>randomised trials only</evimed-correction>" }] }],
  }, AGENT);
  const packet = appendedText(calls[0]);
  assert.match(packet, /randomised trials only/, "a run with no other handles still carries its corrections");
  assert.match(packet, /correction/);
});
