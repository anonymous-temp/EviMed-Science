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
    image: "open-science-opencode:opencode-1.17.13-uv-0.11.26",
    imageId: `sha256:${"a".repeat(64)}`,
    opencodeVersion: "1.17.13",
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

export const productionReleaseConfig = Object.freeze({
  releaseManifest: releaseManifestFixture,
  materialsProjectApiKey: "test-materials-project-key",
});

export const runtimeReleaseConfig = Object.freeze({
  releaseManifest: releaseManifestFixture,
  materialsProjectApiKey: "test-materials-project-key",
  runtimeContainerImage: releaseManifestFixture.runtime.image,
  opencodeVersion: releaseManifestFixture.runtime.opencodeVersion,
  uvVersion: releaseManifestFixture.runtime.uvVersion,
});

/**
 * The same release, published as the DSH kernel ships it. Two readiness
 * comparisons read a manifest's runtime row, and only one of them had learned
 * that a DSH manifest carries `dshVersion` instead of `opencodeVersion`; the
 * other compared against `undefined` and failed `release_manifest_mismatch` on
 * every DSH deployment. A fixture that only ever names one kernel cannot catch
 * that, which is why this one exists.
 */
export const dshReleaseManifestFixture = Object.freeze({
  ...releaseManifestFixture,
  runtime: Object.freeze({
    image: "evimed-runtime-dsh:dsh-0.1.1-rc.2-uv-0.11.26",
    imageId: `sha256:${"a".repeat(64)}`,
    dshVersion: "0.1.1-rc.2",
    cordisVersion: "4.0.1",
    socketVersion: "0.1.0",
    domainVersion: "0.1.0",
    uvVersion: "0.11.26",
  }),
});

export const dshProductionReleaseConfig = Object.freeze({
  releaseManifest: dshReleaseManifestFixture,
  materialsProjectApiKey: "test-materials-project-key",
  runtimeContainerImage: dshReleaseManifestFixture.runtime.image,
  dshVersion: dshReleaseManifestFixture.runtime.dshVersion,
  socketBundleVersion: dshReleaseManifestFixture.runtime.socketVersion,
  uvVersion: dshReleaseManifestFixture.runtime.uvVersion,
});
