import assert from "node:assert/strict";
import test from "node:test";
import { releaseImageEntries, verifyReleaseImages } from "../../../scripts/ops/verify-release-images.mjs";

const id = (letter) => `sha256:${letter.repeat(64)}`;
const manifestDigest = id("d");
const manifest = {
  web: { image: "registry.example/web:1", imageId: id("1") },
  runtime: { image: "registry.example/runtime:1", imageId: id("2") },
  proxy: { image: "caddy:2.11.4-alpine", imageId: id("3") },
  services: [{ name: "openlist", image: `registry.example/openlist:v1@${manifestDigest}`, imageId: id("4") }],
};

function images() {
  return Object.fromEntries(releaseImageEntries(manifest).map((entry) => [entry.image, {
    Id: entry.imageId,
    RepoDigests: entry.image.includes("@sha256:") ? [`registry.example/openlist@${manifestDigest}`] : [],
  }]));
}

test("release admission inspects every manifest image and checks config and manifest digests", () => {
  const local = images();
  const inspected = [];
  const verified = verifyReleaseImages(manifest, (image) => {
    inspected.push(image);
    return local[image];
  });
  assert.deepEqual(verified, ["web", "runtime", "caddy", "openlist"]);
  assert.deepEqual(inspected, releaseImageEntries(manifest).map((entry) => entry.image));
});

test("a pruned Caddy image fails admission by component and exact reference", () => {
  const local = images();
  assert.throws(() => verifyReleaseImages(manifest, (image) => {
    if (image === manifest.proxy.image) throw new Error("No such image");
    return local[image];
  }), (error) => {
    assert.equal(error.code, "release_image_missing");
    assert.match(error.message, /caddy image is missing locally: caddy:2\.11\.4-alpine/);
    assert.match(error.message, /before admission/);
    return true;
  });
});

test("a present image with the wrong config or manifest digest is not accepted", () => {
  const wrongConfig = images();
  wrongConfig[manifest.runtime.image].Id = id("9");
  assert.throws(() => verifyReleaseImages(manifest, (image) => wrongConfig[image]), (error) => {
    assert.equal(error.code, "release_image_mismatch");
    assert.match(error.message, /runtime local image ID/);
    return true;
  });
  const wrongManifest = images();
  wrongManifest[manifest.services[0].image].RepoDigests = [`registry.example/openlist@${id("e")}`];
  assert.throws(() => verifyReleaseImages(manifest, (image) => wrongManifest[image]), (error) => {
    assert.equal(error.code, "release_image_digest_mismatch");
    assert.match(error.message, /openlist local image does not carry the required manifest digest/);
    return true;
  });
});
