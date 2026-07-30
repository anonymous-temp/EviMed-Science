import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function withoutRuntimeEnvironment(run) {
  const names = ["OPEN_SCIENCE_RUNTIME_MODE", "OPEN_SCIENCE_OPENCODE_BIN"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    await run();
  } finally {
    for (const name of names) {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("hosted development defaults to the bundled OpenCode runtime", async () => {
  await withoutRuntimeEnvironment(async () => {
    const config = loadConfig({ rootDir: repoRoot });
    assert.equal(config.runtimeMode, "opencode");
    assert.equal(config.modelGatewayTimeoutMs, 300_000);
    assert.match(
      config.opencodeBin,
      /apps\/desktop\/src-tauri\/binaries\/opencode-/,
    );
  });
});

test("a missing bundled binary remains a visible OpenCode startup failure", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "evimed-config-"));
  try {
    await withoutRuntimeEnvironment(async () => {
      const config = loadConfig({ rootDir });
      assert.equal(config.runtimeMode, "opencode");
      assert.notEqual(config.opencodeBin, "");
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("the mock runtime must be selected explicitly", async () => {
  const config = loadConfig({ rootDir: repoRoot, runtimeMode: "mock" });
  assert.equal(config.runtimeMode, "mock");
});

test("Materials Project credentials load from a private server-only file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-materials-config-"));
  try {
    const secret = path.join(root, "materials-project-api-key.txt");
    await writeFile(secret, "test-materials-project-key\n", { mode: 0o600 });
    const config = loadConfig({ rootDir: repoRoot, materialsProjectApiKeyFile: secret });
    assert.equal(config.materialsProjectApiKey, "test-materials-project-key");
    assert.equal(config.materialsProjectApiKeySource, "file");
    assert.equal(config.materialsProjectApiKeyError, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credentialed public-source adapters load server-only credentials from private files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-public-source-config-"));
  try {
    const secret = path.join(root, "umls-api-key.txt");
    await writeFile(secret, "test-umls-key\n", { mode: 0o600 });
    const config = loadConfig({ rootDir: repoRoot, umlsApiKeyFile: secret });
    assert.equal(config.publicSourceCredentials.umls, "test-umls-key");
    assert.equal(config.publicSourceCredentialSources.umls, "file");
    assert.equal(config.publicSourceCredentialErrors.umls, null);
    assert.equal(Object.keys(config.publicSourceCredentials).length, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EviMed evidence credentials load from a private server-only file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-evidence-config-"));
  try {
    const secret = path.join(root, "evimed-api-key.txt");
    await writeFile(secret, "test-evimed-key\n", { mode: 0o600 });
    const config = loadConfig({ rootDir: repoRoot, evimedApiKeyFile: secret });
    assert.equal(config.publicSourceCredentials.evimedEvidence, "test-evimed-key");
    assert.equal(config.publicSourceCredentialSources.evimedEvidence, "file");
    assert.equal(config.publicSourceCredentialErrors.evimedEvidence, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in local auto configuration loads mode-600 EviMed service secrets", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "evimed-local-config-"));
  try {
    const rootDir = path.join(parent, "OpenScience");
    const secretsDir = path.join(parent, ".evimed-local", "secrets");
    await Promise.all([mkdir(rootDir), mkdir(secretsDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(secretsDir, "deepseek.api-key"), "test-deepseek-key\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "evimed.api-key"), "test-evimed-key\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "model-gateway.signing"), "model-signing-secret-with-at-least-32-bytes\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "evimed-workload.signing"), "workload-signing-secret-with-at-least-32-bytes\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "memos.pat"), "test-memos-token\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "bootstrap-password"), "local-password-with-at-least-16-bytes\n", { mode: 0o600 }),
    ]);

    const disabled = loadConfig({ rootDir, localAutoConfig: false });
    assert.equal(disabled.deepseekProviderEnabled, false);
    assert.equal(disabled.memosUrl, "");

    const enabled = loadConfig({ rootDir, localAutoConfig: true });
    assert.equal(enabled.deepseekProviderEnabled, true);
    assert.equal(enabled.deepseekApiKeySource, "file");
    assert.equal(enabled.publicSourceCredentialSources.evimedEvidence, "file");
    assert.equal(enabled.modelGatewaySigningSecretSource, "file");
    assert.equal(enabled.evimedWorkloadSigningSecretSource, "file");
    assert.equal(enabled.memosAccessTokenSource, "file");
    assert.equal(enabled.memosUrl, "http://127.0.0.1:8081");
    assert.equal(enabled.bootstrapPasswordSource, "file");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the agent run monitor outlasts a systematic review by default", () => {
  assert.equal(loadConfig({ dataDir: "/tmp/os-config-monitor" }).agentRunMonitorTimeoutMs, 4 * 60 * 60_000);
});

test("the agent run monitor timeout is configurable", () => {
  const config = loadConfig({ dataDir: "/tmp/os-config-monitor", agentRunMonitorTimeoutMs: 90 * 60_000 });
  assert.equal(config.agentRunMonitorTimeoutMs, 90 * 60_000);
});
