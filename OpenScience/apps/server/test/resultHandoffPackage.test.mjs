// The selected research package as a handoff (plan 2026-10-02 §5.6, §11.3 N16).
//
// What these tests are for: a recipient who has only the ZIP must be able to say what the result is, what it was made
// from and on, what was checked, what is missing and why, and — for a supported calculation — what numbers a rebuilt
// environment must give. Every case runs the package the real exporter produced through the verifier it ships, never a
// hand-written manifest, and the tampered copies are made from that same package: a changed byte, a missing file, an
// undeclared extra, a name that escapes the package, a dependency that stopped being accounted for, a completeness that
// no longer follows from the omissions. The last group is the boundary: nothing in a package is executed, a credential
// never rides in, and a record that cannot be read never refuses the package.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unzipSync, zipSync } from "fflate";
import { RESULT_PACKAGE_FILE_ROLES, engineJobSnapshot, RESULT_PACKAGE_FORMAT, RESULT_PACKAGE_OMISSION_REASONS, RESULT_PACKAGE_RECORD_FILES, compareResultNumbers, projectResultCorrection, reproductionRecord } from "@evimed/domain";
import { loadConfig } from "../src/config.mjs";
import { ResultExportService } from "../src/resultExport.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultReplayService, verifiedEngineFacts } from "../src/resultReplayService.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";
import { captureSkillResults, readSkillExecution } from "../src/skillExecution.mjs";
import { stableBytes } from "../src/resultDeliveryCapture.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const run = promisify(execFile);
const sha = value => createHash("sha256").update(value).digest("hex");
const OWNER = "owner";
const VERIFIER = new URL("../src/resultPackageVerify.py", import.meta.url).pathname;
const CODE_FILES = [{ path: "new_meta/engines/meta_engine.py", sha256: "1".repeat(64), bytes: 120 }, { path: "adapter/deterministic_replay.py", sha256: "2".repeat(64), bytes: 99 }];
const ENVIRONMENT = { python: "3.12.3", implementation: "CPython", platform: "linux", machine: "x86_64", packages: { numpy: "1.26.4", scipy: "1.13.0", pydantic: "2.7.1" } };
const values = effect => [
  { key: "values.pooled_effect", value: effect, unit: "odds_ratio", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 },
  { key: "values.ci_lower", value: 0.5201, unit: "odds_ratio", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 },
  { key: "values.i_squared", value: 41.234, unit: "percent", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 }];

/** The result stores on their in-memory documents, a replay engine that reports what it measured, and the exporter over them. */
async function fixture(t, { references = async (_actor, _project, reference) => reference, exporter = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: OWNER, rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const write = async (relative, text) => { await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(project.workspaceDir, relative), text); };
  const documents = productDocumentsDouble();
  let authorize = references;
  const results = new ResultProvenanceService({ documents, authorizeProject: async () => project, authorizeReference: (...args) => authorize(...args) });
  const queue = new Map();
  const jobs = {
    async enqueue(userId, kind, payload, { projectId }) {
      const job = { id: `job_${queue.size + 1}`, userId, kind, projectId, payload, status: "queued", leaseToken: `lease_${queue.size + 1}` };
      queue.set(job.id, job); return job;
    },
    get: async (_userId, id) => queue.get(id) ?? null,
    withLease: async (_userId, _id, _leaseToken, operation) => operation(null),
    renew: async () => true,
    async finishWithLease(_userId, id, _leaseToken, _result, operation) { await operation(null); queue.get(id).status = "succeeded"; },
  };
  const capability = { available: true, method: "meta.dl", version: "1", codeDigest: replayDigest(CODE_FILES), environmentDigest: replayDigest(ENVIRONMENT), codeFiles: CODE_FILES, environment: ENVIRONMENT };
  const replays = new ResultReplayService({ results, documents, jobs, engine: { configured: () => true, capabilities: async () => ({ methods: [capability] }), start: async () => ({ state: "running" }) } });
  const finish = async (job, effect) => {
    const prepared = await replays.prepare(job);
    await replays.start(job, prepared);
    const resultPath = `result-replays/${job.id}/output/result.json`;
    const body = JSON.stringify({ receipt: { recipeDigest: prepared.execution.recipeDigest, codeFiles: CODE_FILES, environment: ENVIRONMENT },
      result: { executedMethod: { tau_estimator: "DL", ci_method: "normal_wald" } }, machineValues: values(effect) });
    await write(resultPath, body);
    const answer = { jobId: job.id, recipeDigest: prepared.execution.recipeDigest, state: "succeeded", cleanup: "confirmed", resultPath,
      artifacts: [{ path: resultPath, sha256: sha(body), bytes: Buffer.byteLength(body) }], machineValues: values(effect) };
    return replays.complete(job, prepared, answer);
  };
  const calculate = async (effect, { input = { studies: [{ id: "a", effect: 0.4, variance: 0.04 }] } } = {}) => {
    await write("input.json", JSON.stringify(input));
    const calculation = await replays.calculate(OWNER, project, { method: "meta.dl", inputPath: "input.json", parameters: {} }, { kind: "engine", sessionId: "native-session", callId: `call-${queue.size + 1}` });
    return finish([...queue.values()].find(item => item.payload.replayId === calculation.id), effect);
  };
  const rerun = async (version, effect, requestId = "again") => {
    const replay = await replays.request(OWNER, version.versionId, { projectId: "p", digest: version.digest, requestId });
    return finish([...queue.values()].find(item => item.payload.replayId === replay.id), effect);
  };
  const corrections = { read: async () => ({ items: [] }) };
  const exportOf = (options = {}) => new ResultExportService({ results, replays, corrections, ...exporter, ...options });
  return { project, documents, results, replays, write, calculate, rerun, exportOf, corrections, setReferences: next => { authorize = next; } };
}

/** The ZIP's files, and the same files as a folder on disk (the way a recipient extracts it). */
async function extract(t, zipBytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-handoff-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = unzipSync(zipBytes);
  for (const [name, bytes] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); }
  return { root, files, manifest: JSON.parse(Buffer.from(files["manifest.json"]).toString()), json: name => JSON.parse(Buffer.from(files[name]).toString()) };
}

/** What the verifier says and how it exits, for a folder or a ZIP; an exit status other than 0 is a value here, not an exception. */
async function verify(target, ...args) {
  try { return { status: 0, report: JSON.parse((await run("python3", ["-I", VERIFIER, target, ...args])).stdout) }; }
  catch (error) { return { status: error.code, report: JSON.parse(error.stdout) }; }
}
const codes = outcome => outcome.report.problems.map(problem => problem.code);

test("an engine result's package carries its execution, verification and reproduction records, each with size and digest, and the verifier passes it", async t => {
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  await f.rerun(original, 0.7134);
  const reply = await f.exportOf().export(OWNER, "p", original.versionId);
  const pkg = await extract(t, reply.bytes);

  assert.equal(pkg.manifest.format, "evimed-research-result");
  assert.equal(pkg.manifest.version, 2);
  assert.deepEqual(pkg.manifest.records, { execution: "execution.json", verification: "verification.json", reproduction: "reproduction.json" });
  for (const file of pkg.manifest.files) {
    assert.equal(sha(pkg.files[file.archivePath]), file.sha256, file.archivePath);
    assert.equal(pkg.files[file.archivePath].length, file.bytes, file.archivePath);
  }
  assert.deepEqual(Object.keys(pkg.files).sort(), [...pkg.manifest.files.map(file => file.archivePath), "manifest.json"].sort(), "nothing is in the archive that the manifest does not list");
  assert.equal(pkg.manifest.files.find(file => file.role === "result").versionId, original.versionId);
  assert.ok(pkg.manifest.exclusions.some(item => item.kind === "patient_level_data") && pkg.manifest.exclusions.some(item => item.kind === "credentials"));

  // The script and environment snapshot, as the engine measured them.
  const [execution] = pkg.json("execution.json").versions;
  assert.equal(execution.snapshot.kind, "engine_job");
  assert.equal(execution.script.digest, replayDigest(CODE_FILES));
  assert.deepEqual(execution.script.files.map(file => file.path), CODE_FILES.map(file => file.path));
  assert.equal(execution.environment.facts.packages.numpy, "1.26.4");
  assert.equal(execution.method, null, "a result with no method record has none, and none is made up");
  assert.equal(execution.inputs[0].state, "included", "the input data is a file of the package");
  assert.ok(execution.inputs[0].archivePath.startsWith("results/rv_"));
  assert.equal(execution.code.state, "referenced");
  assert.equal(execution.code.reason, "bytes_not_captured", "the engine's code is identified by digest and not distributed");

  // What was checked: the re-run, its numbers under the original's tolerances, and the environment it ran on.
  const [record] = pkg.json("verification.json").versions;
  assert.equal(record.replays.status, "recorded");
  assert.equal(record.replays.items[0].state, "succeeded");
  assert.equal(record.replays.items[0].comparison.numbers.status, "identical");
  assert.equal(record.replays.items[0].comparison.environment.status, "same");
  assert.equal(record.replays.items[0].outputDigest.length, 64);
  assert.equal(record.corrections.status, "none_recorded", "no correction was recorded, and the record says so rather than staying silent");
  assert.equal(record.scientificApplicability, "not_assessed");

  // How a supported calculation is reconstructed.
  const [calculation] = pkg.json("reproduction.json").calculations;
  assert.equal(calculation.basis, "engine_recipe");
  assert.equal(calculation.status, "reconstructable");
  assert.equal(calculation.recipe.method, "meta.dl");
  assert.equal(calculation.recipe.codeDigest, replayDigest(CODE_FILES));
  assert.equal(calculation.inputs[0].digest, calculation.recipe.input.sha256);
  assert.ok(pkg.files[calculation.inputs[0].archivePath], "the recipe's input is in the package");
  assert.deepEqual(calculation.expected.values.map(item => item.key), values(0).map(item => item.key));
  assert.equal(calculation.expected.values[0].absoluteTolerance, 1e-10);

  // The declared completeness follows from the omissions: the engine's code and environment are identified, not shipped.
  assert.equal(pkg.manifest.completeness, "partial");
  assert.ok(pkg.manifest.omissions.every(item => item.requiredBy === original.versionId && ["code", "environment"].includes(item.role)));
  assert.ok(pkg.manifest.omissions.every(item => item.reason === "bytes_not_captured"));

  {
    const outcome = await verify(pkg.root);
    assert.equal(outcome.status, 0, JSON.stringify(outcome.report.problems));
    assert.equal(outcome.report.bytes, "identical");
    assert.equal(outcome.report.ok, true);
    assert.equal(outcome.report.completeness.consistent, true);
    assert.equal(outcome.report.executed, false);
    assert.equal(outcome.report.manifestSha256, sha(pkg.files["manifest.json"]));
    assert.equal(outcome.report.verifierSha256, sha(await readFile(VERIFIER)));
    assert.equal(outcome.report.dependencies.accounted, 3, "the input file and the two identities are all accounted for");
  }
  const zipPath = path.join(pkg.root, "..", `${path.basename(pkg.root)}.zip`);
  await writeFile(zipPath, reply.bytes); t.after(() => rm(zipPath, { force: true }));
  assert.equal((await verify(zipPath)).status, 0, "the ZIP itself is checked in place, without extracting it");
  assert.equal((await run("python3", ["-I", path.join(pkg.root, "verify.py"), pkg.root])).stdout.includes('"ok": true'), true, "the copy of the verifier in the package is the same one");
});

test("the numbers a recipient reproduced are compared under the original's tolerances, by the platform's own rule", async t => {
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  const pkg = await extract(t, (await f.exportOf().export(OWNER, "p", original.versionId)).bytes);
  const stated = values(0.7134);
  const attempt = async rows => {
    const file = path.join(pkg.root, "..", `${path.basename(pkg.root)}-numbers.json`);
    await writeFile(file, typeof rows === "string" ? rows : JSON.stringify(rows)); t.after(() => rm(file, { force: true }));
    return verify(pkg.root, "--compare", file);
  };
  const cases = {
    identical: stated,
    "within-tolerance": stated.map((item, index) => ({ ...item, value: index === 0 ? item.value + 5e-11 : item.value })),
    changed: stated.map((item, index) => ({ ...item, value: index === 0 ? item.value + 1e-6 : item.value })),
    missing: stated.slice(1),
    "incompatible-unit": stated.map((item, index) => ({ ...item, unit: index === 0 ? "percent" : item.unit })),
  };
  for (const [expected, rows] of Object.entries(cases)) {
    const outcome = await attempt(rows);
    // The same inputs through the platform's own comparison: the two agree on the verdict and on every value's status.
    const platform = compareResultNumbers(stated, rows.map(row => ({ key: row.key, value: row.value, unit: row.unit })));
    const wanted = expected === "missing" || expected === "incompatible-unit" ? "changed" : expected;
    assert.equal(outcome.report.compare.status, wanted, expected);
    assert.equal(outcome.report.compare.status, platform.status, `${expected}: the verifier follows compareResultNumbers`);
    assert.deepEqual(outcome.report.compare.values.map(item => item.status), platform.values.map(item => item.status));
    assert.equal(outcome.status, wanted === "changed" ? 3 : 0, expected);
    assert.equal(outcome.report.bytes, "identical");
    assert.equal(outcome.report.compare.toleranceSource, "frozen_original");
  }
  // A rerun cannot loosen the tolerance it is held to: the tolerance in the file it gives is not read.
  const loosened = await attempt(stated.map((item, index) => ({ ...item, value: index === 0 ? item.value + 1e-6 : item.value, absoluteTolerance: 1 })));
  assert.equal(loosened.report.compare.status, "changed");
  // The engine's own output file and a plain {key: number} map are both accepted shapes; NaN and a non-list are not.
  assert.equal((await attempt({ machineValues: stated })).report.compare.status, "identical");
  assert.equal((await attempt('[{"key":"values.pooled_effect","value":NaN}]')).status, 2);
  assert.equal((await attempt('"not rows"')).status, 2);
});

test("a changed byte, a missing file, an undeclared extra file and a name that escapes the package are each found, in a folder and in the ZIP", async t => {
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  const reply = await f.exportOf().export(OWNER, "p", original.versionId);
  const clean = unzipSync(reply.bytes);
  const resultFile = Object.keys(clean).find(name => name.startsWith(`results/${original.versionId}/`));
  const dependency = Object.keys(clean).find(name => name.startsWith("results/rv_") && !name.startsWith(`results/${original.versionId}/`));
  const manifestOf = files => JSON.parse(Buffer.from(files["manifest.json"]).toString());
  const rewrite = (files, change) => { const manifest = manifestOf(files); change(manifest); return { ...files, "manifest.json": Buffer.from(JSON.stringify(manifest)) }; };
  /** A record rewritten and the manifest re-sealed over it, the way someone who edits both would: the hashes agree, the contents must not. */
  const reseal = (files, name, change) => {
    const record = JSON.parse(Buffer.from(files[name]).toString()); change(record);
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    return rewrite({ ...files, [name]: bytes }, manifest => { Object.assign(manifest.files.find(file => file.archivePath === name), { bytes: bytes.length, sha256: sha(bytes) }); });
  };
  const cases = {
    "a record that cites a file under another digest": { files: reseal(clean, "execution.json", record => { record.versions[0].inputs[0].digest = "9".repeat(64); }), code: "record_digest_mismatch" },
    "a record that cites a file the package does not hold": { files: reseal(clean, "execution.json", record => { record.versions[0].inputs[0].archivePath = "results/rv_none/input.json"; }), code: "record_file_missing" },
    "a record about a version the package does not describe": { files: reseal(clean, "verification.json", record => { record.versions[0].versionId = `rv_${"8".repeat(64)}`; }), code: "record_version_unknown" },
    "expected numbers that are not the version's": { files: reseal(clean, "reproduction.json", record => { record.calculations[0].expected.values[0].value += 1; }), code: "expected_values_inconsistent" },
    "a changed byte": { files: { ...clean, [resultFile]: Buffer.from(Buffer.from(clean[resultFile]).toString().replace("receipt", "receipz")) }, code: "file_hash_mismatch", path: resultFile },
    "a changed size": { files: rewrite(clean, manifest => { manifest.files.find(file => file.archivePath === resultFile).bytes += 1; }), code: "file_size_mismatch", path: resultFile },
    "a missing file": { files: Object.fromEntries(Object.entries(clean).filter(([name]) => name !== dependency)), code: "file_missing", path: dependency },
    "an undeclared extra file": { files: { ...clean, "extra/notes.txt": Buffer.from("not listed") }, code: "file_undeclared", path: "extra/notes.txt" },
    "a name that escapes the package": { files: { ...clean, "../escape.txt": Buffer.from("outside") }, code: "file_unsafe_path", path: "../escape.txt", zipOnly: true },
    "a manifest path that escapes the package": {
      files: rewrite(clean, manifest => { manifest.files.push({ archivePath: "../outside/secret.txt", bytes: 4, sha256: sha("data"), role: "dependency", versionId: null, scan: "clean" }); }),
      code: "file_unsafe_path", path: "../outside/secret.txt" },
    "an absolute manifest path": {
      files: rewrite(clean, manifest => { manifest.files.push({ archivePath: "/etc/passwd", bytes: 4, sha256: sha("data"), role: "dependency", versionId: null, scan: "clean" }); }),
      code: "file_unsafe_path", path: "/etc/passwd" },
    "a version that no longer matches its file": { files: rewrite(clean, manifest => { manifest.versions[0].digest = "f".repeat(64); }), code: "version_digest_mismatch" },
    "a dependency that is no longer accounted for": { files: rewrite(clean, manifest => { manifest.omissions.pop(); }), code: "dependency_unaccounted" },
    "a completeness the omissions do not give": { files: rewrite(clean, manifest => { manifest.completeness = "captured"; }), code: "completeness_inconsistent" },
    "a selected version that is not in the package": { files: rewrite(clean, manifest => { manifest.selectedVersionId = `rv_${"9".repeat(64)}`; }), code: "selected_unlisted" },
    "no manifest": { files: Object.fromEntries(Object.entries(clean).filter(([name]) => name !== "manifest.json")), code: "manifest_missing" },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const archive = path.join(os.tmpdir(), `evimed-handoff-tamper-${process.pid}-${sha(name).slice(0, 8)}.zip`);
    await writeFile(archive, zipSync(tamper.files, { level: 0 })); t.after(() => rm(archive, { force: true }));
    const outcome = await verify(archive);
    assert.equal(outcome.status, 1, `${name}: ${JSON.stringify(outcome.report)}`);
    assert.ok(codes(outcome).includes(tamper.code), `${name}: expected ${tamper.code}, got ${codes(outcome)}`);
    assert.equal(outcome.report.ok, false);
    if (tamper.path) assert.ok(outcome.report.problems.some(problem => problem.code === tamper.code && problem.path === tamper.path), `${name} names the path`);
    if (["file_hash_mismatch", "file_size_mismatch", "file_missing"].includes(tamper.code)) assert.ok(outcome.report.failed.includes(tamper.path), `${name} is in failed`);
    if (["file_undeclared"].includes(tamper.code)) assert.deepEqual(outcome.report.undeclared, [tamper.path]);

    if (tamper.zipOnly) continue; // a folder cannot hold a name outside itself; the ZIP is where that is checked
    const folder = await mkdtemp(path.join(os.tmpdir(), "evimed-handoff-tamper-dir-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    for (const [file, bytes] of Object.entries(tamper.files)) { await mkdir(path.dirname(path.join(folder, file)), { recursive: true }); await writeFile(path.join(folder, file), bytes); }
    const inFolder = await verify(folder);
    assert.equal(inFolder.status, 1, `${name} (folder)`);
    assert.ok(codes(inFolder).includes(tamper.code), `${name} (folder): ${codes(inFolder)}`);
  }
});

test("a link in the package, a name that differs only by case and a file outside the listed set are not read through or accepted", async t => {
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  const pkg = await extract(t, (await f.exportOf().export(OWNER, "p", original.versionId)).bytes);
  const outside = path.join(pkg.root, "..", `${path.basename(pkg.root)}-outside.txt`);
  await writeFile(outside, "outside the package"); t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(pkg.root, "linked.txt"));
  await writeFile(path.join(pkg.root, "README.TXT"), "same name, different case");
  const outcome = await verify(pkg.root);
  assert.equal(outcome.status, 1);
  assert.ok(codes(outcome).includes("file_not_regular"), "a link is named, not followed");
  assert.ok(codes(outcome).includes("file_undeclared"));
  assert.ok(codes(outcome).includes("file_duplicate"), "two names that one case-insensitive extraction would merge");
});

test("nothing in a package is executed: a package that ships a json.py and a hashlib.py is not run by the verifier", async t => {
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  const pkg = await extract(t, (await f.exportOf().export(OWNER, "p", original.versionId)).bytes);
  const canary = path.join(pkg.root, "..", `${path.basename(pkg.root)}-ran`);
  for (const module of ["json", "hashlib", "zipfile", "re", "sitecustomize", "usercustomize"]) {
    await writeFile(path.join(pkg.root, `${module}.py`), `open(${JSON.stringify(canary)}, "w").write("ran")\n`);
  }
  await writeFile(path.join(pkg.root, "evil.pth"), `import os; open(${JSON.stringify(canary)}, "w").write("ran")\n`);
  // From inside the package, with and without -I, by the script's own path: no run, only the undeclared files named.
  for (const args of [["-I", path.join(pkg.root, "verify.py")], [path.join(pkg.root, "verify.py")]]) {
    await run("python3", args, { cwd: pkg.root }).then(() => assert.fail("undeclared files are not a pass"), error => {
      assert.equal(error.code, 1);
      assert.ok(JSON.parse(error.stdout).undeclared.includes("json.py"));
    });
    await assert.rejects(readFile(canary), { code: "ENOENT" }, "the shadowing module was never imported");
  }
  // The verifier's own source reads, never runs: a closed set of standard-library imports, no way to execute or fetch.
  const source = await readFile(VERIFIER, "utf8");
  const imported = [...source.matchAll(/^(?:import|from) ([a-z_0-9]+)/gm)].map(match => match[1]).sort();
  assert.deepEqual([...new Set(imported)], ["argparse", "hashlib", "json", "os", "re", "stat", "sys", "zipfile"]);
  for (const forbidden of ["subprocess", "importlib", "runpy", "exec(", "eval(", "__import__", "os.system", "popen", "socket", "urllib", "pickle", "marshal", "ctypes", "shutil"]) {
    assert.equal(source.includes(forbidden), false, `the verifier does not use ${forbidden}`);
  }
  assert.equal(/(?<![.\w])compile\(/.test(source), false, "no compile() of package text (re.compile of its own patterns is the only compile)");
  assert.equal(/open\([^)]*["'][wax+]/.test(source), false, "no file is opened for writing");
});

test("every kind of omission carries its reason, and a dependency is never silently missing", async t => {
  const f = await fixture(t, { references: async (_actor, _project, reference) => {
    if (reference.id === "10.1000/restricted") return { ...reference, path: null, availability: "restricted" };
    if (reference.id === "gone.csv") return { ...reference, path: null, availability: "deleted" };
    return reference;
  } });
  await f.write("report.md", "# Report\n\nThe pooled estimate is 0.71.\n");
  const kept = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "report.md",
    producer: { kind: "deliverable", runId: "run", sessionId: "session" }, expectedDigest: sha("# Report\n\nThe pooled estimate is 0.71.\n"),
    inputs: [{ kind: "source", id: "10.1000/cited", availability: "reference" },
      { kind: "source", id: "10.1000/restricted", digest: "a".repeat(64), availability: "captured", versionId: `rv_${"a".repeat(64)}` },
      { kind: "data", id: "gone.csv", digest: "b".repeat(64), availability: "captured", versionId: `rv_${"b".repeat(64)}` }] });
  const reply = await f.exportOf().export(OWNER, "p", kept.versionId);
  const reasons = Object.fromEntries(reply.manifest.omissions.map(item => [item.id, item.reason]));
  assert.deepEqual(reasons, { "10.1000/cited": "bytes_not_captured", "10.1000/restricted": "input_unavailable", "gone.csv": "input_deleted" });
  assert.equal(reply.manifest.completeness, "partial");
  const pkg = await extract(t, reply.bytes);
  const outcome = await verify(pkg.root);
  assert.equal(outcome.status, 0, JSON.stringify(outcome.report.problems));
  assert.equal(outcome.report.dependencies.omitted, 3);
  // The reference a recipient needs to fetch the cited work themselves is in the package: its identifier.
  assert.ok(pkg.manifest.omissions.some(item => item.id === "10.1000/cited" && item.kind === "source" && item.requiredBy === kept.versionId));
});

test("a dependency that would pass the package's allowance is an omission with its size, and only the selected result's own bytes can refuse the package", async t => {
  const f = await fixture(t);
  const big = Buffer.alloc(40 * 1024, "x");
  await f.write("data/big.csv", big);
  const dependency = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "data/big.csv", producer: { kind: "workspace", eventId: "big" }, expectedDigest: sha(big) });
  await f.write("report.md", "short report");
  const selected = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "report.md", producer: { kind: "deliverable", runId: "r", sessionId: "s" },
    expectedDigest: sha("short report"), inputs: [{ kind: "data", id: "big", versionId: dependency.versionId, digest: dependency.digest, availability: "captured" }] });
  const small = await f.exportOf({ maxBytes: 60 * 1024 }).export(OWNER, "p", selected.versionId);
  const omitted = small.manifest.omissions.find(item => item.id === "big");
  assert.deepEqual([omitted.reason, omitted.bytes, omitted.digest], ["over_package_limit", big.length, dependency.digest]);
  assert.equal((await verify((await extract(t, small.bytes)).root)).status, 0, "an omitted dependency does not fail the check; it is a declared omission");
  const wide = await f.exportOf({ maxBytes: 80 * 1024, maxFiles: 7 }).export(OWNER, "p", selected.versionId);
  assert.equal(wide.manifest.omissions.find(item => item.id === "big").reason, "over_package_limit", "the file allowance is the same kind of limit");
  await assert.rejects(f.exportOf({ maxBytes: 4 * 1024 }).export(OWNER, "p", selected.versionId), { code: "result_export_limit" });
  const roomy = await f.exportOf().export(OWNER, "p", selected.versionId);
  assert.equal(roomy.manifest.omissions.length, 0);
  assert.equal(roomy.manifest.completeness, "partial", "the selected result has coverage gaps of its own, and they are still declared");
});

test("a captured script that holds a credential-shaped string is left out as a named omission, and the string is nowhere in the package", async t => {
  const f = await fixture(t);
  // Built here, not written out, so this file is not itself a credential in the repository's scanner.
  const key = ["sk", "T".repeat(8) + "k3y" + "Q".repeat(16)].join("-");
  const url = ["postgres://analyst", ["hunter", "2hunter2"].join(""), "@db.internal/trials"].join(":").replace(":@", "@");
  const clean = 'import os\nTOKEN = os.environ["REPORT_TOKEN"]\nprint("pooled")\n';
  await f.write("analysis.py", `import requests\nAPI_KEY = "${key}"\nrequests.get("https://example.org")\n`);
  await f.write("tidy.py", clean);
  await f.write("results.json", JSON.stringify({ estimate: 1.25 }));
  await f.write("report.md", "A report.");
  const script = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "analysis.py", producer: { kind: "workspace", eventId: "s" } });
  const tidy = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "tidy.py", producer: { kind: "workspace", eventId: "t" } });
  await f.write("conn.txt", `${url}\n`);
  const conn = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "conn.txt", producer: { kind: "workspace", eventId: "c" } });
  const selected = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "report.md", producer: { kind: "deliverable", runId: "r", sessionId: "s" },
    expectedDigest: sha("A report."), inputs: [{ kind: "code", id: "analysis.py", versionId: script.versionId, digest: script.digest, availability: "captured" },
      { kind: "code", id: "tidy.py", versionId: tidy.versionId, digest: tidy.digest, availability: "captured" },
      { kind: "data", id: "conn.txt", versionId: conn.versionId, digest: conn.digest, availability: "captured" }] });
  const reply = await f.exportOf().export(OWNER, "p", selected.versionId);
  const everything = Object.values(unzipSync(reply.bytes)).map(bytes => Buffer.from(bytes).toString("latin1")).join("\n");
  assert.equal(everything.includes(key), false);
  assert.equal(everything.includes("hunter2hunter2"), false);
  const reasons = Object.fromEntries(reply.manifest.omissions.map(item => [item.id, item.reason]));
  assert.deepEqual(reasons, { "analysis.py": "credential_shaped_text", "conn.txt": "credential_shaped_text" });
  const tidyFile = reply.manifest.files.find(file => file.versionId === tidy.versionId);
  assert.equal(tidyFile.scan, "clean", "a script that reads its token from the environment holds no credential, and is checked and kept");
  assert.equal(reply.manifest.files.find(file => file.role === "result").scan, "clean");
  assert.equal(reply.manifest.versions.some(version => version.versionId === script.versionId), true, "the omitted version is still described: its identity, size and digest");
  const omitted = reply.manifest.omissions.find(item => item.id === "analysis.py");
  assert.deepEqual([omitted.digest, omitted.bytes], [script.digest, script.size]);
  assert.equal((await verify((await extract(t, reply.bytes)).root)).status, 0);
});

test("a skill script's package carries the script, the environment it ran on and its inputs, and says what it cannot promise", async t => {
  const f = await fixture(t);
  const script = Buffer.from("import pandas\nprint('analysis')\n");
  const data = Buffer.from("id,arm,outcome\n1,a,0.5\n2,b,0.7\n");
  const doc = Buffer.from(JSON.stringify({ schemaVersion: 1, analyses: [{ id: "primary", method: "ttest", estimate: 1.25, pValue: 0.034 }] }));
  const snap = (relative, bytes) => ({ path: relative, sha256: sha(bytes), size: bytes.length, mtimeNs: 1, ctimeNs: 1, inode: 1 });
  const receipt = { schemaVersion: 1, executions: [{ id: "e1", argv: ["/usr/bin/python3", "analysis.py", "--token", "must-not-be-kept"], script: snap("analysis.py", script),
    inputs: [snap("data/trial.csv", data)], transforms: [], startedAt: "2026-10-04T10:00:00.000000+00:00",
    versions: { interpreter: "3.12.3 (main)", libraries: { numpy: "1.26.4", pandas: "2.2.2" } }, exitCode: 0, endedAt: "2026-10-04T10:00:03.000000+00:00",
    output: { before: null, after: snap("deliverables/s1/results.json", doc), observation: "created", observedWrite: true }, sourcesUnchanged: true, warnings: [] }] };
  await f.write("analysis.py", script); await f.write("data/trial.csv", data); await f.write("deliverables/s1/results.json", doc);
  await f.write("deliverables/s1/run.json", JSON.stringify(receipt));
  const readBytes = (relative, limit) => stableBytes(f.project, relative, limit);
  const image = `sha256:${"7".repeat(64)}`;
  const captured = await captureSkillResults({ results: f.results, project: f.project, userId: OWNER, receiptPath: "deliverables/s1/run.json", resultsPath: "deliverables/s1/results.json",
    readBytes, producer: { sessionId: "s", runId: "r" }, runtimeImageId: async () => image });
  assert.equal(captured.status, "captured");
  assert.equal((await readSkillExecution({ results: f.results, project: f.project, userId: OWNER, receiptPath: "deliverables/s1/run.json", resultsPath: "deliverables/s1/results.json", readBytes })).status, "recorded");
  const reply = await f.exportOf().export(OWNER, "p", captured.version.versionId);
  const pkg = await extract(t, reply.bytes);
  const [execution] = pkg.json("execution.json").versions;
  assert.equal(execution.snapshot.kind, "skill_script");
  assert.equal(execution.snapshot.reproduction, "observed_execution");
  assert.equal(execution.script.path, "analysis.py");
  assert.equal(execution.script.file.state, "included");
  assert.equal(Buffer.from(pkg.files[execution.script.file.archivePath]).toString(), script.toString(), "the script's bytes are in the package");
  assert.equal(execution.environment.facts.imageId, image);
  assert.deepEqual(execution.environment.facts.packages, { numpy: "1.26.4", pandas: "2.2.2" });
  assert.equal(execution.inputs[0].state, "included");
  assert.ok(execution.snapshot.unknown.includes("undeclared_dependencies"));
  const [calculation] = pkg.json("reproduction.json").calculations;
  assert.equal(calculation.basis, "script_rerun");
  assert.equal(calculation.status, "partial", "a script's rerun is partial by its own account");
  assert.ok(calculation.reasons.includes("arguments_not_recorded") && calculation.reasons.includes("undeclared_dependencies_unknown"));
  assert.equal(calculation.requirements, "numpy==1.26.4\npandas==2.2.2\n");
  assert.equal(calculation.expected.values.find(item => item.key === "analyses[0].estimate").value, 1.25);
  assert.equal(calculation.expected.values[0].absoluteTolerance, null, "no tolerance was declared, so none is made up");
  const everything = JSON.stringify(pkg.manifest) + Object.values(pkg.files).map(bytes => Buffer.from(bytes).toString("latin1")).join("");
  assert.equal(everything.includes("must-not-be-kept"), false, "no command line or token is carried");
  assert.equal(everything.includes("/usr/bin/python3"), false);
  const same = path.join(pkg.root, "..", `${path.basename(pkg.root)}-same.json`);
  await writeFile(same, JSON.stringify([{ key: "analyses[0].estimate", value: 1.25 }])); t.after(() => rm(same, { force: true }));
  const outcome = await verify(pkg.root, "--compare", same);
  assert.equal(outcome.report.compare.status, "changed", "the other numbers were not given, so the comparison names them missing");
  assert.equal(outcome.report.compare.values.find(item => item.key === "analyses[0].estimate").status, "identical");
  assert.equal(outcome.report.compare.reproductionStatus, "partial");
});

test("a correction is carried as the pair of versions and what differs, never as the researcher's words, and an unreadable record never refuses the package", async t => {
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  const words = "Please swap the denominator for MY-OWN-WORDS";
  const correction = projectResultCorrection({ revisionId: `rr_${"c".repeat(64)}`, original: { versionId: original.versionId, digest: original.digest, path: original.path },
    successor: { versionId: `rv_${"d".repeat(64)}`, digest: "d".repeat(64), path: "revised.md" }, kind: "analytic",
    effects: { bytes: "changed", printedNumbers: "changed", machineValues: "changed", evidence: "identical", method: "identical" },
    anchor: { kind: "text", elementId: "p-2", selectedText: "the selected sentence" }, instruction: words, instructionDigest: sha(words) });
  const reader = { read: async () => ({ items: [{ id: "e1", occurredAt: "2026-10-04T09:00:00.000Z", role: "original", correction, outcome: { status: "settled", successorVersionId: correction.successor.versionId } }] }) };
  const pkg = await extract(t, (await f.exportOf({ corrections: reader }).export(OWNER, "p", original.versionId)).bytes);
  const [record] = pkg.json("verification.json").versions;
  assert.equal(record.corrections.status, "recorded");
  const [item] = record.corrections.items;
  assert.deepEqual([item.role, item.kind, item.original.versionId, item.successor.versionId], ["original", "analytic", original.versionId, correction.successor.versionId]);
  assert.equal(item.effects.printedNumbers, "changed");
  assert.equal(item.instructionDigest, sha(words));
  assert.equal(item.successorOrigin, "system_generated");
  assert.equal(item.adoption, "not_recorded");
  const everything = Object.values(pkg.files).map(bytes => Buffer.from(bytes).toString("utf8")).join("");
  assert.equal(everything.includes("MY-OWN-WORDS"), false, "the researcher's words are not exported");
  assert.equal(everything.includes("the selected sentence"), false);
  assert.ok(pkg.manifest.exclusions.some(entry => entry.kind === "researcher_instructions"));

  const broken = { listFor: async () => { throw Object.assign(new Error("db down"), { code: "product_unavailable" }); }, recipe: async () => { throw new Error("db down"); } };
  const refusing = { read: async () => { throw new Error("feedback ledger down"); } };
  const degraded = await extract(t, (await f.exportOf({ replays: broken, corrections: refusing }).export(OWNER, "p", original.versionId)).bytes);
  const [unread] = degraded.json("verification.json").versions;
  assert.deepEqual([unread.replays.status, unread.replays.reason], ["unavailable", "product_unavailable"]);
  assert.deepEqual([unread.corrections.status, unread.corrections.reason], ["unavailable", "read_failed"]);
  assert.equal(degraded.json("reproduction.json").calculations.length, 0, "with no recipe the engine basis is not claimed");
  assert.equal((await verify(degraded.root)).status, 0, "the package stands; the labels say what could not be read");
  const bare = await extract(t, (await new ResultExportService({ results: f.results }).export(OWNER, "p", original.versionId)).bytes);
  assert.equal(bare.json("verification.json").versions[0].replays.reason, "not_configured");
  assert.equal((await verify(bare.root)).status, 0);
});

test("a hostile snapshot cannot put an environment variable, a command line or a token into the package", async t => {
  const f = await fixture(t);
  await f.write("out.json", JSON.stringify({ estimate: 2 }));
  const version = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "out.json", producer: { kind: "engine", sessionId: "s", callId: "c" },
    machineValues: [{ key: "estimate", value: 2, unit: "ratio" }],
    snapshot: { kind: "engine_job", origin: "platform_measured", method: { id: "meta.dl", version: "1" }, argv: ["--token", "TOKEN-IN-ARGV"], env: { API_TOKEN: "TOKEN-IN-ENV" },
      script: { name: "meta.dl", digest: "c".repeat(64), executed: true, verified: true, command: "curl -H TOKEN-IN-COMMAND" },
      environment: { digest: "e".repeat(64), facts: { interpreter: "Python 3.12", env: { SECRET: "TOKEN-IN-FACTS" }, packages: { numpy: "1.26.4", "bad name": "1" } } }, reproduction: "observed_execution" } });
  const pkg = await extract(t, (await f.exportOf().export(OWNER, "p", version.versionId)).bytes);
  const everything = JSON.stringify(pkg.manifest) + Object.values(pkg.files).map(bytes => Buffer.from(bytes).toString("utf8")).join("");
  for (const secret of ["TOKEN-IN-ARGV", "TOKEN-IN-ENV", "TOKEN-IN-COMMAND", "TOKEN-IN-FACTS", "bad name"]) assert.equal(everything.includes(secret), false, secret);
  assert.deepEqual(pkg.json("execution.json").versions[0].environment.facts.packages, { numpy: "1.26.4" });
  // Nothing the package names grants anything: it holds identities and digests, no token, URL or access.
  assert.equal(/https?:\/\//.test(everything.replace(/https:\/\/doi\.org\/[^\s"]*/g, "")), false);
  assert.equal((await readdir(f.project.workspaceDir)).includes("connection-secret.txt"), false);
});

test("the verifier's report is stable across a folder and its ZIP, and its exit statuses mean what its header says", async t => {
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  const reply = await f.exportOf().export(OWNER, "p", original.versionId);
  const pkg = await extract(t, reply.bytes);
  const zipPath = path.join(pkg.root, "..", `${path.basename(pkg.root)}-same.zip`);
  await writeFile(zipPath, reply.bytes); t.after(() => rm(zipPath, { force: true }));
  const [folder, archive] = [await verify(pkg.root), await verify(zipPath)];
  assert.deepEqual(folder.report, archive.report, "the same package says the same thing however it is held");
  assert.equal((await verify(path.join(pkg.root, "missing-folder.zip"))).status, 2, "something that is not a package at all is not readable, not failed");
  const notZip = path.join(pkg.root, "..", `${path.basename(pkg.root)}-not.zip`);
  await writeFile(notZip, "not a zip"); t.after(() => rm(notZip, { force: true }));
  assert.equal((await verify(notZip)).status, 2);
  // A package from before the records existed (format version 1) still has its files and versions checked, and says that is all.
  const v1 = { ...unzipSync(reply.bytes) };
  const manifestV1 = JSON.parse(Buffer.from(v1["manifest.json"]).toString());
  manifestV1.version = 1; manifestV1.omissions = []; delete manifestV1.records; delete manifestV1.coverageGaps; manifestV1.completeness = "partial";
  v1["manifest.json"] = Buffer.from(JSON.stringify(manifestV1));
  for (const name of ["execution.json", "verification.json", "reproduction.json"]) { manifestV1.files = manifestV1.files.filter(file => file.archivePath !== name); delete v1[name]; }
  v1["manifest.json"] = Buffer.from(JSON.stringify(manifestV1));
  const olderDir = await mkdtemp(path.join(os.tmpdir(), "evimed-handoff-older-"));
  t.after(() => rm(olderDir, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(v1)) { await mkdir(path.dirname(path.join(olderDir, name)), { recursive: true }); await writeFile(path.join(olderDir, name), bytes); }
  const older = await verify(olderDir);
  assert.equal(older.status, 0, JSON.stringify(older.report.problems));
  assert.deepEqual(older.report.warnings.map(item => item.code), ["older_package_format"]);
  const unrelated = await mkdtemp(path.join(os.tmpdir(), "evimed-handoff-unrelated-"));
  t.after(() => rm(unrelated, { recursive: true, force: true }));
  await writeFile(path.join(unrelated, "manifest.json"), JSON.stringify({ format: "something-else" }));
  const other = await verify(unrelated);
  assert.equal(other.status, 1);
  assert.ok(codes(other).includes("format_unknown"));
});

test("the verifier and the exporter name the same format, records and omission reasons", async t => {
  const source = await readFile(VERIFIER, "utf8");
  const reasons = [...source.match(/KNOWN_REASONS = \{([^}]*)\}/s)[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(reasons, [...RESULT_PACKAGE_OMISSION_REASONS].sort(), "a reason the exporter can write is a reason the verifier knows");
  assert.ok(source.includes(`FORMAT = "${RESULT_PACKAGE_FORMAT}"`));
  for (const key of Object.keys(RESULT_PACKAGE_RECORD_FILES)) assert.ok(source.includes(`"${key}"`), `the verifier reads the ${key} record`);
  const f = await fixture(t);
  const original = await f.calculate(0.7134);
  const { manifest } = await f.exportOf().export(OWNER, "p", original.versionId);
  assert.ok(manifest.files.every(file => RESULT_PACKAGE_FILE_ROLES.includes(file.role)));
  assert.ok(manifest.omissions.every(item => RESULT_PACKAGE_OMISSION_REASONS.includes(item.reason)));
  assert.equal(manifest.format, RESULT_PACKAGE_FORMAT);
  const clean = await verify((await extract(t, (await f.exportOf().export(OWNER, "p", original.versionId)).bytes)).root);
  assert.deepEqual(clean.report.warnings, [], "a package the exporter wrote has nothing the verifier merely tolerates");
});

test("the engine variables a reproduction names are the ones the adapter reads", async () => {
  const adapter = await readFile(new URL("../../../deploy/specialist-adapter/evimed_specialist_adapter/deterministic_replay.py", import.meta.url), "utf8");
  const table = Object.fromEntries([...adapter.matchAll(/"([a-z.]+)": \{\s*"environment": "([A-Z_]+)"/g)].map(match => [match[1], match[2]]));
  assert.deepEqual(Object.keys(table).sort(), ["bibliometric.network", "faers.signals", "meta.dl"], "the adapter's table was not read; the pattern is wrong");
  for (const [method, variable] of Object.entries(table)) {
    const record = domainReproduction(method);
    assert.equal(record.engineRootVariable, variable, method);
    assert.equal(record.engineSource, "deploy/specialist-adapter/evimed_specialist_adapter/deterministic_replay.py");
  }
  assert.equal(domainReproduction("design.analytic").invocation, null, "the R engine is a service, and no command is made up for it");
});

/** @param {string} method */
function domainReproduction(method) {
  return reproductionRecord({ versionId: `rv_${"a".repeat(64)}`, digest: "1".repeat(64), size: 1, path: "r.json", inputs: [], machineValues: [{ key: "k", value: 1 }], snapshot: {} },
    { recipe: { recipe: { method, input: { sha256: "2".repeat(64) } } }, archivePathFor: () => null });
}

// The documented way to reproduce, followed to the end with the real engine: the recipe and the input are taken out of the
// package, the adapter's own command is run on them, and the numbers it writes are held to the original's tolerances by
// the shipped verifier. Needs the Python engines (numpy, scipy, pydantic and 项目代码/meta); skipped where they are not
// installed unless OPEN_SCIENCE_TEST_RESULT_ENGINES=1 says this job must have them.
const ADAPTER = new URL("../../../deploy/specialist-adapter", import.meta.url).pathname;
const META_ROOT = fileURLToPath(new URL("../../../../项目代码/meta", import.meta.url));
const enginesRequired = process.env.OPEN_SCIENCE_TEST_RESULT_ENGINES === "1";
const enginesPresent = existsSync(path.join(META_ROOT, "new_meta")) && spawnSync("python3", ["-c", "import numpy, scipy, pydantic"]).status === 0;

test("a recipient reproduces an engine result from the package alone, and an engine that is not the recorded one says so", { skip: !enginesRequired && !enginesPresent ? "the Python engines are not installed" : false }, async t => {
  const environment = { ...process.env, PYTHONPATH: ADAPTER, EVIMED_REPLAY_META_ROOT: META_ROOT };
  const adapter = (args, options = {}) => run("python3", ["-m", "evimed_specialist_adapter.deterministic_replay", ...args], { env: environment, ...options });
  const measured = JSON.parse((await run("python3", ["-c", "import json; from evimed_specialist_adapter import deterministic_replay as r; print(json.dumps(r.manifest('meta.dl')))"], { env: environment })).stdout);
  const f = await fixture(t);
  const input = Buffer.from(JSON.stringify({ studies: [0, 1, 3].map((effect, index) => ({ id: String(index), label: String(index), yi: effect, vi: 0.1 })), effectMeasure: "MD", outcome: "outcome" }));
  const recipe = { method: "meta.dl", version: "1", input: { path: "result-replays/job_1/input.json", sha256: sha(input) }, parameters: {},
    codeDigest: measured.codeDigest, environmentDigest: measured.environmentDigest };
  const work = await mkdtemp(path.join(os.tmpdir(), "evimed-handoff-engine-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(path.join(work, "recipe.json"), JSON.stringify(recipe)); await writeFile(path.join(work, "input.json"), input);
  await adapter(["--recipe", path.join(work, "recipe.json"), "--input", path.join(work, "input.json"), "--output", path.join(work, "original.json")]);
  const produced = await readFile(path.join(work, "original.json"));
  const output = JSON.parse(produced.toString());

  // The platform's own capture of that run: the input and the engine's output, bound to the recipe the engine was given.
  await f.write(recipe.input.path, input); await f.write("result-replays/job_1/output/result.json", produced);
  const inputVersion = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: recipe.input.path, expectedDigest: sha(input),
    producer: { kind: "tool", sessionId: "s", callId: "c", eventId: "input:c" } });
  const inputs = [{ kind: "data", id: inputVersion.versionId, versionId: inputVersion.versionId, digest: inputVersion.digest, availability: "captured" }];
  const facts = verifiedEngineFacts(recipe, { codeFiles: measured.codeFiles, environment: measured.environment }, output);
  const original = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "result-replays/job_1/output/result.json", expectedDigest: sha(produced),
    producer: { kind: "engine", sessionId: "s", callId: "job_1", eventId: "job_1" }, inputs, machineValues: output.machineValues,
    snapshot: engineJobSnapshot({ recipe, capability: facts.capability, output: facts.output, inputs }),
    code: { kind: "code", id: "meta.dl", digest: recipe.codeDigest, availability: "reference" }, environment: { kind: "code", id: "engine-environment", digest: recipe.environmentDigest, availability: "reference" } });
  await f.replays.admit(OWNER, { projectId: "p", versionId: original.versionId, inputVersionId: inputVersion.versionId, recipe, machineValues: output.machineValues,
    receipt: { recipeDigest: replayDigest(recipe), outputDigest: original.digest } });
  assert.equal(output.receipt.recipeDigest, replayDigest(recipe), "the JavaScript and Python canonical forms of a recipe agree");

  const pkg = await extract(t, (await f.exportOf().export(OWNER, "p", original.versionId)).bytes);
  const [calculation] = pkg.json("reproduction.json").calculations;
  assert.equal(calculation.status, "reconstructable");
  assert.deepEqual(calculation.environment.packages, measured.environment.packages, "the packages to install are the ones the engine measured");
  assert.deepEqual(calculation.executionFiles.map(file => file.sha256), measured.codeFiles.map(file => file.sha256));
  assert.equal(calculation.engineRootVariable, "EVIMED_REPLAY_META_ROOT");

  // The recipient: the recipe and the input out of the package, the adapter's command, the shipped verifier.
  const recipient = await mkdtemp(path.join(os.tmpdir(), "evimed-handoff-recipient-"));
  t.after(() => rm(recipient, { recursive: true, force: true }));
  await writeFile(path.join(recipient, "recipe.json"), JSON.stringify(calculation.recipe));
  await writeFile(path.join(recipient, "the-input.json"), pkg.files[calculation.inputs[0].archivePath]);
  await adapter(["--recipe", path.join(recipient, "recipe.json"), "--input", path.join(recipient, "the-input.json"), "--output", path.join(recipient, "numbers.json")]);
  const outcome = await verify(pkg.root, "--compare", path.join(recipient, "numbers.json"));
  assert.equal(outcome.status, 0, JSON.stringify(outcome.report.compare));
  assert.equal(outcome.report.compare.status, "identical");
  assert.equal(outcome.report.compare.reproductionStatus, "reconstructable");
  assert.ok(outcome.report.compare.values.length > 20, "every machine value of the result was compared");

  // An engine that is not the recorded one refuses the recipe under its own name; that refusal is the answer.
  await writeFile(path.join(recipient, "other.json"), JSON.stringify({ ...calculation.recipe, codeDigest: "a".repeat(64) }));
  await assert.rejects(adapter(["--recipe", path.join(recipient, "other.json"), "--input", path.join(recipient, "the-input.json"), "--output", path.join(recipient, "refused.json")]),
    error => error.code === 1 && /replay_code_changed/.test(error.stderr));
  // A numerical difference beyond the original's tolerance is reported, not forgiven.
  const drifted = JSON.parse(await readFile(path.join(recipient, "numbers.json"), "utf8"));
  drifted.machineValues[0].value += 1e-3;
  await writeFile(path.join(recipient, "drifted.json"), JSON.stringify(drifted));
  const different = await verify(pkg.root, "--compare", path.join(recipient, "drifted.json"));
  assert.equal(different.status, 3);
  assert.equal(different.report.compare.status, "changed");
});

test("the package's file allowance is a lever whose compose fallback is the code's own default and which .env.example names", async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const config = loadConfig({ rootDir: repoRoot });
  assert.equal(config.resultExportMaxFiles, 96);
  assert.equal(loadConfig({ rootDir: repoRoot, resultExportMaxFiles: 3 }).resultExportMaxFiles, 8, "a floor: the package's own fixed files have to fit");
  assert.equal(loadConfig({ rootDir: repoRoot, resultExportMaxFiles: 100000 }).resultExportMaxFiles, 512);
  assert.equal(loadConfig({ rootDir: repoRoot, resultExportMaxFiles: "not a number" }).resultExportMaxFiles, 96);
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.match(compose, new RegExp(`^ +OPEN_SCIENCE_RESULT_EXPORT_MAX_FILES: \\$\\{OPEN_SCIENCE_RESULT_EXPORT_MAX_FILES:-${config.resultExportMaxFiles}\\}$`, "m"),
    "a compose fallback that differed from the code's default would override it");
  assert.match(await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8"), new RegExp(`^OPEN_SCIENCE_RESULT_EXPORT_MAX_FILES=${config.resultExportMaxFiles}$`, "m"));
});
