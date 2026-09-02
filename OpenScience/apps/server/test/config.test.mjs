import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("the runtime mode defaults to a real kernel rather than a mock", async () => {
  // It used to default to "opencode" and point at a bundled binary. There is
  // one kernel now and it ships inside the runtime image, so what remains
  // worth asserting is that the default is the real thing: a default of "mock"
  // would make a deployment answer every question convincingly without ever
  // running an agent.
  await withoutRuntimeEnvironment(async () => {
    const config = loadConfig({ rootDir: repoRoot });
    assert.equal(config.runtimeMode, "kernel");
    assert.equal(config.modelGatewayTimeoutMs, 300_000);
  });
});

test("memory extraction is given longer than one extraction actually takes", () => {
  // Measured against deepseek-v4-pro, one extraction request takes 40-46s. At
  // the previous 30s budget every request aborted, so the store only ever held
  // raw run summaries and never a single extracted memory. The failure was
  // silent because an aborted extraction and an empty one both reported zero.
  const config = loadConfig({ rootDir: repoRoot });
  assert.ok(
    config.memoryExtractionTimeoutMs >= 60_000,
    `memory extraction budget ${config.memoryExtractionTimeoutMs}ms is below one measured request`,
  );
});

test("the retired kernel's runtime mode is refused by name, not ignored", async () => {
  // The value "opencode" meant "a real kernel in a container" back when there
  // was only one. A deployment still setting it is configuring something this
  // build does not contain, and accepting it silently would leave that
  // deployment believing it had chosen something.
  await withoutRuntimeEnvironment(async () => {
    assert.throws(
      () => loadConfig({ rootDir: repoRoot, runtimeMode: "opencode" }),
      /OPEN_SCIENCE_RUNTIME_MODE no longer accepts "opencode"/,
      "the retired value must name its replacement rather than being aliased away",
    );
  });
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
    // Named, not counted. A bare count told you a number had changed and
    // nothing about which credential appeared or vanished -- and a rename
    // would have kept it passing.
    assert.deepEqual(Object.keys(config.publicSourceCredentials).sort(), [
      "addgene",
      "core",
      "evimedEvidence",
      "ncbi",      // rate ceiling, not authorization: injected by host
      "omim",
      "openFda",   // same
      "opengwas",
      "semanticScholar",
      "umls",
      "unpaywall",
      "biogrid",
    ].sort());
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

// The shipped default is a posture, not a preference, so it is pinned by a test
// rather than left to whoever edits the file next.
//
// It read `opencode` "until the DSH session view lands", and that condition was
// met on 2026-08-31: the session layer was accepted on a real DSH run — 3981
// frames, terminal `succeeded`, a reconnect at seq 40 that lost and repeated
// nothing. So this now pins the other side.
//
// The environment variable is the rollback lever for the change window, and it
// is the only reason the appendix-B trees still exist. Deleting them in the same
// change as the flip would have removed every way back in the same second the
// switch was thrown; they are frozen instead, and come out in their own change
// after the quiet period. A frozen rollback lever is not a second stack.
test("the kernel is not selectable, and the variable that used to select it is refused", () => {
  // This file used to assert that OPEN_SCIENCE_RUNTIME_KERNEL=opencode still
  // worked, with the note "if this stops working the appendix-B deletion has
  // effectively happened already". It has happened: the product owner dropped
  // the rollback requirement, and the second kernel is gone.
  //
  // So the assertion inverts. A deployment still exporting that variable is
  // reaching for a lever that no longer exists, and it must be told rather than
  // have its setting quietly do nothing -- which is what the whole suite spent
  // this migration learning to detect.
  const saved = process.env.OPEN_SCIENCE_RUNTIME_KERNEL;
  delete process.env.OPEN_SCIENCE_RUNTIME_KERNEL;
  try {
    assert.equal(loadConfig({ dataDir: "/tmp/os-config-kernel" }).runtimeKernel, undefined);
    process.env.OPEN_SCIENCE_RUNTIME_KERNEL = "opencode";
    assert.throws(
      () => loadConfig({ dataDir: "/tmp/os-config-kernel" }),
      /OPEN_SCIENCE_RUNTIME_KERNEL/,
    );
  } finally {
    if (saved == null) delete process.env.OPEN_SCIENCE_RUNTIME_KERNEL;
    else process.env.OPEN_SCIENCE_RUNTIME_KERNEL = saved;
  }
});
