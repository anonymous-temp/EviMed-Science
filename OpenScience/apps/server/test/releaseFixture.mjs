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
