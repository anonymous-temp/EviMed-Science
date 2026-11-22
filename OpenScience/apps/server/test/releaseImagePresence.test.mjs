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
    if (image === manifest.proxy.image) throw Object.assign(new Error("No such image"), { code: "release_image_missing" });
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

test("a digest-addressed inspect can use a descriptor or a daemon without RepoDigests", () => {
  const pinned = manifest.services[0];
  for (const meta of [{ Descriptor: { digest: manifestDigest } }, { RepoDigests: [] }]) {
    const local = images();
    local[pinned.image] = { Id: pinned.imageId, ...meta };
    verifyReleaseImages(manifest, (ref) => local[ref]);
  }
});

test("a classic image can also match a manifest digest reported by Docker", () => {
  const local = images();
  const pinned = manifest.services[0];
  const release = { ...manifest, services: [{ ...pinned, imageId: manifestDigest }] };
  verifyReleaseImages(release, (ref) => local[ref], assert.fail);
});

test("containerd accepts the local manifest ID or its config digest", () => {
  const local = images();
  const target = id("a");
  local[manifest.runtime.image] = { Id: target, Descriptor: { digest: target } };
  const release = { ...manifest, runtime: { ...manifest.runtime, imageId: target } };
  verifyReleaseImages(release, (ref) => local[ref], assert.fail);
  verifyReleaseImages(manifest, (ref) => local[ref], (digest, imageId) => {
    assert.equal(digest, target);
    assert.equal(imageId, target);
    return { schemaVersion: 2, layers: [], config: { digest: manifest.runtime.imageId } };
  });
});

test("a config digest cannot override a conflicting pinned reference", () => {
  const local = images();
  const pinned = manifest.services[0];
  const target = id("a");
  local[pinned.image] = { Id: target, Descriptor: { digest: target } };
  assert.throws(() => verifyReleaseImages(manifest, (ref) => local[ref], assert.fail),
    { code: "release_image_digest_mismatch" });
});

test("an image index only uses the manifest for the platform Docker inspected", () => {
  const local = images();
  const index = id("a");
  const selected = id("b");
  const other = id("c");
  local[manifest.runtime.image] = { Id: index, Descriptor: { digest: index }, Os: "linux", Architecture: "amd64" };
  const readManifest = (digest, imageId) => {
    assert.equal(imageId, index);
    if (digest === index) return { manifests: [
      { digest: other, platform: { os: "linux", architecture: "arm64" } },
      { digest: selected, platform: { os: "linux", architecture: "amd64" } },
    ] };
    assert.equal(digest, selected);
    return { schemaVersion: 2, layers: [], config: { digest: manifest.runtime.imageId } };
  };
  verifyReleaseImages(manifest, (ref) => local[ref], readManifest);
  const release = { ...manifest, runtime: { ...manifest.runtime, imageId: selected } };
  verifyReleaseImages(release, (ref) => local[ref], readManifest);
  release.runtime.imageId = other;
  assert.throws(() => verifyReleaseImages(release, (ref) => local[ref], readManifest), { code: "release_image_mismatch" });
});

test("a resolved different config is a mismatch and an unavailable config is unverified", () => {
  const local = images();
  const target = id("a");
  const different = id("b");
  local[manifest.runtime.image] = { Id: target, containerdStore: true };
  assert.throws(() => verifyReleaseImages(manifest, (ref) => local[ref], () => undefined),
    { code: "release_image_unverified", message: /Could not verify runtime local image/ });
  assert.throws(() => verifyReleaseImages(manifest, (ref) => local[ref], () => ({
    schemaVersion: 2, layers: [], config: { digest: different },
  })), { code: "release_image_mismatch", message: new RegExp(`found ${target} \\(config ${different}\\)`) });
});

test("an unavailable Docker daemon is reported as an inspect failure", () => {
  assert.throws(() => verifyReleaseImages(manifest, () => { throw new Error("daemon unavailable"); }),
    (error) => error.code === "release_image_inspect_failed" && error.message.includes(manifest.web.image));
});
