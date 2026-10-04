import test from "node:test";
import assert from "node:assert/strict";
import * as domain from "../index.mjs";

const { SNAPSHOT_UNKNOWNS, projectResultVersion, snapshotGaps } = domain;
// A snapshot is deeply optional by design; a test reads it by the path it asserts, so its builders answer `any` here.
/** @param {Parameters<typeof domain.engineJobSnapshot>[0]} input @returns {any} */
const engineJobSnapshot = (input) => domain.engineJobSnapshot(input);
/** @param {Parameters<typeof domain.skillScriptSnapshot>[0]} input @returns {any} */
const skillScriptSnapshot = (input) => domain.skillScriptSnapshot(input);
/** @param {Parameters<typeof domain.authoredSnapshot>[0]} input @returns {any} */
const authoredSnapshot = (input) => domain.authoredSnapshot(input);
/** @param {Parameters<typeof domain.renderSnapshot>[0]} input @returns {any} */
const renderSnapshot = (input) => domain.renderSnapshot(input);
/** @param {unknown} input @returns {any} */
const projectProducerSnapshot = (input) => domain.projectProducerSnapshot(input);
/** @returns {any} */
const unobservedSnapshot = () => domain.unobservedSnapshot();
/** @param {Parameters<typeof domain.methodIdentityFromResult>[0]} input @returns {any} */
const methodIdentityFromResult = (input) => domain.methodIdentityFromResult(input);

/** @param {string} letter */
const HASH = (letter) => letter.repeat(64);

test("a version nobody observed says so, and names each thing it does not know", () => {
  const snapshot = unobservedSnapshot();
  assert.equal(snapshot.kind, "unobserved");
  assert.equal(snapshot.origin, "unknown");
  assert.equal(snapshot.recorded, false, "it is the default, not a record anyone wrote");
  assert.deepEqual(snapshot.unknown, [...SNAPSHOT_UNKNOWNS]);
  assert.equal(snapshot.script, null);
  assert.deepEqual(snapshotGaps(snapshot), ["dependencies_not_observed"]);
});

test("a deterministic engine job carries its method, code files, parameters, seed, environment facts and exact input versions", () => {
  const files = [{ path: "new_meta/engines/meta_engine.py", sha256: HASH("1"), bytes: 120 }, { path: "adapter/deterministic_replay.py", sha256: HASH("2"), bytes: 99 }];
  const snapshot = engineJobSnapshot({
    recipe: { method: "faers.signals", version: "1", parameters: { yates: false, correctZeroCells: true, seed: 7 }, codeDigest: HASH("c"), environmentDigest: HASH("e"),
      input: { path: "result-replays/job/input.json", sha256: HASH("d") } },
    capability: { codeFiles: files, environment: { python: "3.12.3", implementation: "CPython", platform: "linux", machine: "x86_64", packages: { numpy: "1.26.4", scipy: "1.13.0" } } },
    output: { result: { executedMethod: { tau_estimator: "DL", ci_method: "normal_wald" } }, methodRecord: { id: "validated.meta.dl", revision: 3 } },
    inputs: [{ kind: "data", id: `rv_${HASH("a")}`, versionId: `rv_${HASH("a")}`, digest: HASH("d"), availability: "captured" }],
  });
  assert.equal(snapshot.kind, "engine_job");
  assert.equal(snapshot.origin, "platform_measured");
  assert.deepEqual([snapshot.method.id, snapshot.method.version, snapshot.method.seed], ["faers.signals", "1", 7]);
  assert.deepEqual(snapshot.method.executed, { tau_estimator: "DL", ci_method: "normal_wald" }, "the engine's own executed-method block is read where it already is");
  assert.deepEqual(snapshot.method.record, { id: "validated.meta.dl", revision: 3 }, "the validated-method record, when a result carries one, is read in this one place");
  assert.equal(snapshot.script.digest, HASH("c"));
  assert.equal(snapshot.script.files.length, 2);
  assert.equal(snapshot.script.executed, true);
  assert.equal(snapshot.environment.status, "reported");
  assert.deepEqual(snapshot.environment.facts.packages, { numpy: "1.26.4", scipy: "1.13.0" });
  assert.equal(snapshot.environment.facts.interpreter, "Python 3.12.3");
  assert.equal(snapshot.inputs[0].digest, HASH("d"));
  assert.equal(snapshot.reproduction, "observed_execution");
  assert.deepEqual(snapshot.unknown, []);
  assert.deepEqual(snapshotGaps(snapshot), []);
});

test("the R engine's manifest becomes environment facts without inventing a package list", () => {
  const snapshot = engineJobSnapshot({ recipe: { method: "design.analytic", version: "1", parameters: { seed: 11, cpuSecondsLimit: 60 }, codeDigest: HASH("c"), environmentDigest: HASH("e") },
    capability: { engineMethodVersion: "3" }, output: { manifest: { engineVersion: "2.4.0", rVersion: "4.4.1", packageLockHash: HASH("f") } } });
  assert.equal(snapshot.method.engineVersion, "3");
  assert.equal(snapshot.method.seed, 11);
  assert.equal(snapshot.environment.facts.interpreter, "R 4.4.1");
  assert.equal(snapshot.environment.facts.lockDigest, HASH("f"));
  assert.equal(snapshot.environment.facts.packages, undefined);
});

test("no credential, command line or environment variable has a field to ride in", () => {
  const snapshot = projectProducerSnapshot({
    kind: "skill_script", origin: "receipt_declared", apiKey: "sk-live-secret", argv: ["python", "--token", "abc"], env: { OPENAI_API_KEY: "secret" },
    script: { path: "analysis.py", digest: HASH("a"), executed: true, verified: true, command: "curl -H 'Authorization: Bearer t'" },
    environment: { digest: HASH("b"), facts: { interpreter: "Python 3.12", token: "t", HOME: "/home/x", packages: { numpy: "1.26", "bad name": "1", pandas: "x".repeat(200) } } },
    method: { id: "native-python", parameters: { alpha: 0.05, note: "x".repeat(500), nested: { a: 1 }, flag: true } },
    process: { exitCode: 0, startedAt: "2026-10-04T10:00:00Z", endedAt: "2026-10-04T10:00:03Z", sourcesUnchanged: true, stdout: "secret" },
  });
  const serialized = JSON.stringify(snapshot);
  for (const leaked of ["sk-live-secret", "OPENAI_API_KEY", "--token", "Bearer", "/home/x", "secret", "x".repeat(100)]) assert.ok(!serialized.includes(leaked), leaked);
  assert.deepEqual(snapshot.environment.facts, { interpreter: "Python 3.12", packages: { numpy: "1.26" } });
  assert.deepEqual(snapshot.method.parameters, { alpha: 0.05, flag: true });
  assert.equal(snapshot.process.exitCode, 0);
});

test("generated reproduction code is never promoted to an observed execution", () => {
  const written = authoredSnapshot({ tool: "write", path: "reproduce.py" });
  assert.equal(written.kind, "authored");
  assert.equal(written.script.executed, false);
  assert.equal(written.reproduction, "generated_not_executed");
  assert.deepEqual(snapshotGaps(written), ["code_not_executed"]);
  assert.equal(authoredSnapshot({ tool: "write", path: "report.md" }).reproduction, "not_applicable");
  // A producer that is not an engine job or an admitted script cannot say code ran, whatever it claims.
  const claimed = projectProducerSnapshot({ kind: "authored", origin: "platform_measured", reproduction: "observed_execution",
    script: { path: "run.py", digest: HASH("a"), executed: true, verified: true } });
  assert.equal(claimed.script.executed, false);
  assert.equal(claimed.script.verified, false);
  assert.equal(claimed.reproduction, "generated_not_executed");
  const unknownOrigin = projectProducerSnapshot({ kind: "engine_job", origin: "unknown", script: { digest: HASH("a"), executed: true }, reproduction: "observed_execution" });
  assert.equal(unknownOrigin.script.executed, false, "a producer nobody vouches for does not become an execution");
  assert.notEqual(unknownOrigin.reproduction, "observed_execution");
});

test("an admitted skill script's receipt is recorded as declared, with its undeclared reads still unknown", () => {
  const ok = skillScriptSnapshot({ script: { path: "analysis.py", digest: HASH("a"), verified: true },
    inputs: [{ kind: "data", id: "data.csv", digest: HASH("b"), path: "data.csv", versionId: `rv_${HASH("b")}`, availability: "captured" }],
    environment: { facts: { interpreter: "3.12.3", packages: { pandas: "2.2.2" } } }, execution: { exitCode: 0, sourcesUnchanged: true }, interpreter: "python",
    transformations: [{ datasetId: "trial-a", name: "derive-age-band", version: 2, codeDigest: HASH("9") }] });
  assert.equal(ok.origin, "receipt_declared");
  assert.equal(ok.script.executed, true);
  assert.equal(ok.script.verified, true);
  assert.deepEqual(ok.transformations, [{ datasetId: "trial-a", name: "derive-age-band", version: 2, codeDigest: HASH("9") }], "N03's versioned transformation is named, not restated");
  assert.deepEqual(ok.unknown, ["undeclared_dependencies"], "what the process read beyond its declared inputs stays unknown");
  const failed = skillScriptSnapshot({ script: { path: "analysis.py", digest: HASH("a"), verified: false }, inputs: [], execution: { exitCode: 1 } });
  assert.equal(failed.script.executed, false);
  assert.equal(failed.reproduction, "generated_not_executed");
  assert.ok(failed.unknown.includes("inputs"));
  // The receipt says it ran, but the script on disk is no longer the bytes it names: declared, never observed.
  const edited = skillScriptSnapshot({ script: { path: "analysis.py", digest: HASH("a"), verified: false }, inputs: [], execution: { exitCode: 0, sourcesUnchanged: true } });
  assert.equal(edited.script.executed, false);
  assert.equal(edited.reproduction, "declared_execution");
  // Only an owned receipt may declare an execution.
  assert.equal(projectProducerSnapshot({ kind: "authored", origin: "platform_measured", script: { path: "a.py" }, reproduction: "declared_execution" }).reproduction, "generated_not_executed");
});

test("the rendering snapshot is the platform's own and the version projection always carries a snapshot", () => {
  const rendered = renderSnapshot({ inputs: [{ kind: "artifact", id: "t", versionId: `rv_${HASH("a")}`, digest: HASH("a"), availability: "captured" }], version: "1" });
  assert.equal(rendered.kind, "render");
  assert.deepEqual(rendered.method, { id: "number-binding", version: "1", engineVersion: null, executed: null, seed: null, parameters: null, record: null });
  const base = { artifactId: `ra_${HASH("a")}`, versionId: `rv_${HASH("b")}`, projectId: "p", path: "report.md", digest: HASH("c"), size: 3, coverage: { gaps: [] }, producer: { kind: "tool" } };
  const legacy = projectResultVersion(base);
  assert.equal(legacy.snapshot.recorded, false, "an old version is not retroactively given an execution record");
  assert.equal(legacy.bindings.status, "not_checked");
  assert.equal(projectResultVersion({ ...base, snapshot: rendered }).snapshot.kind, "render");
});

test("method identity reads what a result already carries and makes nothing up", () => {
  assert.equal(methodIdentityFromResult({}), null);
  const identity = methodIdentityFromResult({ recipe: { method: "meta.dl" } });
  assert.deepEqual([identity.id, identity.version, identity.seed, identity.record], ["meta.dl", null, null, null]);
});
