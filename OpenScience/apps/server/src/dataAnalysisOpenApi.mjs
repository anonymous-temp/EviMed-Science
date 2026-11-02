/** Public contract for the existing DeepSeek/DSH analyst; execution stays in the platform run ledger. */
export function dataAnalysisOpenApi() {
  /** @param {any} schema */
  const json = schema => ({ 'application/json': { schema } });
  /** @param {string} name */
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  /** @param {any} schema */
  const body = schema => ({ required: true, content: json(schema) });
  /** @param {any} properties @param {string[]} [required] */
  const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
  /** @param {number} maxLength */
  const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
  /** @param {string} name */
  const parameter = name => ({ name, in: 'path', required: true, schema: text(100) });
  /** @param {string} description @param {any} [schema] */
  const response = (description, schema = ref('Envelope')) => ({ description, content: json(schema) });
  const errors = {
    400: response('Invalid request, input encoding or filename.', ref('Error')),
    401: response('Missing, expired or revoked API key.', ref('Error')),
    403: response('Missing scope, project grant or source grant.', ref('Error')),
    404: response('No resource visible to this account.', ref('Error')),
    409: response('Busy analysis, conflicting request ID or changed preserved bytes.', ref('Error')),
    413: response('Input or artifact exceeds the configured byte limit.', ref('Error')),
    429: response('Request or execution limit reached.', ref('Error')),
    503: response('Service disabled, under maintenance or unavailable.', ref('Error')),
  };
  /** @param {string} operationId @param {string} summary @param {number} [status] @param {any} [request] @param {any[]} [parameters] */
  const operation = (operationId, summary, status = 200, request = undefined, parameters = []) => ({
    operationId, summary, parameters,
    ...(request ? { requestBody: request } : {}),
    responses: { [status]: response(status === 202 ? 'Turn admitted; poll its status. This is not analysis completion.' : 'Success.'), ...errors },
  });
  const analysis = parameter('analysisId');
  const turn = parameter('turnId');
  /** @type {any} */
  const contract = {
    openapi: '3.1.0',
    info: { title: 'EviMed Data Analysis API', version: '1.0.0', description: 'Authenticated asynchronous scientific analysis on DeepSeek and DSH. Each analysis owns a separate project/runtime. Follow-up turns share its state and serialize. Results are frozen per turn; partial outputs and notices remain visible.' },
    servers: [{ url: '/api/data-analysis/v1' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/analyses': { post: operation('createAnalysis', 'Create an isolated analysis; requires an unbound analysis.write key.', 201, body(ref('CreateAnalysis'))) },
      '/analyses/{analysisId}': { get: operation('getAnalysis', 'Read analysis identity, inputs and turn history; requires analysis.read.', 200, undefined, [analysis]) },
      '/analyses/{analysisId}/inputs': { post: operation('addAnalysisInput', 'Preserve a file, public HTTPS response or authorized configured source; requires analysis.write and an idle analysis.', 201, {
        required: true, content: { ...json(ref('Input')), 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      }, [analysis, { name: 'filename', in: 'query', required: false, description: 'Required for application/octet-stream. A filename, never a directory or host path.', schema: text(160) }]) },
      '/analyses/{analysisId}/turns': { post: operation('startAnalysisTurn', 'Start or continue the same analyst session; requires analysis.write. Reuse requestId to retry the same request.', 202, body(ref('TurnRequest')), [analysis]) },
      '/analyses/{analysisId}/turns/{turnId}': { get: operation('getAnalysisTurn', 'Read progress and, when settled, frozen results; requires analysis.read.', 200, undefined, [analysis, turn]) },
      '/analyses/{analysisId}/turns/{turnId}/results': { get: operation('getAnalysisResults', 'Read the same turn projection and artifact manifest; requires analysis.read.', 200, undefined, [analysis, turn]) },
      '/analyses/{analysisId}/turns/{turnId}/cancel': { post: operation('cancelAnalysisTurn', 'Request cancellation; poll until the actual runtime settles.', 200, body(object({})), [analysis, turn]) },
      '/analyses/{analysisId}/artifacts/{artifactId}': { get: {
        ...operation('downloadAnalysisArtifact', 'Download immutable bytes listed in a turn manifest; requires analysis.read.', 200, undefined, [analysis, parameter('artifactId')]),
        responses: { 200: { description: 'Artifact bytes. Active content is served as an attachment. Manifest includes SHA-256 and size.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...errors },
      } },
      '/openapi.json': { get: { operationId: 'getAnalysisOpenApi', security: [], summary: 'Read this API contract when the service is enabled.', responses: { 200: response('OpenAPI document.', { type: 'object' }), ...errors } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'An account API key with analysis.read and/or analysis.write. Never a DeepSeek provider key. X-Subject is not supported.' } },
      schemas: {
        CreateAnalysis: object({ name: text(120), requestId: { ...text(100), pattern: '^[A-Za-z0-9._:-]+$' } }, ['name', 'requestId']),
        TurnRequest: object({ question: text(16000), requestId: { ...text(100), pattern: '^[A-Za-z0-9._:-]+$' } }, ['question', 'requestId']),
        Input: { ...object({ filename: text(160), base64: { type: 'string', contentEncoding: 'base64' }, url: { type: 'string', format: 'uri', maxLength: 2048 }, sourceId: text(80) }, ['filename']),
          oneOf: [{ required: ['base64'] }, { required: ['url'] }, { required: ['sourceId'] }],
          description: 'Exactly one source is required. URL input snapshots the returned bytes; it does not let a model fetch the source independently. Configured sources bind an exact endpoint and account grant on the server.' },
        Envelope: { type: 'object', required: ['data'], properties: { data: { type: 'object', additionalProperties: true } } },
        Error: { type: 'object', properties: { code: { type: 'string' }, error: { type: 'string' }, requestId: { type: ['string', 'null'] } }, required: ['code', 'error', 'requestId'] },
        InputReceipt: { type: 'object', required: ['id', 'filename', 'sha256', 'bytes', 'path', 'provenance'], properties: {
          id: text(100), filename: text(160), path: { type: 'string', description: 'Workspace-relative source copy; not a download grant.' },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 1 },
          provenance: { type: 'object', properties: { kind: { enum: ['upload', 'url', 'configured-source'] }, acquiredAt: { type: 'string', format: 'date-time' }, origin: { type: 'string' }, pathname: { type: 'string' }, sourceId: { type: 'string' } }, required: ['kind', 'acquiredAt'] },
        } },
        Analysis: { type: 'object', required: ['id', 'projectId', 'name', 'requestId', 'phase', 'inputs', 'turnIds', 'sessionId', 'active'], properties: {
          id: text(100), projectId: text(100), name: text(120), requestId: text(100), phase: { enum: ['creating', 'ready'] },
          inputs: { type: 'array', items: ref('InputReceipt'), maxItems: 64 }, turnIds: { type: 'array', items: text(100), maxItems: 128 },
          sessionId: { type: ['string', 'null'] }, active: { type: ['object', 'null'], description: 'A durable input/turn reservation. Poll the named turn before requesting another writer.' },
        } },
        Notice: { type: 'object', required: ['code'], properties: { code: text(100), path: { type: 'string' } } },
        Artifact: { type: 'object', required: ['id', 'filename', 'role', 'mediaType', 'bytes', 'sha256', 'downloadUrl'], properties: {
          id: text(100), filename: text(160), path: { type: 'string' }, role: { enum: ['table', 'figure', 'report', 'code', 'data'] },
          mediaType: { type: 'string' }, bytes: { type: 'integer', minimum: 0 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          verification: { enum: ['verified', 'unverified'], description: 'Existing platform delivery-check label; not independent statistical validation, external validity or clinical certification.' },
          downloadUrl: { type: 'string', description: 'Same-origin API path. Send the account key to this path; never a provider credential.' },
        } },
        Result: { type: 'object', required: ['summary', 'structuredResults', 'artifacts', 'notices', 'frozenAt'], properties: {
          summary: { type: 'string', maxLength: 8000 },
          primaryOutput: { type: ['object', 'null'], description: 'The coherent output bundle selected for summary and structuredResults: one explicitly presented bundle first, otherwise one outermost bundle. Discovery of nested copies cannot override it. Multiple explicit or unresolved outermost bundles return null with a notice.', properties: {
            directory: { type: 'string' }, manifestPath: { type: ['string', 'null'] }, resultsPath: { type: ['string', 'null'] }, reportPath: { type: ['string', 'null'] },
          } },
          structuredResults: { type: ['object', 'null'], description: 'Executed analysis JSON, when available. Its method-specific fields are open; missing/invalid content is null with a notice.', properties: { schemaVersion: { const: 1 }, analyses: { type: 'array', items: { type: 'object' }, maxItems: 64 } } },
          artifacts: { type: 'array', items: ref('Artifact'), maxItems: 64 }, notices: { type: 'array', items: ref('Notice'), maxItems: 128 }, frozenAt: { type: 'string', format: 'date-time' },
        } },
        Turn: { type: 'object', required: ['id', 'analysisId', 'status', 'runId'], properties: {
          id: text(100), analysisId: text(100), projectId: text(100), requestId: text(100), question: text(16000),
          status: { type: 'string', description: 'Run lifecycle status, or dispatch_unknown when acceptance cannot be established. A succeeded run does not imply every scientific claim is verified.' },
          runId: { type: ['string', 'null'] }, errorCode: { type: 'string' }, dispatchStatus: { type: ['string', 'null'] },
          result: ref('Result'), notices: { type: 'array', items: ref('Notice') },
        } },
      },
    },
  };
  const outputs = { createAnalysis: 'Analysis', getAnalysis: 'Analysis', addAnalysisInput: 'InputReceipt', startAnalysisTurn: 'Turn', getAnalysisTurn: 'Turn', getAnalysisResults: 'Turn', cancelAnalysisTurn: 'Turn' };
  for (const route of Object.values(contract.paths)) {
    for (const entry of Object.values(/** @type {Record<string, any>} */ (route))) {
      const name = outputs[entry.operationId];
      if (!name) continue;
      for (const [status, answer] of Object.entries(/** @type {Record<string, any>} */ (entry.responses))) {
        if (Number(status) < 300) answer.content = json({ type: 'object', required: ['data'], properties: { data: ref(name) } });
      }
    }
  }
  return contract;
}
