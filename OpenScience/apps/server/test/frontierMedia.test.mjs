// The reader's images through the knowledge plugin: a body that gives out halfway is a failure of the service and not a missing picture
// (rev-1101): the picture step tries a post again after the first and withdraws nothing for the second.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fetchFrontierMedia } from "../src/frontierMedia.mjs";

const ID = "a".repeat(64);

/** @param {(headers?: Record<string, string>) => any} respond */
async function withClient(respond, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "frontier-media-"));
  try {
    const tokenFile = path.join(directory, "token");
    await writeFile(tokenFile, "test-token\n", { mode: 0o600 });
    await run({ baseUrl: "http://plugin.invalid", tokenFile, timeoutMs: 1_000, fetch: async () => respond() });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const imageHeaders = () => new Headers({ "content-type": "image/jpeg" });

test("a body that stops halfway is frontier_media_unreadable, a service failure and not a missing picture", async () => {
  async function* broken() { yield Buffer.from("first half"); throw new TypeError("terminated"); }
  await withClient(() => ({ status: 200, ok: true, headers: imageHeaders(), body: broken() }), async (client) => {
    await assert.rejects(fetchFrontierMedia(client, ID), (error) => {
      assert.equal(/** @type {any} */ (error).code, "frontier_media_unreadable");
      assert.equal(/** @type {any} */ (error).status, 503);
      return true;
    });
  });
});

test("a body larger than the cap keeps its own code, an absent picture its own, and a whole body is returned", async () => {
  async function* large() { yield Buffer.alloc(1024 * 1024); yield Buffer.alloc(1024 * 1024); yield Buffer.alloc(16); }
  await withClient(() => ({ status: 200, ok: true, headers: imageHeaders(), body: large() }), async (client) => {
    await assert.rejects(fetchFrontierMedia(client, ID), (error) => /** @type {any} */ (error).code === "frontier_media_invalid");
  });
  await withClient(() => ({ status: 404, ok: false, headers: new Headers(), body: null }), async (client) => {
    await assert.rejects(fetchFrontierMedia(client, ID), (error) => /** @type {any} */ (error).code === "frontier_media_not_found");
  });
  async function* whole() { yield Buffer.from("jpeg-bytes"); }
  await withClient(() => ({ status: 200, ok: true, headers: imageHeaders(), body: whole() }), async (client) => {
    const image = await fetchFrontierMedia(client, ID);
    assert.equal(image.contentType, "image/jpeg");
    assert.equal(image.bytes.toString(), "jpeg-bytes");
  });
});
