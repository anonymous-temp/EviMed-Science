#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseManifestFile } from "../../apps/server/src/releaseManifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const commandOptions = { timeout: 10_000, maxBuffer: 2 * 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] };

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function releaseImageEntries(manifest) {
  return [
    { name: "web", image: manifest.web.image, imageId: manifest.web.imageId },
    { name: "runtime", image: manifest.runtime.image, imageId: manifest.runtime.imageId },
    { name: "caddy", image: manifest.proxy.image, imageId: manifest.proxy.imageId },
    ...manifest.services.map((service) => ({ name: service.name, image: service.image, imageId: service.imageId })),
  ];
}

function dockerBin() {
  return process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_BIN ?? "docker";
}

function commandJson(result, digest) {
  if (result.error || result.status !== 0) return undefined;
  if (digest && `sha256:${createHash("sha256").update(result.stdout).digest("hex")}` !== digest) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

function carriesManifest(info, digest) {
  return info.Descriptor?.digest === digest || (info.RepoDigests ?? []).some((ref) => ref.endsWith(`@${digest}`));
}

function inspectLocalImage(image, expectedId) {
  const result = spawnSync(dockerBin(), ["image", "inspect", "--format", "{{json .}}", image], commandOptions);
  if (result.error || result.status !== 0) {
    const missing = !result.error && /no such (?:image|object)/i.test(result.stderr);
    throw fail(missing ? "release_image_missing" : "release_image_inspect_failed",
      missing ? "image is missing locally" : "could not inspect the local Docker image");
  }
  const info = commandJson(result);
  if (!info || typeof info !== "object" || !SHA256.test(info.Id ?? "")) {
    throw fail("release_image_invalid", `${image} returned invalid local image metadata.`);
  }
  // Older Docker API versions omit Descriptor even with a containerd image store.
  if (!info.Descriptor && info.Id !== expectedId && !carriesManifest(info, expectedId)) {
    const status = commandJson(spawnSync(dockerBin(), ["info", "--format", "{{json .DriverStatus}}"], commandOptions));
    info.containerdStore = status === null ? false : Array.isArray(status)
      ? status.some((row) => row?.[0] === "driver-type" && row[1] === "io.containerd.snapshotter.v1")
      : null;
  }
  return info;
}

function readLocalManifest(digest, imageId) {
  // Docker's inspect Config is a projection. Read the exact manifest blob from
  // a local export by immutable ID and bound the time spent streaming layers.
  const exported = spawnSync("timeout", ["--kill-after=1s", "5s", "sh", "-c",
    '"$1" image save "$2" | tar --extract --to-stdout --occurrence --file=- "$3"',
    "release-image-manifest", dockerBin(), imageId, `blobs/sha256/${digest.slice(7)}`], commandOptions);
  const manifest = commandJson(exported, digest);
  if (manifest) return manifest;

  return commandJson(spawnSync("ctr", ["-n", "moby", "content", "get", digest], commandOptions), digest);
}

function localImageDigests(info, readManifest) {
  const target = readManifest(info.Id, info.Id);
  if (!Array.isArray(target?.manifests)) return { config: manifestConfig(target) };

  // Match the platform Docker inspected. An index can also list other
  // platforms and attestations, whose config digests cannot admit this image.
  const candidates = target.manifests.filter((item) => SHA256.test(item?.digest ?? "") &&
    info.Os && info.Architecture && item.platform?.os === info.Os && item.platform.architecture === info.Architecture &&
    (!info.Variant || item.platform.variant === info.Variant));
  if (candidates.length !== 1) return {};
  const manifest = candidates[0].digest;
  const config = manifestConfig(readManifest(manifest, info.Id));
  return config ? { manifest, config } : {};
}

function manifestConfig(manifest) {
  if (manifest?.schemaVersion === 2 && Array.isArray(manifest.layers) && SHA256.test(manifest.config?.digest ?? "")) {
    return manifest.config.digest;
  }
  return undefined;
}

export function verifyReleaseImages(manifest, inspect = inspectLocalImage, readManifest = readLocalManifest) {
  const entries = releaseImageEntries(manifest);
  for (const entry of entries) {
    let info;
    try {
      info = inspect(entry.image, entry.imageId);
    } catch (error) {
      const missing = error?.code === "release_image_missing";
      throw fail(error?.code ?? "release_image_inspect_failed", missing
        ? `${entry.name} image is missing locally: ${entry.image}. Restore the exact release image before admission.`
        : `Could not inspect ${entry.name} image ${entry.image}: ${error.message}`);
    }
    const digest = entry.image.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
    // Inspect was addressed by the complete repo@digest, never by a fallback tag.
    // Containerd can expose the manifest as a descriptor instead of a RepoDigest.
    if (digest && (info.RepoDigests?.length || info.Descriptor?.digest) && !carriesManifest(info, digest)) {
      throw fail("release_image_digest_mismatch", `${entry.name} local image does not carry the required manifest digest ${digest}: ${entry.image}.`);
    }
    if (info.Id === entry.imageId || carriesManifest(info, entry.imageId)) continue;

    let config;
    if (info.Descriptor?.digest === info.Id || info.containerdStore || info.containerdStore === null) {
      const digests = localImageDigests(info, readManifest);
      if (digests.manifest === entry.imageId || digests.config === entry.imageId) continue;
      config = digests.config;
      if (!config) {
        throw fail("release_image_unverified", `Could not verify ${entry.name} local image ${entry.image}: Docker and ctr did not resolve a config digest for ${info.Id}; expected ${entry.imageId}.`);
      }
    }
    const found = config ? `${info.Id} (config ${config})` : info.Id;
    throw fail("release_image_mismatch", `${entry.name} local image ID differs from the release manifest: ${entry.image}; expected ${entry.imageId}, found ${found}.`);
  }
  return entries.map((entry) => entry.name);
}

async function main() {
  const output = process.argv.find((argument) => argument.startsWith("--manifest="))?.slice("--manifest=".length);
  const file = path.resolve(output ?? process.env.OPEN_SCIENCE_RELEASE_MANIFEST_FILE ?? path.join(repoRoot, "deploy/web/release-manifest.json"));
  const loaded = readReleaseManifestFile(file);
  if (loaded.error || !loaded.manifest) throw fail(loaded.error ?? "release_manifest_missing", "The release manifest is missing or invalid.");
  const verified = verifyReleaseImages(loaded.manifest);
  process.stdout.write(`release images present and digest-verified: ${verified.join(", ")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "release_image_verification_failed"}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
