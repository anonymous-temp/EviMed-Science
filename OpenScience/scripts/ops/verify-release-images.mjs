#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseManifestFile } from "../../apps/server/src/releaseManifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA256 = /^sha256:[a-f0-9]{64}$/;

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

function inspectLocalImage(image) {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{json .}}", image], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 ** 2, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const missing = !result.error && /no such (?:image|object)/i.test(result.stderr);
    throw fail(missing ? "release_image_missing" : "release_image_inspect_failed",
      missing ? "image is missing locally" : "could not inspect the local Docker image");
  }
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw fail("release_image_invalid", "Docker returned invalid image metadata"); }
  if (!info || typeof info !== "object" || !SHA256.test(info.Id ?? "")) {
    throw fail("release_image_invalid", `${image} returned invalid local image metadata.`);
  }
  return info;
}

export function verifyReleaseImages(manifest, inspect = inspectLocalImage) {
  const entries = releaseImageEntries(manifest);
  for (const entry of entries) {
    let info;
    try {
      info = inspect(entry.image);
    } catch (error) {
      const missing = error?.code === "release_image_missing";
      throw fail(error?.code ?? "release_image_inspect_failed", missing
        ? `${entry.name} image is missing locally: ${entry.image}. Restore the exact release image before admission.`
        : `Could not inspect ${entry.name} image ${entry.image}: ${error.message}`);
    }
    if (info.Id !== entry.imageId) {
      throw fail("release_image_mismatch", `${entry.name} local image ID differs from the release manifest: ${entry.image}; expected ${entry.imageId}, found ${info.Id ?? "none"}.`);
    }
    const digest = entry.image.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
    // Inspect was addressed by the complete repo@digest, never by a fallback tag.
    // Containerd can expose the manifest as a descriptor instead of a RepoDigest.
    const repoDigests = info.RepoDigests ?? [];
    if (digest && (repoDigests.length || info.Descriptor?.digest) && info.Descriptor?.digest !== digest
      && !repoDigests.some((reference) => reference.endsWith(`@${digest}`))) {
      throw fail("release_image_digest_mismatch", `${entry.name} local image does not carry the required manifest digest ${digest}: ${entry.image}.`);
    }
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
