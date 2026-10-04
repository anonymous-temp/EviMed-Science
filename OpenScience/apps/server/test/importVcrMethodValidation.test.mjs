import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VCR_ENGINE_METHODS } from '@evimed/domain';
import { NUMERIC_REFERENCES, assertProtectedDirectory, fetchGitHubEvidence, methodsWithoutReference, numericalSourceDigest, packageLockHash, parseArguments,
  produceMethodValidation, readValidationSource, sourceCases, verifyGitHubIdentity, writeMethodValidation } from '../../../scripts/ops/import-vcr-method-validation.mjs';
import { referenceProblems } from '../../../scripts/ops/vcr-method-references.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const engine = path.join(root, '项目代码/vcr-engine');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(40);
const repository = 'example/evimed';
const runId = '101';
const jobId = '202';
const url = `https://github.com/${repository}/actions/runs/${runId}`;
const steps = ['Prove the library is exactly the locks', 'Run every numeric acceptance case', 'Check the run was whole', 'Preserve numerical validation evidence'];
const archive = Buffer.from('mock immutable artifact archive');
const github = () => ({ repository, sourceRevision: revision, runId, jobId,
  run: { id: 101, repository: { full_name: repository }, head_sha: revision, path: '.github/workflows/web.yml', event: 'push', status: 'completed', conclusion: 'success', html_url: url },
  job: { id: 202, run_id: 101, head_sha: revision, name: 'vcr-engine', status: 'completed', conclusion: 'success', html_url: `${url}/job/${jobId}`, completed_at: '2026-10-01T02:00:00Z',
    steps: steps.map(name => ({ name, status: 'completed', conclusion: 'success' })) },
  artifact: { id: 303, name: `vcr-numerical-evidence-${revision}`, expired: false, workflow_run: { id: 101, head_sha: revision }, digest: `sha256:${hash(archive)}` },
});

let source;
async function actualSource() {
  if (source) return source;
  const runtimeFiles = [];
  for (const name of (await fs.readdir(path.join(engine, 'R'))).filter(name => /\.(?:R|json)$/.test(name))) {
    runtimeFiles.push({ path: `R/${name}`, bytes: await fs.readFile(path.join(engine, 'R', name)) });
  }
  const caseFiles = [];
  for (const name of (await fs.readdir(path.join(engine, 'tests/numeric'))).filter(name => /\.R$/.test(name))) {
    caseFiles.push({ path: `tests/numeric/${name}`, bytes: await fs.readFile(path.join(engine, 'tests/numeric', name)) });
  }
  source = { runtimeFiles, caseFiles, methods: JSON.parse(runtimeFiles.find(file => file.path === 'R/domain-snapshot.json').bytes).methods };
  return source;
}

async function fixture() {
  const testedSource = await actualSource();
  const definitions = sourceCases(testedSource.caseFiles);
  const report = { schemaVersion: 1, sourceRevision: revision, numericalSourceDigest: numericalSourceDigest(testedSource.runtimeFiles), rVersion: '4.3.3',
    packageLockHash: packageLockHash(testedSource.runtimeFiles.find(file => file.path === 'R/package-lock.json').bytes), methods: testedSource.methods,
    cases: [...definitions.keys()].map(id => ({ id, ac: ['AC-30'], pass: true, detail: 'unit-test fixture: numerical comparison passed', seconds: 1 })),
    // E05 exercised every handler, but its structural smoke checks qualify none. Every reference case that exists in this source ran
    // the methods it names (what a passing full run records), and nothing else is listed here by hand.
    methodsByCase: { E05: Object.keys(testedSource.methods),
      ...Object.fromEntries(Object.entries(NUMERIC_REFERENCES).filter(([id]) => definitions.has(id)).map(([id, spec]) => [id, spec.methods.length === 1 ? spec.methods[0] : spec.methods])) },
    complete: true, testOnly: '', skippedCaseIds: [] };
  const logBytes = Buffer.from(`${report.cases.map(item => `${item.id} PASS AC-30 | ${item.detail} [1.0s]`).join('\n')}\n\nPASSED ${definitions.size}/${definitions.size}\n`);
  const ci = verifyGitHubIdentity(github());
  const health = { ok: true, rVersion: 'R version 4.3.3 (2024-02-29)', packageLockHash: report.packageLockHash, numericalSourceDigest: report.numericalSourceDigest };
  return { report, reportBytes: Buffer.from(JSON.stringify(report)), logBytes, source: testedSource, sourceRevision: revision, ci, health };
}

const generate = value => produceMethodValidation({ ...value, reportBytes: Buffer.from(JSON.stringify(value.report)) });

test('a whole source-bound run qualifies only methods with executed explicit numerical references', async () => {
  const input = await fixture();
  const evidence = generate(input);
  assert.equal(evidence.ci.reportSha256, hash(Buffer.from(JSON.stringify(input.report))));
  assert.equal(evidence.ci.headSha, evidence.sourceRevision);
  // every method the engine dispatches has a row, and the list is the registry's, not a number written here
  assert.deepEqual(evidence.methods.map(entry => entry.method).sort(), Object.keys(input.source.methods).sort());
  assert.ok(evidence.methods.length >= 27, 'the 24 methods of the first release and the robustness methods');
  assert.ok(evidence.methods.every(entry => entry.numericTests.caseIds.length >= 1 && entry.numericTests.referenceCases.length >= 1));
  const analytic = evidence.methods.find(entry => entry.method === 'design.analytic');
  assert.deepEqual(analytic.numericTests.caseIds, ['N01b', 'N06b', 'N06c']);
  assert.match(analytic.numericTests.referenceCases[0].reference, /rpact::getDesignGroupSequential/);
  assert.match(analytic.numericTests.referenceCases[0].reference, /d_rp < 1e-4 && d_g4 < 1e-4/);
  assert.equal(analytic.version, VCR_ENGINE_METHODS['design.analytic'].version);
  // the twelve methods the deployed file used to leave out now have the case that compares each with something outside it
  for (const [method, caseId] of [['matching.evaluate', 'N29'], ['design.grid', 'N06d'], ['profile.snapshot', 'N41a'], ['population.synthpop', 'N41b'],
    ['comparator.negative_control', 'N37a'], ['comparator.tipping_point', 'N38a'], ['comparator.prognostic_adjustment', 'N39a']]) {
    assert.ok(evidence.methods.find(entry => entry.method === method).numericTests.caseIds.includes(caseId), `${method} is held by ${caseId}`);
  }
  for (const entry of evidence.methods) {
    for (const assumption of entry.assumptions) {
      const [, file, number] = /^(.*):(\d+)$/.exec(assumption.source);
      const original = input.source.caseFiles.find(item => item.path === file).bytes.toString().split('\n')[Number(number) - 1].trim();
      assert.equal(assumption.text, original);
    }
  }
});

test('R machine metadata singleton arrays preserve exact method identity when auto-unboxed', async () => {
  const input = await fixture();
  input.report.methods = structuredClone(input.source.methods);
  let unboxed = 0;
  for (const method of Object.values(input.report.methods)) {
    for (const field of ['endpoints', 'crossChecks']) {
      if (Array.isArray(method[field]) && method[field].length === 1) {
        method[field] = method[field][0]; unboxed += 1;
      }
    }
  }
  // The registry fields R's auto-unboxing turns into scalars: every one-element `endpoints` and `crossChecks` array of the domain's methods.
  const singletons = Object.values(VCR_ENGINE_METHODS).reduce((n, method) => n + (method.endpoints.length === 1 ? 1 : 0) + (method.crossChecks.length === 1 ? 1 : 0), 0);
  assert.ok(singletons > 0, 'the walk proves it walked');
  assert.equal(unboxed, singletons, 'The real R report unboxes these registry fields');
  const original = JSON.stringify(input.report);
  const evidence = generate(input);
  assert.equal(evidence.methods.length, Object.keys(input.source.methods).length);
  assert.equal(evidence.ci.reportSha256, hash(Buffer.from(original)));
  assert.equal(JSON.stringify(input.report), original, 'Raw immutable evidence is never rewritten');
  assert.deepEqual(input.source.methods['comparator.evalue'].crossChecks, ['EValue']);
  for (const mutate of [
    methods => { methods['patients.binary'].endpoints = 'time_to_event'; },
    methods => { methods['comparator.evalue'].version = 'unverified-version'; },
    methods => { methods['comparator.evalue'].unexpectedMetadata = true; },
  ]) {
    const changed = structuredClone(input.report.methods);
    mutate(changed);
    assert.throws(() => generate({ ...input, report: { ...input.report, methods: changed } }), /report_methods_mismatch/);
  }
});

test('structural unknown-method refusal attempts never qualify numerical evidence', async () => {
  const input = await fixture();
  input.report = structuredClone(input.report);
  input.report.methodsByCase.E10a = ['design.analytic', 'nope.nope'];
  const evidence = generate(input);
  assert.equal(evidence.methods.length, Object.keys(input.source.methods).length);
  assert.ok(!evidence.methods.some(method => method.method === 'nope.nope'));
  assert.ok(evidence.methods.every(method => !method.numericTests.caseIds.includes('E10a')));
  input.report.methodsByCase.N01b = ['design.analytic', 'nope.nope'];
  assert.throws(() => generate(input), /report_coverage_invalid/);
  input.report.methodsByCase.N01b = ['design.analytic'];
  input.report.methodsByCase.E10a = [42];
  assert.throws(() => generate(input), /report_coverage_invalid/);
});

test('failed, filtered, skipped, partial or source-mismatched machine reports cannot turn green', async () => {
  const changes = [
    report => { report.sourceRevision = 'b'.repeat(40); }, report => { report.complete = false; }, report => { report.testOnly = 'N01'; },
    report => { report.skippedCaseIds = ['N01b']; }, report => { report.rVersion = '4.4.0'; }, report => { report.packageLockHash = 'b'.repeat(64); },
    report => { report.numericalSourceDigest = 'b'.repeat(64); }, report => { report.cases.pop(); }, report => { report.cases[0].pass = false; },
    report => { report.cases[0].detail = 'skipped: missing R package'; }, report => { report.cases[1].id = report.cases[0].id; },
    report => { report.methods['design.analytic'].version = 'invented'; }, report => { report.green = true; },
    report => { report.methodsByCase.unexecuted = 'design.analytic'; }, report => { report.methodsByCase.N01b = 'invented'; },
    report => { report.methodsByCase.N01b = ['design.analytic', 'design.analytic']; },
  ];
  for (const change of changes) {
    const input = await fixture(); input.report = structuredClone(input.report); change(input.report);
    assert.throws(() => generate(input));
  }
  for (const patch of [{ ok: false }, { rVersion: '4.4.0' }, { numericalSourceDigest: 'b'.repeat(64) }, { packageLockHash: 'b'.repeat(64) }]) {
    const input = await fixture(); input.health = { ...input.health, ...patch };
    assert.throws(() => generate(input), /runtime_identity_mismatch/);
  }
});

test('the numerical log must independently show every unique case with no skip and its final complete summary', async () => {
  for (const update of [log => log.replace(/PASSED \d+\/\d+/, 'PASSED 1/1'), log => log.replace('N01b PASS', 'N01b FAIL'),
    log => log.replace('N01b PASS', 'unknown PASS'), log => log.replace('N01b PASS', 'N01 PASS'), log => log.replace(/N01b PASS[^\n]*\n/, ''),
    log => log.replace('numerical comparison passed', 'skipped: dependency absent'), log => `${log}process died\n`]) {
    const input = await fixture(); input.logBytes = Buffer.from(update(input.logBytes.toString()));
    assert.throws(() => generate(input), /numeric_log_incomplete/);
  }
});

test('missing source references and structural-only method coverage cannot fabricate a numeric claim', async () => {
  const input = await fixture();
  input.source = { ...input.source, caseFiles: input.source.caseFiles.map(file => ({ ...file, bytes: Buffer.from(file.bytes.toString().replace('d_rp < 1e-4 && d_g4 < 1e-4', 'a structural smoke check')) })) };
  assert.throws(() => generate(input), /numeric_reference_missing/);
  const structural = await fixture(); structural.report.methodsByCase = { E05: Object.keys(structural.source.methods) };
  assert.throws(() => generate(structural), /numeric_reference_missing/);
  const unmapped = await fixture(); unmapped.report.methodsByCase = { N01b: 'design.simulate' };
  assert.throws(() => generate(unmapped), /numeric_reference_missing/);
});

test('a dispatched method with no reference case fails the evidence and names itself; nothing is left "unmeasured" quietly', async () => {
  // the only case that holds matching.evaluate did not run its method: the evidence is refused, naming it
  const input = await fixture();
  input.report = structuredClone(input.report);
  delete input.report.methodsByCase.N29;
  assert.throws(() => generate(input), error => error.message === 'method_reference_missing' && JSON.stringify(error.methods) === JSON.stringify(['matching.evaluate']));
  // a method added to the registry (the domain snapshot, which the engine's start-up check holds equal to its handler table) has no
  // entry yet: the generator fails until it has a reference case, whatever the report says about the cases that did run
  const added = await fixture();
  added.source = { ...added.source, methods: { ...added.source.methods, 'comparator.added_later': structuredClone(added.source.methods['comparator.evalue']) } };
  added.report = structuredClone(added.report);
  added.report.methods = structuredClone(added.source.methods);
  assert.throws(() => generate(added), error => error.message === 'method_reference_missing' && JSON.stringify(error.methods) === JSON.stringify(['comparator.added_later']));
});

test('the real source: every method the engine dispatches has a reference case that is in the source, and every anchor is still in its case', async () => {
  const testedSource = await actualSource();
  const definitions = sourceCases(testedSource.caseFiles);
  const methods = Object.keys(testedSource.methods);
  assert.deepEqual(methodsWithoutReference(methods, definitions), []);
  assert.deepEqual(referenceProblems(methods, definitions), []);
  // the check is not vacuous: a registry with one method more fails it
  assert.deepEqual(methodsWithoutReference([...methods, 'comparator.added_later'], definitions), ['comparator.added_later']);
  assert.deepEqual([...new Set(referenceProblems(methods, new Map([['N29', { lines: ['an edited case'] }]])).map(problem => problem.caseId))], ['N29']);
});

test('GitHub success must belong to the same completed job, run, revision and immutable artifact', () => {
  const changes = [
    value => { value.run.head_sha = 'b'.repeat(40); }, value => { value.run.conclusion = 'failure'; }, value => { value.run.status = 'in_progress'; },
    value => { value.run.event = 'pull_request'; }, value => { value.run.path = '.github/workflows/other.yml'; }, value => { value.run.repository.full_name = 'other/repo'; },
    value => { value.job.run_id = 404; }, value => { value.job.head_sha = 'b'.repeat(40); }, value => { value.job.name = 'web'; },
    value => { value.job.conclusion = 'failure'; }, value => { value.job.completed_at = 'not a timestamp'; }, value => { value.job.steps[0].conclusion = 'skipped'; },
    value => { value.job.steps.pop(); }, value => { value.artifact.workflow_run.id = 404; }, value => { value.artifact.workflow_run.head_sha = 'b'.repeat(40); },
    value => { value.artifact.name = 'arbitrary-green-report'; }, value => { value.artifact.expired = true; }, value => { delete value.artifact.digest; },
  ];
  for (const change of changes) { const value = github(); change(value); assert.throws(() => verifyGitHubIdentity(value)); }
  assert.equal(verifyGitHubIdentity(github()).url, `${url}/job/${jobId}`);
});

test('the importer queries trusted GitHub endpoints and checks archive hash before reading any report', async () => {
  const input = await fixture();
  const metadata = github();
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'gh') {
      const suffix = args[1];
      if (suffix.endsWith('/zip')) return archive;
      if (suffix.endsWith(`/jobs/${jobId}`)) return Buffer.from(JSON.stringify(metadata.job));
      if (suffix.includes('/artifacts?')) return Buffer.from(JSON.stringify({ artifacts: [metadata.artifact] }));
      return Buffer.from(JSON.stringify(metadata.run));
    }
    if (args[0] === '-Z1') return Buffer.from('vcr-numerical-evidence.json\nvcr-numeric.log\nvcr-service.log\n');
    return args.at(-1) === 'vcr-numeric.log' ? input.logBytes : input.reportBytes;
  };
  const downloaded = await fetchGitHubEvidence(metadata, execute);
  assert.ok(downloaded.reportBytes.equals(input.reportBytes));
  assert.ok(calls.some(call => call[2] === `repos/${repository}/actions/jobs/${jobId}`));
  metadata.artifact.digest = `sha256:${'b'.repeat(64)}`;
  await assert.rejects(fetchGitHubEvidence(metadata, execute), /ci_archive_digest_mismatch/);
  assert.throws(() => parseArguments(['--success', 'true']), /argument_invalid/);
  assert.throws(() => parseArguments(['--repo', repository]), /argument_missing/);
});

test('runtime digest crosschecks the shipped Python implementation and excludes the test-only crosscheck lock', async () => {
  const input = await fixture();
  const withCrosscheck = [...input.source.runtimeFiles, { path: 'tests/package-lock.crosscheck.json', bytes: Buffer.from('test-only packages') }, { path: 'R/notes.txt', bytes: Buffer.from('notes') }];
  assert.equal(numericalSourceDigest(withCrosscheck), numericalSourceDigest(input.source.runtimeFiles));
  const script = 'import ast, hashlib, os, stat, sys, __future__\nfrom pathlib import Path\nsource = Path(sys.argv[1]).read_text()\ntree = ast.parse(source)\nselected = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("read_regular_file", "numerical_source_digest")]\nexec(compile(ast.Module(body=selected, type_ignores=[]), "shipped-health", "exec", flags=__future__.annotations.compiler_flag))\nprint(numerical_source_digest(Path(sys.argv[2])))\n';
  const observed = execFileSync('python3', ['-c', script, path.join(engine, 'service/app.py'), engine], { encoding: 'utf8' }).trim();
  assert.equal(numericalSourceDigest(input.source.runtimeFiles), observed);
  const runtimeChange = input.source.runtimeFiles.map(file => file.path === 'R/engine.R' ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from('\n# changed\n')]) } : file);
  assert.notEqual(numericalSourceDigest(runtimeChange), observed);
});

async function temporaryRoot() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-import-test-'))); }

test('source inspection binds exact tracked bytes and inventories and refuses symlinked code', async () => {
  const directory = await temporaryRoot();
  try {
    const input = await fixture();
    const fixtureEngine = path.join(directory, '项目代码/vcr-engine');
    await fs.mkdir(path.join(fixtureEngine, 'R'), { recursive: true });
    await fs.mkdir(path.join(fixtureEngine, 'tests/numeric'), { recursive: true });
    await fs.writeFile(path.join(fixtureEngine, 'R/engine.R'), '# unit test engine\n');
    await fs.writeFile(path.join(fixtureEngine, 'R/package-lock.json'), input.source.runtimeFiles.find(file => file.path === 'R/package-lock.json').bytes);
    await fs.writeFile(path.join(fixtureEngine, 'R/domain-snapshot.json'), JSON.stringify({ methods: input.source.methods }));
    await fs.writeFile(path.join(fixtureEngine, 'tests/numeric/N01.R'), 'vcr_case("N01", c("AC-30"), function() { list(pass = TRUE, detail = "1 = 1") })\n');
    const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test fixture']);
    const sha = git(['rev-parse', 'HEAD']).trim();
    assert.equal((await readValidationSource(directory, sha)).caseFiles.length, 1);
    await fs.appendFile(path.join(fixtureEngine, 'R/engine.R'), '# dirty\n');
    await assert.rejects(readValidationSource(directory, sha), /source_revision_mismatch/);
    await fs.writeFile(path.join(fixtureEngine, 'R/engine.R'), '# unit test engine\n');
    await fs.writeFile(path.join(fixtureEngine, 'R/extra.R'), '# untested runtime code\n');
    await assert.rejects(readValidationSource(directory, sha), /source_inventory_mismatch/);
    await fs.rm(path.join(fixtureEngine, 'R/extra.R'));
    await fs.rename(path.join(fixtureEngine, 'R/engine.R'), path.join(directory, 'outside.R'));
    await fs.symlink(path.join(directory, 'outside.R'), path.join(fixtureEngine, 'R/engine.R'));
    await assert.rejects(readValidationSource(directory, sha), /source_symlink_refused/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('staging uses an atomic regular 0644 file and refuses links, directories and non-root installs', async () => {
  const directory = await temporaryRoot();
  try {
    const evidence = generate(await fixture());
    const file = path.join(directory, 'evidence.json');
    const result = await writeMethodValidation(file, evidence);
    assert.equal(result.status, 'staged_untrusted');
    const stat = await fs.lstat(file);
    assert.equal(stat.mode & 0o777, 0o644); assert.equal(stat.nlink, 1);
    assert.equal(result.sha256, hash(await fs.readFile(file)));
    await fs.symlink(file, path.join(directory, 'link.json'));
    await assert.rejects(writeMethodValidation(path.join(directory, 'link.json'), evidence), /destination_file_untrusted/);
    await fs.link(file, path.join(directory, 'hard.json'));
    await assert.rejects(writeMethodValidation(path.join(directory, 'hard.json'), evidence), /destination_file_untrusted/);
    await fs.mkdir(path.join(directory, 'folder.json'));
    await assert.rejects(writeMethodValidation(path.join(directory, 'folder.json'), evidence), /destination_file_untrusted/);
    await fs.symlink(directory, path.join(directory, 'parent-link'));
    await assert.rejects(writeMethodValidation(path.join(directory, 'parent-link/evidence.json'), evidence));
    if (process.getuid?.() !== 0) await assert.rejects(writeMethodValidation(path.join(directory, 'install.json'), evidence, { install: true }), /installation_requires_root/);
    assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('.')), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('protected install policy rejects writable ancestors and non-root ownership', () => {
  const stat = { isDirectory: () => true, uid: 0, mode: 0o40755 };
  assert.doesNotThrow(() => assertProtectedDirectory(stat));
  for (const patch of [{ uid: 501 }, { mode: 0o40777 }, { mode: 0o40775 }, { isDirectory: () => false }]) {
    assert.throws(() => assertProtectedDirectory({ ...stat, ...patch }), /destination_directory_unprotected/);
  }
});
