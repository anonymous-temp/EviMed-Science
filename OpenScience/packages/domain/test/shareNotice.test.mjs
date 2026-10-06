import assert from "node:assert/strict";
import test from "node:test";
import { shareNoticeHref } from "../index.mjs";

test("a delivery notice opens the page that previews it, any other share notice the memory page, and nothing else is a share", () => {
  assert.equal(shareNoticeHref({ type: "share", id: "delivery/dlv_0123abcd" }), "/app/memory/delivered/dlv_0123abcd");
  assert.equal(shareNoticeHref({ type: "share", id: "withdrawn/dlv_0123abcd" }), "/app/memory");
  assert.equal(shareNoticeHref({ type: "share", id: "delivery/" + "x".repeat(81) }), "/app/memory", "an id that is too long is not an id");
  assert.equal(shareNoticeHref({ type: "share", id: "delivery/../etc" }), "/app/memory");
  assert.equal(shareNoticeHref({ type: "share", id: 7 }), "/app/memory");
  assert.equal(shareNoticeHref({ type: "memory", id: "delivery/dlv_1" }), null);
  assert.equal(shareNoticeHref(null), null);
  assert.equal(shareNoticeHref(undefined), null);
});
