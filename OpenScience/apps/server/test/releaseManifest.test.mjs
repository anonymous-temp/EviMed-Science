import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  digestDirectory,
  readReleaseManifestFile,
  runtimeReleasePolicyError,
  validateReleaseManifest,
} from "../src/releaseManifest.mjs";
import { releaseManifestFixture, runtimeReleaseConfig } from "./releaseFixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/generate-release-manifest.mjs");

const releaseEnv = {
  OPEN_SCIENCE_RELEASE_ID: "2026.07.10-release.1",
  OPEN_SCIENCE_SOURCE_REVISION: "1234567890abcdef1234567890abcdef12345678",
  OPEN_SCIENCE_BUILD_CREATED: "2026-07-10T03:00:00.000Z",
  OPEN_SCIENCE_WEB_CONTAINER_IMAGE: "registry.example.com/open-science-web:0.1.3",
  OPEN_SCIENCE_WEB_IMAGE_ID: `sha256:${"1".repeat(64)}`,
  OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE: "registry.example.com/open-science-runtime:dsh-0.1.2-alpha.3-uv-0.11.26",
  OPEN_SCIENCE_RUNTIME_IMAGE_ID: `sha256:${"2".repeat(64)}`,
  OPEN_SCIENCE_CADDY_VERSION: "2.11.4-alpine",
  OPEN_SCIENCE_CADDY_IMAGE_ID: `sha256:${"3".repeat(64)}`,
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
    // Every entry is digest-bound, not just whichever one sorts first — that
    // was the shape of the defect this list grew to close.
    for (const skill of manifest.skills) {
      assert.ok(skill.files > 0, `${skill.source} bound zero files`);
      assert.match(skill.digest, /^sha256:[a-f0-9]{64}$/, `${skill.source} has no content digest`);
    }
    // Everything shipped as model-facing instruction text, sorted by source.
    // `runtime/skills/community` is the fourth preset root the DSH image mounts
    // and `capability-skills` holds the bodies delegation pre-injects into every
    // child's prompt; both shipped bound by nothing, while
    // `runtime/skills/external/ai4s-skills` carried a digest and is not in the
    // DSH image at all. Binding a tree the running kernel ignores costs nothing;
    // shipping one it reads with no digest is the defect.
    assert.deepEqual(
      manifest.skills.map((skill) => skill.source),
      [
        "capability-skills",
        "runtime/skills/community",
        "runtime/skills/core",
        "runtime/skills/curated-scientific",
        "runtime/skills/external/ai4s-skills",
        "runtime/skills/office",
      ],
    );
    assert.deepEqual(
      manifest.inputs.map((item) => item.path),
      [
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
        // The three trees the runtime image COPYs and executes inside the
        // container, and the Dockerfile that puts them there. Unbound until
        // 2026-08-26, which is how a day of gate fixes reached the host and
        // never ran: the manifest could not say which code the image held.
        "packages/socket",
        "packages/domain",
        "packages/harness-port",
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
      ],
    );
    assert.deepEqual(manifest.monitoring, {
      prometheusVersion: "3.13.0",
      alertmanagerVersion: "0.33.1",
      blackboxExporterVersion: "0.28.0",
      grafanaVersion: "13.1.0",
    });
    assert.equal(JSON.stringify(manifest).includes(tmp), false);

    const checked = await runManifest(output, ["--check", "--verify-images", "--json"]);
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
