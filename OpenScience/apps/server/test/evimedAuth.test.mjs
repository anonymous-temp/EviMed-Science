// The `evimed` login mode (fusion plan 2026-09-26 §9.2, step one): the EviMed
// shell's signed-in user becomes a Science session without signing in twice.
//
// What these tests hold:
//
// - first sight provisions an account with a personal tenant, every sight after
//   resolves to the same one, and which credential was presented does not
//   change the answer;
// - a credential EviMed refuses mints nothing — including the shape that
//   actually happens, HTTP 200 carrying `code: 401`, which a status-only check
//   would have read as a signed-in user called "认证失败";
// - with the mode off the route is not there and `/api/auth/methods` answers
//   exactly what it answered before;
// - the EviMed credential is never written down: not in a user row, a session,
//   the security ledger or the error ledger;
// - EviMed's sign-out revokes the Science session.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { evimedIdentityOf, evimedUserId, validateEvimedAuthSettings } from "../src/evimedAuthService.mjs";

/** Obviously not a key: the platform credential only has to be present and
 *  observable on the wire for these tests. */
const platformKey = "evimed-platform-key-for-tests";
/** The shell's own credential. Every stored byte is searched for this string. */
const shellCredential = "evimed-shell-credential-0e1f2a3b4c5d6e7f";
const introspectPath = "/system/v2/profile/info";

/** A stand-in for EviMed's user endpoint that records what it was asked. */
async function startEvimedUserEndpoint(answer) {
  const requests = [];
  let reply = answer;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Only introspections are counted. Anything else that reaches this port —
    // this machine's own port scanner does, which is why `localhostProbeGuard`
    // exists — is answered and ignored, so "EviMed was asked once" stays a
    // statement about EviMed rather than about the port.
    if (url.pathname !== introspectPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    requests.push({
      method: req.method,
      pathname: url.pathname,
      token: req.headers.token ?? null,
      authorization: req.headers.authorization ?? null,
    });
    const { status = 200, body = {} } = reply;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}${introspectPath}`,
    requests,
    /** @param {{ status?: number, body?: any }} next */
    answerWith: (next) => { reply = next; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))),
  };
}

/** The overrides a deployment running the EviMed login mode has. The key file
 *  is pinned empty so the ambient environment cannot decide it. */
function evimedOverrides(introspectUrl, extra = {}) {
  return {
    authMode: "evimed",
    runtimeMode: "mock",
    // Https so the session cookie carries Secure, as it does behind the
    // deployment's own ingress.
    publicUrl: "https://www.evimed.com",
    evimedUserIntrospectUrl: introspectUrl,
    evimedApiKeyFile: "",
    evimedApiKey: platformKey,
    ...extra,
  };
}

async function withApp(overrides, body) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-auth-"));
  const app = createWebApiApp({ dataDir, port: 0, ...overrides });
  try {
    const address = await app.listen(0, "127.0.0.1");
    await body({ app, dataDir, base: `http://127.0.0.1:${address.port}` });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** @param {Response} response @param {string} name */
function cookieValue(response, name) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match ? `${name}=${match[1]}` : "";
}

/** @param {string} base @param {{ token?: string, cookie?: string }} presented */
function exchange(base, { token, cookie } = {}) {
  return fetch(`${base}/api/auth/evimed/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(token === undefined ? {} : { token }),
  });
}

/** Every byte this deployment wrote down. */
async function storedBytes(dataDir) {
  const parts = [];
  const walk = async (/** @type {string} */ dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if ((await stat(full)).size > 4 * 1024 * 1024) continue;
      parts.push(`${full}\n${await readFile(full, "utf8").catch(() => "")}`);
    }
  };
  await walk(dataDir);
  // The walk must prove it walked: an empty read passes every search below.
  assert.ok(parts.length >= 2, `walked ${parts.length} files under the data directory; the walk is broken`);
  return parts.join("\n");
}

test("the shell's user is provisioned once and resolves to the same account after", async () => {
  const endpoint = await startEvimedUserEndpoint({
    body: { code: 200, msg: "success", data: { userId: 98_211, nickName: "王医生", phone: "13800000000" } },
  });
  try {
    await withApp(evimedOverrides(endpoint.url), async ({ base, dataDir }) => {
      const first = await exchange(base, { token: shellCredential });
      assert.equal(first.status, 200);
      const minted = await first.json();
      const expectedId = evimedUserId(
        { introspectUrl: new URL(endpoint.url) },
        "98211",
      );
      assert.equal(minted.data.user.id, expectedId);
      assert.match(minted.data.user.id, /^evimed_[a-f0-9]{40}$/);
      assert.equal(minted.data.user.name, "王医生");
      // A personal tenant of its own, which is what makes the account a tenant
      // boundary rather than a name.
      assert.equal(minted.data.user.tenantId, minted.data.user.id);
      assert.match(minted.data.csrfToken, /^csrf_/);

      // The session is this deployment's own cookie, with the attributes every
      // other login path mints.
      const setCookie = String(first.headers.get("set-cookie") ?? "");
      assert.match(setCookie, /^os_session=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.match(setCookie, /Secure/);
      const cookie = cookieValue(first, "os_session");

      // The introspection happened server side, with the shell's credential in
      // EviMed's own header and this deployment's platform key as the caller.
      assert.equal(endpoint.requests.length, 1);
      assert.deepEqual(endpoint.requests[0], {
        method: "GET",
        pathname: introspectPath,
        token: shellCredential,
        authorization: `Bearer ${platformKey}`,
      });

      const me = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
      assert.equal(me.status, 200);
      const account = (await me.json()).data;
      assert.equal(account.user.id, expectedId);
      assert.equal(account.tenant.id, expectedId);
      assert.equal(account.project.id, "default");

      // Second sight: the same credential is answered from the introspection
      // cache, and it is the same account with a new session.
      const second = await exchange(base, { token: shellCredential });
      assert.equal(second.status, 200);
      assert.equal((await second.json()).data.user.id, expectedId);
      assert.equal(endpoint.requests.length, 1, "the cache answered the repeat rather than asking EviMed again");
      assert.notEqual(cookieValue(second, "os_session"), cookie);

      // A different credential for the same EviMed user: introspected afresh,
      // and still the same Science account — the account follows the identity,
      // not the credential.
      const rotated = await exchange(base, { token: `${shellCredential}-rotated` });
      assert.equal(rotated.status, 200);
      assert.equal((await rotated.json()).data.user.id, expectedId);
      assert.equal(endpoint.requests.length, 2);

      // One account, recorded as an EviMed one so step two of §9.2 can find it.
      const users = JSON.parse(await readFile(path.join(dataDir, "users.json"), "utf8"));
      assert.deepEqual(users.users.map((/** @type {any} */ user) => [user.id, user.authType]), [[expectedId, "evimed"]]);
      assert.equal(Object.hasOwn(users.users[0], "passwordHash"), false);
    });
  } finally {
    await endpoint.close();
  }
});

test("a credential EviMed refuses mints nothing, including the HTTP 200 refusal", async () => {
  const endpoint = await startEvimedUserEndpoint({ status: 401, body: { code: 401, msg: "认证失败" } });
  try {
    await withApp(evimedOverrides(endpoint.url), async ({ base, dataDir }) => {
      for (const reply of [
        { status: 401, body: { code: 401, msg: "认证失败" } },
        // The one that actually happens: HTTP 200 with the business code inside.
        { status: 200, body: { code: 401, msg: "认证失败", data: null } },
        // Answered, and with no user in it.
        { status: 200, body: { code: 200, data: {} } },
      ]) {
        endpoint.answerWith(reply);
        const refused = await exchange(base, { token: shellCredential });
        assert.equal(refused.status, 401, `${JSON.stringify(reply)} must not sign anyone in`);
        assert.equal((await refused.json()).code, "evimed_credential_rejected");
        assert.equal(cookieValue(refused, "os_session"), "", "a refused credential mints no session");
      }

      // No account was created, and no session exists to be used.
      await assert.rejects(
        () => readFile(path.join(dataDir, "users.json"), "utf8"),
        (/** @type {any} */ error) => error.code === "ENOENT",
      );
      const me = await fetch(`${base}/api/me`);
      assert.equal(me.status, 401);

      // A missing credential is refused before anything is asked upstream.
      const asked = endpoint.requests.length;
      const bare = await fetch(`${base}/api/auth/evimed/session`, { method: "POST" });
      assert.equal(bare.status, 400);
      assert.equal((await bare.json()).code, "evimed_credential_missing");
      assert.equal(endpoint.requests.length, asked);
    });
  } finally {
    await endpoint.close();
  }
});

test("with the mode off the route is not there and nothing else changes", async () => {
  const operator = { authMode: "local", runtimeMode: "mock", bootstrapUser: "operator", bootstrapPassword: "operator-account-password" };
  await withApp(operator, async ({ base }) => {
    const refused = await exchange(base, { token: shellCredential });
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).code, "auth_method_disabled");
    assert.equal(cookieValue(refused, "os_session"), "");

    // The logout route, asked by a caller who does hold a session of this
    // deployment: the route is absent, not unauthorized.
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: operator.bootstrapUser, password: operator.bootstrapPassword }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieValue(login, "os_session");
    const { csrfToken } = (await login.json()).data;
    const absent = await fetch(`${base}/api/auth/evimed/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "X-Open-Science-CSRF": csrfToken },
    });
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).code, "auth_method_disabled");
    // And the session it was asked about is untouched.
    assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 200);

    // The login page is told the same thing it was told before the mode existed.
    const methods = await (await fetch(`${base}/api/auth/methods`)).json();
    assert.deepEqual(methods.data, { mode: "local", selfRegistration: false });
  });
});

test("the mode is reported and offered where it is on", async () => {
  const endpoint = await startEvimedUserEndpoint({ body: { code: 200, data: { userId: "42", name: "Reader" } } });
  try {
    await withApp(evimedOverrides(endpoint.url), async ({ base }) => {
      const methods = await (await fetch(`${base}/api/auth/methods`)).json();
      assert.deepEqual(methods.data, {
        mode: "evimed",
        evimed: { sessionUrl: "/api/auth/evimed/session", logoutUrl: "/api/auth/evimed/logout" },
      });
      const readiness = (await (await fetch(`${base}/api/ready`)).json()).data;
      assert.equal(readiness.checks.auth.ok, true);
      assert.equal(readiness.checks.auth.mode, "evimed");
      assert.equal(readiness.checks.auth.evimed.introspectHost, new URL(endpoint.url).host);
      assert.equal(readiness.checks.auth.evimed.platformKey, "configured");
      // Readiness never carries the key itself.
      assert.equal(JSON.stringify(readiness).includes(platformKey), false);
    });
  } finally {
    await endpoint.close();
  }
});

test("the mode fails closed when it is on with nowhere to introspect", async () => {
  await withApp({ authMode: "evimed", runtimeMode: "mock", evimedUserIntrospectUrl: "" }, async ({ base }) => {
    const readiness = (await (await fetch(`${base}/api/ready`)).json()).data;
    assert.equal(readiness.checks.auth.ok, false);
    assert.equal(readiness.checks.auth.code, "evimed_introspect_url_missing");
  });
});

test("the EviMed credential is never written down", async () => {
  const endpoint = await startEvimedUserEndpoint({
    body: { code: 200, data: { userId: "77-541", nickName: "李药师" } },
  });
  try {
    await withApp(evimedOverrides(endpoint.url), async ({ base, dataDir }) => {
      const minted = await exchange(base, { token: shellCredential });
      assert.equal(minted.status, 200);
      // And a failure, because a failure is the other thing that writes a line.
      endpoint.answerWith({ status: 401, body: { code: 401 } });
      const refused = await exchange(base, { token: `${shellCredential}-stale` });
      assert.equal(refused.status, 401);

      const written = await storedBytes(dataDir);
      // The ledgers were written, so the search is looking at something.
      assert.match(written, /auth\.evimed\.session/);
      assert.match(written, /evimed_credential_rejected/);
      for (const secret of [shellCredential, `${shellCredential}-stale`, platformKey, "77-541"]) {
        assert.equal(written.includes(secret), false, `${secret.slice(0, 12)}… was written to disk`);
      }
    });
  } finally {
    await endpoint.close();
  }
});

test("EviMed's sign-out revokes the Science session", async () => {
  const endpoint = await startEvimedUserEndpoint({ body: { code: 200, data: { userId: "513", nickName: "张医生" } } });
  try {
    await withApp(evimedOverrides(endpoint.url), async ({ base }) => {
      const minted = await exchange(base, { token: shellCredential });
      const cookie = cookieValue(minted, "os_session");
      const { csrfToken } = (await minted.json()).data;
      assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 200);

      // Without the session's CSRF token it is somebody else's request.
      const forged = await fetch(`${base}/api/auth/evimed/logout`, { method: "POST", headers: { Cookie: cookie } });
      assert.equal(forged.status, 403);
      assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 200);

      const out = await fetch(`${base}/api/auth/evimed/logout`, {
        method: "POST",
        headers: { Cookie: cookie, "X-Open-Science-CSRF": csrfToken },
      });
      assert.equal(out.status, 200);
      assert.match(String(out.headers.get("set-cookie") ?? ""), /os_session=;[^,]*Max-Age=0/);
      assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 401);
    });
  } finally {
    await endpoint.close();
  }
});

test("the identity reader accepts the envelope EviMed sends and refuses the rest", () => {
  assert.deepEqual(
    evimedIdentityOf({ code: 200, data: { userId: 4, nickName: " 王 医生 " } }),
    { userId: "4", name: "王 医生" },
  );
  // A bare identity document, which is what a purpose-built endpoint returns.
  assert.deepEqual(evimedIdentityOf({ sub: "abc", name: "Reader" }), { userId: "abc", name: "Reader" });
  // Named by nobody, but identified: the account is still resolvable.
  assert.deepEqual(evimedIdentityOf({ code: "0", data: { id: "9" } }), { userId: "9", name: "EviMed User" });
  // EviMed registers by phone, so its login fields are commonly the number
  // itself. An account name is written into a user row, every ledger line and
  // every export, so neither is ever taken as one.
  assert.deepEqual(
    evimedIdentityOf({ code: 200, data: { userId: "9", userName: "13800000000", phone: "13800000000" } }),
    { userId: "9", name: "EviMed User" },
  );
  for (const refused of [
    null,
    "signed in",
    [],
    { code: 401, data: { userId: "9" } },
    { success: false, data: { userId: "9" } },
    { code: 200, data: { userId: "" } },
    { code: 200 },
  ]) {
    assert.equal(evimedIdentityOf(refused), null, `${JSON.stringify(refused)} is not an identity`);
  }
});

test("the settings refuse what cannot be used, and the account id is stable", () => {
  const base = {
    evimedAuthEnabled: true,
    evimedUserIntrospectUrl: "https://www.evimed.com/system/v2/profile/info",
    evimedIntrospectTimeoutMs: 5_000,
    evimedIntrospectCacheTtlMs: 60_000,
    publicSourceCredentials: { evimedEvidence: platformKey },
    publicSourceCredentialErrors: { evimedEvidence: null },
  };
  assert.equal(validateEvimedAuthSettings(base).introspectUrl.host, "www.evimed.com");
  for (const [override, code] of [
    [{ evimedAuthEnabled: false }, "evimed_auth_disabled"],
    [{ evimedUserIntrospectUrl: "" }, "evimed_introspect_url_missing"],
    [{ evimedUserIntrospectUrl: "not-a-url" }, "evimed_introspect_url_invalid"],
    [{ evimedUserIntrospectUrl: "https://someone:example@www.evimed.com/x" }, "evimed_introspect_url_invalid"],
    [{ production: true, evimedUserIntrospectUrl: "http://www.evimed.com/x" }, "evimed_introspect_https_required"],
    [{ evimedIntrospectTimeoutMs: 0 }, "evimed_introspect_timeout_invalid"],
    [{ evimedIntrospectCacheTtlMs: -1 }, "evimed_introspect_cache_ttl_invalid"],
    // A key file that cannot be read is a fault with a name of its own; no key
    // at all is not a fault.
    [{ publicSourceCredentialErrors: { evimedEvidence: "public_source_evimed_evidence_file_symlink" } },
      "public_source_evimed_evidence_file_symlink"],
  ]) {
    assert.throws(
      () => validateEvimedAuthSettings({ ...base, ...override }),
      (/** @type {any} */ error) => error?.code === code,
      `${JSON.stringify(override)} must fail with ${code}`,
    );
  }
  assert.equal(validateEvimedAuthSettings({ ...base, publicSourceCredentials: {} }).apiKey, "");

  // The id is the same every time, and different per EviMed installation.
  const here = { introspectUrl: new URL("https://www.evimed.com/system/v2/profile/info") };
  const elsewhere = { introspectUrl: new URL("https://staging.evimed.com/system/v2/profile/info") };
  assert.equal(evimedUserId(here, "98211"), evimedUserId(here, "98211"));
  assert.notEqual(evimedUserId(here, "98211"), evimedUserId(elsewhere, "98211"));
  assert.notEqual(evimedUserId(here, "98211"), evimedUserId(here, "98212"));
  // It carries nothing of EviMed's identifier into our filesystem or ledgers.
  assert.match(evimedUserId(here, "98211"), /^evimed_[a-f0-9]{40}$/);
});
