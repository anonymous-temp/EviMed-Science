// The handles a structured compaction carries forward are read from the run mirror by the socket and rendered into the
// summary request by the engine in the harness port. The two sides share a vocabulary - `{ kind, id, detail }`, with the
// kinds in `STATE_HANDLE_KINDS` - and a reader tested on its own cannot tell when they stop sharing it: the socket wrote
// `note` for the engine's `detail`, so every context line it chose never reached the summary; named a kind the packet had no
// rank for; and read `deliverableId` / `state` from plan items that carry `id` / `status`, so no deliverable was ever
// listed (2026-10-10 review D6). These tests read the handles the way the engine does and look at the packet it renders.
import assert from 'node:assert/strict'
import test from 'node:test'
import { planFileFor, runStateFileFor } from '@evimed/domain'
import { STATE_HANDLE_KINDS, createEvimedCompactionEngine } from '@evimed/harness-port'
import { readRunHandles } from '../plugins/compaction.mjs'

/** The upstream shape the engine subclasses, and nothing else. */
class FakeBase {
  static inject = ['llm']
  static Config = {}
  /** @param {any} ctx @param {any} [config] */
  constructor(ctx, config) { this.ctx = ctx; this.config = config }
  async summarize() { return { summary: [{ type: 'text', text: 'base summary' }] } }
  async compactIfNeeded() { return null }
}

const AGENT = { session: { id: 'session_a' } }

/** The tables as the run policy fills them: plan items are `publicItem`s (`id`, `status`), evidence rows carry `sourceId`. */
function tables() {
  return {
    runIdForSession: () => 'run_a',
    runMirror: { select: async () => [{ runId: 'run_a', sessionId: 'session_a', cwd: '/workspace', steps: 3, tokens: 1200, children: 0, budget: { maxSteps: 100, maxTokens: 8000, maxChildren: 3 } }] },
    planIndex: { select: async () => [{ runId: 'run_a', revision: 2, items: [
      { id: 'd1', title: 'Report', contractKind: 'research-brief', capability: 'research-brief', dependsOn: [], status: 'accepted', attempts: 1, issues: [] },
      { id: 'd2', title: 'Appendix', contractKind: 'research-brief', capability: 'research-brief', dependsOn: ['d1'], status: 'planned', attempts: 0, issues: [] },
    ] }] },
    evidence: { select: async () => [{ evidenceId: 'ev_1', runId: 'run_a', sourceId: 'src_4b1e', status: 'ready' }] },
  }
}

/** The packet the engine puts in front of the summarizer for these tables: the engine's own path, from `readHandles` on. */
async function renderedPacket() {
  const handles = await readRunHandles(tables(), AGENT)
  /** @type {any[]} */
  const calls = []
  const Engine = createEvimedCompactionEngine(FakeBase, {
    readHandles: (agent) => readRunHandles(tables(), agent),
    // A summary that keeps every identifier, so the engine asks once.
    summarise: async (input) => { calls.push(input); return { summary: [{ type: 'text', text: handles.map((handle) => handle.id).join(' ') }] } },
  })
  const engine = new Engine({ on() {} }, {})
  await engine.summarize({ messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'run the review' }] }] }, AGENT)
  assert.equal(calls.length, 1, 'the summary kept every handle, so the engine asked once')
  const text = /** @type {string} */ (calls[0].messages.at(-1).content[0].text)
  return { handles, lines: text.slice(text.indexOf('STATE HANDLES'), text.indexOf('END STATE HANDLES')).split('\n') }
}

test('the handles the socket reads use the engine\'s vocabulary: its kinds and its `detail` field', async () => {
  const { handles } = await renderedPacket()
  assert.ok(handles.length >= 5, `the run's plan, projection, deliverables, source and budget: ${JSON.stringify(handles)}`)
  for (const handle of handles) {
    assert.ok(STATE_HANDLE_KINDS.includes(handle.kind), `${handle.kind} is a kind the packet ranks`)
    assert.deepEqual(Object.keys(handle).filter((key) => !['kind', 'id', 'detail'].includes(key)), [], `${handle.id} carries only the fields the engine reads`)
  }
})

test('the summary request lists each handle with its context, in the packet\'s reading order', async () => {
  const { lines } = await renderedPacket()
  const body = lines.filter((line) => line.startsWith('['))
  assert.deepEqual(body, [
    `[plan] ${planFileFor('run_a')} - this run’s plan is authoritative; this summary is not`,
    `[projection] ${runStateFileFor('run_a')} - this run only; other session state is not this task`,
    '[source] src_4b1e - ready',
    '[deliverable] d1 - plan item is accepted',
    '[deliverable] d2 - plan item is planned',
    '[budget] 1200/8000 tokens',
  ])
})
