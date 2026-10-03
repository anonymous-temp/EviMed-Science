import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResultPath, projectResultVersion, projectResultInput, validateResultAnchor, resultVersionDifference } from "../src/resultProvenance.mjs";

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
