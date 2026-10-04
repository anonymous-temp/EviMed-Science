#!/usr/bin/env node
// Live ordinary-user acceptance. No login passwords, model prompts or cleanup.
// Credentials JSON: {cookie,csrf}; chmod 600. Input JSON is owner supplied.
import { mkdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { VCR_EXPORT_KINDS, VCR_STEPS } from '../../packages/domain/src/vcrVocabulary.mjs';
import { patientFetch } from '../ops/transient-refusal.mjs';

const COMMANDS = ['intake', 'observe', 'run-step', 'engine-job', 'vcr-exports', 'artifact-export'];
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('invalid_id'); return value; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// The route's ceiling on a study name (`vcrStudyName` in apps/server/src/vcrRoutes.mjs); the test holds the two equal.
export const STUDY_NAME_MAX = 40;
/** The study name an intake creates: the owner's words, cut to leave room, then a tag cut from the receipt's
 * correlation so the study can be found again by exact suffix. The whole 47-character correlation used to be
 * appended, which no name of 40 characters can hold: every intake ended at 400 vcr_name_invalid.
 * @param {unknown} name @param {string} correlation @returns {{ name: string, tag: string }} */
export function acceptanceStudyName(name, correlation) {
  const tag = `acc-${String(correlation).replace(/^acceptance-/, '').replace(/-/g, '').slice(0, 12)}`;
  if (!/^acc-[a-f0-9]{12}$/.test(tag)) throw new Error('correlation_required');
  const words = [...String(name ?? '').replace(/\s+/g, ' ').trim() || 'Acceptance'];
  return { name: `${words.slice(0, STUDY_NAME_MAX - tag.length - 1).join('').trim()} ${tag}`, tag };
}
export function validateConfig(c) {
  if (!COMMANDS.includes(c.command) || !['S2', 'S3', 'S4', 'staging'].includes(c.stage)) throw new Error('explicit_command_and_stage_required');
  const url = new URL(c.baseUrl);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('https_origin_required');
  if (!path.isAbsolute(c.output ?? '') || path.resolve(c.output) === '/') throw new Error('absolute_new_output_directory_required');
  if (['observe', 'run-step', 'engine-job', 'vcr-exports'].includes(c.command)) id(c.studyId);
  if (c.command === 'run-step' && (!VCR_STEPS.includes(c.step) || c.allowResearch !== 'yes')) throw new Error('explicit_step_and_research_authorization_required');
  if (['intake', 'vcr-exports'].includes(c.command) && c.allowResearch !== 'yes') throw new Error('research_authorization_required_creation_and_export_can_schedule_models');
  for (const [key, fallback, max] of [['timeoutMs', 300000, 7200000], ['responseBytes', 33554432, 67108864], ['uploadBytes', 33554432, 67108864]]) {
    c[key] = Number(c[key] ?? fallback);
    if (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > max) throw new Error(`invalid_${key}`);
  }
  return { ...c, baseUrl: url.origin };
}
export function redact(value, secrets = []) {
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /cookie|csrf|password|token|api.?key|authorization/i.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  return value;
}
export async function boundedBytes(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('response_limit'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}
export async function pollReady(read, { timeoutMs, intervalMs = 1500 }) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = await read();
    if (state.state === 'ready') return state;
    if (['failed', 'canceled', 'cancelled', 'partial'].includes(state.state)) throw new Error(`conversion_${state.state}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, until - Date.now()))));
  }
  throw new Error('poll_timeout');
}
async function safePath(file, allowMissingFinal = false) {
  if (!path.isAbsolute(file ?? '') || file !== path.resolve(file)) throw new Error('canonical_absolute_path_required');
  let current = path.parse(file).root;
  const parts = file.slice(current.length).split(path.sep);
  for (let n = 0; n < parts.length; n++) {
    current = path.join(current, parts[n]);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === 'ENOENT' && allowMissingFinal && n === parts.length - 1) return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('symlink_path_refused');
    if (n < parts.length - 1 && !stat.isDirectory()) throw new Error('directory_required');
  }
}
export async function safeRead(file, max, privateFile = false) {
  await safePath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (privateFile && (stat.mode & 0o077))) throw new Error('private_regular_file_required');
    if (stat.size > max) throw new Error('file_limit');
    const buffer = Buffer.alloc(max + 1); let offset = 0;
    while (offset <= max) { const { bytesRead } = await handle.read(buffer, offset, max + 1 - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset > max) throw new Error('file_limit');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
// A shape the field map has nothing for is answered `skipped`, and is no defect: a baseline-only source derives
// the subject table and skips the other two. Only a shape the owner expected has to be registered.
export function validateTables(tables, expected) {
  const nonzero = value => typeof value === 'number' ? value > 0 : Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.values(value).some(nonzero) : Boolean(value);
  if (!Array.isArray(expected) || !expected.length || expected.some(shape => typeof shape !== 'string') || !tables?.registered?.length || expected.some(shape => !tables.registered.some(row => row.shape === shape)) || tables.refused?.length || nonzero(tables.dropped)) throw new Error('tables_not_admitted');
}
export function reviewAcceptance(reviews) {
  const roles = ['clinical', 'statistical'];
  return { verified: roles.every(role => reviews.some(row => row.role === role && row.reviewerKind === 'ai' && row.status === 'done' && row.current === true && row.by && row.inputDigest)), requiredRoles: roles, records: reviews };
}
async function credentials(file) {
  if (!path.isAbsolute(file ?? '')) throw new Error('absolute_credentials_file_required');
  const auth = JSON.parse((await safeRead(file, 16384, true)).toString());
  if (![auth.cookie, auth.csrf].every(value => typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value))) throw new Error('cookie_and_csrf_required');
  return auth;
}
async function inputFile(file) {
  if (!path.isAbsolute(file ?? '')) throw new Error('absolute_input_file_required');
  return JSON.parse((await safeRead(file, 65536)).toString());
}
export async function runAcceptance(config) {
  const c = validateConfig(config);
  const owner = await credentials(c.credentials);
  const stranger = await credentials(c.strangerCredentials);
  if (owner.cookie === stranger.cookie) throw new Error('distinct_accounts_required');
  await safePath(c.output, true);
  await mkdir(c.output, { mode: 0o700 }); // Existing output directories are refused.
  const secrets = [owner.cookie, owner.csrf, stranger.cookie, stranger.csrf];
  const receipt = { stage: c.stage, command: c.command, baseUrl: c.baseUrl, startedAt: new Date().toISOString(), status: 'incomplete', steps: [], outputs: [], manualChecks: ['Account identities must be independently confirmed unrelated.', 'Inspect Chinese text, equations, figures, long tables and numerical fidelity.', 'Matching/referral/follow-up and backup/concurrency acceptance remain separate.', 'A client timeout does not cancel server work; inspect receipts before retrying. Server usage caps bound model spend; no client-supplied currency budget exists on the VCR run route.'] };
  const until = Date.now() + c.timeoutMs;
  let sequence = 0;
  let attemptSequence = 0;
  const save = async (name, bytes) => {
    const handle = await open(path.join(c.output, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const directory = await open(c.output, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  };
  const request = async (method, route, body, auth = owner, binary = false, allowed = [200, 201, 202]) => {
    if (Date.now() >= until) throw new Error('overall_timeout');
    if (!route.startsWith('/api/') || route.includes('..')) throw new Error('unsafe_route');
    const started = Date.now();
    const attempt = method === 'POST' ? { method, route, startedAt: new Date(started).toISOString(), bodySha256: sha(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? null))), ownedStudyId: receipt.createdStudyId ?? c.studyId ?? null, sessionId: receipt.studySessionId ?? null, correlation: receipt.correlation ?? null, outcome: 'unknown' } : null;
    const attemptName = attempt ? `${String(++attemptSequence).padStart(4, '0')}-attempt.json` : null;
    // Durable intent exists before the network can perform any mutation.
    if (attempt) { receipt.attempts ??= []; receipt.attempts.push(attempt); await save(attemptName, JSON.stringify(attempt, null, 2)); }
    // Patient with a runtime apply under way (423 `plugin_apply_in_progress`): the refusal comes before the control plane does anything, so asking again is not a second attempt.
    const response = await patientFetch(c.baseUrl + route, { method, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(30000, until - Date.now()))), headers: { Cookie: auth.cookie, 'X-Open-Science-CSRF': auth.csrf, Origin: c.baseUrl, ...(body !== undefined ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) }, ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
    const bytes = await boundedBytes(response, c.responseBytes);
    let data;
    if (!binary) { try { data = JSON.parse(bytes.toString()); } catch { throw new Error(`non_json_response_${response.status}`); } }
    if (attempt) { attempt.outcome = allowed.includes(response.status) ? 'response_received' : 'refused_or_failed'; attempt.status = response.status; attempt.identities = { resourceId: data?.data?.id ?? null, projectId: data?.data?.projectId ?? null, runId: data?.data?.runId ?? null, sessionId: data?.data?.sessionId ?? null, sourceId: data?.data?.source?.id ?? null, snapshotId: data?.data?.snapshot?.id ?? null, exportId: data?.data?.export?.id ?? null, conversionId: data?.data?.conversion?.id ?? null }; await save(attemptName.replace('-attempt', '-attempt-result'), JSON.stringify(redact(attempt, secrets), null, 2)); }
    const step = { method, route, account: auth === owner ? 'owner' : 'unrelated', status: response.status, durationMs: Date.now() - started, bytes: bytes.length, ...(binary ? { sha256: sha(bytes) } : { response: redact(data, secrets) }) };
    receipt.steps.push(step);
    await save(`${String(++sequence).padStart(4, '0')}-response.json`, JSON.stringify(step, null, 2));
    if (!allowed.includes(response.status)) throw new Error(`http_${response.status}`);
    return binary ? bytes : data.data;
  };
  const deny = route => request('GET', route, undefined, stranger, false, [403, 404]);
  const conversion = async (row, label) => {
    const exportId = id(row.id);
    await deny(`/api/document-exports/${exportId}`);
    await pollReady(() => request('GET', `/api/document-exports/${exportId}`), { timeoutMs: Math.max(1, until - Date.now()) });
    for (const format of ['docx', 'pdf']) {
      const route = `/api/document-exports/${exportId}/download/${format}`;
      await deny(route);
      const bytes = await request('GET', route, undefined, owner, true);
      if (format === 'pdf' ? !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) : !bytes.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error(`invalid_${format}_signature`);
      const name = `${label}-${exportId}.${format}`;
      await save(name, bytes);
      receipt.outputs.push({ file: name, bytes: bytes.length, sha256: sha(bytes), exportId });
    }
  };
  try {
    if (c.command === 'artifact-export') {
      const input = await inputFile(c.input);
      if (!input.projectId || !input.source?.artifactId || !input.source?.root || !input.source?.revision) throw new Error('explicit_completed_artifact_identity_required');
      await conversion(await request('POST', '/api/document-exports', { projectId: input.projectId, source: input.source, formats: ['docx', 'pdf'] }), 'artifact');
    } else {
      let studyId = c.studyId;
      if (c.command === 'intake') {
        const input = await inputFile(c.input);
        if (!['synthetic', 'public', 'owner-authorized'].includes(input.datasetClass) || !input.authorizationNote?.trim() || !input.study || !input.source || !Array.isArray(input.fieldMap?.columns) || !path.isAbsolute(input.file ?? '')) throw new Error('explicit_dataset_metadata_file_and_mapping_required');
        if (input.datasetClass === 'synthetic' && (input.source.valueSource !== 'synthetic' || !/synthetic/i.test(input.study.name ?? '') || !/synthetic/i.test(input.study.question ?? ''))) throw new Error('synthetic_fixture_requires_source_and_study_labels');
        // Preserve supplied facts; never generate rows or infer clinical claims.
        const bytes = await safeRead(input.file, c.uploadBytes);
        if (!Array.isArray(input.expectedTableShapes) || !input.expectedTableShapes.length) throw new Error('expected_table_shapes_required');
        receipt.input = { datasetClass: input.datasetClass, sha256: sha(bytes), bytes: bytes.length };
        receipt.correlation = `acceptance-${randomUUID()}`;
        const named = acceptanceStudyName(input.study.name, receipt.correlation);
        // The label has to survive the cut: a synthetic study is said to be one by the name it is created under.
        if (input.datasetClass === 'synthetic' && !/synthetic/i.test(named.name)) throw new Error('synthetic_fixture_requires_source_and_study_labels');
        receipt.studyName = named.name;
        receipt.reconciliation = `Read GET /api/vcr/studies and locate exact name suffix ${named.tag}; never repeat an unknown creation automatically.`;
        const study = await request('POST', '/api/vcr/studies', { ...input.study, name: named.name });
        studyId = id(study.id); receipt.createdStudyId = studyId;
        receipt.studySessionId = study.sessionId ?? null;
        const root = `/api/vcr/studies/${studyId}`;
        await deny(root);
        const source = await request('POST', `${root}/data/sources`, input.source);
        const sourceId = id(source.source.id);
        const uploaded = await request('POST', `${root}/data/sources/${sourceId}/files?name=${encodeURIComponent(path.basename(input.file))}`, bytes);
        await deny(`${root}/data`);
        receipt.uploadedFileId = id(uploaded.file.id);
        const proposed = await request('POST', `${root}/data/sources/${sourceId}/fieldmap`, input.fieldMap);
        if (proposed.entryIssues?.length || proposed.mapIssues?.length || !/^[a-f0-9]{64}$/.test(proposed.hash ?? '')) throw new Error('field_map_not_clean');
        await request('POST', `${root}/data/sources/${sourceId}/fieldmap/confirm`, { hash: proposed.hash });
        const frozen = await request('POST', `${root}/data/sources/${sourceId}/snapshots`, { fileIds: [uploaded.file.id], ...(input.asOf ? { asOf: input.asOf } : {}) });
        receipt.snapshotId = id(frozen.snapshot?.id);
        receipt.tableAdmission = frozen.tables;
        validateTables(frozen.tables, input.expectedTableShapes);
      }
      const root = `/api/vcr/studies/${id(studyId)}`;
      await deny(root);
      const ownedStudy = await request('GET', root);
      receipt.studySessionId = ownedStudy.sessionId ?? receipt.studySessionId ?? null;
      await request('GET', `${root}/data`);
      await request('GET', `${root}/jobs`);
      await request('GET', `${root}/overview`);
      if (c.command === 'run-step') {
        receipt.commissionedStep = c.step;
        receipt.dispatch = await request('POST', `${root}/run`, { step: c.step });
        await pollReady(async () => {
          const overview = await request('GET', `${root}/overview`);
          await request('GET', `${root}/jobs`);
          await request('GET', root);
          const state = overview.steps?.[c.step]?.status;
          if (state === 'done') return { state: 'ready', overview };
          if (['failed', 'canceled'].includes(state)) return { state };
          return { state: 'queued' };
        }, { timeoutMs: Math.max(1, until - Date.now()) });
      }
      if (c.command === 'engine-job') {
        const input = await inputFile(c.input);
        if (!Number.isInteger(input.cpuSecondsLimit) || input.cpuSecondsLimit < 1 || input.cpuSecondsLimit > 600 || !Number.isInteger(input.seed) || !Number.isInteger(input.replicates) || input.replicates < 1 || input.replicates > 10000) throw new Error('explicit_bounded_engine_job_required');
        const queued = await request('POST', `${root}/jobs`, input);
        const jobId = id(queued.job?.id ?? queued.id);
        receipt.createdJobId = jobId;
        await deny(`${root}/jobs/${jobId}`);
        await pollReady(async () => {
          const row = await request('GET', `${root}/jobs/${jobId}`);
          const job = row.job ?? row;
          if (job.state === 'awaiting_budget') throw new Error('engine_awaiting_budget_no_automatic_topup');
          return { ...job, state: job.state === 'succeeded' ? 'ready' : job.state };
        }, { timeoutMs: Math.max(1, until - Date.now()) });
      }
      if (c.command === 'vcr-exports') {
        const delivered = [];
        receipt.reviewAcceptance = {};
        for (const kind of VCR_EXPORT_KINDS) {
          let vcrExportId = null;
          // One kind that fails is that kind's finding. The kinds after it are still asked for, and what
          // was delivered before it is still inspected below: the driver used to end at the first failure,
          // so a failed second kind left the first unreviewed and the last two untried.
          try {
            const exported = await request('POST', `${root}/export`, { kind });
            vcrExportId = id(exported.export?.id);
            if (exported.export?.kind && exported.export.kind !== kind) throw new Error('export_kind_mismatch');
            let conversionRow = exported.conversion;
            if (!conversionRow?.id) {
              await deny(`${root}/export/${vcrExportId}`);
              const ready = await pollReady(async () => {
                const view = await request('GET', `${root}/export/${vcrExportId}`);
                receipt.currentExport = { id: vcrExportId, state: view.state, reviews: view.document?.reviews ?? [] };
                if (view.documentExportId) return { state: 'ready', id: view.documentExportId };
                return { state: view.state === 'failed' ? 'failed' : 'queued' };
              }, { timeoutMs: Math.max(1, until - Date.now()) });
              conversionRow = { id: ready.id };
            }
            await conversion(conversionRow, kind);
            delivered.push({ kind, vcrExportId, documentExportId: conversionRow.id });
            receipt.reviewAcceptance[kind] = { verified: false, state: 'not_yet_inspected', conversion: 'completed', vcrExportId, documentExportId: conversionRow.id };
          } catch (error) {
            receipt.reviewAcceptance[kind] = { verified: false, state: 'export_failed', conversion: 'failed', vcrExportId, error: redact(String(error.message), secrets) };
          }
        }
        // All usable conversions are preserved before review waiting begins.
        for (const { kind, vcrExportId, documentExportId } of delivered) {
          try {
          let view = await request('GET', `${root}/export/${vcrExportId}`);
          let review = reviewAcceptance(view.document?.reviews ?? []);
          if (!review.verified && review.records.some(row => ['queued', 'running'].includes(row.status))) {
            try {
              await pollReady(async () => {
                view = await request('GET', `${root}/export/${vcrExportId}`);
                review = reviewAcceptance(view.document?.reviews ?? []);
                return { state: review.verified ? 'ready' : review.records.some(row => row.status === 'failed') ? 'failed' : 'queued' };
              }, { timeoutMs: Math.max(1, until - Date.now()) });
            } catch (error) { review.error = String(error.message); }
          }
          // The export's own state is kept beside its documents: one delivered from a row that still reads queued is a finding.
          receipt.reviewAcceptance[kind] = { ...review, conversion: 'completed', vcrExportId, documentExportId, exportState: view.state ?? null };
          // Capture raw platform review receipts when the export exposes its run.
          if (view.runId) {
            const studyView = await request('GET', root);
            await request('GET', `/api/review/runs/${id(view.runId)}?projectId=${encodeURIComponent(id(studyView.projectId))}`, undefined, owner, false, [200, 404]);
          }
          } catch (error) { receipt.reviewAcceptance[kind] = { ...receipt.reviewAcceptance[kind], verified: false, error: String(error.message) }; }
        }
      }
    }
    receipt.status = receipt.reviewAcceptance && Object.values(receipt.reviewAcceptance).some(review => !review.verified) ? 'incomplete' : 'completed_scoped_checks';
  } catch (error) {
    receipt.error = redact(String(error.message), secrets);
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await save('receipt.json', JSON.stringify(receipt, null, 2));
  }
  return receipt;
}
function cli(argv) {
  const out = { command: argv[0] };
  const flags = { '--stage': 'stage', '--base-url': 'baseUrl', '--output': 'output', '--credentials': 'credentials', '--stranger-credentials': 'strangerCredentials', '--input': 'input', '--study-id': 'studyId', '--step': 'step', '--allow-research': 'allowResearch', '--timeout-ms': 'timeoutMs', '--response-bytes': 'responseBytes', '--upload-bytes': 'uploadBytes' };
  for (let n = 1; n < argv.length; n += 2) { const key = flags[argv[n]]; if (!key || !argv[n + 1] || out[key] !== undefined) throw new Error('invalid_arguments'); out[key] = argv[n + 1]; }
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log('node scripts/vcr/live-acceptance.mjs <intake|observe|run-step|engine-job|vcr-exports|artifact-export> --stage <staging|S2|S3|S4> --base-url <https-origin> --credentials <absolute-private-json> --stranger-credentials <absolute-private-json> --output <absolute-new-dir> [--study-id ID | --input absolute-json] [--step definition|evidence|population|patients|comparator|trial|matching] [--allow-research yes] [--timeout-ms 300000]\nIntake requires {datasetClass,authorizationNote,file,study,source,fieldMap,expectedTableShapes}; artifact-export requires {projectId,source:{artifactId,root,revision}}. All paths must be absolute with no symlink components. Intake and VCR exports can schedule AI work, requiring --allow-research yes. Run-step authorizes one explicit study action, subject to existing server usage caps. Engine-job requires a real API body including seed, replicates and cpuSecondsLimit <=600. Unknown POST outcomes must be reconciled via read-only observe/study-list lookup; never blindly repeat. VCR documents remain downloaded when AI review is unavailable, but review acceptance stays incomplete. An export kind that fails is recorded under its own name; the remaining kinds are still requested and the delivered ones still inspected. No invented data or automatic retries/cleanup.');
  else runAcceptance(cli(process.argv.slice(2))).then(result => { console.log(JSON.stringify({ status: result.status, receipt: 'receipt.json' })); process.exitCode = result.status === 'incomplete' ? 1 : 0; }).catch(() => { console.error('Acceptance setup failed; check explicit arguments and private credential files.'); process.exitCode = 1; });
}
