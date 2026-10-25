import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "../official-packs.mjs";

test("the report needs no argument, and the one undo names a method and the body it was stopped on", () => {
  assert.deepEqual(parseArguments([]), { restore: null });
  assert.deepEqual(parseArguments(["--restore", "official:review:pooling", "abcdef012345"]), { restore: { key: "official:review:pooling", sha: "abcdef012345" } });
});

test("anything else is refused by name", () => {
  assert.throws(() => parseArguments(["--apply"]), /unknown argument --apply/);
  assert.throws(() => parseArguments(["--restore", "official:review:pooling"]), /needs a method id/);
  assert.throws(() => parseArguments(["--restore", "method:learned:x", "abcdef012345"]), /not an official method id/);
  assert.throws(() => parseArguments(["--restore", "official:review:pooling", "short"]), /twelve or more hexadecimal/);
});
