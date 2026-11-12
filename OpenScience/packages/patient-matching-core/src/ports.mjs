import { array, check, identifier, object, oneOf, text } from './validation.mjs'
import { assertScope, validateScope } from './identity.mjs'

export const HOST_ABI = 'patient-matching.host.v1'
export const HOST_PORT_METHODS = Object.freeze(Object.fromEntries(Object.entries({
  IdentityPort: ['resolve', 'authorize'],
  PatientDataPort: ['read', 'context', 'correct'],
  KnowledgePort: ['search', 'read'],
  RegistryPort: ['search', 'read'],
  IndexPort: ['query', 'build'],
  ModelPort: ['embed', 'rerank', 'priority'],
  ExecutionPort: ['assess', 'compute', 'report', 'cancel'],
  JobPort: ['get', 'cancel', 'continue'],
  ResultPort: ['get', 'save', 'history'],
  ExtensionPort: ['describe'],
}).map(([port, methods]) => [port, Object.freeze(methods)])))

export function validateHostPorts(host) {
  object(host, 'host')
  check(host.abi === HOST_ABI, 'host.abi', 'incompatible host ABI', 'unsupported_host_abi')
  object(host.ports, 'host.ports')
  for (const [port, methods] of Object.entries(HOST_PORT_METHODS)) {
    object(host.ports[port], `host.ports.${port}`)
    for (const method of methods) check(typeof host.ports[port][method] === 'function', `host.ports.${port}.${method}`, 'missing host operation', 'missing_host_operation')
  }
  return host
}

export function validateToolResponse(response, path = 'response') {
  object(response, path, ['status', 'summary', 'data', 'artifacts', 'nextAction'])
  oneOf(response.status, ['complete', 'pending', 'partial', 'failed', 'unsupported', 'cancelled'], `${path}.status`)
  text(response.summary, `${path}.summary`)
  check(Object.hasOwn(response, 'data'), `${path}.data`, 'missing typed data')
  array(response.artifacts, `${path}.artifacts`, identifier)
  if (response.nextAction !== undefined && response.nextAction !== null) text(response.nextAction, `${path}.nextAction`)
  return response
}

/** Scope is a host-verified invocation reference, never authority derived from a model argument. */
export function createHostClient(host, scope) {
  validateHostPorts(host)
  validateScope(scope)
  const boundScope = Object.freeze({ ...scope })
  return Object.freeze({
    abi: HOST_ABI,
    scope: boundScope,
    async call(port, operation, input = {}) {
      check(Object.hasOwn(HOST_PORT_METHODS, port) && HOST_PORT_METHODS[port].includes(operation), 'operation', 'operation is outside host ABI', 'unsupported_operation')
      check(!(port === 'IdentityPort'), 'operation', 'identity operations are host bootstrap operations', 'unsupported_operation')
      object(input, 'input')
      if (input.scope !== undefined) assertScope(boundScope, input.scope, 'input.scope')
      // Authorization and the operation share an isolated immutable invocation envelope.
      const envelope = structuredClone({ scope: boundScope, port, operation, input })
      const authorization = await host.ports.IdentityPort.authorize(structuredClone(envelope))
      check(authorization?.allowed === true, 'authorization', 'host denied operation', 'access_denied')
      assertScope(boundScope, authorization.scope, 'authorization.scope')
      const response = await host.ports[port][operation](envelope)
      validateToolResponse(response)
      if (response.data?.scope !== undefined) assertScope(boundScope, response.data.scope, 'response.data.scope')
      return response
    },
  })
}

export async function bindHostInvocation(host, invocation) {
  validateHostPorts(host)
  const scope = await host.ports.IdentityPort.resolve({ invocation: structuredClone(invocation) })
  return createHostClient(host, scope)
}
