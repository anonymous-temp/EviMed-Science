// 2026-10-10 review C-5: a deleted capsule's hosted snapshots kept serving imports. The route revokes them after the
// removal; this holds the transfer service's part — every live snapshot of that capsule, nothing of any other.
import assert from "node:assert/strict";
import test from "node:test";

import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

test("revoking a deleted capsule's snapshots touches every live one of that capsule and nothing else", async () => {
  const documents = productDocumentsDouble();
  const put = (id, payload) => documents.put("owner", "preferences", id, { recordType: "capsule-snapshot", ...payload }, { expectedRevision: 0 });
  await put("snap-a", { capsuleId: "capsule-x", status: "active" });
  await put("snap-b", { capsuleId: "capsule-x", status: "active" });
  await put("snap-c", { capsuleId: "capsule-x", status: "revoked", revokedAt: "2026-09-30T00:00:00.000Z" });
  await put("snap-d", { capsuleId: "capsule-y", status: "active" });
  const service = new CapsuleTransferService({ documents, capsules: null, identities: null, dataDir: "/nonexistent" });

  assert.deepEqual((await service.revokeAllForCapsule("owner", "capsule-x")).sort(), ["snap-a", "snap-b"]);
  const status = async (id) => (await documents.get("owner", "preferences", id)).payload.status;
  assert.deepEqual([await status("snap-a"), await status("snap-b"), await status("snap-c"), await status("snap-d")], ["revoked", "revoked", "revoked", "active"]);
  assert.equal((await documents.get("owner", "preferences", "snap-c")).payload.revokedAt, "2026-09-30T00:00:00.000Z", "an earlier revocation keeps its time");
  assert.deepEqual(await service.revokeAllForCapsule("owner", "capsule-x"), [], "idempotent");
});
