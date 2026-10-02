import assert from "node:assert/strict";
import test from "node:test";
import { exportExtensionAccountRow, exportPersonalSkillResources } from "../src/extensionAccountExport.mjs";

test("authored skill exports preserve native policy and content while dropping live authority", () => {
  const row = { id: "skill:one", kind: "skill", revision: 1, payload: { title: "Review", description: "Review sources", instructions: "Use these sources.",
    resources: [], invocation: { userInvocable: false, modelInvocable: true }, metadata: { title: "My review" }, whenToUse: "When supplied",
    nativeName: "private-current-owner", prepared: true, proof: "must-not-leave", tokenFile: "/private/credential" } };
  const exported = exportExtensionAccountRow(row);
  assert.equal(exported.payload.instructions, row.payload.instructions); assert.deepEqual(exported.payload.invocation, row.payload.invocation);
  assert.equal(exported.payload.prepared, false); assert(!JSON.stringify(exported).includes("credential")); assert(!JSON.stringify(exported).includes("must-not-leave"));
});
test("historical resource bytes are owner-resolved, deduplicated and bounded instead of silently omitted", async () => {
  const resource = { id: `resource:${"a".repeat(64)}`, path: "references/table.csv", digest: `sha256:${"a".repeat(64)}`, size: 4 };
  const row = { id: "skill:one", kind: "skill", revision: 1, payload: { title: "Review", description: "Source table", instructions: "Read this table.",
    resources: [resource], invocation: { userInvocable: true, modelInvocable: true } } };
  const user = { id: "alice" }, calls = [];
  const artifacts = { resourceBytes: async (actor, selected) => { calls.push({ actor, selected }); return Buffer.from("data"); } };
  const exported = await exportPersonalSkillResources({ artifacts, user, rows: [row, { ...row, revision: 2 }] });
  assert.equal(calls.length, 1); assert.equal(calls[0].actor, user); assert.equal(exported.bytes, 4);
  assert.equal(Buffer.from(exported.resources[0].base64, "base64").toString(), "data");
  await assert.rejects(exportPersonalSkillResources({ artifacts, user, rows: [row], maxBytes: 3 }), { status: 413 });
  await assert.rejects(exportPersonalSkillResources({ artifacts: null, user, rows: [row] }), { status: 503 });
});
test("installation and desired-set exports cannot transfer qualification, connections or generation state", () => {
  const coordinate = { kind: "npm", name: "example-tool", version: "1.0.0" };
  const installed = exportExtensionAccountRow({ id: "extension:one", kind: "extension-installation", payload: { coordinate, catalogueId: "one", qualification: true, prepareJobId: "lease-authority" } });
  assert.deepEqual(Object.keys(installed.payload).sort(), ["catalogueId", "coordinate", "schemaVersion"]);
  const selected = exportExtensionAccountRow({ id: "extensions:project:p1", kind: "extension-defaults", payload: { selections: [{ installationId: "extension:one", coordinate,
    enabled: true, settings: { rowLimit: 10 }, connectionRefs: ["connector:private"], actorId: "old-user" }], effectiveGeneration: "must-not-import" } });
  assert.deepEqual(selected.payload.selections[0].connectionRefs, []); assert.equal(selected.payload.selections[0].reconnectRequired, true);
  assert(!JSON.stringify(selected).includes("old-user")); assert(!JSON.stringify(selected).includes("must-not-import"));
});
