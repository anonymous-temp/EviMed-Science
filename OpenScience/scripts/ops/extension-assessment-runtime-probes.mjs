/**
 * Trusted assessment measurements only. No route/config selector installs these observers.
 *
 * A library, not a command: nothing in package.json runs it, by design — the private
 * assessment composition installs it (`createPrivateAssessmentFactories` in
 * extension-saas-acceptance-composition.mjs, where `runtimeManagerFactory` first holds
 * the assessment config this asserts on). Its measurements are what two cases of the
 * acceptance journey are declared to still lack (extension-saas-acceptance-completion.mjs):
 * SAAS-14 "retries, rolling caps and cancellation" (`runFinancialCapRefusal`,
 * `runFiniteConcurrentRefusal`) and SAAS-21 "actual owned-network HTTP/DNS observation"
 * (`finishOutboundObservation`). Until the journey (extension-saas-acceptance-journey.mjs,
 * the SAAS-14 and SAAS-21 steps) calls them, only extensionAssessmentRuntimeProbes.test.mjs
 * reaches it; deleting it would delete the measurement those two cases are waiting for.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveGatewayFetch } from '../../apps/server/src/recordedGateway.mjs';
import { edgeProxyFromConfig, fetchWithEdge } from '../../apps/server/src/edgeProxy.mjs';
import { webReadTransportFor } from '../../apps/server/src/webRead.mjs';
import { validateRequest } from '../runtime/extensions/cowork/policy.mjs';
const sha = value => createHash('sha256').update(value).digest('hex'), stamp = () => new Date().toISOString();
const knownErrors = new Set(['usage_budget_exceeded', 'product_state_unavailable', 'extension_access_denied', 'cowork_input_refused']);
const errorFact = error => ({ status: Number.isInteger(error?.status) ? error.status : null, code: knownErrors.has(error?.code) ? error.code : 'other' });
const scopeOf = auth => ({ actorId: auth.userId, projectId: auth.projectId, runtimeGeneration: auth.runtimeGeneration });
const scopedRows = async (database, actorId) => (await database.query('SELECT id,revision,status,project_id,run_id,purpose FROM evimed_usage.model_requests WHERE user_id=$1 ORDER BY id', [actorId])).rows;
async function persist(out, name, value) {
    await fs.mkdir(out, { recursive: true, mode: 0o700 });
    assert.equal((await fs.stat(out)).mode & 0o777, 0o700);
    await fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function finish(errors, work) {
    try { await work(); }
    catch (error) {
        errors.push(error);
        errors.cleanupUnconfirmed = true;
    }
}
function throwFailures(errors) {
    if (!errors.length) return;
    if (errors.cleanupUnconfirmed) {
        const failure = new AggregateError(errors, 'assessment_cleanup_unconfirmed');
        failure.cleanupUnconfirmed = true;
        throw failure;
    }
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'assessment_work_and_cleanup_unconfirmed');
}
/** Preserve the existing private cleanup flag through ordinary error aggregation. */
export function hasUnconfirmedCleanup(error) {
    const seen = new WeakSet();
    const visit = value => {
        if (!value || typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        return value.cleanupUnconfirmed === true || value instanceof AggregateError && value.errors.some(visit);
    };
    return visit(error);
}
/** Values from the known ordinary actor credential fields only; never persisted. */
export function actorCredentialCanaries(actor) {
    const cookie = actor.headers?.cookie;
    const values = [actor.password, cookie, actor.headers?.['x-open-science-csrf']];
    if (typeof cookie === 'string') for (const part of cookie.split(';')) {
        const separator = part.indexOf('=');
        if (separator > 0) values.push(part.slice(separator + 1).trim());
    }
    return values.filter(value => typeof value === 'string' && value.length > 0);
}
/** Construct before the real app, preserving the original fetch and pinned transport (including edge fallback). */
export function createAssessmentRuntimeProbes({ config, env = process.env, fetchImpl = globalThis.fetch, maxRecords = 2048 }) {
    assert.ok(Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= 4096);
    assert.equal(config.production, false);
    assert.equal(config.learningEnabled, false);
    assert.equal(config.reviewEnabled, false);
    const records = [], reservations = [], forbidden = new Set([config.modelGatewaySigningSecret, config.evimedWorkloadSigningSecret, config.bootstrapPassword].filter(Boolean));
    let phase = null, dropped = 0, ledger = null, originalReserve = null;
    const secrets = value => { for (const item of value)
        if (typeof item === 'string' && item)
            forbidden.add(item); };
    const safeOrigin = url => { const result = scan(url.origin); return result.forbiddenMatches || result.providerKeyMatches ? 'redacted:' + sha(url.origin) : url.origin; };
    const matches = bytes => [...forbidden].filter(value => bytes.includes(Buffer.from(value))).length;
    const scan = (value, allowProviderAuthorization = false) => {
        if (value == null)
            return { bytes: 0, sha256: sha(''), forbiddenMatches: 0 };
        if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) {
            const bytes = Buffer.from(value);
            return { bytes: bytes.length, sha256: sha(bytes), forbiddenMatches: matches(bytes), providerKeyMatches: config.deepseekApiKey && !allowProviderAuthorization && bytes.includes(Buffer.from(config.deepseekApiKey)) ? 1 : 0 };
        }
        if (value instanceof FormData) {
            let bytes = 0, forbiddenMatches = 0, providerKeyMatches = 0, binaryFields = 0;
            for (const [name, item] of value) {
                const nameScan = scan(name);
                bytes += nameScan.bytes;
                forbiddenMatches += nameScan.forbiddenMatches;
                providerKeyMatches += nameScan.providerKeyMatches ?? 0;
                if (typeof item === 'string') {
                    const row = scan(item);
                    bytes += row.bytes;
                    forbiddenMatches += row.forbiddenMatches;
                    providerKeyMatches += row.providerKeyMatches ?? 0;
                }
                else {
                    bytes += item.size;
                    binaryFields++;
                }
            }
            return { bytes, forbiddenMatches, providerKeyMatches, binaryFields, unscannedBinary: binaryFields > 0 };
        }
        return { bytes: null, forbiddenMatches: 0, unscannedBody: true };
    };
    const scanUrl = url => {
        let decoded;
        try { decoded = decodeURIComponent(url.href); }
        catch { decoded = url.href; }
        const raw = scan(url.href), decodedScan = scan(decoded);
        return {
            bytes: raw.bytes, sha256: raw.sha256,
            forbiddenMatches: Math.max(raw.forbiddenMatches, decodedScan.forbiddenMatches),
            providerKeyMatches: Math.max(raw.providerKeyMatches ?? 0, decodedScan.providerKeyMatches ?? 0)
        };
    };
    const push = row => {
        if (!phase) return;
        if (records.length >= maxRecords) { dropped++; return; }
        records.push(row);
    };
    const observingFetch = (purpose, original) => async function (input, init) {
        if (!phase)
            return original(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const headerScans = [];
        for (const [name, value] of headers) {
            const nameScan = scan(name);
            const valueScan = scan(value, purpose === 'model' && name === 'authorization' && url.origin === new URL(config.deepseekBaseUrl).origin);
            const knownHeader = ['authorization','content-type','accept','user-agent','content-length'].includes(name);
            headerScans.push({
                name: knownHeader ? name : 'custom-header:' + sha(name), nameSHA256: sha(name),
                ...valueScan,
                forbiddenMatches: nameScan.forbiddenMatches + valueScan.forbiddenMatches,
                providerKeyMatches: (nameScan.providerKeyMatches ?? 0) + (valueScan.providerKeyMatches ?? 0)
            });
        }
        const body = init?.body ?? (input instanceof Request && input.body ? { unscannedRequestBody: true } : null), bodyScan = scan(body), fingerprint = typeof body === 'string' ? sha(body) : null;
        const linked = purpose === 'model' ? reservations.filter(row => row.fingerprint === fingerprint && row.state === 'reserved') : [];
        const row = { phase: phase.name, purpose, origin: safeOrigin(url), pathSHA256: sha(url.pathname), urlSHA256: sha(url.href), urlScan: scanUrl(url), method: init?.method ?? (input instanceof Request ? input.method : 'GET'), startedAt: stamp(), body: bodyScan, headers: headerScans, scope: linked.length === 1 ? linked[0].scope : null, ambiguousScope: purpose === 'model' && linked.length !== 1 };
        push(row);
        try {
            const response = await original(input, init);
            row.status = response.status;
            return response;
        }
        catch (error) {
            row.error = errorFact(error);
            throw error;
        }
        finally {
            row.endedAt = stamp();
        }
    };
    const publicFetch = observingFetch('public-source', fetchImpl), edge = edgeProxyFromConfig(config);
    const direct = resolveGatewayFetch(env, publicFetch), gateway = edge ? fetchWithEdge(edge, direct) : direct;
    const originalTransport = webReadTransportFor(env, gateway, { edge, directTimeoutMs: config.webReadDirectTimeoutMs, edgeFallback: config.webReadEdgeFallback !== false });
    const transport = async input => {
        if (!phase) return originalTransport(input);
        const url = new URL(input.url);
        const row = {
            phase: phase.name, purpose: 'pinned-public-document', urlScan: scanUrl(url),
            origin: safeOrigin(url), pathSHA256: sha(url.pathname), urlSHA256: sha(url.href),
            startedAt: stamp(), scope: phase.scope ?? null
        };
        push(row);
        try {
            const result = await originalTransport(input);
            row.status = result.status;
            row.body = scan(result.body);
            return result;
        } catch (error) {
            row.error = errorFact(error);
            throw error;
        } finally { row.endedAt = stamp(); }
    };
    return {
        overrides: {
            modelGatewayFetch: observingFetch('model', fetchImpl), publicSourceFetch: publicFetch,
            edgeProxy: edge, webReadTransport: transport,
            documentParserFetch: observingFetch('document-parser', fetchImpl),
            vcrFetch: observingFetch('vcr', fetchImpl)
        },
        bind(app) {
            assert.equal(ledger, null);
            ledger = app.usageLedger;
            assert.ok(ledger && typeof ledger.reserveModel === 'function');
            originalReserve = ledger.reserveModel;
            ledger.reserveModel = async function(input) {
                const row = {
                    phase: phase?.name ?? null,
                    scope: { actorId: input.userId, projectId: input.projectId, runId: input.runId ?? null },
                    id: input.id, purpose: input.purpose, fingerprint: input.requestFingerprint,
                    estimatedCost: input.estimatedCost, dailyLimit: input.dailyLimit, state: 'entered'
                };
                if (phase) {
                    if (reservations.length < maxRecords) reservations.push(row);
                    else dropped++;
                }
                try {
                    const result = await originalReserve.call(this, input);
                    row.state = 'reserved';
                    return result;
                } catch (error) {
                    row.state = 'refused';
                    row.error = errorFact(error);
                    if (error?.code === 'usage_budget_exceeded') row.budget = {
                        window: ['day','week','run'].includes(error.details?.window) ? error.details.window : null,
                        limit: Number.isFinite(error.details?.limit) ? error.details.limit : null,
                        committed: Number.isFinite(error.details?.committed) ? error.details.committed : null,
                        requested: Number.isFinite(error.details?.requested) ? error.details.requested : null
                    };
                    throw error;
                }
            };
        },
        registerSecrets: secrets,
        registerActorCredentials(actor) { secrets(actorCredentialCanaries(actor)); },
        begin(name, scope = null) {
            assert.equal(phase, null, 'Do not overlap isolated measurement phases');
            phase = { name, scope, start: records.length, reserveStart: reservations.length, startedAt: stamp() };
            return phase;
        },
        end() {
            assert.ok(phase);
            const observed = {
                phase: phase.name, startedAt: phase.startedAt, endedAt: stamp(),
                records: structuredClone(records.slice(phase.start)),
                reservations: structuredClone(reservations.slice(phase.reserveStart)), dropped
            };
            phase = null;
            return observed;
        },
        snapshot() { return { records: structuredClone(records), reservations: structuredClone(reservations), dropped }; },
        close() {
            assert.equal(phase, null, 'End the bounded measurement before restoring observers');
            if (ledger) ledger.reserveModel = originalReserve;
            ledger = null;
            forbidden.clear();
        }
    };
}
/** Normal zero-spend account, original native UI/model gateway and durable ledger; no synthetic bill. */
export async function runFinancialCapRefusal({ owned, probes, actor, nativeFactory, base, fetchImpl, out, observe = async () => { } }) {
    const app = owned.app;
    assert.equal(owned.record.qualified, false);
    assert.ok(app.usageLedger);
    assert.equal((await scopedRows(app.store.database, actor.id)).length, 0, 'Budget phase requires an actual zero-spend account');
    const original = { daily: app.config.userDailySpendLimit, durable: app.config.requireDurableUsageLedger }, errors = [];
    let native, report, turn, frameReleased = false, runtimeStopped = false;
    const user = await app.store.userById(actor.id), project = await app.store.requireProject(user, actor.projectId), manager = app.runtimeManager, key = manager.key(project);
    assert.equal(project.userId, actor.id);
    assert.equal(manager.runtimes.has(key), false, 'Use only this phase newly owned zero-spend project runtime');
    let phaseRuntime, phaseGeneration;
    probes.registerActorCredentials(actor);
    await persist(out, 'financial-cap.json', { qualified: false, state: 'intent', actorId: actor.id, projectId: actor.projectId, capCny: 0.00000001 });
    probes.begin('financial-cap', { actorId: actor.id, projectId: actor.projectId });
    try {
        native = await nativeFactory({ base, actor, projectId: actor.projectId, out: path.join(out, 'native'), fetchImpl });
        phaseRuntime = manager.runtimes.get(key);
        phaseGeneration = manager.runtimeGeneration(project);
        assert.ok(phaseRuntime);
        await native.selectModel();
        assert.equal((await scopedRows(app.store.database, actor.id)).length, 0);
        app.config.userDailySpendLimit = 0.00000001;
        app.config.requireDurableUsageLedger = true;
        turn = await native.prompt('Reply with one harmless sentence about preserving public source uncertainty. Do not call tools or retry a failed model request.', { deadlineMs: 60000 });
        const measured = probes.snapshot();
        assert.equal(measured.dropped, 0, 'Truncated financial observation is incomplete');
        const refusals = measured.reservations.filter(row => row.phase === 'financial-cap');
        assert.ok(refusals.length > 0, 'Native UI/transport failure alone is not gateway budget evidence');
        assert.ok(refusals.every(row => row.scope.actorId === actor.id && row.scope.projectId === actor.projectId && row.state === 'refused' && row.error.status === 402 && row.error.code === 'usage_budget_exceeded' && row.estimatedCost > 0.00000001 && row.dailyLimit === 0.00000001 && row.budget?.window === 'day' && row.budget.limit === 0.00000001 && row.budget.committed === 0 && row.budget.requested === row.estimatedCost));
        assert.equal(measured.records.filter(row => row.phase === 'financial-cap' && row.purpose === 'model').length, 0, 'Budget-refused model reached upstream');
        assert.equal((await scopedRows(app.store.database, actor.id)).length, 0);
        assert.equal(turn.terminal, true, 'Keep pending refusal observation incomplete');
        report = { qualified: false, caseId: 'SAAS-14', scope: 'actual-normal-native-model-finite-budget-refusal', actorId: actor.id, projectId: actor.projectId, sessionId: native.sessionId, requestId: turn.requestId, capCny: 0.00000001, refusals, upstreamModelCalls: 0, ledgerRowsBefore: 0, ledgerRowsAfter: 0 };
    }
    catch (error) {
        errors.push(error);
    }
    finally {
        app.config.userDailySpendLimit = original.daily;
        app.config.requireDurableUsageLedger = original.durable;
        await finish(errors, async () => { assert.equal(app.config.userDailySpendLimit, original.daily); assert.equal(app.config.requireDurableUsageLedger, original.durable); });
        if (native && !turn?.terminal)
            await finish(errors, () => native.cancel());
        if (native)
            await finish(errors, async () => { await native.release(); frameReleased = true; });
        phaseRuntime ??= manager.runtimes.get(key);
        phaseGeneration ??= manager.runtimeGeneration(project);
        if (phaseRuntime)
            await finish(errors, async () => { assert.equal(manager.runtimes.get(key), phaseRuntime, 'Never stop a replacement runtime'); assert.equal(await manager.stop(project, { expectedGeneration: phaseGeneration, guard: () => manager.runtimes.get(key) === phaseRuntime }), true); assert.equal(manager.runtimes.has(key), false); runtimeStopped = true; });
        let telemetry;
        await finish(errors, async () => { telemetry = probes.end(); });
        await finish(errors, () => persist(out, 'financial-cap.json', { ...report, qualified: false, state: errors.length ? 'incomplete-preserved' : 'refused-before-upstream', configRestored: true, frameReleaseConfirmed: frameReleased, ownedPhaseRuntimeStopped: runtimeStopped, telemetry, errorCount: errors.length }));
    }
    throwFailures(errors);
    await observe(report);
    return report;
}
/** Tighten existing finite caps for two real native scopes. Existing controller owns deadline/kill/join. */
export async function runFiniteConcurrentRefusal({ owned, physical, natives, actors, out, observe = async () => { }, inspectRunning, downloadOriginal, originalSHA256 }) {
    const operations = owned.app.hostedExtensions.operations, tools = owned.assessment.composition.tools, database = owned.app.store.database;
    const [first, second] = actors, [firstNative, secondNative] = natives;
    assert.notEqual(first.projectId, second.projectId);
    assert.notEqual(first.id, second.id);
    const activeQuery = "SELECT id,status FROM evimed_product.jobs WHERE kind='extension-execute' AND (status IN ('queued','running') OR payload->>'recoveryRequired'='true') ORDER BY id";
    assert.equal((await database.query(activeQuery)).rows.length, 0);
    assert.equal(await tools.admissionAvailable(), true);
    assert.equal(tools.active.size, 0);
    const originals = { maxPending: operations.maxPending, maxUserPending: operations.maxUserPending, maxConcurrent: tools.maxConcurrent, submit: operations.submit, withAdmission: operations.withAdmission }, context = new AsyncLocalStorage(), facts = [], errors = [];
    let firstTurn, excessTurn, joined, firstJob;
    let firstPromptStarted = false, secondPromptStarted = false, phaseActive = true;
    const nativeCancellationRequests = [];
    let cleanupConfirmed = false, firstChildJoined = false;
    const excessTarget = 'finite_concurrent_excess_xlsx', firstTarget = 'bounded_stall_xlsx';
    let runningIdentity, runningContainer;
    await persist(out, 'concurrent-cap.json', { qualified: false, state: 'intent', firstActorId: first.id, secondActorId: second.id, finiteCaps: { maxPending: 1, maxUserPending: 1, maxConcurrent: 1 } });
    operations.submit = async function(auth, input) {
        if (input?.request?.targetId !== excessTarget) return originals.submit.call(this, auth, input);
        let validRequest = true, invocation;
        try { validateRequest(input.request); } catch { validRequest = false; }
        try { invocation = typeof auth.invocation === 'string' ? JSON.parse(auth.invocation) : auth.invocation; }
        catch { invocation = null; }
        const row = {
            ...scopeOf(auth), targetId: excessTarget, validRequest, originalCalls: 1,
            invocation: invocation ? Object.fromEntries(
                ['sessionId','callId','rootCallId','agentId','toolName','runtimeGeneration'].map(key => [key,invocation[key] ?? null])
            ) : null,
            enteredAt: stamp(), count: null
        };
        facts.push(row);
        return context.run(row, async () => {
            try {
                const result = await originals.submit.call(this, auth, input);
                row.returned = true;
                return result;
            } catch (error) {
                row.error = errorFact(error);
                row.refusedAt = stamp();
                throw error;
            }
        });
    };
    operations.withAdmission = async function(scope, work, settling = false) {
        const row = context.getStore();
        if (!row) return originals.withAdmission.call(this, scope, work, settling);
        return originals.withAdmission.call(this, scope, async () => {
            const client = this.admission.getStore().client, query = client.query;
            client.query = async function(sql, ...params) {
                const result = await query.call(this, sql, ...params);
                if (typeof sql === 'string' && sql.includes('count(*)::int AS total') && sql.includes("kind='extension-execute'")) {
                    row.count = { total: result.rows[0].total, owned: result.rows[0].owned };
                }
                return result;
            };
            try { return await work(); }
            finally {
                client.query = query;
                row.transactionQueryRestored = client.query === query;
            }
        }, settling);
    };
    operations.maxPending = 1;
    operations.maxUserPending = 1;
    tools.maxConcurrent = 1;
    try {
        physical.armStalledNativeWrite({ userId: first.id, projectId: first.projectId, targetId: firstTarget, otherUserId: second.id, otherProjectId: second.projectId, observeOtherScope: async () => { const snapshot = await secondNative.snapshot(), current = await inspectRunning(second); return { userId: second.id, projectId: second.projectId, httpStatus: 200, runtimeResponded: true, runtimeContainerId: current.containerId, sessionId: secondNative.sessionId, responseDigest: sha(JSON.stringify(snapshot)) }; }, onRunning: async ({ identity, containerId, observedRunning }) => {
                assert.equal(phaseActive, true, 'Closing phase cannot dispatch a late second native request');
                assert.equal(observedRunning, true);
                runningIdentity = identity;
                runningContainer = containerId;
                firstJob = (await database.query('SELECT payload FROM evimed_product.jobs WHERE id=$1 AND user_id=$2', [identity.jobId, identity.ownerId])).rows[0];
                assert.equal(firstJob?.payload.scope.userId, first.id);
                assert.equal(firstJob.payload.scope.projectId, first.projectId);
                assert.equal(firstJob.payload.auth.runtimeGeneration, identity.runtimeGeneration);
                assert.equal(await tools.admissionAvailable(), false);
                assert.equal(phaseActive, true, 'Closing phase cannot dispatch after physical admission awaits');
                secondPromptStarted = true;
                const excess = excessTurn = await secondNative.prompt('Call doc_write once with targetId ' + excessTarget + ', format xlsx, spec {"kind":"create","sheets":[{"name":"Public","cells":[{"ref":"A1","value":"Harmless finite concurrent request"}]}]}. Preserve capacity refusal. No retry or other tools.', { deadlineMs: 60000 });
                assert.equal(excess.terminal, true);
                const calls = excess.tools.filter(row => row.tool === 'doc_write' && row.input.targetId === excessTarget);
                assert.equal(calls.length, 1);
                assert.equal(calls[0].status, 'error');
                assert.equal(excess.tools.length, 1);
                assert.equal(facts.length, 1);
                const fact = facts[0];
                assert.equal(fact.validRequest, true);
                assert.equal(fact.originalCalls, 1);
                assert.ok(fact.runtimeGeneration);
                assert.equal(fact.actorId, second.id);
                assert.equal(fact.projectId, second.projectId);
                assert.equal(fact.invocation.sessionId, secondNative.sessionId);
                assert.equal(fact.invocation.callId, calls[0].callId);
                assert.equal(fact.invocation.rootCallId, calls[0].callId);
                assert.equal(fact.invocation.agentId, secondNative.sessionId);
                assert.equal(fact.invocation.toolName, 'doc_write');
                assert.equal(fact.invocation.runtimeGeneration, fact.runtimeGeneration);
                assert.equal(fact.error?.status, 503);
                assert.equal(fact.error?.code, 'product_state_unavailable');
                assert.equal(fact.count?.total, 1);
                assert.equal(fact.transactionQueryRestored, true);
                assert.equal(fact.returned, undefined);
                const running = await inspectRunning(first, containerId);
                assert.equal(running.containerId, containerId);
                assert.equal(running.running, true, 'Refusal after deadline is not concurrency overlap');
                fact.firstStillRunning = true;
                fact.requestId = excess.requestId;
                fact.callId = calls[0].callId;
            } });
        firstPromptStarted = true;
        firstTurn = await firstNative.prompt('Call doc_write once with targetId ' + firstTarget + ', format xlsx, spec {"kind":"create","sheets":[{"name":"Public","cells":[{"ref":"A1","value":"Harmless bounded stall"}]}]}. A trusted assessment may induce a bounded child stall after authorization. Preserve its failure and earlier output; no retry.', { deadlineMs: 180000 });
        assert.equal(firstTurn.terminal, true);
        assert.ok(runningIdentity && facts.length === 1);
        const checkpoint = await physical.checkpoint();
        joined = checkpoint.attempts.find(row => row.jobId === runningIdentity.jobId);
        const job = checkpoint.jobs.find(row => row.jobId === runningIdentity.jobId);
        assert.ok(joined?.stalled && joined.physicallyAbsent && joined.joined && joined.settledReceipt);
        assert.equal(joined.containerId, runningContainer);
        assert.equal(job.leaseHeld, false);
        assert.ok(['failed', 'canceled'].includes(job.status));
        assert.equal(checkpoint.otherObservation?.observedWhileRunning, true);
        const excessJobs = (await database.query("SELECT id FROM evimed_product.jobs WHERE kind='extension-execute' AND payload->'request'->>'targetId'=$1", [excessTarget])).rows;
        assert.equal(excessJobs.length, 0);
        assert.equal(sha(await downloadOriginal()), originalSHA256);
    }
    catch (error) {
        errors.push(error);
    }
    finally {
        phaseActive = false;
        for (const [native, started, turn] of [[secondNative,secondPromptStarted,excessTurn],[firstNative,firstPromptStarted,firstTurn]]) {
            if (!started || turn?.terminal) continue;
            const fact = {sessionId:native.sessionId,requestId:turn?.requestId ?? null,requestedAt:stamp(),cancelReturned:false,physicalJoinClaimed:false};
            nativeCancellationRequests.push(fact);
            await finish(errors, async () => { await native.cancel(); fact.cancelReturned = true; });
            // An acknowledged cancel does not prove this session cannot submit another operation.
            await finish(errors, async () => { throw new Error('Phase native terminal remains unconfirmed: ' + native.sessionId); });
        }
        if (firstPromptStarted && !runningIdentity) await finish(errors, async () => { throw new Error('Phase child identity/join unavailable; do not continue after cancellation ACK'); });
        if (runningIdentity)
            await finish(errors, async () => { let checkpoint = await physical.checkpoint(), attempt = checkpoint.attempts.find(row => row.jobId === runningIdentity.jobId), job = checkpoint.jobs.find(row => row.jobId === runningIdentity.jobId); if (!(attempt?.joined && attempt.physicallyAbsent && attempt.settledReceipt && job?.leaseHeld === false)) {
                assert.ok(firstJob?.payload.auth);
                await operations.cancel(firstJob.payload.auth, runningIdentity.jobId);
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    checkpoint = await physical.checkpoint();
                    attempt = checkpoint.attempts.find(row => row.jobId === runningIdentity.jobId);
                    job = checkpoint.jobs.find(row => row.jobId === runningIdentity.jobId);
                    if (attempt?.joined && attempt.physicallyAbsent && attempt.settledReceipt && job?.leaseHeld === false)
                        break;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } assert.ok(attempt?.joined && attempt.physicallyAbsent && attempt.settledReceipt && job?.leaseHeld === false, 'Actual owned child cleanup remains unconfirmed'); joined = attempt; firstChildJoined = true; });
        cleanupConfirmed = firstChildJoined && nativeCancellationRequests.length === 0;
        operations.maxPending = originals.maxPending;
        operations.maxUserPending = originals.maxUserPending;
        tools.maxConcurrent = originals.maxConcurrent;
        operations.submit = originals.submit;
        operations.withAdmission = originals.withAdmission;
        await finish(errors, async () => { assert.equal(operations.submit, originals.submit); assert.equal(operations.withAdmission, originals.withAdmission); assert.equal(operations.maxPending, originals.maxPending); assert.equal(operations.maxUserPending, originals.maxUserPending); assert.equal(tools.maxConcurrent, originals.maxConcurrent); });
        await finish(errors, () => persist(out, 'concurrent-cap.json', { qualified: false, state: errors.length ? 'incomplete-preserved' : 'finite-refusal-and-joined', facts, firstRequestId: firstTurn?.requestId ?? null, joined: joined ?? null, settingsRestored: true, cleanupConfirmed, firstChildJoined, nativeCancellationRequests, errorCount: errors.length }));
    }
    throwFailures(errors);
    const report = { qualified: false, caseId: 'SAAS-17', scope: 'actual-finite-concurrent-admission-refusal-and-physical-join', facts, joined, firstRequestId: firstTurn.requestId, originalCompletedOutputUnchanged: true, settingsRestored: true, cleanupConfirmed, firstChildJoined, nativeCancellationRequests };
    await observe(report);
    return report;
}
/** Scanner records only hashes/counts and the intended endpoint classes; no request/response secrets are serialized. */
export async function finishOutboundObservation({ probes, out, observe = async () => { } }) {
    const telemetry = probes.end();
    let failure;
    try {
        assert.equal(telemetry.dropped, 0, 'Truncated outbound observation is incomplete');
        assert.ok(telemetry.records.length > 0, 'No actual scoped outbound observation');
        for (const row of telemetry.records) {
            assert.ok(row.endedAt);
            if (row.purpose === 'model')
                assert.equal(row.ambiguousScope, false, 'No guessed model actor attribution');
            for (const field of [row.urlScan, row.body, ...(row.headers ?? [])].filter(Boolean)) {
                assert.equal(field.forbiddenMatches, 0);
                assert.equal(field.providerKeyMatches ?? 0, 0);
                assert.equal(field.unscannedBody ?? false, false);
                assert.equal(field.unscannedBinary ?? false, false, 'Binary body not scanned; retain partial outbound evidence');
            }
        }
    }
    catch (error) {
        failure = error;
    }
    const report = { qualified: false, caseId: 'SAAS-21', scope: 'actual-scoped-original-control-plane-outbound', state: failure ? (telemetry.records.some(row => row.body?.unscannedBinary || row.body?.unscannedBody) ? 'partial-unscanned' : 'incomplete-preserved') : 'observed', coverageAccepted: !failure, knownMatchedFields: telemetry.records.flatMap(row => [row.urlScan, row.body, ...(row.headers ?? [])].filter(Boolean)).filter(field => (field.forbiddenMatches ?? 0) + (field.providerKeyMatches ?? 0) > 0).length, telemetry, uncovered: ['Binary FormData fields are labeled unscanned; public PDF decoded outputs and protected synthetic source remain separately checked. No packet/whole-host capture or response stream interception.'] };
    await persist(out, 'outbound-telemetry.json', report);
    if (failure)
        throw failure;
    await observe(report);
    return report;
}
