import assert from "node:assert/strict";
import { test } from "node:test";
import { recordNativeUploadAttempt } from "../src/nativeUploadActivity.mjs";

test("native attachment activity is scoped, durable before forwarding, and never claims upload success", async () => {
  const rows = new Map();
  const documents = {
    get: async (user, kind, id) => rows.get(`${user}:${kind}:${id}`),
    put: async (user, kind, id, payload, options) => { rows.set(`${user}:${kind}:${id}`, { payload, projectId: options.projectId }); },
  };
  await recordNativeUploadAttempt(documents, { userId: "owner", id: "project" });
  const marker = await documents.get("owner", "preferences", "native-upload-attempt:project");
  assert.deepEqual(marker, { projectId: "project", payload: { recordType: "native-upload-attempt", state: "attempted" } });
  assert.equal(await documents.get("foreign", "preferences", "native-upload-attempt:project"), undefined);
  assert.equal(await documents.get("owner", "preferences", "native-upload-attempt:other"), undefined);
  // An upstream refusal or disconnection does not change an attempt into a success.
  await recordNativeUploadAttempt(documents, { userId: "owner", id: "project" });
  assert.equal(rows.size, 1);
  assert.equal(marker.payload.state, "attempted");
});

test("an unreadable or unwritable activity ledger refuses forwarding rather than losing an upload intent", async () => {
  await assert.rejects(recordNativeUploadAttempt({ get: async () => null, put: async () => { throw new Error("unavailable"); } }, { userId: "owner", id: "project" }), /unavailable/);
});
