// What `pnpm configure:production-state` writes, and what `--check` refuses.
//
// The recall index reads one JSON file for its entire configuration, and four
// of its defaults are wrong for this deployment in ways that are silent: the
// data path lands outside the volume, a root key without an explicit auth mode
// selects a different mode, the `openai` embedding provider never sends
// `dimensions`, and the server's own extractor writes memories beside ours.
// That file is therefore rendered from the pins rather than written by hand,
// and this test is what keeps the rendering honest.
//
// No real key is used anywhere here: the DashScope credential is a fixture
// string, and nothing in this file prints the contents of a generated file.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(root, "scripts/ops/configure-production-state.mjs");
const execFileAsync = promisify(execFile);

/**
 * A stand-in for the operator-supplied key: the right shape, and no value.
 *
 * `example` is load-bearing, not decoration. `audit:source-secrets` reads this
 * repository as text and flags any `sk-`-prefixed literal that does not say of
 * itself that it is one — which is the correct rule, because a scanner that
 * exempted key-shaped strings in test files would exempt the place a real key
 * is most likely to be pasted.
 */
const DASHSCOPE_FIXTURE_KEY = "sk-example-0123456789abcdef0123";

async function secretsDirectory() {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "evimed-production-state-"));
  const keyFile = path.join(directory, "dashscope.api-key");
  await writeFile(keyFile, DASHSCOPE_FIXTURE_KEY);
  await chmod(keyFile, 0o600);
  return { directory, keyFile };
}

function environment(directory, keyFile) {
  return {
    ...process.env,
    OPEN_SCIENCE_PRODUCTION_STATE_SECRETS_DIR: directory,
    OPEN_SCIENCE_DASHSCOPE_API_KEY_HOST_FILE: keyFile,
  };
}

async function run(args, env) {
  return execFileAsync(process.execPath, [script, ...args], { cwd: root, env });
}

test("the rendered index configuration overrides every default that is wrong here", async () => {
  const { directory, keyFile } = await secretsDirectory();
  try {
    await run([], environment(directory, keyFile));
    const confFile = path.join(directory, "openviking-ov.conf");
    const apiKeyFile = path.join(directory, "openviking-api-key.txt");
    const configuration = JSON.parse(await readFile(confFile, "utf8"));
    const pin = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8")).openviking;

    // The workspace default is `./data`, resolved against /app — outside the
    // volume, so every record would vanish with the container.
    assert.equal(configuration.storage.workspace, "/app/.openviking/data");
    assert.equal(configuration.storage.agfs.backend, "local");
    assert.equal(configuration.storage.vectordb.backend, "local");
    assert.equal(configuration.storage.vectordb.dimension, pin.embedding.dimension);

    // Omitting auth_mode while setting a root key gives `api_key` mode, whose
    // identity rules are not the ones this client speaks.
    assert.equal(configuration.server.auth_mode, "trusted");
    assert.equal(configuration.server.host, "0.0.0.0");
    assert.equal(configuration.server.port, 1933);
    assert.deepEqual(configuration.server.cors_origins, []);
    // The index's own key is the one this deployment generated for it, so the
    // control plane and the server cannot end up holding different keys.
    assert.equal(configuration.server.root_api_key, (await readFile(apiKeyFile, "utf8")).trim());

    // Provider `openai` never sends `dimensions`; `dashscope` with the text
    // input does, and appends `/compatible-mode/v1` to this host itself.
    assert.equal(configuration.embedding.dense.provider, "dashscope");
    assert.equal(configuration.embedding.dense.input, "text");
    assert.equal(configuration.embedding.dense.api_base, pin.embedding.apiBase);
    assert.equal(configuration.embedding.dense.model, pin.embedding.model);
    assert.equal(configuration.embedding.dense.dimension, pin.embedding.dimension);
    assert.equal(configuration.embedding.dense.api_key, DASHSCOPE_FIXTURE_KEY);

    // The server's extractor would write memories our evidence gate never saw.
    assert.equal(configuration.memory.extraction_enabled, false);
    assert.equal(configuration.memory.session_skill_extraction_enabled, false);
    assert.equal(configuration.allow_private_networks, false);

    // No rerank section at all: `/search/find` is the only endpoint this
    // layout can use and it never reranks, so a section here would buy nothing
    // and would put a second credential in this file.
    assert.ok(!("rerank" in configuration), "the index must not be configured to rerank");
    assert.ok(!("vlm" in configuration));

    if (process.platform !== "win32") {
      assert.equal((await stat(confFile)).mode & 0o777, 0o600);
      assert.equal((await stat(apiKeyFile)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("what is rendered does not depend on the shell that rendered it", async () => {
  // `--check` compares the whole file byte for byte, so any value read from the
  // ambient environment turns a difference between two shells into a report
  // that two credentials disagree — and the remedy that message gives is to
  // delete the file. The account is the one that was: it selects nothing here,
  // because trusted mode makes the client name an account on every request.
  const { directory, keyFile } = await secretsDirectory();
  try {
    await run([], environment(directory, keyFile));
    const configuration = JSON.parse(await readFile(path.join(directory, "openviking-ov.conf"), "utf8"));
    assert.equal(configuration.default_account, "evimed");
    assert.equal(configuration.default_user, "evimed");
    await run(["--check"], { ...environment(directory, keyFile), OPEN_SCIENCE_OPENVIKING_ACCOUNT: "another-tenant" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--check passes on what it just wrote and fails when the rendering would differ", async () => {
  const { directory, keyFile } = await secretsDirectory();
  try {
    await run([], environment(directory, keyFile));
    await run(["--check"], environment(directory, keyFile));

    // A rotated key with a stale ov.conf is the failure this catches: the
    // index would keep embedding with a credential nobody can revoke, and
    // every probe of the deployment would still be green.
    await writeFile(keyFile, "sk-example-fedcba9876543210fedcba");
    await chmod(keyFile, 0o600);
    const rejected = await run(["--check"], environment(directory, keyFile)).then(
      () => null,
      (error) => error,
    );
    assert.ok(rejected, "a configuration rendered from a different key was accepted");
    assert.match(String(rejected.stderr), /production_state_openviking_conf_mismatch/);
    // Named, never shown: this file holds two credentials.
    assert.ok(!String(rejected.stderr).includes("sk-"), "the failure printed key material");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the one secret this script cannot produce is refused before it writes anything", async () => {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "evimed-production-state-"));
  try {
    const missing = path.join(directory, "dashscope.api-key");
    const rejected = await run([], environment(directory, missing)).then(
      () => null,
      (error) => error,
    );
    assert.ok(rejected, "a deployment with no embedding credential was configured anyway");
    assert.match(String(rejected.stderr), /production_state_dashscope_key_missing/);
    // Nothing generated: half a secrets directory plus a message about a key
    // reads as a failure of the generation rather than a missing purchase.
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a group-readable credential is refused, because a secret anyone can read is not one", async () => {
  const { directory, keyFile } = await secretsDirectory();
  try {
    await chmod(keyFile, 0o644);
    const rejected = await run([], environment(directory, keyFile)).then(
      () => null,
      (error) => error,
    );
    assert.ok(rejected);
    assert.match(String(rejected.stderr), /production_state_secret_permissions/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
