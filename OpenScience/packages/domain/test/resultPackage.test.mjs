import test from "node:test";
import assert from "node:assert/strict";
import * as domain from "../index.mjs";

const {
  RESULT_PACKAGE_EXCLUSIONS, RESULT_PACKAGE_OMISSION_REASONS, credentialShapedText, omissionReason, packageCompleteness, packageCredentialScan,
  pinnedRequirements,
} = domain;
/** The builders take a projected version; a test reads what they return by the path it asserts. @param {any} version @param {any} accounting @returns {any} */
const executionRecord = (version, accounting) => domain.executionRecord(version, accounting);
/** @param {any} version @param {any} basis @returns {any} */
const reproductionRecord = (version, basis) => domain.reproductionRecord(version, basis);
/** @param {any} version @param {any} read @returns {any} */
const verificationRecord = (version, read) => domain.verificationRecord(version, read);

const hex = (/** @type {string} */ letter) => letter.repeat(64);
const VERSION = `rv_${hex("a")}`;
const DATA = `rv_${hex("b")}`;
/** A credential, built here so that this file is not one in the repository's own scanner. */
const providerKey = ["sk", `${"Z".repeat(10)}k3y${"Q".repeat(14)}`].join("-");

test("text in the shape of a credential is found, and text that only talks about one is not", () => {
  for (const text of [
    `API_KEY = "${providerKey}"`,
    `headers = {"Authorization": "${["Bearer", "e".repeat(30)].join(" ")}"}\nkey=${providerKey}`,
    ["-----BEGIN RSA", "PRIVATE KEY-----\nMIIE"].join(" "),
    ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
    ["ghp", "A".repeat(30)].join("_"),
    ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijk123456"].join("."),
    ["postgres://analyst", "gk39dnbq2@db.internal/trials"].join(":"),
    `password: "${"correct-horse-battery"}"`,
    `{"secret": "${"n0t-a-real-one-but-long"}"}`,
  ]) assert.equal(credentialShapedText(text), true, text.slice(0, 24));
  for (const text of [
    'token = os.environ["REPORT_TOKEN"]',
    "The password policy requires twelve characters; the token is rotated nightly.",
    'password = "changeme"',
    'api_key = "your-key-goes-here-123"',
    'password = "****************"',
    "risk-adjusted-outcome-measurement-model-v2 was fitted",
    "https://example.org/docs and postgres://db.internal/trials with no user",
    "The estimate was 1.25 (95% CI 0.8 to 1.9) in 238 participants.",
    "",
  ]) assert.equal(credentialShapedText(text), false, text.slice(0, 24));
  assert.equal(credentialShapedText(/** @type {any} */ (null)), false);
});

test("a binary or oversized object is not read and says so; only a read object is clean", () => {
  const scan = (/** @type {string} */ path, /** @type {string} */ mimeType, /** @type {Uint8Array} */ bytes) => packageCredentialScan({ path, mimeType, bytes });
  const secret = new TextEncoder().encode(`key = "${providerKey}"`);
  assert.equal(scan("run.py", "text/x-python", secret), "credential_shaped");
  assert.equal(scan("tables/out.csv", "text/csv", new TextEncoder().encode("a,b\n1,2\n")), "clean");
  assert.equal(scan("deliverables/report.json", "application/json", secret), "credential_shaped");
  assert.equal(scan("notes", "application/octet-stream", new TextEncoder().encode("a,b")), "not_text", "no extension and no text type: not read, and not called clean");
  assert.equal(scan("paper.pdf", "application/pdf", secret), "not_text");
  assert.equal(scan("figure.svg", "application/octet-stream", secret), "credential_shaped", "a known text extension is read whatever the type says");
  assert.equal(scan("big.csv", "text/csv", new Uint8Array(domain.RESULT_PACKAGE_SCAN_LIMIT_BYTES + 1)), "too_large");
});

test("the reason a dependency is missing follows what the ledger said, and completeness follows the omissions", () => {
  assert.equal(omissionReason({ availability: "deleted" }), "input_deleted");
  assert.equal(omissionReason({ availability: "restricted" }), "input_unavailable");
  assert.equal(omissionReason({ status: 403, code: "result_input_restricted" }), "input_unavailable");
  assert.equal(omissionReason({ status: 404, code: "result_version_unavailable" }), "input_unavailable");
  assert.equal(omissionReason({ status: 404, code: "result_snapshot_unavailable" }), "preserved_bytes_unreadable");
  assert.equal(omissionReason({ status: 409, code: "result_snapshot_changed" }), "preserved_bytes_unreadable");
  assert.equal(omissionReason({ availability: "reference" }), "bytes_not_captured");
  assert.equal(omissionReason(), "bytes_not_captured", "an unknown is the weakest claim, not an invented cause");
  for (const reason of ["input_deleted", "input_unavailable", "preserved_bytes_unreadable", "bytes_not_captured"]) assert.ok(RESULT_PACKAGE_OMISSION_REASONS.includes(reason));
  assert.equal(packageCompleteness({ omissions: [], gaps: [] }), "captured");
  assert.equal(packageCompleteness({ omissions: [{}], gaps: [] }), "partial");
  assert.equal(packageCompleteness({ omissions: [], gaps: ["code_not_captured"] }), "partial");
  assert.deepEqual(RESULT_PACKAGE_EXCLUSIONS.map(item => item.kind).slice(0, 2), ["credentials", "patient_level_data"]);
  assert.ok(Object.isFrozen(RESULT_PACKAGE_EXCLUSIONS) && Object.isFrozen(RESULT_PACKAGE_EXCLUSIONS[0]));
});

const calculation = (/** @type {Record<string, any>} */ extra = {}) => ({
  versionId: VERSION, digest: hex("1"), size: 90, path: "result.json", producer: { kind: "engine" },
  inputs: [{ kind: "data", id: DATA, versionId: DATA, digest: hex("2"), path: null, availability: "captured" }],
  code: { kind: "code", id: "meta.dl", versionId: null, digest: hex("c"), availability: "reference" },
  environment: { kind: "code", id: "engine-environment", versionId: null, digest: hex("e"), availability: "reference" },
  method: null, findings: [], review: { status: "unknown" }, coverage: { gaps: [] },
  machineValues: [{ key: "values.effect", value: 0.7, unit: "odds_ratio", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 }],
  snapshot: { kind: "engine_job", origin: "platform_measured", reproduction: "observed_execution", unknown: [], recorded: true,
    method: { id: "meta.dl", version: "1" }, script: { path: null, digest: hex("c"), files: [{ path: "engine.py", sha256: hex("3"), bytes: 9 }], executed: true, verified: true },
    environment: { status: "reported", digest: hex("e"), facts: { interpreter: "Python 3.12.3", packages: { numpy: "1.26.4" } } }, transformations: [], process: null },
  ...extra,
});
const accounting = (/** @type {Record<string, string>} */ files = {}, /** @type {string} */ reason = "bytes_not_captured") => ({ archivePathFor: (/** @type {string} */ id) => files[id] ?? null, reasonFor: () => reason });

test("an execution record says what ran and on what, and each input is a file or a named reference", () => {
  const record = executionRecord(calculation(), accounting({ [DATA]: `results/${DATA}/input.json` }));
  assert.deepEqual([record.snapshot.kind, record.snapshot.reproduction], ["engine_job", "observed_execution"]);
  assert.deepEqual(record.script.files, [{ path: "engine.py", sha256: hex("3"), bytes: 9 }]);
  assert.deepEqual([record.inputs[0].state, record.inputs[0].archivePath, record.inputs[0].reason], ["included", `results/${DATA}/input.json`, null]);
  assert.deepEqual([record.code.state, record.code.reason], ["referenced", "bytes_not_captured"]);
  assert.deepEqual([record.environment.status, record.environment.facts.packages], ["reported", { numpy: "1.26.4" }]);
  // A result nothing is known about says so, and keeps no field a producer could have filled with a secret.
  const bare = executionRecord({ versionId: VERSION, digest: hex("1"), size: 1, path: "a.md", inputs: [], code: null, environment: null, snapshot: undefined }, accounting());
  assert.deepEqual([bare.snapshot.kind, bare.snapshot.origin, bare.environment.status, bare.code, bare.script, bare.inputs], ["unobserved", "unknown", "unknown", null, null, []]);
  assert.equal(Object.keys(record).some(key => /^(?:env|argv|command|token|secret)$/i.test(key)), false);
});

test("a verification record never lets a check that was not run read as a check that passed", () => {
  const record = verificationRecord(calculation({ findings: [{ id: "f", kind: "claim", status: "quote_not_found", message: "x".repeat(900), elementId: "c1", sourceRefs: [{ id: "doi" }] }] }), {});
  assert.equal(record.replays.status, "unavailable");
  assert.equal(record.corrections.reason, "not_read");
  assert.equal(record.findings[0].message.length, 600);
  assert.equal("sourceRefs" in record.findings[0], false);
  assert.deepEqual([record.review.status, record.bindings.status], ["unknown", "not_checked"]);
  const none = verificationRecord(calculation(), { replays: { status: "recorded", items: [] }, corrections: { status: "recorded", items: [] } });
  assert.deepEqual([none.replays.status, none.corrections.status], ["none_recorded", "none_recorded"]);
  const values = Array.from({ length: 600 }, (_, index) => ({ key: `k${index}`, status: "identical", before: 1, after: 1 }));
  const read = verificationRecord(calculation(), { replays: { status: "recorded", items: [{ id: "replay_1", state: "succeeded", comparison: { bytes: "identical",
    numbers: { status: "identical", values }, environment: { status: "same", changed: [] } } }] } });
  assert.equal(read.replays.items[0].comparison.numbers.values.length, 500);
  assert.equal(read.replays.items[0].comparison.numbers.truncated, 100, "a long comparison says how much it left out");
  assert.equal(read.replays.items[0].comparison.scientificApplicability, "not_assessed");
});

test("an engine recipe is reconstructable only with its input and an environment; a script's rerun is partial by its own account", () => {
  const recipe = { recipe: { method: "meta.dl", version: "1", parameters: {}, input: { path: "input.json", sha256: hex("2") }, codeDigest: hex("c"), environmentDigest: hex("e") } };
  const files = { [DATA]: `results/${DATA}/input.json` };
  const full = reproductionRecord(calculation(), { recipe, archivePathFor: (/** @type {string} */ id) => files[id] ?? null });
  assert.deepEqual([full.basis, full.status, full.reasons], ["engine_recipe", "reconstructable", []]);
  assert.equal(full.engine, "evimed_specialist_adapter.deterministic_replay (Python)");
  assert.equal(full.expected.values[0].absoluteTolerance, 1e-10);
  assert.equal(full.steps.length, 4);
  const withoutInput = reproductionRecord(calculation(), { recipe, archivePathFor: () => null });
  assert.deepEqual([withoutInput.status, withoutInput.reasons], ["partial", ["input_not_included"]]);
  const unreported = reproductionRecord(calculation({ snapshot: { ...calculation().snapshot, environment: { status: "unknown", digest: null, facts: null } } }), { recipe, archivePathFor: (/** @type {string} */ id) => files[id] ?? null });
  assert.deepEqual(unreported.reasons, ["environment_not_reported"]);
  const vcr = reproductionRecord(calculation(), { recipe: { recipe: { ...recipe.recipe, method: "design.analytic" } }, archivePathFor: (/** @type {string} */ id) => files[id] ?? null });
  assert.equal(vcr.engine, "vcr-engine (R service)");

  const script = calculation({ code: { kind: "code", id: "a.py", versionId: `rv_${hex("5")}`, digest: hex("6"), availability: "captured" },
    machineValues: [{ key: "estimate", value: 1.25 }],
    snapshot: { kind: "skill_script", origin: "receipt_declared", reproduction: "observed_execution", unknown: ["undeclared_dependencies"], method: { id: "python" },
      script: { path: "a.py", digest: hex("6"), executed: true, verified: true },
      environment: { status: "reported", digest: hex("d"), facts: { interpreter: "3.12.3", packages: { pandas: "2.2.2", numpy: "1.26.4" } } } } });
  const rerun = reproductionRecord(script, { archivePathFor: (/** @type {string} */ id) => /** @type {Record<string, string>} */ ({ ...files, [`rv_${hex("5")}`]: "results/script/a.py" })[id] ?? null });
  assert.equal(rerun.basis, "script_rerun");
  assert.equal(rerun.status, "partial");
  assert.deepEqual(rerun.reasons, ["arguments_not_recorded", "undeclared_dependencies_unknown"]);
  assert.equal(rerun.requirements, "numpy==1.26.4\npandas==2.2.2\n");
  assert.equal(rerun.expected.values[0].absoluteTolerance, null, "no tolerance declared is none, not zero");

  assert.equal(reproductionRecord(calculation({ machineValues: [] }), { recipe, archivePathFor: () => null }), null, "a version with no numbers has nothing to reproduce");
  assert.equal(reproductionRecord(calculation({ snapshot: { kind: "authored" } }), { archivePathFor: () => null }), null, "authored bytes are not a calculation");
  assert.equal(pinnedRequirements({ b: "2", a: "1" }), "a==1\nb==2\n");
});
