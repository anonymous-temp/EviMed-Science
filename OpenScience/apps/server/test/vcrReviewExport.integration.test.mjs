import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { DocumentExportService, exportHash } from '../src/documentExport.mjs';
import { DocumentExportWorker } from '../src/documentExportWorker.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { VcrService } from '../src/vcrService.mjs';
import { VcrOrchestrator } from '../src/vcrOrchestrator.mjs';
import { createVcrDocumentAdapter, canonicalVcrDocument } from '../src/vcrDocumentExport.mjs';
import { createVcrReviewAdapter } from '../src/vcrReview.mjs';
import { vcrReportReviewRevision } from '../src/vcrRender.mjs';
import { DOCUMENT_EXPORT_MIME } from '@evimed/domain';
import { HttpError } from '../src/security.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'A local test PostgreSQL is required.' };
let database, isolated, root, store, documents, jobs;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'vcrreviewexport');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development')");
  store = new VcrStore({ database }); await store.ready();
  documents = new ProductDocuments(database); jobs = new ProductJobs(database);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-review-export-')));
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(name) {
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice',$1,'Research',100000000)", [name]);
  const project = { userId: 'alice', id: name, workspaceDir: path.join(root, name) };
  await fs.mkdir(project.workspaceDir);
  const figure = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(project.workspaceDir, 'figure.png'), figure);
  const study = await store.createStudy({ userId: 'alice', projectId: name, name: '保留数字', question: '' });
  const definition = await store.saveDefinition({ userId: 'alice', studyId: study.id, pico: {}, estimand: {}, endpointType: 'binary' });
  const research = new VcrService({ store, config: { vcrEnabled: true, vcrAudience: 'all' } });
  const model = { ...await research.reportModel(study), counts: { realPatients: 42 }, measures: [{ name: 'power', value: 0.8123 }] };
  const exported = await store.createExport({ userId: 'alice', studyId: study.id, kind: 'study_package', cover: {
    results: model, reports: [{ section: 'main', template: '人数 {{n:counts.realPatients|int}}，效能 {{n:measure(power).value|pct2}}。\n\n![研究图](figure.png)' }],
  } });
  await store.updateExport(exported.id, { state: 'ready' });
  let renders = 0, fail = false, callback;
  const controller = {
    async inspectRuntimeImage() { return { imageId: 'runtime@sha256:fixed' }; },
    async cancelDocumentRender() {},
    async renderDocument(reference) {
      renders++;
      const dir = path.join(root, 'users', reference.ownerId, 'projects', reference.projectId, '.openscience', 'document-exports', reference.exportId, 'attempts', reference.attemptId);
      const input = JSON.parse(await fs.readFile(path.join(dir, 'input/document.json'), 'utf8'));
      const formats = {};
      for (const format of input.formats) {
        if (fail && format === 'pdf') { formats[format] = { state: 'failed' }; continue; }
        const bytes = Buffer.from(`converted ${format}: ${input.canonicalMarkdown}`);
        await fs.writeFile(path.join(dir, 'output', `document.${format}`), bytes);
        formats[format] = { state: 'ready', path: `document.${format}`, mime: DOCUMENT_EXPORT_MIME[format], bytes: bytes.length, sha256: exportHash(bytes) };
      }
      await fs.writeFile(path.join(dir, 'output/manifest.json'), JSON.stringify({ rendererVersion: input.rendererVersion, sourceDigest: input.sourceDigest, formats }));
    },
  };
  const vcr = { store, service: research, access: { judge: async () => ({ allowed: true }) } };
  const adapter = createVcrDocumentAdapter({ vcr, store: { userById: async () => ({ id: 'alice' }), requireProject: async () => project } });
  const conversion = new DocumentExportService({ config: { dataDir: root }, documents, jobs, controller,
    resolveSource: (user, request) => adapter.resolve(user, request), authorize: (user, payload) => adapter.authorize(user, payload.source) });
  const orchestrator = new VcrOrchestrator({ store, jobs: {}, queueExport: (user, target, row) => adapter.queue(conversion, user, target, row) });
  vcr.orchestrator = orchestrator;
  createVcrReviewAdapter({ vcr, reviewService: { registerStudyReviewAdapter(_kind, hooks) { callback = hooks.completed; } } });
  const original = await adapter.queue(conversion, { id: 'alice' }, study, exported);
  const worker = new DocumentExportWorker({ service: conversion, jobs, controller });
  for (let attempt = 0; attempt < 10 && (await conversion.status({ id: 'alice' }, original.id)).state !== 'ready'; attempt++) await worker.tick();
  assert.equal((await conversion.status({ id: 'alice' }, original.id)).state, 'ready');
  const frozen = await store.exportRow(study.id, exported.id);
  const inputDigest = 'a'.repeat(64), configurationDigest = 'b'.repeat(64);
  const records = ['clinical', 'statistical'].map(role => ({ reviewId: `review_${name}_${role}`, studyId: study.id, role,
    subjectRef: { kind: 'vcr', studyId: study.id, exportId: exported.id, reportRevision: vcrReportReviewRevision(frozen.cover) },
    nodes: [`study_definition:${definition.id}@${definition.version}`], inputDigest, configurationDigest,
    configuration: { model: 'configured-reviewer', revision: 'study-review-v1' }, status: 'done', model: 'actual-reviewer', usage: {}, cost: null,
    findings: [], deterministic: { findings: [] }, createdAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' }));
  return { study, exported, frozen, original, records, conversion, worker, orchestrator, callback, project, figure,
    renders: () => renders, fail: () => { fail = true; }, recover: () => { fail = false; },
    restart: () => new VcrOrchestrator({ store, jobs: {}, queueExport: (user, target, row) => adapter.queue(conversion, user, target, row) }),
    async complete() { for (const record of records) { await store.saveAiReview(record); await callback(record); } },
    async reconcile() { return adapter.queue(conversion, { id: 'alice' }, study, await store.exportRow(study.id, exported.id)); },
  };
}

test('a clean trusted review pair refreshes Word/PDF once without changing frozen templates or scientific numbers', options, async () => {
  const f = await fixture('clean');
  const originalPdf = await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf');
  await f.complete();
  assert.equal((await store.exportRow(f.study.id, f.exported.id)).cover.documentExportId, f.original.id, 'Queued conversion cannot replace a working download.');
  await f.worker.tick(); await f.reconcile();
  const updated = await store.exportRow(f.study.id, f.exported.id);
  assert.notEqual(updated.cover.documentExportId, f.original.id);
  assert.deepEqual(updated.cover.results, f.frozen.cover.results);
  assert.deepEqual(updated.cover.reports, f.frozen.cover.reports);
  for (const format of ['docx', 'pdf']) {
    const bytes = (await f.conversion.download({ id: 'alice' }, updated.cover.documentExportId, format)).bytes.toString();
    assert.match(bytes, /AI临床复核：未发现明确问题/); assert.match(bytes, /AI统计复核：未发现明确问题/);
    assert.match(bytes, /人数 42，效能 81.23%/); assert.doesNotMatch(bytes, /尚未完成复核|已复核|实证验证通过/);
  }
  assert.deepEqual((await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes, originalPdf.bytes);
  await Promise.all(f.records.map(record => f.callback(record))); await f.reconcile(); await f.worker.tick();
  assert.equal(f.renders(), 2, 'One original conversion and one review-only conversion, including replay.');
});

test('stale review nodes and mismatched configuration cannot refresh frozen exports', options, async () => {
  for (const name of ['stale', 'configuration', 'digest', 'human']) {
    const f = await fixture(name);
    if (name === 'stale') await store.saveDefinition({ userId: 'alice', studyId: f.study.id, pico: { changed: true }, estimand: {}, endpointType: 'binary' });
    else if (name === 'configuration') f.records[1].configurationDigest = 'c'.repeat(64);
    else if (name === 'digest') f.records[1].inputDigest = 'c'.repeat(64);
    if (name === 'human') {
      await store.saveAiReview(f.records[0]); await f.callback(f.records[0]);
      await store.addReview({ studyId: f.study.id, userId: 'alice', kind: 'statistical', nodes: f.records[1].nodes, reviewer: 'alice' });
      await f.callback(f.records[1]);
    } else await f.complete();
    await f.worker.tick();
    assert.equal((await store.exportRow(f.study.id, f.exported.id)).cover.documentExportId, f.original.id);
    assert.equal(f.renders(), 1);
  }
});

test('late completion replays cannot replace a newer reviewer configuration or select an older role while the new one is queued', options, async () => {
  const f = await fixture('newer-review'); await f.complete(); await f.worker.tick(); await f.reconcile();
  const first = await store.exportRow(f.study.id, f.exported.id);
  const next = f.records.map(record => ({ ...record, reviewId: `${record.reviewId}_next`, configurationDigest: 'c'.repeat(64),
    configuration: { ...record.configuration, model: 'new-configuration' }, model: 'actual-new-reviewer', status: 'queued' }));
  for (const record of next) await store.saveAiReview(record);
  await f.callback(f.records[1]);
  assert.equal((await store.exportRow(f.study.id, f.exported.id)).cover.reviewDocumentRefresh.configurationDigest, 'b'.repeat(64));
  for (const record of next) { record.status = 'done'; await store.saveAiReview(record); await f.callback(record); }
  await Promise.all(f.records.map(record => f.callback(record)));
  assert.equal((await store.exportRow(f.study.id, f.exported.id)).cover.reviewDocumentRefresh.configurationDigest, 'c'.repeat(64));
  await f.worker.tick(); await f.reconcile();
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.notEqual(latest.cover.documentExportId, first.cover.documentExportId);
  await Promise.all(f.records.map(record => f.callback(record)));
  assert.equal((await store.exportRow(f.study.id, f.exported.id)).cover.documentExportId, latest.cover.documentExportId);
  assert.equal(f.renders(), 3);
});

test('the existing study worker resumes a review-only conversion after restart without another model or render request', options, async () => {
  const f = await fixture('restarted'); await f.complete(); await f.worker.tick();
  await f.restart().advance(f.study.id);
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.reviewDocumentRefresh.state, 'ready');
  assert.notEqual(latest.cover.documentExportId, f.original.id);
  assert.equal(f.renders(), 2);
});

test('temporary request failure recovers through the existing study loop while retaining the old download', options, async () => {
  const f = await fixture('request-recover');
  const requestFrozen = f.conversion.requestFrozen.bind(f.conversion);
  let requests = 0;
  f.conversion.requestFrozen = async (...args) => {
    if (++requests === 1) throw new HttpError(503, 'document_export_capacity', 'Waiting for capacity.');
    return requestFrozen(...args);
  };
  await f.complete();
  let latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.documentExportId, f.original.id); assert.equal(latest.cover.reviewDocumentRefresh.state, 'pending');
  await f.restart().advance(f.study.id); await f.worker.tick(); await f.restart().advance(f.study.id);
  latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.reviewDocumentRefresh.state, 'ready');
  assert.notEqual(latest.cover.documentExportId, f.original.id); assert.equal(requests, 2); assert.equal(f.renders(), 2);
});

test('a failed format recovers under the same conversion identity without replacing working downloads early', options, async () => {
  const f = await fixture('format-recover');
  const before = (await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes;
  f.fail(); await f.complete(); await f.worker.tick();
  const pending = (await store.exportRow(f.study.id, f.exported.id)).cover.reviewDocumentRefresh;
  const docxBefore = (await f.conversion.download({ id: 'alice' }, pending.conversionId, 'docx')).bytes;
  await Promise.all([f.reconcile(), f.reconcile(), f.reconcile()]);
  assert.equal((await store.exportRow(f.study.id, f.exported.id)).cover.documentExportId, f.original.id);
  assert.deepEqual((await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes, before);
  f.recover(); await f.worker.tick(); await f.restart().advance(f.study.id);
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.documentExportId, pending.conversionId);
  assert.equal(latest.cover.reviewDocumentRefresh.state, 'ready');
  assert.equal(latest.cover.reviewDocumentRefresh.retryAttempts, 1);
  assert.equal(f.renders(), 3);
  assert.deepEqual((await f.conversion.download({ id: 'alice' }, pending.conversionId, 'docx')).bytes, docxBefore);
});

test('an older partial status cannot remove the active final retry from restart recovery', options, async () => {
  const f = await fixture('last-retry-generation');
  const originalPdf = (await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes;
  f.fail(); await f.complete(); await f.worker.tick(); await f.reconcile(); await f.worker.tick(); await f.reconcile(); await f.worker.tick();
  const before = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(before.cover.reviewDocumentRefresh.retryAttempts, 2);
  const conversionId = before.cover.reviewDocumentRefresh.conversionId;
  const status = f.conversion.status.bind(f.conversion);
  let pause, release;
  const paused = new Promise(resolve => { pause = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let intercept = true, olderRevision;
  f.conversion.status = async (...args) => {
    const observed = await status(...args);
    if (intercept && args[1] === conversionId) {
      intercept = false; olderRevision = observed.revision;
      assert.equal(observed.state, 'partial'); pause(); await gate;
    }
    return observed;
  };
  const olderObserver = f.reconcile();
  try { await paused; await f.reconcile(); } finally { release(); }
  await olderObserver;
  let current = await store.exportRow(f.study.id, f.exported.id);
  const actual = await status({ id: 'alice' }, conversionId);
  assert.equal(actual.state, 'queued'); assert.ok(actual.revision > olderRevision);
  assert.equal(current.cover.reviewDocumentRefresh.retryAttempts, 3);
  assert.equal(current.cover.reviewDocumentRefresh.state, 'pending', 'An older partial status cannot hide a queued final retry.');
  assert.equal(current.cover.reviewDocumentRefresh.conversionRecordRevision, actual.revision);
  assert.equal(current.cover.documentExportId, f.original.id);
  assert.deepEqual((await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes, originalPdf);
  f.recover(); await f.worker.tick(); await f.restart().advance(f.study.id);
  current = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(current.cover.reviewDocumentRefresh.state, 'ready');
  assert.equal(current.cover.documentExportId, conversionId);
  assert.equal(current.cover.reviewDocumentRefresh.retryAttempts, 3, 'Recovery never creates a fourth retry.');
});

test('canceling the review-only conversion never automatically restarts it or removes the original download', options, async () => {
  const f = await fixture('conversion-canceled'); await f.complete();
  const pending = (await store.exportRow(f.study.id, f.exported.id)).cover.reviewDocumentRefresh;
  await f.conversion.cancel({ id: 'alice' }, pending.conversionId);
  await f.reconcile(); await f.restart().advance(f.study.id); await f.worker.tick();
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.documentExportId, f.original.id);
  assert.equal(latest.cover.reviewDocumentRefresh.state, 'failed');
  assert.equal(latest.cover.reviewDocumentRefresh.retryAttempts ?? 0, 0); assert.equal(f.renders(), 1);
  assert.match((await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes.toString(), /人数 42，效能 81.23%/);
});

test('review refresh retains exact frozen figures after workspace replacement or deletion', options, async () => {
  for (const name of ['figure-changed', 'figure-deleted']) {
    const f = await fixture(name);
    if (name === 'figure-changed') await fs.writeFile(path.join(f.project.workspaceDir, 'figure.png'), Buffer.from('Changed workspace picture.'));
    else await fs.rm(path.join(f.project.workspaceDir, 'figure.png'));
    await f.complete(); await f.worker.tick(); await f.reconcile();
    const latest = await store.exportRow(f.study.id, f.exported.id);
    assert.equal(latest.cover.reviewDocumentRefresh.state, 'ready');
    const assets = await f.conversion.frozenAssets({ id: 'alice' }, latest.cover.documentExportId,
      { source: { studyId: f.study.id, exportId: f.exported.id }, sourceRevision: latest.cover.documentExportSourceRevision });
    assert.equal(assets.length, 1); assert.deepEqual(assets[0].data, f.figure); assert.equal(assets[0].sha256, exportHash(f.figure));
    await f.reconcile(); await f.worker.tick();
    assert.equal((await store.exportRow(f.study.id, f.exported.id)).cover.documentExportId, latest.cover.documentExportId);
    assert.equal(f.renders(), 2, 'Re-requesting the completed snapshot cannot reread replaced or deleted workspace figures.');
  }
});

test('changed frozen figure bytes refuse refresh and preserve old verified downloads', options, async () => {
  const f = await fixture('figure-tampered');
  const before = (await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes;
  const file = path.join(root, 'users', 'alice', 'projects', f.study.projectId, '.openscience', 'document-exports', f.original.id, 'input', 'figure.png');
  await fs.chmod(file, 0o600); await fs.writeFile(file, Buffer.from('Changed immutable picture.'));
  await f.complete();
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.reviewDocumentRefresh.state, 'failed');
  assert.equal(latest.cover.reviewDocumentRefresh.code, 'document_input_changed'); assert.equal(f.renders(), 1);
  assert.equal(latest.cover.documentExportId, f.original.id);
  assert.deepEqual((await f.conversion.download({ id: 'alice' }, f.original.id, 'pdf')).bytes, before);
});

test('a source version changing during conversion refuses publication and keeps the old download', options, async () => {
  const f = await fixture('input-edited'); await f.complete();
  await store.saveDefinition({ userId: 'alice', studyId: f.study.id, pico: { newer: true }, estimand: {}, endpointType: 'binary' });
  await f.worker.tick(); await f.reconcile();
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.documentExportId, f.original.id);
  assert.equal(latest.cover.reviewDocumentRefresh.state, 'obsolete');
});

test('successful review-only conversion honestly includes a failed independent role and clinical advice', options, async () => {
  const f = await fixture('failed-role');
  f.records[0].findings = [{ kind: 'wording', location: 'main', message: '不能外推到真实患者。', fix: '' }];
  f.records[1].status = 'failed'; f.records[1].model = null; f.records[1].error = 'review_configuration_changed';
  await f.complete(); await f.worker.tick(); await f.reconcile();
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.notEqual(latest.cover.documentExportId, f.original.id);
  for (const format of ['docx', 'pdf']) {
    const text = (await f.conversion.download({ id: 'alice' }, latest.cover.documentExportId, format)).bytes.toString();
    assert.match(text, /不能外推到真实患者/); assert.match(text, /AI统计复核：审查未完成/);
    assert.match(text, /本次审查因服务配置变化未完成/); assert.match(text, /人数 42，效能 81.23%/);
  }
  assert.equal(latest.cover.documentReview.records[1].provenance.error, 'review_configuration_changed');
});

test('a concurrent report edit refuses the old review conversion at publication', options, async () => {
  const f = await fixture('edited'); await f.complete();
  await store.updateExportCover(f.exported.id, cover => ({ ...cover, reports: [{ section: 'main', template: '新报告，人数 {{n:counts.realPatients|int}}。' }] }));
  await f.worker.tick(); await f.reconcile();
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.documentExportId, f.original.id);
  assert.match(latest.cover.reports[0].template, /新报告/);
});

test('conversion failure keeps every original download and includes true failed review and warning in the new frozen input', options, async () => {
  const f = await fixture('failure');
  f.records[0].findings = [{ kind: 'wording', location: 'main', message: '不能外推到真实患者。', fix: '' }];
  f.records[1].status = 'failed'; f.records[1].model = null; f.records[1].error = 'review_configuration_changed';
  const before = await Promise.all(['docx', 'pdf', 'html'].map(format => f.conversion.download({ id: 'alice' }, f.original.id, format)));
  f.fail(); await f.complete();
  for (let attempt = 0; attempt < 5; attempt++) {
    await f.worker.tick(); await f.reconcile();
    if ((await store.exportRow(f.study.id, f.exported.id)).cover.reviewDocumentRefresh.state === 'failed') break;
  }
  const latest = await store.exportRow(f.study.id, f.exported.id);
  assert.equal(latest.cover.documentExportId, f.original.id); assert.deepEqual(latest.cover.results, f.frozen.cover.results);
  assert.equal(latest.cover.reviewDocumentRefresh.state, 'failed');
  assert.equal(latest.cover.reviewDocumentRefresh.retryAttempts, 3);
  const partial = (await f.conversion.download({ id: 'alice' }, latest.cover.reviewDocumentRefresh.conversionId, 'docx')).bytes.toString();
  assert.match(partial, /不能外推到真实患者/); assert.match(partial, /AI统计复核：审查未完成/);
  assert.match(partial, /本次审查因服务配置变化未完成/); assert.doesNotMatch(partial, /AI统计复核：未发现明确问题/);
  assert.equal(latest.cover.reviewDocumentRefresh.records[1].provenance.error, 'review_configuration_changed');
  for (const [index, format] of ['docx', 'pdf', 'html'].entries()) assert.deepEqual((await f.conversion.download({ id: 'alice' }, f.original.id, format)).bytes, before[index].bytes);
  assert.match(canonicalVcrDocument(f.study, latest).canonicalMarkdown, /尚未完成复核/);
});
