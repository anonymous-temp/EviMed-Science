import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  MAX_RELEASE_MANIFEST_INPUTS,
  digestDirectory,
  readReleaseManifestFile,
  runtimeReleasePolicyError,
  validateReleaseManifest,
} from "../src/releaseManifest.mjs";
import { verifyReleaseImages } from "../../../scripts/ops/verify-release-images.mjs";
import { releaseManifestFixture, runtimeReleaseConfig } from "./releaseFixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/generate-release-manifest.mjs");
const verifier = path.join(repoRoot, "scripts/ops/verify-release-images.mjs");
const execute = promisify(execFile);

const releaseEnv = {
  OPEN_SCIENCE_RELEASE_ID: "2026.07.10-release.1",
  OPEN_SCIENCE_SOURCE_REVISION: "1234567890abcdef1234567890abcdef12345678",
  OPEN_SCIENCE_BUILD_CREATED: "2026-07-10T03:00:00.000Z",
  OPEN_SCIENCE_WEB_CONTAINER_IMAGE: "registry.example.com/open-science-web:0.1.3",
  OPEN_SCIENCE_WEB_IMAGE_ID: `sha256:${"1".repeat(64)}`,
  OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE: "registry.example.com/open-science-runtime:dsh-0.2.2-rc.1-uv-0.11.26",
  OPEN_SCIENCE_RUNTIME_IMAGE_ID: `sha256:${"2".repeat(64)}`,
  OPEN_SCIENCE_CADDY_VERSION: "2.11.4-alpine",
  OPEN_SCIENCE_CADDY_IMAGE_ID: `sha256:${"3".repeat(64)}`,
  OPEN_SCIENCE_OPENLIST_IMAGE_ID: `sha256:${"7".repeat(64)}`,
  OPEN_SCIENCE_OPENVIKING_IMAGE_ID: `sha256:${"8".repeat(64)}`,
};

function runManifest(output, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, `--output=${output}`, ...args],
      { cwd: repoRoot, env: { ...process.env, ...releaseEnv, ...env } },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function localImageFixture(dir, manifest) {
  const images = Object.fromEntries([manifest.web, manifest.runtime, manifest.proxy, ...manifest.services].map((entry) => [
    entry.image, { Id: entry.imageId, RepoDigests: entry.image.includes("@") ? [entry.image] : [] },
  ]));
  const file = path.join(dir, "local-images.json");
  await writeFile(path.join(dir, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "info") {
  process.stdout.write(process.env.FIXTURE_DOCKER_DRIVER_STATUS || "[]");
} else if (args[0] === "image" && args[1] === "save") {
  if (!process.env.FIXTURE_DOCKER_ARCHIVE || args[2] !== process.env.FIXTURE_MANIFEST_DIGEST) process.exit(1);
  fs.createReadStream(process.env.FIXTURE_DOCKER_ARCHIVE).pipe(process.stdout);
} else if (args[0] === "image" && args[1] === "inspect") {
  const images = JSON.parse(fs.readFileSync(process.env.FIXTURE_LOCAL_IMAGES));
  const info = images[args.at(-1)];
  if (!info) { process.stderr.write("No such image"); process.exit(1); }
  process.stdout.write(JSON.stringify(info));
} else process.exit(1);
`, { mode: 0o755 });
  await writeFile(path.join(dir, "ctr"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(" ") !== "-n moby content get " + process.env.FIXTURE_MANIFEST_DIGEST || !process.env.FIXTURE_CTR_CONTENT) process.exit(1);
process.stdout.write(process.env.FIXTURE_CTR_CONTENT);
`, { mode: 0o755 });
  const save = () => writeFile(file, JSON.stringify(images));
  await save();
  const env = { OPEN_SCIENCE_RUNTIME_CONTAINER_BIN: path.join(dir, "docker"), FIXTURE_LOCAL_IMAGES: file,
    PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  return { images, env, save };
}

test("an enabled VCR release records its exact engine image and rejects a missing identity", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "release-vcr-image-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const output = path.join(tmp, "manifest.json");
  const env = { OPEN_SCIENCE_VCR_ENABLED: "true", EVIMED_VCR_ENGINE_IMAGE: "evimed-vcr-engine:tested",
    OPEN_SCIENCE_VCR_ENGINE_IMAGE_ID: `sha256:${"9".repeat(64)}` };
  await runManifest(output, [], env);
  const manifest = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(manifest.services.find(value => value.name === "vcr-engine"), {
    name: "vcr-engine", image: env.EVIMED_VCR_ENGINE_IMAGE, imageId: env.OPEN_SCIENCE_VCR_ENGINE_IMAGE_ID,
  });
  await runManifest(output, ["--check"], env);
  await assert.rejects(runManifest(output, ["--check"], { ...env, EVIMED_VCR_ENGINE_IMAGE: "evimed-vcr-engine:other" }));
  await assert.rejects(runManifest(output, [], { ...env, EVIMED_VCR_ENGINE_IMAGE: "" }));

  const local = await localImageFixture(tmp, manifest);
  const payload = JSON.stringify({ schemaVersion: 2, layers: [], config: { digest: env.OPEN_SCIENCE_VCR_ENGINE_IMAGE_ID } });
  const hex = createHash("sha256").update(payload).digest("hex");
  const target = `sha256:${hex}`;
  const blob = `blobs/sha256/${hex}`;
  const archive = path.join(tmp, "image.tar");
  await mkdir(path.join(tmp, "blobs/sha256"), { recursive: true });
  await writeFile(path.join(tmp, blob), payload);
  await execute("tar", ["-cf", archive, "-C", tmp, blob]);
  const verifyEnv = { ...env, ...local.env, FIXTURE_MANIFEST_DIGEST: target };

  async function verifyBoth(imagesEnv, errorCode) {
    const checks = [
      () => runManifest(output, ["--check", "--verify-images"], imagesEnv),
      () => execute(process.execPath, [verifier, `--manifest=${output}`], { env: { ...process.env, ...imagesEnv } }),
    ];
    for (const check of checks) {
      if (errorCode) await assert.rejects(check, (error) => error.stderr.startsWith(`${errorCode}:`));
      else await check();
    }
  }

  local.images[env.EVIMED_VCR_ENGINE_IMAGE] = { Id: target, Descriptor: { digest: target } };
  await local.save();
  await verifyBoth({ ...verifyEnv, FIXTURE_DOCKER_ARCHIVE: archive });
  await verifyBoth({ ...verifyEnv, FIXTURE_CTR_CONTENT: payload });
  // A readable JSON blob with the wrong hash cannot stand in for the inspected manifest.
  await verifyBoth({ ...verifyEnv, FIXTURE_CTR_CONTENT: `${payload}\n` }, "release_image_unverified");
  await verifyBoth(verifyEnv, "release_image_unverified");

  local.images[env.EVIMED_VCR_ENGINE_IMAGE] = { Id: target }; // Docker API < 1.48
  await local.save();
  await verifyBoth({ ...verifyEnv, FIXTURE_CTR_CONTENT: payload,
    FIXTURE_DOCKER_DRIVER_STATUS: JSON.stringify([["driver-type", "io.containerd.snapshotter.v1"]]) });

  const engine = manifest.services.find(({ name }) => name === "vcr-engine");
  engine.imageId = `sha256:${"a".repeat(64)}`;
  await writeFile(output, JSON.stringify(manifest));
  await verifyBoth({ ...verifyEnv, FIXTURE_DOCKER_ARCHIVE: archive,
    FIXTURE_DOCKER_DRIVER_STATUS: JSON.stringify([["driver-type", "io.containerd.snapshotter.v1"]]) }, "release_image_mismatch");

  engine.imageId = target;
  await writeFile(output, JSON.stringify(manifest));
  await verifyBoth(verifyEnv);
  delete local.images[env.EVIMED_VCR_ENGINE_IMAGE];
  await local.save();
  await verifyBoth(verifyEnv, "release_image_missing");
});

test("release manifest generator records exact images, tools, skills, and source inputs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-release-"));
  const output = path.join(tmp, "release-manifest.json");
  try {
    const generated = await runManifest(output, ["--json"]);
    const result = JSON.parse(generated.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "generate");
    assert.equal(result.imagesVerified, false);

    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.app.name, "evimed-science");
    assert.equal(manifest.app.releaseId, releaseEnv.OPEN_SCIENCE_RELEASE_ID);
    assert.equal(manifest.source.revision, releaseEnv.OPEN_SCIENCE_SOURCE_REVISION);
    assert.deepEqual(manifest.web, {
      image: releaseEnv.OPEN_SCIENCE_WEB_CONTAINER_IMAGE,
      imageId: releaseEnv.OPEN_SCIENCE_WEB_IMAGE_ID,
    });
    assert.equal(manifest.runtime.image, releaseEnv.OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE);
    assert.equal(manifest.runtime.imageId, releaseEnv.OPEN_SCIENCE_RUNTIME_IMAGE_ID);
    // The runtime image records the kernel it carries and the socket bundle
    // installed into it: a receipt naming a different bundle than the image
    // declares is a receipt graded by rules nobody shipped.
    const deps = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));
    assert.equal(manifest.runtime.dshVersion, deps.dsh.version);
    assert.equal(manifest.runtime.cordisVersion, deps.dsh.cordis);
    assert.equal(manifest.runtime.socketVersion, "0.1.0");
    assert.equal(manifest.runtime.domainVersion, "0.1.0");
    assert.equal(manifest.runtime.uvVersion, "0.11.26");
    assert.ok(!("opencodeVersion" in manifest.runtime), "a generated manifest names the kernel that is shipping");
    assert.deepEqual(manifest.proxy, {
      image: "caddy:2.11.4-alpine",
      imageId: releaseEnv.OPEN_SCIENCE_CADDY_IMAGE_ID,
      caddyVersion: "2.11.4-alpine",
    });
    assert.deepEqual(manifest.services, [
      { name: "openlist", image: `${deps.openlist.image}:v${deps.openlist.version}@${deps.openlist.imageDigest}`, imageId: releaseEnv.OPEN_SCIENCE_OPENLIST_IMAGE_ID },
      // The recall index joined the base stack on 2026-09-11, so a release now
      // records which index image served it: the vectors are derived, but which
      // build produced them is not recoverable from the data.
      { name: "openviking", image: `${deps.openviking.image}:${deps.openviking.imageTag}@${deps.openviking.imageDigest}`, imageId: releaseEnv.OPEN_SCIENCE_OPENVIKING_IMAGE_ID },
    ]);
    // Admit the generator's real mixture of local builds, Caddy and registry-pinned services.
    const localIds = new Map([
      [releaseEnv.OPEN_SCIENCE_WEB_CONTAINER_IMAGE, releaseEnv.OPEN_SCIENCE_WEB_IMAGE_ID],
      [releaseEnv.OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE, releaseEnv.OPEN_SCIENCE_RUNTIME_IMAGE_ID],
      [manifest.proxy.image, releaseEnv.OPEN_SCIENCE_CADDY_IMAGE_ID],
      [manifest.services[0].image, releaseEnv.OPEN_SCIENCE_OPENLIST_IMAGE_ID],
      [manifest.services[1].image, releaseEnv.OPEN_SCIENCE_OPENVIKING_IMAGE_ID],
    ]);
    assert.deepEqual(verifyReleaseImages(manifest, (image) => ({
      Id: localIds.get(image), RepoDigests: image.includes("@") ? [image] : [],
    })), ["web", "runtime", "caddy", "openlist", "openviking"]);
    // Every entry is digest-bound, not just whichever one sorts first — that
    // was the shape of the defect this list grew to close.
    for (const skill of manifest.skills) {
      assert.ok(skill.files > 0, `${skill.source} bound zero files`);
      assert.match(skill.digest, /^sha256:[a-f0-9]{64}$/, `${skill.source} has no content digest`);
    }
    // Everything shipped as model-facing instruction text, sorted by source.
    // `runtime/skills/community` is a preset root the DSH image mounts and
    // `capability-skills` holds the bodies delegation pre-injects into every
    // child's prompt; both once shipped bound by nothing, while
    // `runtime/skills/external/ai4s-skills` carried a digest. That tree served
    // only the OpenCode delivery path (deleted 2026-09-01) and is in no DSH
    // image, so it is not recorded.
    assert.deepEqual(
      manifest.skills.map((skill) => skill.source),
      [
        "capability-skills",
        "runtime/skills/community",
        "runtime/skills/core",
        "runtime/skills/curated-scientific",
        "runtime/skills/geo-private",
        "runtime/skills/office",
      ],
    );
    assert.deepEqual(
      manifest.inputs.map((item) => item.path),
      [
        "package.json",
        "deps-version.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "apps/web/package.json",
        "apps/web/index.html",
        "apps/web/public",
        "apps/web/postcss.config.js",
        "apps/web/tailwind.config.js",
        "apps/web/tsconfig.json",
        "apps/web/vite.config.ts",
        "apps/web/src",
        "apps/server/package.json",
        "apps/server/src",
        "packages/shared/package.json",
        "packages/shared/src",
        // The three trees the runtime image COPYs and executes inside the
        // container, and the Dockerfile that puts them there. Unbound until
        // 2026-08-26, which is how a day of gate fixes reached the host and
        // never ran: the manifest could not say which code the image held.
        "packages/socket",
        "packages/domain",
        // The web image COPYs the longitudinal forecast candidates the server reads (deploy/web/Dockerfile).
        "packages/contracts/healthflux/candidates.json",
        "packages/design-tokens",
        "packages/harness-port",
        "packages/research-plugin-runtime",
        "packages/virtual-trial",
        "packages/virtual-cohort",
        "packages/virtual-patient",
        "packages/synthetic-control",
        "packages/virtual-research-suite",
        // The independent search-topics bundle the runtime image COPYs whole and installs as a host plugin (merge of the Gitee main, 2026-10-31).
        "packages/search-topics",
        "deploy/runtime-dsh",
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
        "scripts/vcr",
        "examples/climate-trends",
        "deploy/web/Dockerfile",
        "deploy/web/postgres-backup-status",
        "deploy/web/openviking-backup-status",
        "deploy/openlist",
        "deploy/specialist-adapter",
        "deploy/host",
        "scripts/ops/archive-crypto.mjs",
        "scripts/ops/backup-archive.mjs",
        "scripts/ops/backup_integrity.py",
        "scripts/ops/backup-data.sh",
        "scripts/ops/backup-retention.mjs",
        "scripts/ops/backup-scheduler.mjs",
        "scripts/ops/vcr-backup.mjs",
        "scripts/ops/vcr-backup-process.mjs",
        "scripts/ops/vcr-backup-references.mjs",
        "scripts/ops/vcr-restore-drill.mjs",
        "scripts/ops/recovery-volume.py",
        "scripts/ops/postgres-backup.py",
        "scripts/ops/configure-backup.mjs",
        "scripts/ops/configure-local-auth.mjs",
        "scripts/ops/configure-production-state.mjs",
        "scripts/ops/openviking-configuration.mjs",
        "scripts/ops/openviking-backup.mjs",
        "scripts/ops/object-backup.mjs",
        "scripts/ops/restore-data.sh",
        "scripts/ops/restore-drill.sh",
        "scripts/ops/configure-oidc.mjs",
        "scripts/ops/host-preflight.mjs",
        "scripts/ops/verify-release-images.mjs",
        "scripts/ops/result-replay-deployment.mjs",
        "scripts/ops/result-replay-image-smoke.mjs",
        "scripts/ops/export-extension-acceptance-inputs.mjs",
        "scripts/ops/extension-acceptance-archive.py",
        "scripts/ops/image-archive-inventory.py",
        "scripts/ops/hosted-production-e2e.mjs",
        "scripts/ops/audit-saas-alignment.mjs",
        "deploy/web/docker-compose.yml",
        "deploy/web/docker-compose.backup.yml",
        "deploy/web/docker-compose.vcr-backup.yml",
        "deploy/web/docker-compose.engine-keyless.yml",
      "deploy/web/docker-compose.result-replay.yml",
        "deploy/web/docker-compose.local-auth.yml",
        "deploy/web/docker-compose.oidc.yml",
        "deploy/web/docker-compose.saas.yml",
        "deploy/web/docker-compose.monitoring.yml",
        "deploy/web/docker-compose.ingestion.yml",
        "deploy/web/saas-capability-contract.json",
        "deploy/web/Caddyfile",
        "deploy/web/openviking",
        "deploy/web/monitoring/prometheus.json",
        "deploy/web/monitoring/open-science.rules.json",
        "docs/WEB_OPERATIONS_RUNBOOK.md",
        "docs/WEB_PRIVACY_AND_COMPLIANCE.md",
        "docs/WEB_SECURITY_INCIDENT_RESPONSE.md",
        "docs/SAAS_PRODUCT_ALIGNMENT.md",
        "docs/DRUG_EVIDENCE_AGENT_ARCHITECTURE.md",
      ],
    );
    assert.deepEqual(manifest.monitoring, {
      prometheusVersion: "3.13.0",
      alertmanagerVersion: "0.33.1",
      blackboxExporterVersion: "0.28.0",
      grafanaVersion: "13.1.0",
    });
    assert.equal(JSON.stringify(manifest).includes(tmp), false);

    const local = await localImageFixture(tmp, manifest);
    const checked = await runManifest(output, ["--check", "--verify-images", "--json"], local.env);
    assert.equal(JSON.parse(checked.stdout).imagesVerified, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("release source directory digests detect content, file-set, and symlink drift", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-release-input-"));
  const source = path.join(tmp, "src");
  try {
    await mkdir(source);
    await writeFile(path.join(source, "a.mjs"), "export const value = 1;\n", "utf8");
    const initial = await digestDirectory(source, { errorPrefix: "release_input" });
    await writeFile(path.join(source, "a.mjs"), "export const value = 2;\n", "utf8");
    const contentChanged = await digestDirectory(source, { errorPrefix: "release_input" });
    assert.notEqual(contentChanged.digest, initial.digest);

    await writeFile(path.join(source, "b.mjs"), "export const added = true;\n", "utf8");
    const fileAdded = await digestDirectory(source, { errorPrefix: "release_input" });
    assert.equal(fileAdded.files, 2);
    assert.notEqual(fileAdded.digest, contentChanged.digest);

    await rm(path.join(source, "b.mjs"));
    const fileRemoved = await digestDirectory(source, { errorPrefix: "release_input" });
    assert.equal(fileRemoved.files, 1);
    assert.equal(fileRemoved.digest, contentChanged.digest);

    await symlink(path.join(source, "a.mjs"), path.join(source, "linked.mjs"));
    await assert.rejects(
      digestDirectory(source, { errorPrefix: "release_input" }),
      (error) => error?.code === "release_input_symlink",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("release manifest check detects source digest drift", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-release-"));
  const output = path.join(tmp, "release-manifest.json");
  try {
    await runManifest(output);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    manifest.inputs[0].digest = `sha256:${"f".repeat(64)}`;
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => runManifest(output, ["--check"]),
      (err) => {
        assert.match(err.stderr, /release_manifest_input_mismatch/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The shared fixture is what every other suite builds a production config from,
// and it named the retired kernel's version field: the spread set
// `opencodeVersion: undefined` and left `dshVersion` and `socketBundleVersion`
// missing, so a config built from it alone failed `release_manifest_mismatch`
// on a row the test using it was never about, and each consumer re-added the
// two rows by hand.
test("the shared release fixture carries every provenance row the release gate compares", () => {
  const config = { ...runtimeReleaseConfig, production: true };
  assert.equal(runtimeReleasePolicyError(config), null);
  assert.equal("opencodeVersion" in runtimeReleaseConfig, false, "the fixture must not name the retired kernel");

  // Negative control: the gate is running, so the pass above is a pass and not
  // a comparison that never happened.
  assert.deepEqual(
    runtimeReleasePolicyError({ ...config, dshVersion: "9.9.9-alpha.1" }),
    { code: "release_manifest_mismatch", field: "dshVersion" },
  );
  assert.deepEqual(
    runtimeReleasePolicyError({ ...config, socketBundleVersion: "9.9.9" }),
    { code: "release_manifest_mismatch", field: "socketBundleVersion" },
  );
});

test("release manifest validation rejects unpinned images and undeclared fields", () => {
  const latest = structuredClone(releaseManifestFixture);
  latest.runtime.image = "open-science-runtime:latest";
  assert.throws(
    () => validateReleaseManifest(latest),
    (err) => err?.code === "release_manifest_image_unpinned",
  );

  const secret = structuredClone(releaseManifestFixture);
  secret.providerApiKey = "should-never-be-recorded";
  assert.throws(
    () => validateReleaseManifest(secret),
    (err) => err?.code === "release_manifest_fields_invalid",
  );
});

test("release source inputs accept the exact capacity and refuse one additional binding", async (t) => {
  const manifest = structuredClone(releaseManifestFixture);
  manifest.inputs = Array.from({ length: MAX_RELEASE_MANIFEST_INPUTS }, (_, index) => ({
    path: `packages/release-source-${index}`, digest: `sha256:${"d".repeat(64)}`,
  }));
  assert.equal(validateReleaseManifest(manifest), manifest);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "release-input-capacity-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const output = path.join(tmp, "manifest.json");
  await writeFile(output, JSON.stringify(manifest));
  assert.deepEqual(readReleaseManifestFile(output).manifest, manifest);

  const overflow = structuredClone(manifest);
  overflow.inputs.push({ path: "packages/one-too-many", digest: `sha256:${"e".repeat(64)}` });
  assert.throws(() => validateReleaseManifest(overflow), { code: "release_manifest_inputs_invalid" });

  // The last newly admitted row still receives every source-binding guard.
  for (const [entry, code] of [
    [{ ...manifest.inputs.at(-1), path: "../outside" }, "release_manifest_input_path_invalid"],
    [{ ...manifest.inputs.at(-1), path: manifest.inputs[0].path }, "release_manifest_input_duplicate"],
    [{ ...manifest.inputs.at(-1), digest: "sha256:invalid" }, "release_manifest_digest_invalid"],
  ]) {
    const invalid = structuredClone(manifest);
    invalid.inputs[MAX_RELEASE_MANIFEST_INPUTS - 1] = entry;
    assert.throws(() => validateReleaseManifest(invalid), { code });
  }

  // Valid JSON and an admitted row count cannot bypass the independent byte bound.
  await writeFile(output, `${" ".repeat(128 * 1024)}${JSON.stringify(manifest)}`);
  assert.equal(readReleaseManifestFile(output).error, "release_manifest_file_too_large");
});

test("release manifest reader refuses symbolic links", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-release-"));
  const target = path.join(tmp, "target.json");
  const link = path.join(tmp, "release-manifest.json");
  try {
    await writeFile(target, `${JSON.stringify(releaseManifestFixture)}\n`, "utf8");
    await symlink(target, link);
    const loaded = readReleaseManifestFile(link);
    assert.equal(loaded.manifest, null);
    assert.equal(loaded.error, "release_manifest_file_symlink");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("node_modules is not part of a source digest, and every other symlink still fails the walk", async () => {
  // `packages/socket` and its two siblings became manifest inputs so a release
  // can say which code the runtime image contains. Each carries a pnpm
  // `node_modules` whose workspace entries are symlinks, so the walk hit the
  // symlink guard and `pnpm release:manifest` failed outright — the whole
  // server suite went red on it. The image installs its own dependencies, so
  // these bytes are not what it runs.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-skipdirs-"));
  try {
    const source = path.join(tmp, "pkg");
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src/index.mjs"), "export const shipped = true;\n", "utf8");
    const before = await digestDirectory(source, { errorPrefix: "release_input" });
    assert.equal(before.files, 1);

    // A pnpm workspace link: a *symlinked* node_modules, which is what pnpm
    // actually creates. Skipped by name before the lstat, so never followed.
    await mkdir(path.join(tmp, "elsewhere"), { recursive: true });
    await writeFile(path.join(tmp, "elsewhere/dep.mjs"), "export const dep = 1;\n", "utf8");
    await symlink(path.join(tmp, "elsewhere"), path.join(source, "node_modules"));

    const after = await digestDirectory(source, { errorPrefix: "release_input" });
    assert.equal(after.files, 1, "node_modules must contribute no files");
    assert.equal(after.digest, before.digest, "and must not change the digest");

    // The control. Skipping node_modules must not have retired the guard: any
    // other symlink still fails, because that is what stops a link from binding
    // a digest to bytes outside the tree.
    await symlink(path.join(tmp, "elsewhere/dep.mjs"), path.join(source, "src/linked.mjs"));
    await assert.rejects(
      digestDirectory(source, { errorPrefix: "release_input" }),
      (error) => error?.code === "release_input_symlink",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("configured aggregate replay binds its exact image independently of native VCR", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "release-replay-image-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const output = path.join(tmp, "manifest.json");
  const env = { OPEN_SCIENCE_RESULT_ENGINE_URL: "http://result-replay:8031",
    OPEN_SCIENCE_RESULT_REPLAY_IMAGE: "evimed-result-replay:qualified-revision",
    OPEN_SCIENCE_RESULT_REPLAY_IMAGE_ID: `sha256:${"a".repeat(64)}`, OPEN_SCIENCE_VCR_ENABLED: "false" };
  await runManifest(output, [], env);
  const manifest = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(manifest.services.find(value => value.name === "result-replay"), {
    name: "result-replay", image: env.OPEN_SCIENCE_RESULT_REPLAY_IMAGE, imageId: env.OPEN_SCIENCE_RESULT_REPLAY_IMAGE_ID,
  });
  assert.equal(manifest.services.some(value => value.name === "vcr-engine"), false);
  const local = await localImageFixture(tmp, manifest);
  const differentId = `sha256:${"b".repeat(64)}`;
  await runManifest(output, ["--check", "--verify-images"], { ...env, ...local.env, OPEN_SCIENCE_RESULT_REPLAY_IMAGE_ID: differentId });
  local.images[env.OPEN_SCIENCE_RESULT_REPLAY_IMAGE].Id = differentId;
  await local.save();
  await assert.rejects(runManifest(output, ["--check", "--verify-images"], { ...env, ...local.env }),
    (error) => error.stderr.startsWith("release_image_mismatch:"));
  await assert.rejects(runManifest(output, ["--check"], { ...env, OPEN_SCIENCE_RESULT_ENGINE_URL: "" }));
  await assert.rejects(runManifest(output, [], { ...env, OPEN_SCIENCE_RESULT_REPLAY_IMAGE: "" }));
  await assert.rejects(runManifest(output, [], { ...env, OPEN_SCIENCE_RESULT_REPLAY_IMAGE: "evimed-result-replay:latest" }));
});
