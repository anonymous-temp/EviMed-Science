import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateOidcSettings, openOidcFlow, sealOidcFlow } from "../src/oidc.mjs";
import { createWebApiApp } from "../src/server.mjs";

const clientId = "open-science-test";
const clientSecret = "oidc-test-client-secret-that-is-not-the-flow-secret";
const flowSecret = "oidc-test-flow-secret-with-more-than-thirty-two-bytes";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configureOidcScript = path.join(repoRoot, "scripts/ops/configure-oidc.mjs");

function runConfigureOidc(outputDir, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [configureOidcScript, ...args], {
      cwd: repoRoot,
      env: { ...process.env, OPEN_SCIENCE_OIDC_SECRETS_DIR: outputDir, ...env },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedIdToken(privateKey, payload) {
  const encoded = `${base64urlJson({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${base64urlJson(payload)}`;
  return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`;
}

async function bodyText(req, limit = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startMockProvider(claimOverrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const codes = new Map();
  const issuedAccessToken = `access_${randomBytes(20).toString("hex")}`;
  let issuer = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" }] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("client_id"), clientId);
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.match(url.searchParams.get("scope") ?? "", /(?:^| )openid(?: |$)/);
      const code = `code_${randomBytes(12).toString("hex")}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge"),
        nonce: url.searchParams.get("nonce"),
        redirectUri: url.searchParams.get("redirect_uri"),
      });
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: callback.href });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const encodedCredentials = String(req.headers.authorization ?? "").replace(/^Basic\s+/i, "");
      const [encodedClientId, encodedClientSecret] = Buffer.from(encodedCredentials, "base64").toString("utf8").split(":");
      assert.equal(decodeURIComponent(encodedClientId), clientId);
      assert.equal(decodeURIComponent(encodedClientSecret), clientSecret);
      const form = new URLSearchParams(await bodyText(req));
      const record = codes.get(form.get("code"));
      if (!record) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      codes.delete(form.get("code"));
      assert.equal(form.get("redirect_uri"), record.redirectUri);
      assert.equal(
        createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
        record.challenge,
      );
      const now = Math.floor(Date.now() / 1000);
      const idToken = signedIdToken(privateKey, {
        iss: issuer,
        sub: "researcher-12345",
        aud: clientId,
        iat: now,
        exp: now + 300,
        nonce: record.nonce,
        name: "Ada Researcher",
        email: "ada@example.edu",
        email_verified: true,
        groups: ["researchers"],
        ...claimOverrides,
      });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        access_token: issuedAccessToken,
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    issuedAccessToken,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function oidcOverrides(issuer) {
  return {
    authMode: "oidc",
    devAuth: false,
    oidcIssuer: issuer,
    oidcClientId: clientId,
    oidcClientSecret: clientSecret,
    oidcFlowSecret: flowSecret,
    oidcAllowedGroups: ["researchers"],
    oidcAllowedEmailDomains: ["example.edu"],
    runtimeMode: "mock",
  };
}

function cookieValue(response, name) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match ? `${name}=${match[1]}` : "";
}

test("OIDC flow cookies are encrypted, authenticated, scoped, and expiring", () => {
  const settings = validateOidcSettings({
    ...oidcOverrides("http://127.0.0.1:9000"),
    publicUrl: "http://127.0.0.1:8787",
    production: false,
    oidcScopes: ["openid", "profile", "email"],
    oidcLabel: "Organization SSO",
    oidcGroupClaim: "groups",
    oidcTimeoutMs: 10_000,
    oidcFlowTtlMs: 600_000,
  });
  const now = Date.now();
  const flow = {
    version: 1,
    issuedAt: now,
    state: "state-value",
    nonce: "nonce-value",
    codeVerifier: "verifier-value",
    returnTo: "/settings",
  };
  const sealed = sealOidcFlow(flow, settings);
  assert.equal(sealed.includes("state-value"), false);
  assert.deepEqual(openOidcFlow(sealed, settings, now), flow);
  const tamperedParts = sealed.split(".");
  const tamperedCiphertext = Buffer.from(tamperedParts[1], "base64url");
  tamperedCiphertext[0] ^= 1;
  tamperedParts[1] = tamperedCiphertext.toString("base64url");
  assert.throws(
    () => openOidcFlow(tamperedParts.join("."), settings, now),
    (error) => error?.code === "oidc_flow_invalid",
  );
  assert.throws(
    () => openOidcFlow(sealed, settings, now + settings.flowTtlMs + 1),
    (error) => error?.code === "oidc_flow_invalid",
  );
});

test("hosted OIDC code flow validates PKCE and ID token without persisting provider tokens", async () => {
  const provider = await startMockProvider();
  const dataDir = await mkdtemp(path.join(tmpdir(), "open-science-oidc-"));
  let app;
  try {
    app = createWebApiApp({ dataDir, port: 0, publicUrl: "http://127.0.0.1", ...oidcOverrides(provider.issuer) });
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    app.config.publicUrl = base;

    const methods = await fetch(`${base}/api/auth/methods`);
    assert.equal(methods.status, 200);
    assert.deepEqual((await methods.json()).data, {
      mode: "oidc",
      oidc: { label: "Organization SSO", startUrl: "/api/auth/oidc/start" },
    });

    const localLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "not-used" }),
    });
    assert.equal(localLogin.status, 404);
    assert.equal((await localLogin.json()).code, "auth_method_disabled");

    const start = await fetch(`${base}/api/auth/oidc/start?returnTo=%2Fsettings`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const flowCookie = cookieValue(start, "os_oidc_flow");
    assert.match(flowCookie, /^os_oidc_flow=.+/);
    assert.equal((start.headers.get("set-cookie") ?? "").includes(clientSecret), false);
    assert.equal((start.headers.get("set-cookie") ?? "").includes("researcher-12345"), false);

    const authorize = await fetch(start.headers.get("location"), { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const callbackUrl = authorize.headers.get("location");
    const callback = await fetch(callbackUrl, {
      headers: { Cookie: flowCookie },
      redirect: "manual",
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/settings");
    assert.match(callback.headers.get("set-cookie") ?? "", /os_oidc_flow=;[^,]*Max-Age=0/);
    const sessionCookie = cookieValue(callback, "os_session");
    assert.match(sessionCookie, /^os_session=.+/);

    const me = await fetch(`${base}/api/me`, { headers: { Cookie: sessionCookie } });
    assert.equal(me.status, 200);
    const meData = (await me.json()).data;
    assert.match(meData.user.id, /^oidc_[a-f0-9]{48}$/);
    assert.equal(meData.user.name, "Ada Researcher");
    assert.match(meData.csrfToken, /^csrf_/);

    const usersState = await readFile(path.join(dataDir, "users.json"), "utf8");
    const sessionsState = await readFile(path.join(dataDir, ".openscience", "sessions.json"), "utf8");
    const persisted = `${usersState}\n${sessionsState}`;
    assert.match(usersState, /"authType":\s*"oidc"/);
    for (const secret of [provider.issuedAccessToken, clientSecret, flowSecret, "researcher-12345", "ada@example.edu"]) {
      assert.equal(persisted.includes(secret), false);
    }

    await app.close();
    app = createWebApiApp({ dataDir, port: 0, publicUrl: base, ...oidcOverrides(provider.issuer) });
    const restarted = await app.listen(0, "127.0.0.1");
    const restartedBase = `http://127.0.0.1:${restarted.port}`;
    const persistedMe = await fetch(`${restartedBase}/api/me`, { headers: { Cookie: sessionCookie } });
    assert.equal(persistedMe.status, 200);
    assert.equal((await persistedMe.json()).data.user.name, "Ada Researcher");
  } finally {
    await app?.close();
    await provider.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("OIDC readiness fails closed on missing or weak correlation secrets", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "open-science-oidc-ready-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    publicUrl: "http://127.0.0.1:8787",
    ...oidcOverrides("http://127.0.0.1:9000"),
    oidcFlowSecret: "short",
  });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
    const readiness = (await response.json()).data;
    assert.equal(readiness.checks.auth.ok, false);
    assert.equal(readiness.checks.auth.code, "oidc_flow_secret_weak");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("OIDC readiness rejects a symbolic-link client secret file", async () => {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "open-science-oidc-secret-link-")));
  const realSecret = path.join(dataDir, "real-client-secret.txt");
  const linkedSecret = path.join(dataDir, "client-secret.txt");
  await writeFile(realSecret, `${clientSecret}\n`, { mode: 0o600 });
  await symlink(realSecret, linkedSecret);
  const overrides = oidcOverrides("http://127.0.0.1:9000");
  delete overrides.oidcClientSecret;
  const app = createWebApiApp({
    dataDir,
    port: 0,
    publicUrl: "http://127.0.0.1:8787",
    ...overrides,
    oidcClientSecretFile: linkedSecret,
  });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
    const readiness = (await response.json()).data;
    assert.equal(readiness.checks.auth.ok, false);
    assert.equal(readiness.checks.auth.code, "oidc_client_secret_file_symlink");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("OIDC callback fails closed when provider claims do not satisfy admission policy", async () => {
  const provider = await startMockProvider({ groups: ["guests"] });
  const dataDir = await mkdtemp(path.join(tmpdir(), "open-science-oidc-policy-"));
  const app = createWebApiApp({ dataDir, port: 0, publicUrl: "http://127.0.0.1", ...oidcOverrides(provider.issuer) });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    app.config.publicUrl = base;
    const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: "manual" });
    const flowCookie = cookieValue(start, "os_oidc_flow");
    const authorize = await fetch(start.headers.get("location"), { redirect: "manual" });
    const callback = await fetch(authorize.headers.get("location"), {
      headers: { Cookie: flowCookie },
      redirect: "manual",
    });
    assert.equal(callback.status, 403);
    assert.equal((await callback.json()).code, "oidc_group_forbidden");
    assert.equal(cookieValue(callback, "os_session"), "");
    assert.match(callback.headers.get("set-cookie") ?? "", /os_oidc_flow=;[^,]*Max-Age=0/);
  } finally {
    await app.close();
    await provider.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("OIDC secret tooling writes private files without exposing secret values", async () => {
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), "open-science-oidc-secrets-")));
  const outputDir = path.join(tmp, "secrets");
  const generatedClientSecret = "provider-client-secret-for-oidc-tooling";
  try {
    const generated = await runConfigureOidc(outputDir, ["--json"], {
      OPEN_SCIENCE_OIDC_CLIENT_SECRET: generatedClientSecret,
    });
    const result = JSON.parse(generated.stdout);
    assert.equal(result.ok, true);
    assert.equal(generated.stdout.includes(generatedClientSecret), false);
    const clientFile = path.join(outputDir, "oidc-client-secret.txt");
    const flowFile = path.join(outputDir, "oidc-flow-secret.txt");
    assert.equal((await readFile(clientFile, "utf8")).trim(), generatedClientSecret);
    assert.ok((await readFile(flowFile, "utf8")).trim().length >= 32);
    if (process.platform !== "win32") {
      assert.equal((await lstat(outputDir)).mode & 0o077, 0);
      assert.equal((await lstat(clientFile)).mode & 0o077, 0);
      assert.equal((await lstat(flowFile)).mode & 0o077, 0);
    }
    const checked = await runConfigureOidc(outputDir, ["--check", "--json"]);
    assert.equal(JSON.parse(checked.stdout).ok, true);
    await assert.rejects(
      () => runConfigureOidc(outputDir, [], { OPEN_SCIENCE_OIDC_CLIENT_SECRET: generatedClientSecret }),
      (error) => {
        assert.match(error.stderr, /oidc_secrets_exist/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("OIDC secret tooling rejects symlink paths and group-readable files", { skip: process.platform === "win32" }, async () => {
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), "open-science-oidc-secret-policy-")));
  const realDir = path.join(tmp, "real");
  const linkedDir = path.join(tmp, "linked");
  const env = { OPEN_SCIENCE_OIDC_CLIENT_SECRET: "provider-client-secret-for-policy-tests" };
  try {
    await mkdir(realDir);
    await symlink(realDir, linkedDir);
    await assert.rejects(
      () => runConfigureOidc(linkedDir, [], env),
      (error) => {
        assert.match(error.stderr, /oidc_secret_path_symlink/);
        return true;
      },
    );

    const outputDir = path.join(tmp, "private");
    await runConfigureOidc(outputDir, [], env);
    await chmod(path.join(outputDir, "oidc-flow-secret.txt"), 0o640);
    await assert.rejects(
      () => runConfigureOidc(outputDir, ["--check"]),
      (error) => {
        assert.match(error.stderr, /oidc_secret_permissions/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
