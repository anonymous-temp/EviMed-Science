// The connectors a researcher may hold a credential for, as one registry the
// shell, the account card, the gateway and the adapters all read. What these
// pin: every id is a profile the gateway injects (the deployment-side mapping
// exists), the two rate-only upstreams are marked keyless, and a credential's
// shape is checked without ever being sent anywhere.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CONNECTOR_CREDENTIALS, CONNECTOR_CREDENTIAL_IDS, connectorCredentialSpec, connectorDeploymentSource,
  validateConnectorCredentialValue } from '../src/connectorCredentials.mjs'

test('every connector maps to a deployment-side credential source, and the first-party API is not a connector', () => {
  assert.ok(CONNECTOR_CREDENTIALS.length >= 10, `walked ${CONNECTOR_CREDENTIALS.length} connectors`)
  for (const spec of CONNECTOR_CREDENTIALS) {
    assert.ok(CONNECTOR_CREDENTIAL_IDS.has(spec.id))
    assert.ok(connectorDeploymentSource(spec.id), `${spec.id} has no deployment-side source`)
    assert.match(spec.unlocks, /[一-鿿]/, `${spec.id}: the researcher-facing sentence is Chinese`)
    assert.match(spec.obtainUrl, /^https:\/\//)
    assert.equal(connectorCredentialSpec(spec.id), spec)
  }
  assert.equal(connectorCredentialSpec('evimed-evidence'), null)
  assert.equal(connectorDeploymentSource('evimed-evidence'), null)
  assert.deepEqual(connectorDeploymentSource('materials-project'), { configValue: 'materialsProjectApiKey' })
  assert.deepEqual(connectorDeploymentSource('semantic-scholar'), { configKey: 'semanticScholar' })
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
