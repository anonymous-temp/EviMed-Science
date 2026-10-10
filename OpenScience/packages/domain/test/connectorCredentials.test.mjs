// The connectors a researcher may hold a credential for, as one registry the
// shell, the account card, the gateway and the adapters all read. What these
// pin: every id is a profile the gateway injects (the deployment-side mapping
// exists), the two rate-only upstreams are marked keyless, and a credential's
// shape is checked without ever being sent anywhere.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CONNECTOR_CREDENTIALS, CONNECTOR_CREDENTIAL_IDS, CONNECTOR_MISSING_CODES, connectorCredentialSpec,
  connectorDeploymentSource, connectorForMissingCode, connectorMissingCode,
  validateConnectorCredentialValue } from '../src/connectorCredentials.mjs'
import { classifyEvidenceSourceError, errorCodeMessage, recoverableEvidenceSourceErrorCodes } from '../src/errorCodes.mjs'

test('every connector maps to a deployment-side credential source, the first-party evidence API included', () => {
  assert.ok(CONNECTOR_CREDENTIALS.length >= 12, `walked ${CONNECTOR_CREDENTIALS.length} connectors`)
  for (const spec of CONNECTOR_CREDENTIALS) {
    assert.ok(CONNECTOR_CREDENTIAL_IDS.has(spec.id))
    assert.ok(connectorDeploymentSource(spec.id), `${spec.id} has no deployment-side source`)
    assert.match(spec.unlocks, /[一-鿿]/, `${spec.id}: the researcher-facing sentence is Chinese`)
    assert.match(spec.obtainUrl, /^https:\/\//)
    assert.equal(connectorCredentialSpec(spec.id), spec)
  }
  // Left out until 2026-10-04 ("a deployment either has it or does not"); the
  // owner ruled that a source nobody configured is the researcher's to
  // configure when they use it, and this is the one that literature search,
  // guideline text and the ChiCTR listing read.
  assert.equal(connectorCredentialSpec('evimed-evidence')?.title, 'EviMed 证据库')
  assert.deepEqual(connectorDeploymentSource('evimed-evidence'), { configKey: 'evimedEvidence' })
  assert.deepEqual(connectorDeploymentSource('materials-project'), { configValue: 'materialsProjectApiKey' })
  assert.deepEqual(connectorDeploymentSource('semantic-scholar'), { configKey: 'semanticScholar' })
  assert.deepEqual(connectorDeploymentSource('iuphar'), { configKey: 'iuphar' })
  assert.equal(connectorCredentialSpec('iuphar')?.keyless, false)
  assert.equal(connectorForMissingCode('public_source_iuphar_credential_missing'), 'iuphar')
  assert.deepEqual(CONNECTOR_CREDENTIALS.filter((spec) => spec.keyless).map((spec) => spec.id).sort(), ['ncbi', 'openfda', 'semantic-scholar'])
  assert.equal(connectorCredentialSpec('opengwas')?.validityDays, 14)
})

test('a credential is validated by shape only, and a JWT yields its own expiry', () => {
  const exp = Math.floor(Date.now() / 1000) + 14 * 86_400
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: 'x', exp })).toString('base64url'), 'sig'].join('.')
  const okJwt = validateConnectorCredentialValue('opengwas', jwt)
  assert.equal(okJwt.ok, true)
  assert.equal(okJwt.ok && okJwt.expiresAt, new Date(exp * 1000).toISOString())
  const expired = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp: 1_000 })).toString('base64url'), 'sig'].join('.')
  assert.equal(validateConnectorCredentialValue('opengwas', expired).ok, false)
  assert.equal(validateConnectorCredentialValue('opengwas', 'not-a-jwt').ok, false)
  assert.equal(validateConnectorCredentialValue('unpaywall', 'researcher@example.org').ok, true)
  assert.equal(validateConnectorCredentialValue('unpaywall', 'researcher').ok, false)
  assert.equal(validateConnectorCredentialValue('umls', ' abc123 ').ok, true)
  assert.equal(validateConnectorCredentialValue('umls', 'abc 123').ok, false)
  assert.equal(validateConnectorCredentialValue('umls', 'a\nb').ok, false)
  assert.equal(validateConnectorCredentialValue('umls', '').ok, false)
  assert.equal(validateConnectorCredentialValue('umls', 'x'.repeat(8 * 1024 + 1)).ok, false)
  assert.equal(validateConnectorCredentialValue('nope', 'x').ok, false)
  assert.equal(validateConnectorCredentialValue('umls', 42).ok, false)
})

test('every connector has one "not configured" code, and the recoverable set is exactly that list', () => {
  assert.equal(connectorMissingCode('semantic-scholar'), 'public_source_semantic_scholar_credential_missing')
  assert.equal(connectorMissingCode('evimed-evidence'), 'public_source_evimed_evidence_credential_missing')
  for (const spec of CONNECTOR_CREDENTIALS) {
    const code = connectorMissingCode(spec.id)
    assert.equal(connectorForMissingCode(code), spec.id)
    // Recoverable for every connector, none exempted: a run that meets an
    // unconfigured source goes on with the sources it has.
    assert.equal(classifyEvidenceSourceError(code), 'recoverable', code)
    assert.match(errorCodeMessage(code), /设置 → 数据源/, code)
  }
  // The engine's own refusal for the same need is mapped to the same connector.
  assert.equal(connectorForMissingCode('mr_input_remote_auth_required'), 'opengwas')
  assert.equal(CONNECTOR_MISSING_CODES.size, CONNECTOR_CREDENTIALS.length + 1)
  // Derived, not hand-listed: the `*_credential_missing` codes the set carries
  // are exactly the registry's, so a connector added to the registry is covered
  // and a code with no connector behind it cannot linger.
  const carried = [...recoverableEvidenceSourceErrorCodes].filter((code) => /^public_source_[a-z0-9_]+_credential_missing$/.test(code))
  assert.deepEqual(new Set(carried), new Set(CONNECTOR_CREDENTIALS.map((spec) => connectorMissingCode(spec.id))))
  // A code that only looks like one names no connector.
  assert.equal(connectorForMissingCode('public_source_nonexistent_credential_missing'), null)
  assert.equal(connectorForMissingCode(null), null)
  assert.equal(classifyEvidenceSourceError('public_source_nonexistent_credential_missing'), 'unknown')
})
