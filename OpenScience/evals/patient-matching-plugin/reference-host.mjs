import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs'
import { ProductDocuments } from '../../apps/server/src/productStore.mjs'
import { migrateProductStore } from '../../apps/server/src/productPersistence.mjs'
import { composeVcr } from '../../apps/server/src/vcrComposition.mjs'
import { createVcrPatientContext } from '../../apps/server/src/vcrPatientContext.mjs'
import { readSubjectNote, tableFieldsOf } from '../../apps/server/src/vcrMatchJudge.mjs'
import { createPatientMatchingHostAdapter } from '../../apps/server/src/patientMatchingHostAdapter.mjs'
import { createPatientMatchingGatewayHandler } from '../../apps/server/src/patientMatchingGateway.mjs'
import { renderPatientMatchingReport } from '../../apps/server/src/patientMatchingReport.mjs'
import { createGeoTestDatabase } from '../../apps/server/test/helpers/geoTestDatabase.mjs'
import { validateMatchingResult, verifyEvidencePassage, contentDigest } from '../../packages/patient-matching-core/index.mjs'
const usageText = `Run one real native Flash clinical fixture with an isolated local PostgreSQL host adapter.

Required:
  --artifact PATH             Self-contained patient-matching bundle tarball
  --key-proxy-config PATH     Operator-owned JSON with deepseek.key_file and optional messages_endpoint/proxy
  --postgres-config PATH      Private JSON with databaseUrl for a local evimed_test database
  --out PATH                  New output directory; the paid-child guard prevents accidental repetition
Optional:
  --artifact-sha256 HEX       Refuse an unexpected artifact before execution
  --dsh PATH                  Pinned DSH executable (default: dsh on PATH)
  --help                      Print this usage without reading credentials or starting services

The root is scripted. Its one clinical child uses the real native DeepSeek Messages adapter.
No model retries: at most 16 provider requests and 16,000 cumulative output tokens.
`
const names = new Set(['artifact', 'key-proxy-config', 'postgres-config', 'out', 'artifact-sha256', 'dsh'])
const args = {}
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index]
  if (flag === '--help') { console.log(usageText); process.exit(0) }
  if (!flag.startsWith('--') || !names.has(flag.slice(2)) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(usageText)
  if (args[flag.slice(2)]) throw new Error(`Duplicate argument ${flag}`)
  args[flag.slice(2)] = process.argv[++index]
}
for (const name of ['artifact', 'key-proxy-config', 'postgres-config', 'out']) if (!args[name]) throw new Error(usageText)
const exec = promisify(execFile), base = path.dirname(fileURLToPath(import.meta.url)), artifact = path.resolve(args.artifact)
const sha = createHash('sha256').update(await fs.readFile(artifact)).digest('hex')
if (args['artifact-sha256']) assert.equal(sha, args['artifact-sha256'], 'The selected bundle artifact differs from the requested digest')
const out = path.resolve(args.out), temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-real-clinical-'))
await fs.mkdir(out, { recursive: true, mode: 0o700 })
const guard = path.join(out, 'one-child-started.json')
try { await fs.access(guard); throw new Error('This one-child run was already started; no automatic clinical rerun is allowed') } catch (error) { if (error.code !== 'ENOENT') throw error }
const configured = JSON.parse(await fs.readFile(path.resolve(args['key-proxy-config']), 'utf8'))
const providerConfig = configured.deepseek ?? configured
if (typeof providerConfig.key_file !== 'string') throw new Error('The key proxy configuration requires a host-owned key_file')
const realKey = (await fs.readFile(providerConfig.key_file, 'utf8')).trim()
if (!realKey || /[\r\n]/.test(realKey)) throw new Error('The host provider credential is invalid')
const messagesEndpoint = new URL(providerConfig.messages_endpoint ?? '/anthropic/v1/messages', providerConfig.endpoint ?? 'https://api.deepseek.com')
if (messagesEndpoint.protocol !== 'https:' || messagesEndpoint.username || messagesEndpoint.password || messagesEndpoint.hash || messagesEndpoint.search) throw new Error('The host provider Messages endpoint must be an HTTPS URL without embedded credentials')
const workload = randomBytes(32).toString('hex'), hostToken = randomBytes(32).toString('hex')
const providerCalls = [], hostCalls = [], errors = [], startedAt = Date.now()
let outputTokens = 0, servedModel = null, childSessionId = null, database, isolated, vcr, adapter, child, rootSessionId, assessmentCallId, finalResult, origin
const patientText = 'Public synthetic patient. Age 62 years. Weight 80 kg. Height 2 m.'
const protocolText = 'Inclusion Criteria:\n- Age at least 18 years.\n- BMI less than 25 kg/m2.'
const setupFile = path.join(temporary, 'setup.json'), nativeEvents = path.join(out, 'native-events.jsonl'), runtimeLog = path.join(out, 'runtime.jsonl')
await fs.writeFile(setupFile, JSON.stringify({ protocolText }), { mode: 0o600 }); await fs.writeFile(nativeEvents, '', { mode: 0o600 })
const receipt = { kind: 'one-case-real-native-clinical-reference', scope: 'Public synthetic fixture only; not a benchmark score, clinical validation, deployment or SaaS customer acceptance.', artifact, sha256: sha, kernel: null, patient: { ageYears: 62, weightKg: 80, heightM: 2 }, protocol: ['Age >= 18 years', 'BMI < 25 kg/m2'], boundaries: { maxChildren: 1, maxProviderCalls: 16, maxCumulativeOutputTokens: 16000, retries: 0, providerKeyInRuntime: false, authorization: 'Fixed public fixture reference host; SaaS pending invocation authorization is covered separately.' } }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}` }
const proxy = createServer(async (req, res) => {
  const callAt = Date.now()
  try {
    assert.equal(req.headers['x-api-key'], workload, 'Unknown workload credential')
    assert.equal(req.url, '/anthropic/v1/messages')
    let input = ''; for await (const chunk of req) input += chunk
    const body = JSON.parse(input); assert.equal(body.model, 'deepseek-flash')
    if (providerCalls.length >= 16 || outputTokens >= 16000) throw new Error('The authorized one-child budget is exhausted')
    const session = String(req.headers['x-deepseek-harness-session-id'] ?? '')
    if (childSessionId && session !== childSessionId) throw new Error('Only one clinical child is allowed')
    childSessionId ??= session
    body.max_tokens = Math.min(body.max_tokens ?? 16000, 16000 - outputTokens)
    const number = providerCalls.length + 1, call = { number, requestedModel: body.model, sessionId: session, requestedMaxOutputTokens: body.max_tokens }
    providerCalls.push(call)
    if (number === 1) await fs.writeFile(guard, JSON.stringify({ at: new Date().toISOString(), artifactSha256: sha, clinicalChild: 'one', firstRequest: number }), { flag: 'wx', mode: 0o600 })
    const requestDir = await fs.mkdtemp(path.join(temporary, 'provider-request-'))
    try {
      const requestFile = path.join(requestDir, 'body'), curlFile = path.join(requestDir, 'curl'), headerFile = path.join(requestDir, 'headers'), responseFile = path.join(requestDir, 'response')
      await fs.writeFile(requestFile, JSON.stringify(body), { mode: 0o600 })
      let curl = `url = ${JSON.stringify(messagesEndpoint.href)}\nrequest = "POST"\nsilent\nshow-error\nconnect-timeout = 10\nmax-time = 180\nheader = "content-type: application/json"\nheader = "anthropic-version: 2023-06-01"\nheader = ${JSON.stringify('x-api-key: ' + realKey)}\ndata-binary = ${JSON.stringify('@' + requestFile)}\noutput = ${JSON.stringify(responseFile)}\ndump-header = ${JSON.stringify(headerFile)}\n`
      if (providerConfig.proxy) curl += `proxy = ${JSON.stringify(providerConfig.proxy)}\n`
      await fs.writeFile(curlFile, curl, { mode: 0o600 })
      const { stdout } = await exec('curl', ['--config', curlFile, '--write-out', '%{http_code}'], { maxBuffer: 1024 * 1024, timeout: 190000 })
      const status = Number(stdout.trim()), bytes = await fs.readFile(responseFile), headers = await fs.readFile(headerFile, 'utf8')
      call.httpStatus = status; call.durationMs = Date.now() - callAt
      const usage = {}
      for (const line of bytes.toString('utf8').split('\n')) if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6))
          if (event.message?.model) servedModel = event.message.model
          if (event.message?.usage) Object.assign(usage, event.message.usage)
          if (event.usage) Object.assign(usage, event.usage)
        } catch { /* Keep the literal provider response for inspection. */ }
      }
      if (status !== 200) { try { const error = JSON.parse(bytes); call.errorCode = error.error?.type ?? error.error?.code ?? 'provider_rejected' } catch { call.errorCode = 'provider_rejected' } }
      call.servedModel = servedModel; call.usage = usage; outputTokens += Number(usage.output_tokens ?? 0)
      await fs.writeFile(path.join(out, `provider-response-${number}.sse`), bytes, { mode: 0o600 })
      await fs.writeFile(path.join(out, 'provider-calls.json'), JSON.stringify(providerCalls, null, 2), { mode: 0o600 })
      const type = /content-type:\s*([^\r\n]+)/ig; let selected = 'text/event-stream'; for (const match of headers.matchAll(type)) selected = match[1]
      res.writeHead(status, { 'content-type': selected }); res.end(bytes)
    } finally { await fs.rm(requestDir, { recursive: true, force: true }) }
  } catch (error) { errors.push({ stage: 'host-model-proxy', code: error.code ?? error.name ?? 'proxy_failed', message: error.message.includes(realKey) ? 'Credential-redacted transport error' : error.message }); res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'reference_proxy_failed', message: 'The bounded reference proxy could not complete this request.' } })) }
})
let gateway
const host = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw), invocation = body.invocation
    rootSessionId ??= invocation.sessionId
    if (invocation.tool === 'match_assess' && body.input.phase === 'prepare') assessmentCallId = invocation.callId
    const replay = Readable.from([Buffer.from(raw)]); replay.method = req.method; replay.url = req.url; replay.headers = req.headers
    const captured = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers) }, end(chunk) { this.body = String(chunk ?? '') } }
    await gateway(replay, captured)
    const answer = JSON.parse(captured.body)
    hostCalls.push({ tool: invocation.tool, port: body.port, operation: body.operation, phase: body.input.phase ?? null, callId: invocation.callId, sessionId: invocation.sessionId, status: answer.status ?? captured.statusCode })
    const state = JSON.parse(await fs.readFile(setupFile, 'utf8'))
    if (body.port === 'PatientDataPort' && body.operation === 'context' && answer.status === 'complete') {
      if (body.input.messageSeq === 1) state.patient = answer.data
      if (body.input.messageSeq === 2) state.protocol = answer.data
    }
    if (body.port === 'ExecutionPort' && body.operation === 'assess' && answer.data?.kind === 'prepared') {
      await fs.writeFile(path.join(out, 'prepared.json'), JSON.stringify(answer.data, null, 2), { mode: 0o600 })
    }
    if (body.port === 'ResultPort' && body.operation === 'save' && captured.statusCode === 200) {
      assert.ok(hostCalls.some(call => call.tool === 'match_evidence' && call.port === 'PatientDataPort' && call.operation === 'read'), 'The actual child must inspect evidence')
      assert.ok(hostCalls.some(call => call.tool === 'match_compute' && call.operation === 'compute'), 'The actual child must compute BMI')
      finalResult = answer.data; state.taskId = body.input.taskId
    }
    if (body.port === 'ExecutionPort' && body.operation === 'compute') await fs.writeFile(path.join(out, 'calculation.json'), JSON.stringify(answer.data, null, 2), { mode: 0o600 })
    await fs.writeFile(setupFile, JSON.stringify(state), { mode: 0o600 })
    res.writeHead(captured.statusCode, captured.headers); res.end(captured.body)
  } catch (error) { errors.push({ stage: 'reference-host', code: error.code ?? error.name, message: error.message }); res.writeHead(500); res.end(JSON.stringify({ error: 'reference_host_failed' })) }
})
try {
  const pgConfig = JSON.parse(await fs.readFile(path.resolve(args['postgres-config']), 'utf8'))
  isolated = await createGeoTestDatabase(pgConfig.databaseUrl, 'realclinical')
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 })
  await migrateProductStore(database)
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('fixture-owner','Public Fixture Owner','development')")
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('fixture-owner','fixture-project','Public Synthetic Clinical Fixture',10000000)")
  const config = { vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true, vcrDataPlaneDir: path.join(temporary, 'data-plane'), deepseekBaseUrl: 'https://api.deepseek.com' }
  vcr = composeVcr({ config, productDatabase: database }); await vcr.store.ready()
  vcr.patientContext = createVcrPatientContext({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, documents: vcr.documents, subjectKnown: vcr.subjectKnown, transcript: async () => ({ sessionId: rootSessionId, messages: [{ seq: 1, role: 'user', source: 'user', parts: [{ type: 'text', text: patientText }] }, { seq: 2, role: 'user', source: 'user', parts: [{ type: 'text', text: protocolText }] }] }), isHumanMessage: async () => true })
  adapter = createPatientMatchingHostAdapter({ vcr, documents: new ProductDocuments(database), config, writeArtifact: async ({ result, format }) => {
    const rendered = renderPatientMatchingReport(result, format), filename = `saved-report.${rendered.extension}`, artifactId = `reference-report:${result.resultId}:${rendered.extension}`
    await fs.writeFile(path.join(out, filename), rendered.text, { mode: 0o600 })
    return { status: 'complete', summary: 'Saved reference report from the persisted shared projection.', data: { artifactId, artifact: path.join(out, filename), format }, artifacts: [artifactId] }
  } })
  gateway = createPatientMatchingGatewayHandler(config, { assertActiveModelGatewayToken(token) { assert.equal(token, hostToken); return { userId: 'fixture-owner', projectId: 'fixture-project' } } }, { vcr, adapter, resolveInvocation: async (_identity, body) => {
    const call = body.invocation
    origin = { userId: 'fixture-owner', projectId: 'fixture-project', rootSessionId, runId: 'one-real-clinical-child', callId: call.callId, rootCallId: call.sessionId === rootSessionId ? call.callId : assessmentCallId, pluginGeneration: `reference-${sha}`, tool: call.tool, args: call.args, child: call.sessionId !== rootSessionId }
    return origin
  }, report: code => errors.push({ stage: 'gateway', code }) })
  const proxyUrl = await listen(proxy), hostUrl = await listen(host)
  const tokenFile = path.join(temporary, 'host.token'); await fs.writeFile(tokenFile, hostToken, { mode: 0o600 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(key)))
  Object.assign(env, { HOME: path.join(temporary, 'home'), DSH_HOME: path.join(temporary, 'dsh'), DSH_TELEMETRY: '0', EVIMED_PATIENT_MATCHING_ENABLED: '1', EVIMED_PATIENT_MATCHING_HOST_ENDPOINT: hostUrl + '/internal/patient-matching/v1/port', EVIMED_PATIENT_MATCHING_TOKEN_FILE: tokenFile, REFERENCE_FLASH_PROXY: proxyUrl + '/anthropic', REFERENCE_WORKLOAD_TOKEN: workload, REFERENCE_SETUP_FILE: setupFile, REFERENCE_NATIVE_EVENTS: nativeEvents })
  await fs.mkdir(env.HOME, { recursive: true }); await fs.mkdir(path.join(temporary, 'workspace'))
  const dsh = args.dsh ?? 'dsh', patch = path.join(temporary, 'reference.patch.yml')
  const runtimePlugin = path.join(base, 'reference-runtime.mjs')
  await fs.writeFile(patch, `- id: agent-default-model\n  config:\n    provider: reference-root\n    model: reference-root\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: llm-retry\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: matching-reference-clinical-runtime\n      name: '${runtimePlugin}'\n`)
  const command = cliArgs => { const result = spawnSync(dsh, cliArgs, { env, encoding: 'utf8', timeout: 120000, cwd: path.join(temporary, 'workspace') }); fs.appendFile(path.join(out, 'cli-setup.jsonl'), JSON.stringify({ args: cliArgs, status: result.status, signal: result.signal, error: result.error?.code, stdout: result.stdout, stderr: result.stderr }) + '\n', { mode: 0o600 }).catch(() => {}); if (result.status !== 0) throw new Error(`Native CLI setup failed (${cliArgs[0]} ${result.status} ${result.error?.code ?? ''})`); return result.stdout }
  command(['--profile', 'real-clinical-reference', '--from-default-profile', 'headless', '--dump-config'])
  command(['plugin', '--profile', 'real-clinical-reference', 'add', artifact, '--offline', '--ignore-scripts'])
  receipt.kernel = command(['--version']).trim()
  child = spawn(dsh, ['--profile', 'real-clinical-reference', '--patch', patch, '--json', 'Run one public synthetic clinical fixture through the native patient matching workflow.'], { env, cwd: path.join(temporary, 'workspace'), stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = [], log = chunk => { logs.push(Buffer.from(chunk)); if (logs.reduce((sum, item) => sum + item.length, 0) > 4 * 1024 * 1024) child.kill('SIGTERM') }
  child.stdout.on('data', log); child.stderr.on('data', log)
  const timeout = setTimeout(() => child.kill('SIGTERM'), 12 * 60 * 1000)
  const [exitCode] = await once(child, 'exit'); clearTimeout(timeout)
  await fs.writeFile(runtimeLog, Buffer.concat(logs), { mode: 0o600 }); receipt.exitCode = exitCode
  assert.ok(finalResult?.rows?.length, 'The one real native child produced no persisted result; inspect preserved partial evidence')
  const state = JSON.parse(await fs.readFile(setupFile, 'utf8'))
  const readOrigin = { userId: 'fixture-owner', projectId: 'fixture-project', rootSessionId, runId: 'one-real-clinical-child', pluginGeneration: `reference-${sha}`, callId: assessmentCallId, rootCallId: assessmentCallId }
  const saved = await adapter.resultOf(readOrigin, state.taskId); validateMatchingResult(saved)
  const study = await vcr.store.taskContext(readOrigin, { create: false }), page = await adapter.pageResult(study, 'fixture-owner', state.taskId, saved.resultId)
  assert.deepEqual(saved, finalResult); assert.deepEqual(page, saved)
  const pageView = await vcr.matchResults.forProtocol(study, state.protocol.protocolVersionId, { viewer: { id: 'fixture-owner' } })
  await adapter.dispatch({ port: 'ExecutionPort', operation: 'report', input: { taskId: state.taskId, resultId: saved.resultId, format: 'json' }, origin: readOrigin })
  await adapter.dispatch({ port: 'ExecutionPort', operation: 'report', input: { taskId: state.taskId, resultId: saved.resultId, format: 'markdown' }, origin: readOrigin })
  const jsonReport = JSON.parse(await fs.readFile(path.join(out, 'saved-report.json'), 'utf8')), markdown = await fs.readFile(path.join(out, 'saved-report.md'), 'utf8')
  assert.deepEqual(jsonReport, saved)
  assert.equal(markdown, renderPatientMatchingReport(page, 'markdown').text)
  const calculation = JSON.parse(await fs.readFile(path.join(out, 'calculation.json'), 'utf8')), prepared = JSON.parse(await fs.readFile(path.join(out, 'prepared.json'), 'utf8'))
  assert.equal(calculation.receipt.result.value, 20); assert.equal(calculation.receipt.exactCheck, 'verified')
  const note = await readSubjectNote({ study, subjectKey: state.patient.subjectKey, documents: vcr.documents, roster: await vcr.documents.roster(study), table: await tableFieldsOf(vcr.subjectTable, study), long: await vcr.documents.longTables?.(study) ?? null })
  let verifiedPassages = 0
  for (const bundle of prepared.evidenceBundles) for (const passage of bundle.patientPassages) {
    const record = note.records.find(item => item.documentId === passage.source.sourceId)
    assert.ok(record)
    verifyEvidencePassage(passage, { source: passage.source, sourceText: record.text }); verifiedPassages += 1
  }
  for (const profile of prepared.trialProfiles) {
    assert.equal(contentDigest(profile.preservedText), profile.source.digest)
    for (const criterion of profile.criteria) assert.equal(profile.preservedText.slice(criterion.span.start, criterion.span.end), criterion.text)
  }
  for (const operand of calculation.receipt.operands) {
    const passage = prepared.evidenceBundles.flatMap(bundle => bundle.patientPassages).find(item => item.evidenceId === operand.evidenceId)
    assert.ok(passage && passage.source.digest === operand.source.digest && passage.text.includes(String(operand.value)))
  }
  const native = (await fs.readFile(nativeEvents, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(native.filter(event => event.kind === 'child-created').length, 1)
  assert.ok(native.some(event => event.tool === 'match_evidence' && event.ok)); assert.ok(native.some(event => event.tool === 'match_compute' && event.ok)); assert.ok(native.some(event => event.tool === 'structured_output' && event.ok))
  assert.ok(servedModel && /flash/i.test(servedModel) && !/pro/i.test(servedModel)); assert.ok(outputTokens <= 16000 && providerCalls.length <= 16)
  receipt.status = 'complete'; receipt.servedModel = servedModel; receipt.actualNativeTools = native.filter(event => event.kind === 'child-tool').map(event => ({ tool: event.tool, ok: event.ok })); receipt.computation = { calculator: calculation.receipt.calculator, value: calculation.receipt.result.value, unit: calculation.receipt.result.unit, exactCheck: calculation.receipt.exactCheck, operandsSourceBound: true }
  receipt.sourceBinding = { literalPatientPassagesVerified: verifiedPassages, protocolDigestAndSpansVerified: true, patientOriginalDigest: contentDigest(patientText), trialSourceRefs: saved.rows[0].sourceRefs.filter(source => source.kind === 'protocol'), allCriterionEvidenceIds: saved.rows[0].criteria.map(criterion => ({ id: criterion.criterionId, evidenceIds: criterion.evidenceIds })) }
  receipt.clinicalDecision = { eligibility: saved.rows[0].clinicalEligibility, criteria: saved.rows[0].criteria, priority: saved.rows[0].recommendation.priority }
  receipt.readback = { actualIsolatedPostgres: true, persistedResultId: saved.resultId, replyEqualsSaved: true, pageEqualsSaved: true, jsonReportEqualsSaved: true, markdownEqualsSavedRenderer: true, legacyPageVerdict: pageView.people?.[0]?.verdict ?? null, files: ['saved-report.md', 'saved-report.json'] }
  await fs.writeFile(path.join(out, 'saved-result.json'), JSON.stringify(saved, null, 2), { mode: 0o600 })
} catch (error) { receipt.status = 'partial'; errors.push({ stage: 'reference-run', code: error.code ?? error.name ?? 'reference_failed', message: error.message.includes(realKey) ? 'Credential-redacted error' : error.message }) }
finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}) }
  await new Promise(closed => host.close(closed)); await new Promise(closed => proxy.close(closed)); await database?.close(); await isolated?.drop(); await fs.rm(temporary, { recursive: true, force: true })
  receipt.durationMs = Date.now() - startedAt; receipt.providerCalls = providerCalls; receipt.cumulativeOutputTokens = outputTokens; receipt.errors = errors; receipt.hostOperations = hostCalls
  receipt.tokenUsage = providerCalls.reduce((total, call) => ({ inputTokens: total.inputTokens + Number(call.usage?.input_tokens ?? 0), cacheReadTokens: total.cacheReadTokens + Number(call.usage?.cache_read_input_tokens ?? 0), cacheCreationTokens: total.cacheCreationTokens + Number(call.usage?.cache_creation_input_tokens ?? 0), outputTokens: total.outputTokens + Number(call.usage?.output_tokens ?? 0), providerDurationMs: total.providerDurationMs + Number(call.durationMs ?? 0) }), { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, providerDurationMs: 0 })
  if (receipt.readback) { receipt.readback.fileDigests = {}; for (const name of ['saved-report.md', 'saved-report.json', 'saved-result.json']) receipt.readback.fileDigests[name] = createHash('sha256').update(await fs.readFile(path.join(out, name))).digest('hex') }
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: receipt.status, receipt: path.join(out, 'receipt.json'), sha256: sha, servedModel, providerCalls: providerCalls.length, cumulativeOutputTokens: outputTokens, clinicalEligibility: receipt.clinicalDecision?.eligibility, errors }, null, 2))
}
