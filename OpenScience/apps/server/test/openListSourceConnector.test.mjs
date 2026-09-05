import assert from "node:assert/strict";
import test from "node:test";
import { OpenListSourceConnector } from "../src/openListSourceConnector.mjs";

test("OpenList account namespaces cannot overlap or escape their configured root", async () => {
  const calls = [];
  const client = {
    list: async (selected) => { calls.push(selected); return { entries: [{ path: `${selected}/paper.pdf`, name: "paper.pdf" }], nextCursor: null }; },
    stat: async (selected) => ({ path: selected, name: "paper.pdf", entryType: "file" }),
    read: async (selected) => Buffer.from(selected),
    health: async () => ({ connected: true }),
  };
  const connector = new OpenListSourceConnector(client, { tenantRoot: "/tenants" });
  const page = await connector.list("user-one", "/folder");
  assert.equal(calls[0], "/tenants/user-one/folder");
  assert.equal(page.entries[0].path, "/folder/paper.pdf");
  assert.equal((await connector.stat("user-two", "/paper.pdf")).path, "/paper.pdf");
  await assert.rejects(() => connector.list("user-one", "/../user-two"), { code: "openlist_path_invalid" });
});
