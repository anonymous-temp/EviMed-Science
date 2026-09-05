import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const execFileAsync = promisify(execFile);

test("the MemOS image builds from the single full source revision pin", async () => {
  const versions = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8"));
  assert.match(versions.memos.sourceRevision, /^[a-f0-9]{40}$/);
  const dockerfile = await readFile(path.join(root, "deploy/memos-engine/Dockerfile"), "utf8");
  assert.match(dockerfile, /deps-version\.json/);
  assert.match(dockerfile, /pin\['sourceRevision'\]/);
  assert.doesNotMatch(dockerfile, /ARG MEMOS_(?:VERSION|REVISION)/);
  assert.match(versions.memos.tokenizerRevision, /^[a-f0-9]{40}$/);
  assert.match(dockerfile, /pin\['tokenizerRevision'\]/);
  assert.match(dockerfile, /COPY deploy\/memos-engine\/gpt2-tokenizer/);
  assert.match(dockerfile, /hashlib\.sha256\(payload\)\.hexdigest\(\)/);
  assert.match(dockerfile, /'refs' \/ 'main'/);
  assert.match(dockerfile, /write_text\(manifest\['revision'\]\)/);
  assert.doesNotMatch(dockerfile, /write_text\(manifest\['revision'\] \+ ['"]\\n/);
  assert.match(dockerfile, /AutoTokenizer\.from_pretrained\('gpt2', local_files_only=True\)/);
  assert.match(dockerfile, /HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1/);
});

test("the vendored GPT-2 tokenizer matches its reviewed revision and file manifest", async () => {
  const versions = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8"));
  const tokenizerDir = path.join(root, "deploy/memos-engine/gpt2-tokenizer");
  const manifest = JSON.parse(await readFile(path.join(tokenizerDir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.repository, "openai-community/gpt2");
  assert.equal(manifest.revision, versions.memos.tokenizerRevision);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    "config.json",
    "merges.txt",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
  ]);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const payload = await readFile(path.join(tokenizerDir, name));
    assert.equal(payload.byteLength, expected.bytes, `${name} byte count`);
    assert.equal(createHash("sha256").update(payload).digest("hex"), expected.sha256, `${name} digest`);
  }
});

test("the MemOS stack is private, persistent, bounded, and reachable only by the control plane", async () => {
  const compose = await readFile(path.join(root, "deploy/web/docker-compose.memos-engine.yml"), "utf8");
  assert.match(compose, /memory-index-internal:\n\s+internal: true/);
  assert.match(compose, /OPEN_SCIENCE_REQUIRE_MEMORY_INDEX: "true"/);
  assert.match(compose, /MEMSCHEDULER_USE_REDIS_QUEUE: "true"/);
  assert.match(compose, /EVIMED_MEMOS_PROVIDER_CONFIG: \/run\/secrets\/memos-engine-providers\.json/);
  assert.match(compose, /OLLAMA_API_BASE: http:\/\/evimed-memos-ollama:11434/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  for (const volume of ["engine-data", "neo4j-data", "qdrant-data", "redis-data", "ollama-data", "secrets"]) {
    assert.match(compose, new RegExp(`evimed-memos-${volume}:`));
  }
  assert.equal((compose.match(/^\s+- memory-index-internal$/gm) ?? []).length, 6,
    "only the control plane and five dedicated memory services join the private network");
  assert.equal((compose.match(/\n\s+limits:\n/g) ?? []).length, 5);
  assert.match(compose, /evimed-memos-ollama-init:[\s\S]*restart: "no"/);
  assert.match(compose, /evimed-memos-secrets-init:[\s\S]*network_mode: none/);
  assert.match(compose, /evimed-memos-ollama:[\s\S]*user: "10002:10002"/);
  assert.match(compose, /evimed-memos-redis:[\s\S]*user: "999:1000"/);
});

test("production-state configuration creates a matched owner-only MemOS provider and Neo4j credential", async () => {
  const tmp = await mkdtemp(path.join(await realpath(os.tmpdir()), "evimed-memos-state-"));
  const script = path.join(root, "scripts/ops/configure-production-state.mjs");
  const env = { ...process.env, OPEN_SCIENCE_PRODUCTION_STATE_SECRETS_DIR: tmp };
  try {
    await execFileAsync(process.execPath, [script], { cwd: root, env });
    await execFileAsync(process.execPath, [script, "--check"], { cwd: root, env });
    const providerFile = path.join(tmp, "memos-engine-providers.json");
    const authFile = path.join(tmp, "memos-neo4j-auth.txt");
    const provider = JSON.parse(await readFile(providerFile, "utf8"));
    const auth = (await readFile(authFile, "utf8")).trim();
    assert.equal(provider.OPENAI_API_BASE, "http://evimed-memos-ollama:11434/v1");
    assert.equal(provider.MOS_EMBEDDER_BACKEND, "ollama");
    assert.equal(provider.MOS_EMBEDDER_MODEL, "bge-m3:latest");
    assert.equal(provider.EMBEDDING_DIMENSION, "1024");
    assert.equal(auth, `neo4j/${provider.NEO4J_PASSWORD}`);
    if (process.platform !== "win32") {
      assert.equal((await stat(providerFile)).mode & 0o777, 0o600);
      assert.equal((await stat(authFile)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
