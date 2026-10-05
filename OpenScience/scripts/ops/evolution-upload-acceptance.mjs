import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson, evolutionDataMatch, evolutionToolVisible } from '@evimed/domain';
import { evolutionDatasetMetadata } from '../../apps/server/src/evolutionIntegration.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Derive the predeclared teaching classifier's counts from the preserved public rows.
 * This is arithmetic, not empirical validation of a predictive model. */
export function publicDecisionCounts(csvBytes, sourceEvidence) {
  const rows = []; let row = [], cell = '', quoted = false;
  const text = Buffer.from(csvBytes).toString('utf8');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') { if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted; }
    else if (!quoted && (char === ',' || char === '\n')) { row.push(cell.replace(/\r$/, '')); cell = ''; if (char === '\n') { rows.push(row); row = []; } }
    else cell += char;
  }
  assert.equal(quoted, false, 'CSV quotes must be balanced.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift(), rule = sourceEvidence.decisionRule;
  assert.equal(rule.operator, '>=');
  assert.ok(Number.isFinite(rule.value));
  const score = header.indexOf(rule.field), outcome = header.indexOf('type');
  assert.ok(score >= 0 && outcome >= 0 && new Set(header).size === header.length);
  const counts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, n: 0, eventCount: 0, threshold: sourceEvidence.threshold };
  assert.ok(counts.threshold > 0 && counts.threshold < 1);
  for (const values of rows) {
    assert.equal(values.length, header.length); assert.ok(values[score].trim() && Number.isFinite(Number(values[score])));
    assert.ok(['Yes', 'No'].includes(values[outcome]));
    const predicted = Number(values[score]) >= rule.value, positive = values[outcome] === sourceEvidence.positiveClass;
    counts[predicted ? positive ? 'truePositive' : 'falsePositive' : positive ? 'falseNegative' : 'trueNegative']++;
    counts.n++; counts.eventCount += Number(positive);
  }
  assert.ok(counts.n > 0);
  return counts;
}

/** The real-data result must come from this exact admitted implementation and observed counts. */
export function uploadedComputationReceipts(rows, { result, run, tool }) {
  const counts = result.aggregateInput;
  const specification = Object.fromEntries(['n', 'truePositive', 'falsePositive', 'eventCount', 'threshold'].map(key => [key, counts[key]]));
  const inputs = [specification, counts].map(value => sha(canonicalJson({ specification: value })));
  return rows.filter(row => {
    const value = row.payload;
    return value?.userId === result.userId && value.projectId === result.projectId && value.runId === run.id
      && value.toolId === tool.id && value.digest === tool.payload.artifactDigest && value.revision === tool.payload.revision
      && inputs.includes(value.inputSha256) && value.callId && value.result?.ok === true
      && value.resultEvidence?.kind === 'structured' && value.resultEvidence?.substantive === true
      && value.resultEvidence?.explicitlyUnsupported !== true;
  });
}

/** Actual upload → native profiling/checks → isolated self-check → agenda CAS wake and queued episode.
 * Requires an isolated live acceptance app. No runtime, parser, semantics or executor is mocked.
 * @param {any} app @param {{toolId:string,csvBytes:Uint8Array,sourceEvidence:any,timeoutMs?:number}} input */
export async function runEvolutionUploadAcceptance(app, { toolId, csvBytes, sourceEvidence, timeoutMs = 1800000 }) {
  assert.ok(String(app.config.databaseUrl ?? app.config.productDatabaseUrl).includes('evimed_test_evolution') && app.config.dataDir === '/acceptance', 'Only the isolated acceptance environment may initialize this synthetic waiting agenda.');
  const { service, worker } = app.evolution;
  assert.equal(worker.running, false); worker.stop();
  const tool = await service.get(toolId);
  assert.ok(tool && evolutionToolVisible(tool.payload) && tool.payload.publicationKind === 'isolated-tool');
  assert.equal(tool.payload.selfCheck?.kind, 'decision-net-benefit');
  assert.ok(tool.payload.dataRequirements);
  const bytes = Buffer.from(csvBytes), csvSha256 = sha(bytes), counts = publicDecisionCounts(bytes, sourceEvidence);
  assert.equal(csvSha256, sourceEvidence.csvSha256);
  assert.match(sourceEvidence.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(/^https:\/\//.test(sourceEvidence.sourceUrl) && sourceEvidence.dictionaryText);
  const suffix = randomUUID(), username = `p2-${suffix}`, password = randomBytes(32).toString('hex');
  const { user, project } = await createEvolutionUploadProject(app.store, { username, password, projectId: `p2-upload-${suffix}` });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '', csrf = '';
  const request = async (pathname, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-evimed-automated': '1', cookie, 'x-open-science-csrf': csrf, 'x-open-science-project': project.id }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    const result = await response.json(); assert.ok(response.ok, `Acceptance API ${pathname} failed: ${result.code ?? result.error?.code ?? response.status}`); return result.data ?? result;
  };
  const login = await request('/api/auth/login', { username, password }); csrf = login.csrfToken;
  assert.ok(cookie && csrf);
  const upload = await request('/api/files/upload', { root: 'workspace', path: 'knowledge-base/pima-training.csv', data: bytes.toString('base64'), encoding: 'base64' });
  await request('/api/files/upload', { root: 'workspace', path: 'knowledge-base/pima-dictionary.md', data: `${sourceEvidence.dictionaryText}\n\nSource: ${sourceEvidence.sourceUrl}\nOriginal source SHA256: ${sourceEvidence.sourceSha256}\nCSV SHA256: ${csvSha256}\n`, encoding: 'utf8' });
  const agenda = await app.autopilotService.create(user.id, { projectId: project.id, title: '公开数据隔离验收', prompt: `Use the actual uploaded knowledge-base/pima-training.csv and its dictionary. Derive confusion counts for the predeclared teaching rule ${sourceEvidence.decisionRule.field} ${sourceEvidence.decisionRule.operator} ${sourceEvidence.decisionRule.value} with outcome type=${sourceEvidence.positiveClass}, then actually invoke isolated tool ${toolId} at the declared utility threshold ${sourceEvidence.threshold}. Preserve the exact source hash and calculator JSON output in a file. The glucose unit is unstated. This is descriptive arithmetic on a public teaching sample, not fitted-model validation or a clinical recommendation. The waiting agenda initialization is a synthetic acceptance fixture.`, topics: ['Public-data decision arithmetic'], taskTypes: ['data-prospecting'], dailyBudgetCny: 10, weeklyBudgetCny: 20, maxEpisodeCny: 10, schedule: { kind: 'daily', time: '08:00', timeZone: 'Asia/Shanghai' } });
  const documents = service.documents;
  const waiting = await documents.put(user.id, 'agenda', agenda.id, { ...agenda.payload, plannerStop: { kind: 'needs_input' }, evolutionWaiting: { sourceEpisodeId: `p2-fixture-${suffix}` }, acceptanceFixture: true }, { expectedRevision: agenda.revision, projectId: project.id });
  const waiter = await service.waitFor({ userId: user.id, projectId: project.id, agendaId: waiting.id, sourceEpisodeId: `p2-fixture-${suffix}`, kind: 'data', toolId, dataRequirements: tool.payload.dataRequirements });
  const session = await request('/api/runtime/sessions', {});
  await request(`/api/research-sessions/${encodeURIComponent(session.id)}`, {mode:'open-domain'}, 'PUT');
  const dispatchId = `p2-profile-${suffix}`;
  await request('/api/agent-runs/dispatch', { sessionId: session.id, dispatchId, automated: true, line: 'dataset-research-scoping', text: 'Profile the actual uploaded knowledge-base/pima-training.csv and read knowledge-base/pima-dictionary.md. Use the native dataset_semantics tool to bind the exact CSV hash, record its actual columns and dictionary facts, and run the actual deterministic checks. Record age in UCUM a and bmi in kg/m2. Glucose concentration unit is unstated: keep it unknown. Preserve type Yes/No categories. This is anonymous complete-case public teaching data; do not invent patient identifiers, temporal order, joins, or unknown checks. Do not generate scientific conclusions or a fabricated empirical validation. Preserve the documented population. Finish only after recording actual check results.' });
  const deadline = Date.now() + timeoutMs;
  let profile, asset, selfCheck, woke;
  while (Date.now() < deadline) {
    profile = (await app.agentRuns.list(project)).find(run => run.dispatchId === dispatchId);
    if (uploadProfileComplete(profile)) {
      const listed = await request(`/api/projects/${encodeURIComponent(project.id)}/data-semantics`);
      const entries = await Promise.all((listed.items ?? []).map(entry => request(`/api/projects/${encodeURIComponent(project.id)}/data-semantics/${encodeURIComponent(entry.datasetId)}`)));
      asset = entries.find(entry => entry.asset?.bindings?.some(binding => binding.sha256?.replace(/^sha256:/, '') === csvSha256));
      if (asset) {
        const match = evolutionDataMatch(tool.payload.dataRequirements, evolutionDatasetMetadata(asset.asset));
        assert.ok(match.matched, `Recorded facts cannot meet the real tool contract: ${match.issues.join(',')}`);
        await worker.tick({ kinds: ['evolution-event'] });
        await worker.tick({ kinds: ['evolution-self-check'] });
        selfCheck = (await service.list('self-check', user.id)).find(record => record.payload.projectId === project.id && record.payload.toolId === toolId && record.payload.datasetId === (asset.datasetId ?? asset.asset.datasetId));
        woke = await documents.get(user.id, 'agenda', agenda.id);
        if (selfCheck?.payload.status === 'passed' && woke.payload.enabled === true) break;
        if (selfCheck && ['failed', 'unsupported'].includes(selfCheck.payload.status)) throw new Error(`Actual isolated self-check ${selfCheck.payload.status}.`);
      }
    }
    await delay(1000);
  }
  assert.ok(profile?.id && asset && selfCheck?.payload.status === 'passed', 'Actual upload/profile/self-check did not complete within acceptance timeout.');
  const resolved = await service.get(waiter.id, user.id);
  assert.equal(resolved.payload.status, 'resolved'); assert.equal(woke.payload.status, 'active');
  const jobs = await documents.database.query("SELECT id,status,payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode' AND payload->>'agendaId'=$2 ORDER BY created_at DESC", [user.id, agenda.id]);
  assert.ok(jobs.rows.length, 'The actual wake must enqueue an ordinary research episode.');
  return { userId: user.id, projectId: project.id, sourceId: upload.source?.id ?? null, csvSha256, profileRunId: profile.id, datasetId: asset.datasetId ?? asset.asset.datasetId, selfCheckId: selfCheck.id, selfCheckStatus: selfCheck.payload.status, waiterId: waiter.id, agendaId: agenda.id, episodeJobId: jobs.rows[0].id, episodeJobStatus: jobs.rows[0].status, syntheticWaitingInitialization: true, aggregateInput: counts, sourceEvidenceHash: sha(JSON.stringify(sourceEvidence)), empiricalValidation: false };
}

/** Account creation returns a public projection; filesystem operations require the authoritative account.
 * @param {any} store @param {{username:string,password:string,projectId:string}} input */
export async function createEvolutionUploadProject(store, { username, password, projectId }) {
  const created = await store.createUser(username, password, 'Isolated public-data acceptance');
  const user = await store.userById(created.id);
  assert.ok(user && user.id === created.id && typeof user.rootDir === 'string', 'The acceptance account must have an authoritative filesystem root.');
  const project = await store.projectFor(user, projectId, '公开数据隔离验收');
  assert.equal(project.userId, user.id);
  assert.equal(typeof project.workspaceDir, 'string');
  return { user, project };
}

/** Inspect semantic assets only after the actual profiling run completes successfully. */
export function uploadProfileComplete(run) {
  if (run && ['failed', 'canceled'].includes(run.status)) throw new Error('Actual profiling run did not complete successfully.');
  return run?.status === 'succeeded';
}
