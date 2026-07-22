#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestDirectory,
  readReleaseManifestFile,
  sha256File,
  validateReleaseManifest,
} from "../../apps/server/src/releaseManifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const checkOnly = process.argv.includes("--check");
const verifyImages = process.argv.includes("--verify-images");
const jsonOutput = process.argv.includes("--json");
const outputArg = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length);
const manifestFile = path.resolve(
  outputArg ?? process.env.OPEN_SCIENCE_RELEASE_MANIFEST_FILE ?? path.join(repoRoot, "deploy/web/release-manifest.json"),
);

const inputPaths = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/desktop/package.json",
  "apps/desktop/index.html",
  "apps/desktop/postcss.config.js",
  "apps/desktop/tailwind.config.js",
  "apps/desktop/tsconfig.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/src",
  "apps/server/package.json",
  "apps/server/src",
  "packages/sdk/package.json",
  "packages/sdk/src",
  "packages/shared/package.json",
  "packages/shared/src",
  "runtime/mcp/evimed-research",
  "runtime/skills/evimed",
  "runtime/skills/office",
  "evals/capability-audit/run_connector_audit.py",
  "evals/capability-audit/run_connector_gateway_audit.mjs",
  "evals/capability-audit/run_skill_execution_audit.py",
  "evals/capability-audit/verify_release_audit.py",
  "evals/capability-audit/results/tool-probe-v3.json",
  "evals/capability-audit/results/connector-probe-v3.json",
  "evals/capability-audit/results/skill-audit-v4.json",
  "evals/capability-audit/results/skill-execution-v1.json",
  "evals/capability-audit/results/skill-execution-v1-artifacts",
  "scripts/dev/fetch-skills.sh",
  "scripts/dev/patch-ai4s-integrity-auditor.py",
  "examples/climate-trends",
  "deploy/web/Dockerfile",
  "deploy/memos/Dockerfile",
  "deploy/specialist-adapter",
  "deploy/runtime-opencode/Dockerfile",
  "deploy/runtime-opencode/open-science-opencode-serve.sh",
  "scripts/ops/archive-crypto.mjs",
  "scripts/ops/backup-data.sh",
  "scripts/ops/backup-retention.mjs",
  "scripts/ops/backup-scheduler.mjs",
  "scripts/ops/configure-backup.mjs",
  "scripts/ops/configure-local-auth.mjs",
  "scripts/ops/configure-production-state.mjs",
  "scripts/ops/provision-memos.mjs",
  "scripts/ops/object-backup.mjs",
  "scripts/ops/restore-data.sh",
  "scripts/ops/restore-drill.sh",
  "scripts/ops/configure-oidc.mjs",
  "scripts/ops/host-preflight.mjs",
  "scripts/ops/hosted-production-e2e.mjs",
  "scripts/ops/audit-saas-alignment.mjs",
  "deploy/web/docker-compose.yml",
  "deploy/web/docker-compose.backup.yml",
  "deploy/web/docker-compose.local-auth.yml",
  "deploy/web/docker-compose.oidc.yml",
  "deploy/web/docker-compose.saas.yml",
  "deploy/web/docker-compose.monitoring.yml",
  "deploy/web/saas-capability-contract.json",
  "deploy/web/Caddyfile",
  "deploy/web/monitoring/prometheus.json",
  "deploy/web/monitoring/open-science.rules.json",
  "docs/WEB_OPERATIONS_RUNBOOK.md",
  "docs/WEB_PRIVACY_AND_COMPLIANCE.md",
  "docs/WEB_SECURITY_INCIDENT_RESPONSE.md",
  "docs/SAAS_PRODUCT_ALIGNMENT.md",
  "docs/DRUG_EVIDENCE_AGENT_ARCHITECTURE.md",
];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail("release_environment_missing", `${name} is required.`);
  return value;
}

async function read(rel) {
  return fsp.readFile(path.join(repoRoot, rel), "utf8");
}

function dockerArg(dockerfile, name) {
  return dockerfile.match(new RegExp(`^ARG ${name}=([^\\s]+)$`, "m"))?.[1] ?? "";
}

function composeDefault(compose, name) {
  return compose.match(new RegExp(`\\$\\{${name}:-([^}]+)\\}`))?.[1] ?? "";
}

function normalizedVersion(value) {
  return String(value ?? "").replace(/^v(?=\d)/, "");
}

function dockerImageId(image, envName) {
  const configured = process.env[envName];
  if (configured) return configured;
  const dockerBin = process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_BIN ?? "docker";
  const inspected = spawnSync(dockerBin, ["image", "inspect", "--format", "{{.Id}}", image], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (inspected.status !== 0 || !inspected.stdout.trim()) {
    fail("release_image_inspect_failed", `Could not inspect ${image}; set ${envName} to its sha256 image id.`);
  }
  return inspected.stdout.trim();
}

async function currentInputs() {
  return Promise.all(
    inputPaths.map(async (inputPath) => {
      const full = path.join(repoRoot, inputPath);
      const stat = await fsp.lstat(full);
      const digest = stat.isDirectory()
        ? (await digestDirectory(full, { errorPrefix: "release_input" })).digest
        : await sha256File(full);
      return { path: inputPath, digest };
    }),
  );
}

async function currentSkills() {
  const configured = process.env.OPEN_SCIENCE_RUNTIME_SKILL_DIRS;
  const defaults = [
    "runtime/skills/core",
    "runtime/skills/external/ai4s-skills",
    "runtime/skills/curated-scientific",
    "runtime/skills/office",
  ];
  const sources = [...(configured == null ? defaults : configured.split(","))]
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(sources)];
  const skills = [];
  for (const source of unique) {
    const full = path.resolve(repoRoot, source);
    const relative = path.relative(repoRoot, full).split(path.sep).join("/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
      fail("release_skill_outside_source", "Runtime skill directories recorded in a release must stay inside the source tree.");
    }
    const digest = await digestDirectory(full);
    const name = relative === "runtime/skills/core" ? "core" : relative.replace(/[^A-Za-z0-9._-]+/g, "-");
    skills.push({ name, source: relative, files: digest.files, digest: digest.digest });
  }
  skills.sort((a, b) => a.source.localeCompare(b.source));
  return skills;
}

async function currentVersions() {
  const runtimeDockerfile = await read("deploy/runtime-opencode/Dockerfile");
  const webCompose = await read("deploy/web/docker-compose.yml");
  const monitoringCompose = await read("deploy/web/docker-compose.monitoring.yml");
  return {
    opencodeVersion: process.env.OPEN_SCIENCE_OPENCODE_VERSION ?? dockerArg(runtimeDockerfile, "OPENCODE_VERSION"),
    uvVersion: process.env.OPEN_SCIENCE_UV_VERSION ?? dockerArg(runtimeDockerfile, "UV_VERSION"),
    caddyVersion: process.env.OPEN_SCIENCE_CADDY_VERSION ?? composeDefault(webCompose, "OPEN_SCIENCE_CADDY_VERSION"),
    monitoring: {
      prometheusVersion: normalizedVersion(
        process.env.OPEN_SCIENCE_PROMETHEUS_VERSION ?? composeDefault(monitoringCompose, "OPEN_SCIENCE_PROMETHEUS_VERSION"),
      ),
      alertmanagerVersion: normalizedVersion(
        process.env.OPEN_SCIENCE_ALERTMANAGER_VERSION ?? composeDefault(monitoringCompose, "OPEN_SCIENCE_ALERTMANAGER_VERSION"),
      ),
      blackboxExporterVersion: normalizedVersion(
        process.env.OPEN_SCIENCE_BLACKBOX_EXPORTER_VERSION ??
          composeDefault(monitoringCompose, "OPEN_SCIENCE_BLACKBOX_EXPORTER_VERSION"),
      ),
      grafanaVersion: normalizedVersion(
        process.env.OPEN_SCIENCE_GRAFANA_VERSION ?? composeDefault(monitoringCompose, "OPEN_SCIENCE_GRAFANA_VERSION"),
      ),
    },
  };
}

async function buildManifest() {
  const pkg = JSON.parse(await read("package.json"));
  const versions = await currentVersions();
  const webImage = process.env.OPEN_SCIENCE_WEB_CONTAINER_IMAGE ?? `open-science-web:${pkg.version}`;
  const runtimeImage =
    process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE ??
    `open-science-opencode:opencode-${versions.opencodeVersion}-uv-${versions.uvVersion}`;
  const proxyImage = `caddy:${versions.caddyVersion}`;
  const manifest = {
    schemaVersion: 2,
    app: {
      name: pkg.name,
      version: pkg.version,
      releaseId: requiredEnv("OPEN_SCIENCE_RELEASE_ID"),
    },
    source: {
      revision: requiredEnv("OPEN_SCIENCE_SOURCE_REVISION").toLowerCase(),
      createdAt: process.env.OPEN_SCIENCE_BUILD_CREATED ?? new Date().toISOString(),
    },
    web: {
      image: webImage,
      imageId: dockerImageId(webImage, "OPEN_SCIENCE_WEB_IMAGE_ID"),
    },
    runtime: {
      image: runtimeImage,
      imageId: dockerImageId(runtimeImage, "OPEN_SCIENCE_RUNTIME_IMAGE_ID"),
      opencodeVersion: versions.opencodeVersion,
      uvVersion: versions.uvVersion,
    },
    proxy: {
      image: proxyImage,
      imageId: dockerImageId(proxyImage, "OPEN_SCIENCE_CADDY_IMAGE_ID"),
      caddyVersion: versions.caddyVersion,
    },
    skills: await currentSkills(),
    inputs: await currentInputs(),
    monitoring: versions.monitoring,
  };
  return validateReleaseManifest(manifest);
}

async function writeManifest(manifest) {
  const parent = path.dirname(manifestFile);
  await fsp.mkdir(parent, { recursive: true, mode: 0o755 });
  const existing = await fsp.lstat(manifestFile).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (existing?.isSymbolicLink()) fail("release_manifest_file_symlink", "Refusing to replace a symbolic-link manifest.");
  if (existing && !existing.isFile()) fail("release_manifest_file_not_regular", "Release manifest target must be a file.");

  const temp = `${manifestFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temp, "wx", 0o644);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, manifestFile);
    await fsp.chmod(manifestFile, 0o644);
  } finally {
    await handle?.close();
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

async function checkManifest(manifest, { images = false } = {}) {
  const pkg = JSON.parse(await read("package.json"));
  const versions = await currentVersions();
  if (manifest.app.name !== pkg.name || manifest.app.version !== pkg.version) {
    fail("release_manifest_app_mismatch", "Release manifest app metadata does not match package.json.");
  }
  if (
    manifest.runtime.opencodeVersion !== versions.opencodeVersion ||
    manifest.runtime.uvVersion !== versions.uvVersion ||
    manifest.proxy.caddyVersion !== versions.caddyVersion ||
    JSON.stringify(manifest.monitoring) !== JSON.stringify(versions.monitoring)
  ) {
    fail("release_manifest_version_mismatch", "Release manifest component versions do not match deployment sources.");
  }

  const expectedInputs = new Map((await currentInputs()).map((item) => [item.path, item.digest]));
  if (
    manifest.inputs.length !== expectedInputs.size ||
    manifest.inputs.some((item) => expectedInputs.get(item.path) !== item.digest)
  ) {
    fail("release_manifest_input_mismatch", "Release manifest input digests do not match the current source.");
  }

  const expectedSkills = new Map((await currentSkills()).map((skill) => [skill.source, skill]));
  if (
    manifest.skills.length !== expectedSkills.size ||
    manifest.skills.some((skill) => {
      const expected = expectedSkills.get(skill.source);
      return !expected || expected.name !== skill.name || expected.files !== skill.files || expected.digest !== skill.digest;
    })
  ) {
    fail("release_manifest_skill_mismatch", "Release manifest skill digests do not match the configured source packs.");
  }

  if (images) {
    if (dockerImageId(manifest.web.image, "OPEN_SCIENCE_WEB_IMAGE_ID") !== manifest.web.imageId) {
      fail("release_manifest_web_image_mismatch", "Web image id does not match the release manifest.");
    }
    if (dockerImageId(manifest.runtime.image, "OPEN_SCIENCE_RUNTIME_IMAGE_ID") !== manifest.runtime.imageId) {
      fail("release_manifest_runtime_image_mismatch", "Runtime image id does not match the release manifest.");
    }
    if (dockerImageId(manifest.proxy.image, "OPEN_SCIENCE_CADDY_IMAGE_ID") !== manifest.proxy.imageId) {
      fail("release_manifest_proxy_image_mismatch", "Caddy image id does not match the release manifest.");
    }
  }
}

async function main() {
  let manifest;
  if (checkOnly) {
    const loaded = readReleaseManifestFile(manifestFile);
    if (loaded.error || !loaded.manifest) fail(loaded.error ?? "release_manifest_missing", "Release manifest is invalid or missing.");
    manifest = loaded.manifest;
  } else {
    manifest = await buildManifest();
    await writeManifest(manifest);
  }
  await checkManifest(manifest, { images: verifyImages });
  const result = {
    ok: true,
    mode: checkOnly ? "check" : "generate",
    releaseId: manifest.app.releaseId,
    revision: manifest.source.revision,
    file: manifestFile,
    imagesVerified: verifyImages,
  };
  process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n` : `release manifest ${result.mode} ok: ${manifestFile}\n`);
}

main().catch((err) => {
  const code = err?.code ?? "release_manifest_failed";
  const message = err instanceof Error ? err.message : String(err);
  if (jsonOutput) process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
