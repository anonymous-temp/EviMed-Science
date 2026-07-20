import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/provision-memos.mjs");

function runProvision(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Memos provisioning creates an administrator and reusable PAT without exposing credentials", async () => {
  const password = "memos-admin-password-for-test-only";
  const accessToken = "memos_access_token_for_test_1234567890";
  const pat = "memos_pat_for_test_12345678901234567890";
  let administratorCreated = false;
  let patCreations = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? "", body });
    res.setHeader("Content-Type", "application/json");

    if (req.url === "/api/v1/auth/me") {
      if (req.headers.authorization === `Bearer ${pat}`) {
        res.end(JSON.stringify({ user: { username: "evimed-memory" } }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: "unauthorized" }));
      }
      return;
    }
    if (req.url === "/api/v1/auth/signin" && req.method === "POST") {
      if (administratorCreated && body?.passwordCredentials?.username === "evimed-memory" && body?.passwordCredentials?.password === password) {
        res.end(JSON.stringify({ accessToken }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: "invalid credentials" }));
      }
      return;
    }
    if (req.url === "/api/v1/users" && req.method === "POST") {
      assert.deepEqual(body, {
        user: {
          username: "evimed-memory",
          password,
          role: "ADMIN",
          state: "NORMAL",
          displayName: "EviMed Memory Integration",
        },
      });
      administratorCreated = true;
      res.end(JSON.stringify({ name: "users/evimed-memory" }));
      return;
    }
    if (req.url === "/api/v1/users/evimed-memory/personalAccessTokens" && req.method === "POST") {
      assert.equal(req.headers.authorization, `Bearer ${accessToken}`);
      assert.deepEqual(body, { description: "EviMed Science production integration", expiresInDays: 0 });
      patCreations += 1;
      res.end(JSON.stringify({ token: pat, personalAccessToken: { name: "users/evimed-memory/personalAccessTokens/1" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });

  const tmp = await mkdtemp(path.join(tmpdir(), "memos-provision-"));
  const passwordFile = path.join(tmp, "admin-password");
  const tokenDir = path.join(tmp, "integration");
  const tokenFile = path.join(tokenDir, "access-token");
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  await chmod(passwordFile, 0o600);
  await mkdir(tokenDir, { mode: 0o700 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const env = {
    OPEN_SCIENCE_MEMOS_URL: `http://127.0.0.1:${address.port}`,
    OPEN_SCIENCE_MEMOS_ADMIN_PASSWORD_FILE: passwordFile,
    OPEN_SCIENCE_MEMOS_ACCESS_TOKEN_FILE: tokenFile,
  };
  try {
    const first = await runProvision(env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Memos integration provisioning ok/);
    assert.equal(first.stdout.includes(password), false);
    assert.equal(first.stdout.includes(accessToken), false);
    assert.equal(first.stdout.includes(pat), false);
    assert.equal(await readFile(tokenFile, "utf8"), `${pat}\n`);
    assert.equal((await stat(tokenFile)).mode & 0o077, 0);
    assert.equal(patCreations, 1);

    const second = await runProvision(env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Memos integration token check ok/);
    assert.equal(patCreations, 1);
    assert.equal(requests.at(-1).url, "/api/v1/auth/me");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});
