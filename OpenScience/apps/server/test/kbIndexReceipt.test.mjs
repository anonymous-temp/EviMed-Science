import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as chunker from "../src/kbChunker.mjs";

test("index receipt binds the sorted exact truncated embedding inputs and purity method", () => {
  assert.equal(chunker.KB_INDEX_METHOD, "captured-content-v1");
  assert.equal(typeof chunker.embeddingInputReceipt, "function");
  const chunks = [{ ordinal: 1, prefix: "Verified heading", content: "z".repeat(9000) }, { ordinal: 0, prefix: "", content: "actualbody" }];
  const expected = createHash("sha256").update(JSON.stringify([chunker.KB_INDEX_METHOD,
    [...chunks].sort((a, b) => a.ordinal - b.ordinal).map(c => [c.ordinal, chunker.embeddingText(c, c.content)])])).digest("hex");
  assert.equal(chunker.embeddingInputReceipt(chunks), expected);
  assert.equal(chunker.embeddingInputReceipt(chunks.map(c => ({ ...c, title: "Private metadata renamed", updatedAt: Date.now() }))), expected);
  assert.notEqual(chunker.embeddingInputReceipt([{ ...chunks[0], prefix: "" }, chunks[1]]), expected);
  assert.equal(chunker.embeddingInputReceipt([{ ...chunks[0], content: chunks[0].content + "tail" }, chunks[1]]), expected);
});
