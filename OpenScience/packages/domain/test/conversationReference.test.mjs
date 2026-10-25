// The origin a conversation is opened from: an event or one item of 前沿动态, each by its public id and a title the server gave.
import assert from "node:assert/strict";
import test from "node:test";

import { conversationReference } from "../index.mjs";

test("an event and an item are origins, kept as they are named", () => {
  assert.deepEqual(conversationReference({ kind: "frontier-event", id: "a".repeat(16), title: "An event" }), { kind: "frontier-event", id: "a".repeat(16), title: "An event" });
  assert.deepEqual(conversationReference({ kind: "frontier-item", id: "k7q2m9x4t1b8", title: "口服 PCSK9 抑制剂" }), { kind: "frontier-item", id: "k7q2m9x4t1b8", title: "口服 PCSK9 抑制剂" });
});

test("only the fields of an origin survive", () => {
  assert.deepEqual(conversationReference({ kind: "frontier-item", id: "k7q2m9x4t1b8", title: "T", extra: 1, url: "https://x" }), { kind: "frontier-item", id: "k7q2m9x4t1b8", title: "T" });
});

test("another kind, a malformed id and a missing or oversized title are no origin", () => {
  for (const value of [
    null, undefined, "frontier-item", {},
    { kind: "frontier-topic", id: "k7q2m9x4t1b8", title: "T" },
    { kind: "frontier-item", id: "short", title: "T" },
    { kind: "frontier-item", id: "K7Q2M9X4T1B8", title: "T" },
    { kind: "frontier-item", id: "k7q2m9x4t1b8/../x", title: "T" },
    { kind: "frontier-item", id: "k7q2m9x4t1b8", title: "" },
    { kind: "frontier-item", id: "k7q2m9x4t1b8", title: "x".repeat(301) },
    { kind: "frontier-item", id: 12, title: "T" },
  ]) assert.equal(conversationReference(value), null, JSON.stringify(value));
  assert.ok(conversationReference({ kind: "frontier-item", id: "k7q2m9x4t1b8", title: "x".repeat(300) }));
});
