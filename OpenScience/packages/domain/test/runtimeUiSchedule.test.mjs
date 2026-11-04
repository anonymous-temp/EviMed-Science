// The kernel's automation tasks are the product's scheduled tasks (owner, 2026-11-04), so the `schedule` namespace is open to the
// browser. What stays held is where a task's conversations open: `schedule/create` and `schedule/edit` take `target.create.cwd` and
// `target.create.agentPreset` as given, and the session they make runs there at the first delivery.
import assert from 'node:assert/strict'
import test from 'node:test'

import { RUNTIME_UI_DENIED_NAMESPACES, isDeniedRuntimeUiMethod, runtimeUiMethodFromPath, runtimeUiScheduleRefusal } from '../index.mjs'

const ROOT = '/workspace/projects/default'
const PRESET = 'evimed-universal'
const refusal = (/** @type {string | null} */ method, /** @type {unknown} */ payload) => runtimeUiScheduleRefusal(method, payload, ROOT, PRESET)
/** A `schedule/create` payload as the kernel's own page sends it: the request is under `args`. */
const create = (/** @type {Record<string, any>} */ over = {}) => ({ args: { request: { title: 't', prompt: 'p', timing: { kind: 'rrule', rrule: 'FREQ=DAILY' }, ...over } } })
const edit = (/** @type {Record<string, any>} */ patch) => ({ args: { request: { id: 'sch_1', action: 'update', patch } } })

test('the schedule namespace is the browser\'s again, and the namespaces that arrived with 0.2.2 are not', () => {
  for (const method of ['schedule/list', 'schedule/view', 'schedule/create', 'schedule/edit', 'schedule/run', 'schedule/deliveryHistory']) {
    assert.equal(isDeniedRuntimeUiMethod(method), false, method)
  }
  assert.ok(!RUNTIME_UI_DENIED_NAMESPACES.includes('schedule'))
  for (const namespace of ['forgePanel', 'liveshareShares', 'pluginRecommendations', 'actionCards']) {
    assert.ok(RUNTIME_UI_DENIED_NAMESPACES.includes(namespace), `${namespace} is classified`)
    assert.equal(isDeniedRuntimeUiMethod(`${namespace}/list`), true, namespace)
  }
  assert.equal(runtimeUiMethodFromPath('/api/schedule/create'), 'schedule/create')
})

test('only the two calls that can name a destination are looked at, and a task that names none is fine', () => {
  for (const method of [null, undefined, '', 'schedule/list', 'schedule/view', 'schedule/run', 'session/prompt', 'workspaceFiles/read']) {
    assert.equal(refusal(/** @type {any} */ (method), { args: { request: { target: { create: { cwd: '/etc', agentPreset: 'x' } } } } }), null, String(method))
  }
  // Omitting the destination, the creation settings, or either of the two is always allowed: the Host's defaults are this project's
  // workspace and this deployment's composition.
  assert.equal(refusal('schedule/create', create()), null)
  assert.equal(refusal('schedule/create', create({ target: { kind: 'new' } })), null)
  assert.equal(refusal('schedule/create', create({ target: { kind: 'new_once', create: {} } })), null)
  assert.equal(refusal('schedule/create', create({ target: { kind: 'session', sessionId: 'ses_1' } })), null)
  assert.equal(refusal('schedule/edit', edit({ title: 'new name', active: false })), null)
  assert.equal(refusal('schedule/edit', { args: { request: { id: 'sch_1', action: 'delete' } } }), null, 'a delete carries no destination')
})

test('a task\'s conversations open in this project\'s workspace, and only there', () => {
  for (const cwd of [ROOT, `${ROOT}/analysis`, 'analysis/2026', 'a/b/c']) {
    assert.equal(refusal('schedule/create', create({ target: { kind: 'new', create: { cwd } } })), null, cwd)
    assert.equal(refusal('schedule/edit', edit({ target: { kind: 'new_once', create: { cwd } } })), null, cwd)
  }
  for (const cwd of ['/etc', '/', '/workspace/projects/other', `${ROOT}-2/x`, '../elsewhere', `${ROOT}/../other`, 'a/%2e%2e/b', 'a\\b', '', 'x\0y', 42, null, {}, ['a']]) {
    const reason = /a task's conversations open in this project's workspace|new-conversation settings/
    assert.match(String(refusal('schedule/create', create({ target: { kind: 'new', create: { cwd } } }))), reason, `create ${JSON.stringify(cwd)}`)
    assert.match(String(refusal('schedule/edit', edit({ target: { kind: 'new', create: { cwd } } }))), reason, `edit ${JSON.stringify(cwd)}`)
  }
})

test('a task\'s conversations run this deployment\'s composition, and no other preset', () => {
  assert.equal(refusal('schedule/create', create({ target: { kind: 'new', create: { agentPreset: PRESET } } })), null)
  assert.equal(refusal('schedule/create', create({ target: { kind: 'new', create: { cwd: ROOT, agentPreset: PRESET } } })), null)
  for (const agentPreset of ['default', 'evimed-open-domain', 'evimed-universal ', 'EVIMED-UNIVERSAL', '', 7, null]) {
    const reason = /this deployment's composition/
    assert.match(String(refusal('schedule/create', create({ target: { kind: 'new', create: { agentPreset } } }))), reason, `create ${JSON.stringify(agentPreset)}`)
    assert.match(String(refusal('schedule/edit', edit({ target: { kind: 'new_once', create: { agentPreset } } }))), reason, `edit ${JSON.stringify(agentPreset)}`)
  }
  // A good directory beside a bad preset is still refused: each is held on its own.
  assert.match(String(refusal('schedule/create', create({ target: { kind: 'new', create: { cwd: ROOT, agentPreset: 'default' } } }))), /composition/)
  assert.match(String(refusal('schedule/create', create({ target: { kind: 'new', create: { cwd: '/etc', agentPreset: PRESET } } }))), /workspace/)
})

test('an edit reads its destination from the patch, and a create from the request', () => {
  const bad = { kind: 'new', create: { cwd: '/etc' } }
  // A destination in the wrong place for the call is not the destination the kernel would read, so it is not looked at.
  assert.equal(refusal('schedule/edit', { args: { request: { id: 'sch_1', action: 'update', patch: { title: 'x' }, target: bad } } }), null)
  assert.equal(refusal('schedule/create', { args: { request: { title: 't', patch: { target: bad } } } }), null)
  assert.match(String(refusal('schedule/edit', edit({ target: bad }))), /workspace/)
  assert.match(String(refusal('schedule/create', create({ target: bad }))), /workspace/)
})

test('a call that does not carry its request in the shape of the transport is refused, not guessed at', () => {
  for (const method of ['schedule/create', 'schedule/edit']) {
    for (const payload of [null, undefined, 'x', 7, [], {}, { args: null }, { args: {} }, { args: { request: null } }, { args: { request: 'x' } }, { args: { request: [] } }, { args: [] }]) {
      assert.match(String(refusal(method, payload)), /must carry its request/, `${method} ${JSON.stringify(payload)}`)
    }
  }
  // A destination or its creation settings that are not objects.
  for (const target of [null, 'new', 7, [], false]) {
    assert.match(String(refusal('schedule/create', create({ target }))), /destination must be an object/, JSON.stringify(target))
    assert.match(String(refusal('schedule/edit', edit({ target }))), /destination must be an object/, JSON.stringify(target))
  }
  for (const settings of [null, 'cwd', 7, [], false]) {
    assert.match(String(refusal('schedule/create', create({ target: { kind: 'new', create: settings } }))), /new-conversation settings must be an object/, JSON.stringify(settings))
    assert.match(String(refusal('schedule/edit', edit({ target: { kind: 'new', create: settings } }))), /new-conversation settings must be an object/, JSON.stringify(settings))
  }
})
