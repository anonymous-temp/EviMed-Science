import test from 'node:test';
import assert from 'node:assert/strict';
import { documentExportFormats, documentExportDigest, DOCUMENT_RENDERER_VERSION } from '../../../packages/domain/src/documentExport.mjs';
import { documentRenderPlan } from '../src/documentRenderController.mjs';

test('formats are closed, ordered and deduplicated', () => {
  assert.deepEqual(documentExportFormats(['pdf','docx','pdf']), ['docx','pdf']);
  for (const formats of [[], ['exe'], ['pdf', 'https://example.com']]) assert.throws(() => documentExportFormats(formats));
});
test('source, assets, cover and renderer identity change the immutable digest', () => {
  const input = { canonicalMarkdown: '中文 95% CI', assets: [], cover: { version: 1 } };
  const digest = documentExportDigest(input);
  assert.equal(digest, documentExportDigest({ cover: { version: 1 }, assets: [], canonicalMarkdown: input.canonicalMarkdown }));
  assert.notEqual(digest, documentExportDigest({ ...input, cover: { version: 2 } }));
  assert.notEqual(digest, documentExportDigest({ ...input, rendererVersion: DOCUMENT_RENDERER_VERSION + '-next' }));
});
test('render plan exposes only input and output with bounded offline isolation', () => {
  const config = { dataDir: '/data', runtimeContainerImage: 'runtime@sha256:pin', runtimeContainerBin: 'docker' };
  const plan = documentRenderPlan(config, { ownerId: 'alice', projectId: 'p1', exportId: 'exp1', attemptId: 'a1' });
  assert.equal(plan.label, documentRenderPlan(config, { attemptId: 'a1', exportId: 'exp1', projectId: 'p1', ownerId: 'alice' }).label);
  assert.ok(plan.args.includes('--read-only'));
  assert.ok(plan.args.includes('--network=none'));
  assert.ok(plan.args.includes('--cap-drop=ALL'));
  assert.ok(plan.args.includes('--security-opt=no-new-privileges'));
  for(const limit of ['--pids-limit=256','--cpus=1','--memory=768m','--memory-swap=768m'])assert.ok(plan.args.includes(limit));
  assert.equal(plan.args.filter(x => x === '--mount').length, 2);
  assert.ok(plan.args.some(x => x.includes('/input,readonly')));
  const env=Object.fromEntries(plan.args.filter((value,index)=>plan.args[index-1]==='--env').map(value=>value.split('=')));
  for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'])assert.ok(env[key]?.startsWith('/tmp/'));
  for(const target of ['/workspace','/runtime'])assert.ok(plan.args.includes(`${target}:ro,noexec,nosuid,nodev,size=1m`));
  assert.ok(plan.args.includes('python3'));
  assert.ok(!plan.args.join(' ').match(/credentials|docker.sock|data-plane|remote.mux/));
  assert.throws(() => documentRenderPlan(config, { ownerId: '../alice', projectId: 'p1', exportId: 'e1', attemptId: 'a1' }));
});

import { canonicalVcrDocument } from '../src/vcrDocumentExport.mjs';
import { VCR_EXPORT_KINDS } from '@evimed/domain';
test('all four VCR formats assemble every section against the same frozen result, including unreviewed work', () => {
  const study = { id: 'study', name: 'Research', intendedUse: 'exploratory' };
  const model = { study, counts: { sample: 42 }, review: { records: [{ kind: 'clinical', state: 'failed', reviewer: 'AI', nodes: ['result:one@1'] }] }, stale: [{ node: 'result:one@1', reason: 'source_changed' }] };
  for (const kind of VCR_EXPORT_KINDS) {
    const result = canonicalVcrDocument(study, { kind, cover: { results: model, reports: [
      { section: 'Methods', template: '样本 {{n:counts.sample|int}}。' },
      { section: 'Limitations', template: '缺失 {{n:counts.missing|int}}。' },
    ] } });
    assert.match(result.canonicalMarkdown, /Methods[\s\S]*42[\s\S]*Limitations[\s\S]*未计算/);
    assert.match(result.canonicalMarkdown, /审查未完成/);
    assert.doesNotMatch(result.canonicalMarkdown, /已复核/);
    assert.match(result.canonicalMarkdown, /source_changed/);
    assert.deepEqual(result.cover.reviews, model.review.records);
    assert.equal(result.cover.results, undefined);
  }
});

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { freezeArtifactDocument, freezeResultVersionDocument } from '../src/documentExport.mjs';
test('every registered public document capability has a canonical output supported by the common converter', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'document-capabilities-')));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const capabilities = new URL('../../../capabilities/', import.meta.url);
  let documents = 0;
  for (const folder of await fs.readdir(capabilities)) {
    const file = new URL(`${folder}/capability.yaml`, capabilities);
    let capability;
    try { capability = YAML.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (capability.visibility === 'internal') continue;
    const outputs = (capability.produces ?? []).flatMap(contract => contract.outputs ?? []).map(output => output.path);
    if (!outputs.some(output => /\.(md|markdown|txt|docx|pdf|html)$/i.test(output))) continue;
    const canonical = outputs.find(output => /\.(md|markdown|txt)$/i.test(output));
    assert.ok(canonical, `${capability.id} must name its canonical text document`);
    await fs.mkdir(path.join(root, folder), { recursive:true });
    const artifactId = `${folder}/${path.basename(canonical)}`;
    await fs.writeFile(path.join(root, artifactId), '# 中文研究\n\nEffect 42.5 [1].');
    const frozen = await freezeArtifactDocument({ workspaceDir:root }, { artifactId });
    assert.equal(frozen.canonicalMarkdown, '# 中文研究\n\nEffect 42.5 [1].');
    documents++;
  }
  assert.ok(documents >= 20, `Checked ${documents} public document capabilities`);
});

test('a result version converts from its own preserved bytes, never from what its path holds now, and an old document is not given a newer figure', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'document-version-')));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'out'), { recursive:true });
  const png = Buffer.from('89504e470d0a1a0a00', 'hex');
  const newerPng = Buffer.from('89504e470d0a1a0a01', 'hex');
  await fs.writeFile(path.join(root, 'out', 'forest.png'), png);
  await fs.writeFile(path.join(root, 'out', 'other.png'), newerPng);
  // The workspace now holds a different report under the same path; the version's own bytes are what convert.
  await fs.writeFile(path.join(root, 'out', 'report.md'), 'Effect 99.9 [1].');
  const bytes = Buffer.from('# 报告\n\nEffect 42.5 [1].\n\n![forest](forest.png)\n\n![other](other.png)\n');
  const version = { versionId: `rv_${'a'.repeat(64)}`, digest: createHash('sha256').update(bytes).digest('hex'), path: 'out/report.md' };
  const asked = [];
  const frozen = await freezeResultVersionDocument({ workspaceDir: root }, version, bytes, {
    preserved: async asset => { asked.push(asset.path); return asset.path === 'out/forest.png'; } });
  assert.match(frozen.canonicalMarkdown, /Effect 42\.5/);
  assert.doesNotMatch(frozen.canonicalMarkdown, /99\.9/);
  assert.equal(frozen.revision, version.digest, 'the conversion names exactly which bytes it is of');
  assert.equal(frozen.title, 'report.md');
  assert.deepEqual(frozen.assets.map(asset => asset.path), ['forest.png'], 'only a figure that is exactly a version captured beside the document goes in');
  assert.deepEqual(asked.sort(), ['out/forest.png', 'out/other.png']);
  const bare = await freezeResultVersionDocument({ workspaceDir: root }, version, bytes);
  assert.deepEqual(bare.assets, [], 'with nothing to vouch for a figure, none is carried');
  await assert.rejects(freezeResultVersionDocument({ workspaceDir: root }, { ...version, path: 'out/forest.png' }, png), { code: 'document_format_unsupported' });
  await assert.rejects(freezeResultVersionDocument({ workspaceDir: root }, version, Buffer.from([0xff, 0xfe, 0xfd])), { code: 'document_format_unsupported' });
  await assert.rejects(freezeResultVersionDocument({ workspaceDir: root }, version, Buffer.alloc(4 * 1024 * 1024 + 1, 97)), { code: 'document_export_too_large' });
});

import { createVcrDocumentAdapter } from '../src/vcrDocumentExport.mjs';
import { vcrReportReviewRevision } from '../src/vcrRender.mjs';
test('review-only metadata cannot change any frozen numeric binding, including references into old review metadata', () => {
  const study = { id: 'study', name: 'Research', intendedUse: 'exploratory' };
  const cover = { results: { study, review: { records: [{ kind: 'clinical', reviewerKind: 'ai', status: 'done', provenance: { cost: 1.25, model: 'old-reviewer' } }] } },
    reports: [{ section: 'main', template: '既有记录 {{n:review.records[0].provenance.cost|f2}}。' }] };
  const original = canonicalVcrDocument(study, { kind: 'study_package', cover });
  const updated = canonicalVcrDocument(study, { kind: 'study_package', cover: { ...cover, documentReview: {
    reportRevision: vcrReportReviewRevision(cover), records: [{ kind: 'clinical', reviewerKind: 'ai', status: 'done', provenance: { cost: 2.5, model: 'actual-new-reviewer', findings: [] } }],
  } } });
  assert.match(updated.canonicalMarkdown, /actual-new-reviewer/);
  assert.match(updated.canonicalMarkdown, /既有记录 1.25/);
  assert.doesNotMatch(updated.canonicalMarkdown, /既有记录 2.50/);
  assert.notEqual(updated.revision, original.revision);
  assert.equal(cover.results.review.records[0].provenance.cost, 1.25);
});
test('a report section arriving during conversion scheduling is retained and attached to its own frozen revision', async () => {
  const study = { id:'study', name:'Research', projectId:'project', intendedUse:'exploratory' };
  const row = { id:'package', kind:'study_package', cover:{ results:{study}, reports:[{section:'Methods',template:'方法。'}] } };
  let cover = structuredClone(row.cover);
  let resume;
  let calls = 0;
  const firstRevision = canonicalVcrDocument(study,row).revision;
  const service = { async request() {
    calls++;
    if(calls===1) await new Promise(resolve=>{resume=resolve;});
    return { id:`shared-${calls}`, sourceRevision:calls===1?firstRevision:canonicalVcrDocument(study,{...row,cover}).revision };
  } };
  const adapter = createVcrDocumentAdapter({ store:{}, vcr:{ store:{ async updateExportCover(_id, update){ cover=update(cover); return { ...row, cover }; } } } });
  const pending = adapter.queue(service,{id:'alice'},study,row);
  cover.reports.push({section:'Results',template:'保留结果。'});
  resume();
  const result = await pending;
  assert.equal(cover.reports.length,2);
  assert.equal(cover.documentExportId,'shared-2');
  assert.equal(result.id,'shared-2');
});

import { vcrReportModel } from '../src/vcrRender.mjs';
import { presentExport } from '../src/vcrViews.mjs';
test('retained snapshots report changes in assumptions, object versions, reviews, seals and stale identities', () => {
  const study={id:'study',name:'Research',question:'Question',dataTier:'T0',intendedUse:'exploratory'};
  const source={study,assumptions:[{key:'rate',name:'Rate',version:1,pointValue:0.3}],results:[],reviews:[],staleMarks:[{node:'result:one@1',reason:'source_changed'}],
    population:{id:'population',version:1},comparator:{id:'comparator',version:1},scenarios:[],models:[],seal:{planFrozenAt:'2026-09-01'}};
  const model=vcrReportModel(source);
  const row={id:'export',kind:'study_package',state:'ready',cover:{results:model},createdAt:'2026-09-01'};
  const bundle={...source,now:new Date('2026-09-02'),exports:[row],stale:source.staleMarks,populations:[source.population],jobs:[],executions:[],decisions:[],comparators:[source.comparator],patientSets:[]};
  assert.equal(presentExport(row,bundle).snapshotChanged,undefined);
  for(const changed of [
    {...bundle,assumptions:[{...source.assumptions[0],version:2,pointValue:0.8}]},
    {...bundle,populations:[{...source.population,version:2}]},
    {...bundle,comparator:{...source.comparator,version:2}},
    {...bundle,reviews:[{kind:'clinical',state:'reviewed',reviewer:'AI',nodes:[]}]},
    {...bundle,seal:{planFrozenAt:'2026-09-02'}},
    {...bundle,stale:[{node:'result:two@1',reason:'source_changed'}]},
  ]) assert.equal(presentExport(row,changed).snapshotChanged,true);
  assert.equal(row.cover.results.assumptions[0].value,0.3,'the retained document is not rewritten');
});

test('VCR reports freeze their verified workspace figure bytes through the shared asset resolver', async t => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'vcr-figure-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64');
  await fs.writeFile(path.join(root,'figure.png'),bytes);
  const study={id:'study',name:'Research',userId:'alice',projectId:'project',intendedUse:'exploratory'};
  const row={id:'export',kind:'study_package',cover:{results:{study},reports:[{section:'Figures',template:'![研究图](figure.png)'}]}};
  const vcr={service:{allows:()=>true},access:{judge:async()=>({allowed:true})},store:{getStudy:async()=>study,exportRow:async()=>row}};
  const adapter=createVcrDocumentAdapter({vcr,store:{userById:async()=>({id:'alice'}),requireProject:async()=>({id:'project',userId:'alice',workspaceDir:root})}});
  const frozen=await adapter.resolve({id:'alice'},{source:{studyId:'study',exportId:'export'}});
  assert.equal(frozen.assets.length,1);
  assert.equal(frozen.assets[0].path,'figure.png');
  assert.deepEqual(frozen.assets[0].data,bytes);
  assert.equal(frozen.assets[0].sha256.length,64);
});

import { VCR_MODEL_DOCUMENT_KINDS } from '@evimed/domain';
import { frozenVersion, modelInputs, reportModelFor } from './vcrModelDocumentFixtures.mjs';
test('the two model documents are queued for Word, PDF and HTML like every other VCR export, bound to the exact frozen revision', async () => {
  for (const kind of VCR_MODEL_DOCUMENT_KINDS) {
    const study = { id: 'study', name: 'Research', projectId: 'project', intendedUse: 'exploratory' };
    const model = reportModelFor({ versions: [frozenVersion(modelInputs())] });
    const row = { id: 'document', kind, cover: { results: model, reports: [{ section: 'introduction', template: '引言。' }] } };
    let cover = structuredClone(row.cover);
    /** @type {any[]} */
    const requested = [];
    const revision = canonicalVcrDocument(study, row).revision;
    const service = { async request(_user, input) { requested.push(input); return { id: `conversion-${kind}`, sourceRevision: revision }; } };
    const adapter = createVcrDocumentAdapter({ store: {}, vcr: { store: { async updateExportCover(_id, update) { cover = update(cover); return { ...row, cover }; } } } });
    const queued = await adapter.queue(service, { id: 'alice' }, study, row);
    assert.equal(queued.id, `conversion-${kind}`);
    assert.deepEqual(requested[0].formats, ['docx', 'pdf', 'html'], kind);
    assert.deepEqual(requested[0].source, { studyId: 'study', exportId: 'document' });
    assert.equal(cover.documentExportId, `conversion-${kind}`, 'the conversion is bound to the revision it was frozen on');
    assert.equal(cover.documentExportSourceRevision, revision);
  }
});

import { spawnSync } from 'node:child_process';
const hasPandoc = spawnSync('pandoc', ['--version']).status === 0;
test('the model documents convert to Word and HTML with their tables, their not-estimable results and their rendered numbers intact', { skip: !hasPandoc && 'pandoc is not installed' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-document-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const kind of VCR_MODEL_DOCUMENT_KINDS) {
    const study = { id: 'study', name: 'Research', intendedUse: 'exploratory' };
    const model = reportModelFor({ versions: [frozenVersion(modelInputs())] });
    const { canonicalMarkdown } = canonicalVcrDocument(study, { kind, cover: { results: model, reports: [{ section: 'introduction', template: '引言。' }] } });
    await fs.writeFile(path.join(dir, `${kind}.md`), canonicalMarkdown);
    for (const format of ['docx', 'html']) {
      const converted = spawnSync('pandoc', [path.join(dir, `${kind}.md`), '-f', 'markdown', '-o', path.join(dir, `${kind}.${format}`), ...(format === 'html' ? ['-s', '--metadata', 'title=文件'] : [])], { encoding: 'utf8' });
      assert.equal(converted.status, 0, converted.stderr);
    }
    const html = await fs.readFile(path.join(dir, `${kind}.html`), 'utf8');
    assert.ok((html.match(/<table/g) ?? []).length >= 4, `${kind}: the tables survive conversion`);
    assert.match(html, kind === 'model_analysis_plan' ? /冻结信息/ : /这份报告依据的模型分析计划/);
    if (kind === 'model_analysis_report') {
      assert.match(html, /不可估计/);
      assert.match(html, /0\.812（蒙特卡洛标准误 0\.0027）/);
    }
    assert.ok((await fs.stat(path.join(dir, `${kind}.docx`))).size > 5_000, `${kind}: a Word file was written`);
  }
});
