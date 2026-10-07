// The account that shared a pack is never told to the account that received it (flywheel review 2026-10-06): the id of a local account
// is its login name. The recipient's capsule records keep the id for the take-down and the corroboration count, and every capsule
// route drops it on the way out — rows written before the rule included.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { HttpError, sendError } from "../src/security.mjs";
import { createCapsuleRoutes } from "../src/capsuleRoutes.mjs";
import { withoutSharerAccount } from "../src/capsuleSharerAccount.mjs";

const SHARER = "sharer-login-5t2n";
const imported = () => ({
  id: "cap-1", kind: "capsule", createdAt: new Date("2026-10-01T00:00:00Z"),
  payload: {
    title: "收到的研究胶囊", imported: true, authorId: "kept-elsewhere",
    transfer: { snapshotId: "snap-1", issuerId: "issuer-1", issuerTrust: "unverified", authorId: SHARER, channel: "link" },
    share: { authorId: SHARER, authorName: "张伟", snapshotHash: "a".repeat(64), channel: "link" },
  },
});

test("withoutSharerAccount drops authorId under transfer and share only, in lists and nested records, and leaves everything else alone", () => {
  const fact = { id: "f-1", payload: { capsuleId: "cap-1", share: { authorId: SHARER, authorName: "张伟" } } };
  const out = withoutSharerAccount({ items: [imported(), fact], page: { next: null } });
  assert.equal(JSON.stringify(out).includes(SHARER), false);
  assert.equal(out.items[0].payload.share.authorName, "张伟", "the display name stays: it is what 「来自 … 的分享」 says");
  assert.equal(out.items[0].payload.transfer.snapshotId, "snap-1");
  assert.equal(out.items[0].payload.authorId, "kept-elsewhere", "an authorId that is not the sharer's record is not this rule's to remove");
  assert.ok(out.items[0].createdAt instanceof Date, "a date is not rebuilt as an empty object");
  assert.equal(withoutSharerAccount(null), null);
  assert.equal(withoutSharerAccount("text"), "text");
});

test("every capsule route answers without the sharer's account: the list and the received packs", async (t) => {
  const service = {
    list: async () => ({ items: [imported()], nextCursor: null }),
    received: async () => ({ items: [imported()] }),
  };
  const store = {
    ensureSessionUser: async () => ({ user: { id: "recipient" } }),
    assertCsrf: async () => {},
    requireProject: async () => { throw new HttpError(404, "project_not_found", "Project unavailable."); },
  };
  const handle = createCapsuleRoutes({ store, service, maxJsonBytes: 262144 });
  const server = createServer((req, res) => { handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  for (const route of ["/api/capsules", "/api/capsules/received"]) {
    const answer = await fetch(`${base}${route}`);
    assert.equal(answer.status, 200, route);
    const body = await answer.text();
    assert.equal(body.includes(SHARER), false, `${route} does not carry the sharer's account id`);
    assert.ok(body.includes("张伟"), `${route} still names the sharer`);
  }
});
