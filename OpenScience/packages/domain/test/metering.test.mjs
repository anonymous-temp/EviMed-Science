import assert from 'node:assert/strict'
import test from 'node:test'
import { PRICE_LIST_VERSIONS, REFERENCE_PRICE_LIST, priceListAt, priceListFor, priceUsage } from '../index.mjs'

/** One metered request, reused so two prices are comparable. */
const request = { resourceType: 'model', model: 'deepseek-v4-pro', cacheMiss: 1_000_000, output: 1_000_000, peak: true }

/** What `priceUsage` returns when it refuses to price. */
const refused = { cost: 0, priced: false, currency: '' }

/** Every object inside a value, itself included — the freeze check walks this.
 * @param {unknown} value @returns {object[]} */
function objectsIn(value) {
  if (!value || typeof value !== 'object') return []
  return [value, ...Object.values(value).flatMap(objectsIn)]
}

test('the current price version resolves to the exact list every ledger row stamps', () => {
  const version = REFERENCE_PRICE_LIST.version
  assert.equal(typeof version, 'string')
  assert.equal(priceListFor(version), REFERENCE_PRICE_LIST)
  // Pricing against the resolved list must equal pricing against the default,
  // or "resolve then price" would quietly be a different calculation.
  assert.deepEqual(priceUsage(request, priceListFor(version)), priceUsage(request))
  assert.equal(priceUsage(request).priced, true)
  assert.notEqual(priceUsage(request).cost, 0)
})

test('a caller that resolved an unknown version cannot get a priced result, as null or as undefined', () => {
  assert.equal(priceListFor('evimed-reference-1999-01-01'), null)
  assert.equal(priceListFor(''), null)
  assert.equal(priceListFor(undefined), null)
  assert.deepEqual(priceUsage(request, priceListFor('evimed-reference-1999-01-01')), refused)
  // The failure this guards: a historical row silently re-priced at today's
  // rates is a wrong invoice that looks right.
  assert.notEqual(priceUsage(request, priceListFor('evimed-reference-1999-01-01')).cost, priceUsage(request).cost)
  // And the same must hold for `undefined`, which is what indexing any map
  // with a version it does not hold returns. A defaulted parameter cannot tell
  // that apart from an omitted argument; this one has to.
  assert.deepEqual(priceUsage(request, undefined), refused)
  const ownRegistry = /** @type {Record<string, any>} */ ({})
  assert.deepEqual(priceUsage(request, ownRegistry['evimed-reference-1999-01-01']), refused)
  for (const resourceType of ['asr', 'embedding', 'specialist-job', 'storage']) {
    assert.deepEqual(priceUsage({ resourceType, minutes: 1, tokens: 1_000_000, jobType: 'meta-analysis', gigabyteDays: 1, peak: true }, undefined), refused)
  }
})

test('nothing exported hands out the registry itself', async () => {
  const metering = await import('../src/metering.mjs')
  const root = await import('../index.mjs')
  let inspected = 0
  for (const source of [metering, root]) {
    for (const [name, value] of Object.entries(source)) {
      if (!value || typeof value !== 'object') continue
      inspected += 1
      const held = Object.values(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (value)))
      assert.equal(held.includes(REFERENCE_PRICE_LIST), false, `${name} exposes the price-list registry; one index with an unknown version is an undefined list`)
    }
  }
  assert.ok(inspected >= 10, `only ${inspected} exported objects were inspected; the walk found nothing to check`)
  // The one enumeration that is exported carries names, not lists, and is frozen.
  for (const version of PRICE_LIST_VERSIONS) assert.equal(typeof version, 'string')
  assert.throws(() => { /** @type {any} */ (PRICE_LIST_VERSIONS).push('evimed-reference-1999-01-01') }, TypeError)
})

test('the list in force now is the one the gateway stamps on every new row', () => {
  // Without this, a later edit could point the registry's newest list somewhere
  // else while the gateway keeps stamping `REFERENCE_PRICE_LIST.version`: every
  // row stamped with one list and charged at another, and nothing would say so.
  assert.equal(priceListAt(new Date()), REFERENCE_PRICE_LIST)
  assert.equal(PRICE_LIST_VERSIONS.at(-1), REFERENCE_PRICE_LIST.version, 'the newest registered list must be the one this platform bills at')
  const current = Date.parse(REFERENCE_PRICE_LIST.effectiveFrom)
  assert.ok(Number.isFinite(current))
  for (const version of PRICE_LIST_VERSIONS) {
    const list = priceListFor(version)
    assert.ok(list, `${version} does not resolve`)
    const from = Date.parse(list.effectiveFrom)
    // The ordering the module's own doc comment prescribes: append with its own
    // `effectiveFrom` and point `REFERENCE_PRICE_LIST` at it. A registered list
    // dated after the reference one, or dated in the future, breaks that.
    assert.ok(from <= current, `${version} starts after the list this platform bills at`)
    assert.ok(from <= Date.now(), `${version} has not started billing yet`)
  }
})

test('an effective-dated lookup returns the list in force at that instant', () => {
  const first = priceListFor(PRICE_LIST_VERSIONS[0])
  assert.ok(first)
  const effectiveFrom = Date.parse(first.effectiveFrom)
  // The three shapes an instant arrives in, each resolving like the others.
  assert.equal(priceListAt(new Date(effectiveFrom)), first, 'the boundary instant belongs to the list that starts then')
  assert.equal(priceListAt(first.effectiveFrom), first, 'an ISO instant resolves like the Date it names')
  assert.equal(priceListAt(effectiveFrom), first, 'epoch milliseconds resolve like the Date they name')
  assert.equal(priceListAt(Date.now()), priceListAt(new Date()))
  assert.equal(priceListAt(new Date(effectiveFrom + 86_400_000)), first)
  assert.equal(priceListAt(new Date(effectiveFrom - 1)), null, 'no list was in force before the first one')
  assert.equal(priceListAt('not-an-instant'), null)
  assert.equal(priceListAt(Number.NaN), null)

  // The selection rule itself, proven on a registry with a successor: at a
  // boundary the later list wins from its own instant, not from the next day.
  const older = Object.freeze({ ...first, version: 'test-older', effectiveFrom: '2020-01-01T00:00:00.000Z' })
  const newer = Object.freeze({ ...first, version: 'test-newer', effectiveFrom: '2021-06-01T00:00:00.000Z' })
  const registry = Object.freeze({ 'test-newer': newer, 'test-older': older })
  const boundary = Date.parse(newer.effectiveFrom)
  assert.equal(priceListAt(new Date(boundary - 1), registry), older)
  assert.equal(priceListAt(new Date(boundary), registry), newer)
  assert.equal(priceListAt(new Date(Date.parse(older.effectiveFrom) - 1), registry), null)
  assert.equal(priceListFor('test-newer'), null, 'a caller-supplied registry must not leak into the shipped one')
})

test('every registered price list is frozen through every rate it holds', () => {
  assert.ok(PRICE_LIST_VERSIONS.length >= 1, 'the registry is empty; no ledger row could resolve its price version')
  for (const version of PRICE_LIST_VERSIONS) {
    const list = /** @type {any} */ (priceListFor(version))
    assert.ok(list, `${version} does not resolve`)
    // `Object.freeze` is shallow; the rates are two levels down. Walk the whole
    // list, not just its top, and prove the *runtime* refuses the writes — that
    // is what protects a list that has already priced a settled ledger row.
    const objects = objectsIn(list)
    assert.ok(objects.length >= 4, `${version} has no nested rate tables to freeze`)
    for (const object of objects) assert.equal(Object.isFrozen(object), true, `${version} holds an unfrozen ${JSON.stringify(object).slice(0, 40)}`)
    assert.throws(() => { list.asrPerMinute = 99 }, TypeError)
    assert.throws(() => { list.model = {} }, TypeError)
    assert.throws(() => { delete list.specialistJob }, TypeError)
    for (const model of Object.keys(list.model)) {
      assert.throws(() => { list.model[model].output = 99 }, TypeError, `${version} lets ${model}'s output rate be rewritten`)
    }
    for (const jobType of Object.keys(list.specialistJob)) {
      assert.throws(() => { list.specialistJob[jobType] = 99 }, TypeError, `${version} lets ${jobType}'s price be rewritten`)
    }
  }
  assert.equal(priceListFor(REFERENCE_PRICE_LIST.version), REFERENCE_PRICE_LIST)
})

test('every registered price list carries its own unique version and a valid effectiveFrom', () => {
  const instants = new Set()
  for (const version of PRICE_LIST_VERSIONS) {
    const list = priceListFor(version)
    assert.ok(list, `${version} does not resolve`)
    assert.equal(list.version, version, `${version} disagrees with the key it is registered under`)
    assert.ok(Number.isFinite(Date.parse(list.effectiveFrom)), `${version} has no parseable effectiveFrom`)
    assert.equal(new Date(list.effectiveFrom).toISOString(), list.effectiveFrom, `${version} must state effectiveFrom as a UTC instant`)
    assert.equal(instants.has(list.effectiveFrom), false, `${version} shares an effectiveFrom with another list`)
    instants.add(list.effectiveFrom)
    assert.ok(typeof list.currency === 'string' && list.currency.length > 0, `${version} has no currency`)
    // Every list must be able to price the models the gateway can route to.
    for (const model of Object.keys(REFERENCE_PRICE_LIST.model)) {
      assert.ok(list.model[model], `${version} cannot price ${model}`)
    }
    // And every list resolves by date to itself or to a successor.
    assert.notEqual(priceListAt(new Date(Date.parse(list.effectiveFrom))), null)
  }
  assert.equal(new Set(PRICE_LIST_VERSIONS).size, PRICE_LIST_VERSIONS.length)
})
