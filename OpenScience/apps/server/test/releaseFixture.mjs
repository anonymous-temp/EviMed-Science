export const releaseManifestFixture = Object.freeze({
  schemaVersion: 2,
  app: {
    name: "evimed-science",
    version: "0.1.3",
    releaseId: "2026.07.10-test.1",
  },
  source: {
    revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-07-10T00:00:00.000Z",
  },
  web: {
    image: "open-science-web:0.1.3",
    imageId: `sha256:${"b".repeat(64)}`,
  },
  runtime: {
    image: "evimed-runtime-dsh:dsh-0.1.2-rc.1-uv-0.11.26",
    imageId: `sha256:${"a".repeat(64)}`,
    dshVersion: "0.1.2-rc.1",
    cordisVersion: "4.0.2",
    socketVersion: "0.1.0",
    domainVersion: "0.1.0",
    uvVersion: "0.11.26",
  },
  proxy: {
    image: "caddy:2.11.4-alpine",
    imageId: `sha256:${"e".repeat(64)}`,
    caddyVersion: "2.11.4-alpine",
  },
  skills: [
    {
      name: "core",
      source: "runtime/skills/core",
      files: 1,
      digest: `sha256:${"c".repeat(64)}`,
    },
    {
      name: "capability-skills",
      source: "capability-skills",
      files: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
    {
      name: "runtime-skills-community",
      source: "runtime/skills/community",
      files: 1,
      digest: `sha256:${"d".repeat(64)}`,
    },
    {
      name: "runtime-skills-external-ai4s-skills",
      source: "runtime/skills/external/ai4s-skills",
      files: 1,
      digest: `sha256:${"f".repeat(64)}`,
    },
    {
      name: "runtime-skills-curated-scientific",
      source: "runtime/skills/curated-scientific",
      files: 1,
      digest: `sha256:${"9".repeat(64)}`,
    },
    {
      name: "runtime-skills-office",
      source: "runtime/skills/office",
      files: 1,
      digest: `sha256:${"8".repeat(64)}`,
    },
  ],
  inputs: [
    {
      path: "package.json",
      digest: `sha256:${"d".repeat(64)}`,
    },
  ],
  monitoring: {
    prometheusVersion: "3.13.0",
    alertmanagerVersion: "0.33.1",
    blackboxExporterVersion: "0.28.0",
    grafanaVersion: "13.1.0",
  },
});

// A manifest describes one kernel, and readiness now says so when the
// deployment is on the other one. So each release fixture names the kernel it
// belongs to: a fixture that calls itself a ready production deployment while
// describing one kernel and running the other is not a baseline anything can be
// measured against, and it was only ever passing because nothing compared them.
export const productionReleaseConfig = Object.freeze({
  releaseManifest: releaseManifestFixture,
  materialsProjectApiKey: "test-materials-project-key",
  runtimeKernel: "opencode",
});

// Every provenance row `runtimeReleasePolicyError` compares, so a production
// config built from this fixture alone passes the release gate instead of
// failing on a field the test was not about. It used to name the retired
// kernel's version field, which the manifest no longer carries: the spread
// therefore set `opencodeVersion: undefined` and left `dshVersion` and
// `socketBundleVersion` missing, so every consumer had to re-add them.
export const runtimeReleaseConfig = Object.freeze({
  releaseManifest: releaseManifestFixture,
  materialsProjectApiKey: "test-materials-project-key",
  runtimeKernel: "opencode",
  runtimeContainerImage: releaseManifestFixture.runtime.image,
  dshVersion: releaseManifestFixture.runtime.dshVersion,
  socketBundleVersion: releaseManifestFixture.runtime.socketVersion,
  uvVersion: releaseManifestFixture.runtime.uvVersion,
});

// Kept as aliases: both names are imported across the suite, and one kernel
// means they now describe the same release rather than two.
export const dshReleaseManifestFixture = releaseManifestFixture;
export const dshProductionReleaseConfig = runtimeReleaseConfig;
