import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResultPath, projectResultMethod, projectResultVersion, projectResultInput, resultMethodDifference, validateResultAnchor, resultVersionDifference } from "../src/resultProvenance.mjs";

const version = { artifactId: `ra_${"a".repeat(64)}`, versionId: `rv_${"b".repeat(64)}`,
  projectId: "one", path: "report.md", digest: "c".repeat(64), size: 12, coverage: { gaps: [] },
  producer: { kind: "legacy", sessionId: "session", secret: "hidden" }, findings: [{ id: "finding", status: "failed" }] };

test("projection preserves honest capture gaps and binds findings without leaking storage or producer extras", () => {
  const projected = projectResultVersion({ ...version, storagePath: "/private/secret", providerKey: "hidden" });
  assert.equal(projected.findings[0].versionId, version.versionId);
  assert.equal(projected.findings[0].status, "failed"); assert.equal(projected.producer.secret, undefined);
  assert.equal(projected.storagePath, undefined); assert.equal(projected.providerKey, undefined);
  assert.equal(projectResultInput({ kind: "source", id: "source", availability: "captured" }).availability, "reference");
  assert.throws(() => normalizeResultPath("../outside")); assert.throws(() => normalizeResultPath("/private"));
  assert.throws(() => normalizeResultPath("folder\\outside")); assert.equal(normalizeResultPath("./a//b.md"), "a/b.md");
});

test("anchored references cannot silently retarget selection to a successor or stale source", () => {
  const anchor = { versionId: version.versionId, digest: version.digest, elementId: "claim-1", selectedText: "claim", instruction: "revise" };
  assert.equal(validateResultAnchor(version, anchor).versionId, version.versionId);
  assert.throws(() => validateResultAnchor(version, { ...anchor, digest: "d".repeat(64) }));
  assert.throws(() => validateResultAnchor(version, { ...anchor, versionId: `rv_${"d".repeat(64)}` }));
  assert.throws(() => validateResultAnchor(version, { ...anchor, sourceDigest: "bad", page: 1 }));
});

test("comparison distinguishes content, source and machine changes without assessing scientific applicability", () => {
  const before = { ...version, inputs: [{ kind: "source", id: "s", digest: "a" }], machineValues: [{ estimate: 1 }] };
  const after = { ...version, versionId: `rv_${"d".repeat(64)}`, digest: "d".repeat(64), inputs: [{ kind: "source", id: "s", digest: "b" }], machineValues: [{ estimate: 2 }] };
  const difference = resultVersionDifference(before, after);
  assert.equal(difference.bytes, "changed"); assert.equal(difference.machineValues, "changed");
  assert.equal(difference.addedInputs.length, 1); assert.equal(difference.removedInputs.length, 1);
  assert.equal(difference.applicability, "not_assessed");
});

test("a result names the method record it ran, no more and no less than the engine said", () => {
  const method = { id: "meta.dl", version: "2.0.0", digest: "e".repeat(64), seeded: false, seed: null, secret: "hidden" };
  assert.deepEqual(projectResultMethod(method), { id: "meta.dl", version: "2.0.0", digest: "e".repeat(64), seeded: false, seed: null });
  assert.deepEqual(projectResultVersion({ ...version, method }).method, projectResultMethod(method));
  // A digest that is not a digest, a seed that is not an integer, a field that is not a boolean: unknown, not made up.
  assert.deepEqual(projectResultMethod({ id: "m", version: "1", digest: "nope", seeded: "no", seed: 1.5 }), { id: "m", version: "1", digest: null, seeded: null, seed: null });
  assert.equal(projectResultMethod({ id: "m", version: "1", seed: 7 })?.seed, 7);
  for (const missing of [undefined, null, {}, { id: "m" }, { version: "1" }, { id: "", version: "1" }, { id: "m", version: "" }, { id: "x".repeat(201), version: "1" }, { id: "m", version: "v".repeat(65) }, "meta.dl"]) {
    assert.equal(projectResultMethod(missing), null);
  }
  assert.equal(projectResultVersion(version).method, null, "a result with no record says so");
});

test("two results are the same method only when both name one and every part of it matches", () => {
  const base = { id: "meta.dl", version: "2.0.0", digest: "e".repeat(64), seeded: false, seed: null };
  assert.equal(resultMethodDifference(base, { ...base }), "identical");
  for (const changed of [{ version: "2.1.0" }, { digest: "f".repeat(64) }, { id: "faers.signals" }, { seeded: true, seed: 3 }, { digest: null }]) {
    assert.equal(resultMethodDifference(base, { ...base, ...changed }), "changed", JSON.stringify(changed));
  }
  // A missing side is not a match: nothing here passes because nothing was recorded.
  for (const [left, right] of [[null, base], [base, null], [null, null], [undefined, {}]]) assert.equal(resultMethodDifference(left, right), "unknown");
  const difference = resultVersionDifference({ ...version, method: base }, { ...version, versionId: `rv_${"d".repeat(64)}`, method: { ...base, version: "2.1.0" } });
  assert.equal(difference.method, "changed");
  assert.equal(resultVersionDifference(version, version).method, "unknown");
});
