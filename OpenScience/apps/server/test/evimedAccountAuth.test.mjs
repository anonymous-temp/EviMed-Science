import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { evimedAccountFailureDetail, validateEvimedAccountSettings } from "../src/evimedAccountService.mjs";

// Public route names are a browser contract, independent of the service's exports.
const accountPaths = {
  captchaUrl: "/api/auth/evimed/captcha",
  sendCodeUrl: "/api/auth/evimed/send-code",
  passwordLoginUrl: "/api/auth/evimed/password-login",
  smsLoginUrl: "/api/auth/evimed/sms-login",
  registerUrl: "/api/auth/evimed/register",
  verifyCodeUrl: "/api/auth/evimed/verify-code",
  resetPasswordUrl: "/api/auth/evimed/reset-password",
};
const phone = "13800000000";
const otherPhone = "13900000000";
const password = "AccountPass123";
const token = "synthetic-account-token-8e4d6c2a";
const platformKey = "synthetic-account-platform-key";
const introspectPath = "/system/v2/profile/info";
const upstreamPaths = new Set([
  introspectPath, "/system/captcha/get", "/system/verifycode/send", "/auth/login", "/auth/loginByCode",
  "/system/user/register", "/system/verifycode/check", "/system/user/resetpwd",
]);
const captcha = {
  canvasSrc: "data:image/png;base64,Y2FudmFz",
  blockSrc: "data:image/png;base64,YmxvY2s=",
  blockX: 0, blockY: 26, canvasWidth: 320, canvasHeight: 160, blockWidth: 40, blockHeight: 40,
};

/** Only owned fixture paths count; localhost port probes never become account calls. */
async function startTeamEndpoint({ imagePaths = [] } = {}) {
  const requests = [];
  const allowedPaths = new Set([...upstreamPaths, ...imagePaths]);
  let answer = () => ({ body: { code: 200, data: true } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!allowedPaths.has(url.pathname)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const request = {
      method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : null,
      cookie: req.headers.cookie ?? null, token: req.headers.token ?? null,
      authorization: req.headers.authorization ?? null,
    };
    requests.push(request);
    const reply = url.pathname === introspectPath
      ? { body: { code: 200, data: { userId: "account-reader", nickName: "Account Reader" } }, ...answer(request) }
      : answer(request);
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = /** @type {any} */ (server.address());
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    answerWith: (next) => { answer = next; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))),
  };
}

function accountOverrides(upstream, extra = {}) {
  return {
    localAutoConfig: false, authMode: "evimed", runtimeMode: "mock", publicUrl: "https://www.evimed.com",
    evimedAuthEnabled: true, evimedUserIntrospectUrl: `${upstream.base}${introspectPath}`,
    evimedAccountApiBaseUrl: upstream.base, evimedApiKeyFile: "", evimedApiKey: platformKey,
    ...extra,
  };
}

async function withApp(overrides, body) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-account-auth-"));
  const app = createWebApiApp({ dataDir, port: 0, localAutoConfig: false, runtimeMode: "mock", evimedAccountApiBaseUrl: "", ...overrides });
  try {
    const address = await app.listen(0, "127.0.0.1");
    await body({ app, dataDir, base: `http://127.0.0.1:${address.port}` });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function cookieValue(response, name) {
  const pair = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  return pair?.split(";", 1)[0] ?? "";
}

function post(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

async function writtenText(dataDir) {
  const parts = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) parts.push(await readFile(full, "utf8"));
    }
  };
  await walk(dataDir);
  assert.ok(parts.length >= 2, "the persistence search must inspect populated ledgers");
  return parts.join("\n");
}

test("account discovery is opt-in and invalid upstream configuration fails closed", async () => {
  const upstream = await startTeamEndpoint();
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      assert.deepEqual((await (await fetch(`${base}/api/auth/methods`)).json()).data, {
        mode: "evimed", evimed: {
          sessionUrl: "/api/auth/evimed/session", logoutUrl: "/api/auth/evimed/logout", account: accountPaths,
        },
      });
    });
    await withApp(accountOverrides(upstream, { evimedAccountApiBaseUrl: "" }), async ({ base }) => {
      const methods = (await (await fetch(`${base}/api/auth/methods`)).json()).data;
      assert.equal(Object.hasOwn(methods.evimed, "account"), false);
      const disabled = await post(base, accountPaths.smsLoginUrl, { phone, code: "123456" });
      assert.equal(disabled.status, 404);
      assert.equal((await disabled.json()).code, "auth_method_disabled");
    });
    const settings = {
      evimedAuthEnabled: true, evimedUserIntrospectUrl: `${upstream.base}${introspectPath}`,
      evimedAccountApiBaseUrl: upstream.base, evimedIntrospectTimeoutMs: 5000, evimedIntrospectCacheTtlMs: 0,
      publicSourceCredentials: {}, publicSourceCredentialErrors: {},
    };
    for (const [override, code] of [
      [{ evimedAccountApiBaseUrl: "file:///tmp/account" }, "evimed_account_url_invalid"],
      [{ evimedAccountApiBaseUrl: `${upstream.base}/?target=elsewhere` }, "evimed_account_url_invalid"],
      [{ evimedAccountApiBaseUrl: upstream.base.replace("127.0.0.1", "localhost") }, "evimed_account_origin_invalid"],
      [{ production: true, evimedUserIntrospectUrl: "https://127.0.0.1/profile" }, "evimed_account_https_required"],
    ]) {
      assert.throws(() => validateEvimedAccountSettings({ ...settings, ...override }), (error) => error.code === code);
    }
    await withApp(accountOverrides(upstream, { evimedAccountApiBaseUrl: "not-a-url" }), async ({ base }) => {
      const invalid = await post(base, accountPaths.smsLoginUrl, { phone, code: "123456" });
      assert.equal(invalid.status, 503);
      assert.equal((await invalid.json()).code, "evimed_account_url_invalid");
    });
    assert.equal(upstream.requests.length, 0);
  } finally { await upstream.close(); }
});

test("captcha, SMS, registration and recovery use the team's exact payloads", async () => {
  const upstream = await startTeamEndpoint();
  upstream.answerWith((request) => request.pathname === "/system/captcha/get"
    ? { body: { code: 200, data: { ...captcha, internalToken: token } }, headers: { "Set-Cookie": "account_challenge=synthetic-captcha; HttpOnly" } }
    : { body: { code: 200, data: { token, unexpected: "discarded" } } });
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      const challenge = await fetch(`${base}${accountPaths.captchaUrl}?phoneNumber=${phone}`);
      assert.equal(challenge.status, 200);
      assert.deepEqual(await challenge.json(), { data: captcha });
      const flowCookie = cookieValue(challenge, "os_evimed_account");
      assert.ok(flowCookie);
      const cases = [
        ["sendCodeUrl", { purpose: "login", phone, xcode: "123.5" }, "/system/verifycode/send", { mark: 0, receiver: phone, xcode: "123.5" }, flowCookie],
        ["sendCodeUrl", { purpose: "register", phone }, "/system/verifycode/send", { mark: 1, prefix: "86", receiver: phone }],
        ["sendCodeUrl", { purpose: "reset", phone }, "/system/verifycode/send", { mark: 2, receiver: phone }],
        ["registerUrl", { phone, code: "123456", password }, "/system/user/register", { code: "123456", mobile: phone, pwd: password }],
        ["verifyCodeUrl", { phone, code: "123456" }, "/system/verifycode/check", { code: "123456", prefix: "86", receiver: phone }],
        ["resetPasswordUrl", { phone, code: "123456", password }, "/system/user/resetpwd", { code: "123456", newPwd: password, receiver: phone }],
      ];
      for (const [key, input, pathname, expected, cookie] of cases) {
        const response = await post(base, accountPaths[key], input, cookie ? { Cookie: cookie } : {});
        assert.equal(response.status, 200, `${pathname} accepted its mapped input`);
        assert.deepEqual(await response.json(), { data: true });
        assert.equal(cookieValue(response, "os_session"), "");
        const request = upstream.requests.at(-1);
        assert.equal(request.method, "POST");
        assert.equal(request.pathname, pathname);
        assert.equal(request.token, null);
        assert.deepEqual(request.body, expected);
      }
      assert.deepEqual(upstream.requests[0].query, { phoneNumber: phone });
      assert.equal(upstream.requests[0].method, "GET");
      assert.equal(upstream.requests[0].token, null);
    });
  } finally { await upstream.close(); }
});

test("password and SMS login exchange each supported token envelope for a Science session", async () => {
  const upstream = await startTeamEndpoint();
  let loginAnswer;
  upstream.answerWith((request) => request.pathname === introspectPath ? {} : { body: loginAnswer });
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      let accountId;
      for (const [key, input, pathname, expected, envelope] of [
        ["passwordLoginUrl", { username: "reader", password }, "/auth/login", { username: "reader", password }, { token }],
        ["smsLoginUrl", { phone, code: "123456" }, "/auth/loginByCode", { vcode: "123456", receiver: phone }, { data: { token: `${token}-sms` } }],
        ["passwordLoginUrl", { username: "reader", password }, "/auth/login", { username: "reader", password }, { data: { access_token: `${token}-access` } }],
      ]) {
        loginAnswer = { code: 200, ...envelope };
        const response = await post(base, accountPaths[key], input);
        assert.equal(response.status, 200);
        const session = (await response.json()).data;
        assert.match(session.user.id, /^evimed_[a-f0-9]{40}$/);
        accountId ??= session.user.id;
        assert.equal(session.user.id, accountId);
        assert.match(session.csrfToken, /^csrf_/);
        const sessionCookie = cookieValue(response, "os_session");
        assert.ok(sessionCookie);
        assert.match(response.headers.getSetCookie().find((value) => value.startsWith("os_session=")), /HttpOnly;.*SameSite=Lax/);
        const me = await fetch(`${base}/api/me`, { headers: { Cookie: sessionCookie } });
        assert.equal(me.status, 200);
        const upstreamLogin = upstream.requests.at(-2);
        assert.equal(upstreamLogin.pathname, pathname);
        assert.equal(upstreamLogin.token, null);
        assert.deepEqual(upstreamLogin.body, expected);
        const introspection = upstream.requests.at(-1);
        assert.equal(introspection.pathname, introspectPath);
        assert.equal(introspection.token, envelope.token ?? envelope.data.token ?? envelope.data.access_token);
        assert.equal(introspection.authorization, `Bearer ${platformKey}`);
      }
    });
  } finally { await upstream.close(); }
});

test("account login never forwards browser credentials to the upstream account API", async () => {
  const upstream = await startTeamEndpoint();
  const browserToken = "synthetic-unrelated-browser-token-786ab2";
  upstream.answerWith((request) => request.pathname === introspectPath ? {} : { body: { code: 200, token } });
  try {
    await withApp(accountOverrides(upstream, { evimedIntrospectCacheTtlMs: 0 }), async ({ base }) => {
      for (const [key, input] of [
        ["passwordLoginUrl", { username: "reader", password }],
        ["smsLoginUrl", { phone, code: "123456" }],
      ]) {
        const response = await post(base, accountPaths[key], input, {
          token: browserToken, Authorization: `Bearer ${browserToken}`,
          Cookie: `name1=${browserToken}; os_session=synthetic-unrelated-science-session`,
        });
        assert.equal(response.status, 200);
        assert.ok(cookieValue(response, "os_session"));
        const upstreamLogin = upstream.requests.at(-2);
        assert.equal(upstreamLogin.token, null, "anonymous account requests carry no browser token");
        assert.equal(upstreamLogin.authorization, null);
        assert.equal(upstreamLogin.cookie, null);
        const introspection = upstream.requests.at(-1);
        assert.equal(introspection.token, token, "session verification still uses only the new upstream credential");
        assert.equal(introspection.authorization, `Bearer ${platformKey}`);
      }
      assert.equal(upstream.requests.some(request => JSON.stringify(request).includes(browserToken)), false);
    });
  } finally { await upstream.close(); }
});

test("refused, expired and missing login credentials never mint a session or fall back to browser credentials", async () => {
  const upstream = await startTeamEndpoint();
  let loginReply;
  let introspectionReply = {};
  upstream.answerWith((request) => request.pathname === introspectPath ? introspectionReply : loginReply);
  try {
    await withApp(accountOverrides(upstream, { evimedIntrospectCacheTtlMs: 0 }), async ({ base, dataDir }) => {
      for (const [reply, identityReply, status, code] of [
        [{ body: { code: 401, msg: token } }, {}, 401, "evimed_credential_rejected"],
        [{ status: 401, body: { code: 401 } }, {}, 401, "evimed_credential_rejected"],
        [{ body: { code: 200, data: {} } }, {}, 502, "evimed_account_failed"],
        [{ body: { code: 200, token } }, { body: { code: 401, data: null } }, 401, "evimed_credential_rejected"],
      ]) {
        loginReply = reply;
        introspectionReply = identityReply;
        const response = await post(base, accountPaths.passwordLoginUrl, { username: "reader", password }, { Cookie: "name1=synthetic-already-signed-in-token" });
        assert.equal(response.status, status);
        assert.equal((await response.json()).code, code);
        assert.equal(cookieValue(response, "os_session"), "");
      }
      assert.equal(upstream.requests.filter((request) => request.pathname === introspectPath).length, 1);
      await assert.rejects(readFile(path.join(dataDir, "users.json"), "utf8"), (error) => error.code === "ENOENT");
      assert.equal((await fetch(`${base}/api/me`)).status, 401);
    });
  } finally { await upstream.close(); }
});

test("account responses and audit persistence never retain team secrets or raw failure messages", async () => {
  const upstream = await startTeamEndpoint();
  const upstreamCookie = "synthetic-private-team-cookie-934abf";
  let rejected = false;
  upstream.answerWith((request) => request.pathname === introspectPath ? {} : {
    body: rejected ? { code: 400, msg: `${password} ${token} ${upstreamCookie}` } : { code: 200, token, data: { password, cookie: upstreamCookie } },
    headers: { "Set-Cookie": `team_private=${upstreamCookie}; HttpOnly` },
  });
  try {
    await withApp(accountOverrides(upstream), async ({ base, dataDir }) => {
      const responses = [];
      for (const shouldReject of [false, true]) {
        rejected = shouldReject;
        const response = await post(base, accountPaths.passwordLoginUrl, { username: "reader", password }, { Cookie: "unrelated=synthetic-browser-cookie" });
        assert.equal(response.status, rejected ? 401 : 200);
        responses.push(`${await response.text()}\n${response.headers.getSetCookie().join("\n")}`);
      }
      const persisted = await writtenText(dataDir);
      assert.match(persisted, /auth\.evimed\./);
      assert.match(persisted, /evimed_credential_rejected/);
      for (const secret of [password, token, upstreamCookie, platformKey, "synthetic-browser-cookie"]) {
        assert.equal(responses.join("\n").includes(secret), false, "a team secret reached a response");
        assert.equal(persisted.includes(secret), false, "a team secret reached persistence");
      }
      assert.equal(upstream.requests.some((request) => request.cookie?.includes("synthetic-browser-cookie")), false);
    });
  } finally { await upstream.close(); }
});

test("business refusals record only bounded generated diagnostics in the private audit", async () => {
  const upstream = await startTeamEndpoint();
  const rawMessage = "synthetic-private-provider-message-779aac";
  const privateAccount = "synthetic-private-reader-account";
  const privateCookie = "synthetic-private-provider-cookie-23da91";
  let reply;
  upstream.answerWith(() => ({ body: reply, headers: { "Set-Cookie": `private=${privateCookie}; HttpOnly` } }));
  const cases = [
    [{ code: 500, msg: `${rawMessage} 用户名或密码错误 ${password} ${token}` }, 500, "missing", false, "credentials"],
    [{ code: "429", success: false, message: `${rawMessage} 尝试次数过多 ${password}` }, 429, "false", false, "rate_limit"],
    [{ code: 200, success: false, token, msg: `${rawMessage} 验证码错误 ${password}` }, 200, "false", true, "challenge"],
    [{ code: `untrusted-${rawMessage}`, success: rawMessage, msg: `${rawMessage} 请求参数无效` }, null, "other", false, "invalid_input"],
    [{ code: 1_000_000, success: true, data: { access_token: token }, message: `${rawMessage} 服务不可用` }, null, "true", true, "service"],
    [{ code: null, msg: `${rawMessage} ${password} ${token} ${privateCookie}` }, null, "missing", false, "other"],
  ];
  try {
    await withApp(accountOverrides(upstream), async ({ base, dataDir }) => {
      const responses = [];
      for (const [body] of cases) {
        reply = body;
        const response = await post(base, accountPaths.passwordLoginUrl, { username: privateAccount, password });
        assert.equal(response.status, 401, "diagnostics must not change the existing refusal outcome");
        assert.equal(cookieValue(response, "os_session"), "");
        const publicBody = await response.json();
        assert.equal(publicBody.code, "evimed_credential_rejected");
        assert.equal(Object.hasOwn(publicBody, "detail"), false);
        responses.push(JSON.stringify(publicBody));
      }
      const lines = (await readFile(path.join(dataDir, ".openscience", "security.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const refusals = lines.filter(line => line.action === "auth.evimed.password-login");
      assert.equal(refusals.length, cases.length);
      refusals.forEach((entry, index) => {
        const [, businessCode, success, tokenPresent, reason] = cases[index];
        assert.equal(entry.status, "failed");
        assert.equal(entry.code, "evimed_credential_rejected");
        assert.ok(entry.detail.length <= 300);
        assert.deepEqual(JSON.parse(entry.detail), {
          stage: "account-response", operation: "password-login", httpStatus: 200,
          businessCode, success, tokenPresent, reason,
        });
      });
      const persisted = await writtenText(dataDir);
      for (const secret of [rawMessage, privateAccount, privateCookie, password, token, platformKey]) {
        assert.equal(persisted.includes(secret), false, "private provider data reached persistence");
        assert.equal(responses.join("\n").includes(secret), false, "private provider data reached a public response");
      }
      assert.equal(upstream.requests.some(request => request.pathname === introspectPath), false);
    });
  } finally { await upstream.close(); }
  assert.equal(evimedAccountFailureDetail(new Error(rawMessage)), "");
  assert.equal(evimedAccountFailureDetail({ detail: rawMessage }), "");
  assert.equal(evimedAccountFailureDetail(null), "");
});

test("captcha cookies are sealed per browser and login SMS binds the challenge to its phone", async () => {
  const upstream = await startTeamEndpoint();
  let challengeCount = 0;
  upstream.answerWith((request) => request.pathname === "/system/captcha/get"
    ? { body: { code: 200, data: captcha }, headers: { "Set-Cookie": `account_challenge=synthetic-browser-${++challengeCount}; HttpOnly` } }
    : { body: { code: 200, data: true } });
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      const browsers = [];
      for (const number of [phone, otherPhone]) {
        const response = await fetch(`${base}${accountPaths.captchaUrl}?phoneNumber=${number}`);
        assert.equal(response.status, 200);
        const header = response.headers.getSetCookie().join("\n");
        assert.match(header, /HttpOnly/);
        assert.match(header, /SameSite=Strict/);
        assert.match(header, /Secure/);
        assert.equal(header.includes("account_challenge="), false);
        assert.equal(header.includes("synthetic-browser-"), false);
        browsers.push(cookieValue(response, "os_evimed_account"));
      }
      assert.notEqual(browsers[0], browsers[1]);
      for (let index = 0; index < browsers.length; index++) {
        const response = await post(base, accountPaths.sendCodeUrl, { purpose: "login", phone: [phone, otherPhone][index], xcode: "123" }, {
          Cookie: `${browsers[index]}; name1=unrelated-credential; os_session=unrelated-science-session`,
        });
        assert.equal(response.status, 200);
        assert.equal(upstream.requests.at(-1).cookie, `account_challenge=synthetic-browser-${index + 1}`);
      }
      const before = upstream.requests.length;
      for (const cookie of [browsers[0], "os_evimed_account=tampered"]) {
        const response = await post(base, accountPaths.sendCodeUrl, { purpose: "login", phone: otherPhone, xcode: "123" }, { Cookie: cookie });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, "evimed_account_invalid_input");
      }
      assert.equal(upstream.requests.length, before);
    });
  } finally { await upstream.close(); }
});

test("same-origin captcha images become data URIs using only this browser's challenge cookie", async () => {
  const imagePaths = ["/captcha-images/canvas.png", "/captcha-images/block.png"];
  const upstream = await startTeamEndpoint({ imagePaths });
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=";
  upstream.answerWith((request) => request.pathname === "/system/captcha/get"
    ? {
      body: { code: 200, data: { ...captcha, canvasSrc: `${upstream.base}${imagePaths[0]}`, blockSrc: imagePaths[1] } },
      headers: { "Set-Cookie": `account_challenge=synthetic-image-${request.query.phoneNumber}; HttpOnly` },
    }
    : { raw: Buffer.from(pngBase64, "base64"), headers: { "Content-Type": "image/png" } });
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      for (const number of [phone, otherPhone]) {
        const response = await fetch(`${base}${accountPaths.captchaUrl}?phoneNumber=${number}`, {
          headers: { Cookie: "name1=synthetic-browser-credential; os_session=synthetic-browser-session; unrelated=private" },
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data, {
          ...captcha, canvasSrc: `data:image/png;base64,${pngBase64}`, blockSrc: `data:image/png;base64,${pngBase64}`,
        });
        const images = upstream.requests.filter((request) => imagePaths.includes(request.pathname)).slice(-2);
        assert.equal(images.length, 2);
        assert.deepEqual(images.map((request) => request.pathname).sort(), [...imagePaths].sort());
        for (const request of images) {
          assert.equal(request.method, "GET");
          assert.equal(request.cookie, `account_challenge=synthetic-image-${number}`);
          assert.equal(request.token, null);
          assert.equal(request.authorization, null);
        }
        const cookies = response.headers.getSetCookie().join("\n");
        assert.equal(cookies.includes("synthetic-image-"), false);
        assert.equal(cookies.includes("synthetic-browser-"), false);
      }
      assert.equal(upstream.requests.length, 6, "each captcha fetches exactly its two same-origin images");
    });
  } finally { await upstream.close(); }
});

test("captcha image normalization rejects cross-origin URLs and never follows image redirects", async () => {
  const upstream = await startTeamEndpoint({ imagePaths: ["/captcha-images/redirect.png"] });
  const elsewhere = await startTeamEndpoint({ imagePaths: ["/captcha-images/external.png", "/captcha-images/followed.png"] });
  let imageUrl = `${elsewhere.base}/captcha-images/external.png`;
  upstream.answerWith((request) => request.pathname === "/system/captcha/get"
    ? { body: { code: 200, data: { ...captcha, canvasSrc: imageUrl } } }
    : { status: 302, headers: { Location: `${elsewhere.base}/captcha-images/followed.png` } });
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      for (const [candidate, status, code] of [
        [`${elsewhere.base}/captcha-images/external.png`, 502, "evimed_account_failed"],
        [`${upstream.base}/captcha-images/redirect.png`, 503, "evimed_account_unreachable"],
      ]) {
        imageUrl = candidate;
        const response = await fetch(`${base}${accountPaths.captchaUrl}?phoneNumber=${phone}`);
        assert.equal(response.status, status);
        assert.equal((await response.json()).code, code);
      }
      assert.equal(elsewhere.requests.length, 0, "neither an external image nor an image redirect is fetched");
      assert.equal(upstream.requests.filter((request) => request.pathname === "/captcha-images/redirect.png").length, 1);
    });
  } finally {
    await upstream.close();
    await elsewhere.close();
  }
});

test("anonymous account calls require same-origin JSON while logout keeps session CSRF protection", async () => {
  const upstream = await startTeamEndpoint();
  upstream.answerWith((request) => request.pathname === introspectPath ? {} : { body: { code: 200, token } });
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      for (const headers of [{ Origin: "https://cross-site.invalid" }, { "Sec-Fetch-Site": "cross-site" }]) {
        const forged = await post(base, accountPaths.passwordLoginUrl, { username: "reader", password }, headers);
        assert.equal(forged.status, 403);
        assert.equal((await forged.json()).code, "csrf_required");
      }
      const form = await fetch(`${base}${accountPaths.passwordLoginUrl}`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "username=reader&password=unused",
      });
      assert.equal(form.status, 400);
      assert.equal(upstream.requests.length, 0);
      const signedIn = await post(base, accountPaths.passwordLoginUrl, { username: "reader", password });
      assert.equal(signedIn.status, 200, "a new browser has no session CSRF token yet");
      const { csrfToken } = (await signedIn.json()).data;
      const cookie = cookieValue(signedIn, "os_session");
      const forgedLogout = await post(base, "/api/auth/evimed/logout", {}, { Cookie: cookie });
      assert.equal(forgedLogout.status, 403);
      assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 200);
      const logout = await post(base, "/api/auth/evimed/logout", {}, { Cookie: cookie, "X-Open-Science-CSRF": csrfToken });
      assert.equal(logout.status, 200);
      assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 401);
    });
  } finally { await upstream.close(); }
});

test("captcha, account operations and the existing session exchange share the auth rate budget", async () => {
  const upstream = await startTeamEndpoint();
  upstream.answerWith((request) => ({ body: { code: 200, data: request.pathname === "/system/captcha/get" ? captcha : true } }));
  try {
    await withApp(accountOverrides(upstream, { authRateLimitMaxRequests: 2, authRateLimitWindowMs: 60_000 }), async ({ base }) => {
      assert.equal((await fetch(`${base}${accountPaths.captchaUrl}?phoneNumber=${phone}`)).status, 200);
      assert.equal((await post(base, accountPaths.sendCodeUrl, { purpose: "register", phone })).status, 200);
      const limited = await post(base, "/api/auth/evimed/session", { token });
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).code, "auth_rate_limited");
      assert.equal(upstream.requests.length, 2, "rate limiting happens before any upstream request");
    });
  } finally { await upstream.close(); }
});

test("disabled account adapters preserve local and OIDC method discovery", async () => {
  const upstream = await startTeamEndpoint();
  try {
    await withApp(accountOverrides(upstream, {
      authMode: "local", evimedAuthEnabled: false, bootstrapUser: "operator", bootstrapPassword: "synthetic-operator-password",
    }), async ({ base }) => {
      assert.deepEqual((await (await fetch(`${base}/api/auth/methods`)).json()).data, { mode: "local", selfRegistration: true });
      const login = await post(base, "/api/auth/login", { username: "operator", password: "synthetic-operator-password" });
      assert.equal(login.status, 200);
      const registration = await post(base, "/api/auth/register", { username: "new-reader", password: "synthetic-registration-password" });
      assert.equal(registration.status, 201);
      const absent = await post(base, accountPaths.passwordLoginUrl, { username: "operator", password });
      assert.equal(absent.status, 404);
    });
    await withApp(accountOverrides(upstream, {
      authMode: "oidc", evimedAuthEnabled: false, oidcIssuer: upstream.base, oidcClientId: "synthetic-client",
      oidcClientSecret: "synthetic-client-secret", oidcClientSecretFile: "", oidcFlowSecret: "synthetic-flow-secret-that-is-at-least-thirty-two-characters", oidcFlowSecretFile: "",
    }), async ({ base }) => {
      const methods = (await (await fetch(`${base}/api/auth/methods`)).json()).data;
      assert.equal(methods.mode, "oidc");
      assert.equal(methods.oidc.startUrl, "/api/auth/oidc/start");
      assert.equal(Object.hasOwn(methods, "evimed"), false);
      const passwordAttempt = await post(base, "/api/auth/login", { username: "reader", password });
      assert.equal(passwordAttempt.status, 404);
      assert.equal((await passwordAttempt.json()).code, "auth_method_disabled");
    });
    assert.equal(upstream.requests.length, 0);
  } finally { await upstream.close(); }
});

test("invalid client fields and unsafe captcha content are rejected without forwarding arbitrary input", async () => {
  const upstream = await startTeamEndpoint();
  upstream.answerWith(() => ({ body: { code: 200, data: { ...captcha, canvasSrc: "javascript:alert(1)" } } }));
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      for (const [key, input] of [
        ["sendCodeUrl", { purpose: "arbitrary", phone }],
        ["sendCodeUrl", { purpose: "reset", phone, upstreamUrl: "http://127.0.0.1/elsewhere" }],
        ["smsLoginUrl", { phone: "bad-number", code: "123456" }],
        ["smsLoginUrl", { phone, code: "123456", token }],
        ["registerUrl", { phone, code: "123456", password: "lettersOnly" }],
        ["resetPasswordUrl", { phone, code: "non-numeric", password }],
      ]) {
        const response = await post(base, accountPaths[key], input);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, "evimed_account_invalid_input");
      }
      assert.equal(upstream.requests.length, 0);
      const invalidCaptcha = await fetch(`${base}${accountPaths.captchaUrl}?phoneNumber=${phone}`);
      assert.equal(invalidCaptcha.status, 502);
      assert.equal((await invalidCaptcha.json()).code, "evimed_account_failed");
    });
  } finally { await upstream.close(); }
});

test("upstream business failures, malformed JSON and redirects expose bounded adapter errors", async () => {
  const upstream = await startTeamEndpoint();
  let reply;
  upstream.answerWith(() => reply);
  try {
    await withApp(accountOverrides(upstream), async ({ base }) => {
      for (const [answer, status, code] of [
        [{ body: { code: 400, data: true, msg: password } }, 400, "evimed_account_rejected"],
        [{ body: { code: 200, success: false, data: true } }, 400, "evimed_account_rejected"],
        [{ raw: "not JSON" }, 502, "evimed_account_failed"],
        [{ raw: JSON.stringify({ code: 200, data: "x".repeat(2 * 1024 * 1024) }) }, 502, "evimed_account_failed"],
        [{ status: 302, headers: { Location: `${upstream.base}/system/user/register` } }, 503, "evimed_account_unreachable"],
        [{ status: 429, body: { code: 429 } }, 429, "auth_rate_limited"],
      ]) {
        reply = answer;
        const response = await post(base, accountPaths.verifyCodeUrl, { phone, code: "123456" });
        assert.equal(response.status, status);
        const body = await response.json();
        assert.equal(body.code, code);
        assert.equal(JSON.stringify(body).includes(password), false);
        assert.equal(cookieValue(response, "os_session"), "");
      }
      assert.equal(upstream.requests.length, 6, "an upstream redirect is never followed");
    });
  } finally { await upstream.close(); }
});
