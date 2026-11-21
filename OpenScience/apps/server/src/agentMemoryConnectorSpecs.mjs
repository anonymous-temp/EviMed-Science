import { agentMemoryOpenApi } from './agentMemoryOpenApi.mjs';

// Both standalone connectors ship the same offline catalogue. Keep the original hand-written
// conversational tools and generate the remaining authenticated operations from the HTTP contract.
export function connectorSpecs() {
  const document = agentMemoryOpenApi({ basePath: '/api/agent-memory/v1', rateLimitPerMinute: 120 });
  function expand(value) {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) return expand(value.$ref.slice(2).split('/').reduce((node, key) => node[key], document));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
  }
  const existing = new Set(['/','/context','/recall','/remember','/forget','/forgotten','/note','/openapi.json']);
  const host = { '/conversations': 'conversationIngest', '/work-events': 'workSignals', '/sharing': 'capsuleSharing' };
  const specs = [];
  for (const [path, verbs] of Object.entries(document.paths)) {
    if (existing.has(path)) continue;
    for (const [verb, operation] of Object.entries(verbs)) {
      const body = expand(operation.requestBody?.content['application/json'].schema ?? {});
      const properties = { ...body.properties };
      const required = [...(body.required ?? [])];
      const query = [];
      for (const param of operation.parameters.map(expand)) {
        if (param.in === 'header') continue;
        properties[param.name] = param.schema;
        if (param.required) required.push(param.name);
        if (param.in === 'query') query.push(param.name);
      }
      const name = path.slice(1).replace('/{id}', '').replace(/[-/]/g, '_') + (verb === 'patch' ? '_edit' : verb === 'delete' ? '_delete' : '');
      specs.push({ name, method:verb.toUpperCase(), path, capability: host[path] ?? null, query,
        description: operation.summary + (host[path] === 'conversationIngest' ? ' Only forward a real host-captured attended transcript. Never reconstruct human turns.' : ''),
        properties, required });
    }
  }
  return specs;
}
