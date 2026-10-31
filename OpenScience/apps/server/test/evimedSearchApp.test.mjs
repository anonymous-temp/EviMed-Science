import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

test("account search is wired to the authenticated app and keeps upstream expiry separate from platform logout", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-search-app-"));
  const token = "synthetic-search-account-credential";
  const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  let expired = false;
  const requested = [];
  const app = createWebApiApp({
    dataDir, port: 0, localAutoConfig: false, runtimeMode: "mock", authMode: "local",
    evimedAuthEnabled: true, evimedAccountApiBaseUrl: "https://accounts.example.test/api-evimed",
    evimedUserIntrospectUrl: "https://accounts.example.test/api-evimed/system/v2/profile/info",
    evimedApiKey: "", evimedApiKeyFile: "",
    modelGatewaySigningSecret: "synthetic-session-encryption-secret-for-tests-only",
    evimedAccountFetch: async () => json({ code: 200, data: { token } }),
    evimedIntrospectFetch: async () => json({ code: 200, data: { userId: "search-reader", nickName: "Search Reader" } }),
    evimedSearchFetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      requested.push(pathname);
      assert.equal(new Headers(init.headers).get("token"), token);
      assert.equal(new Headers(init.headers).get("cookie"), null);
      if (expired) return json({ code: 401 });
      if (pathname.endsWith("/screen")) return json({ code: 200, data: { screenId: "screen-reader" } });
      if (pathname.endsWith("/selectLiteratureDetails")) return json({ code: 200, data: { id: "paper-1", title: "A controlled study", abstract: "Preserved abstract", doi: "10.1234/example" } });
      if (pathname.endsWith("/search")) return json({ code: 200, data: { list: [{ id: "paper-1", title: "A controlled study", abstract: "Preserved abstract" }], total: 1 } });
      throw new Error("Unexpected synthetic upstream path");
    },
  });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/evimed/password-login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "search-reader", password: "SyntheticPassword123" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith("os_session="))?.split(";")[0];
    assert.ok(cookie);
    const loginBody = await login.json();
    assert.equal(JSON.stringify(loginBody).includes(token), false);
    const csrf = loginBody.data.csrfToken;
    const headers = { cookie, "content-type": "application/json", "X-Open-Science-CSRF": csrf };
    const query = { query: "diabetes", page: 1, pageSize: 10, filters: {} };
    const me = await fetch(`${base}/api/me`, { headers: { cookie } }).then(response => response.json());
    assert.equal(me.data.user.authType, "evimed");
    assert.equal(me.data.features.evimedSearch, true);
    assert.equal(JSON.stringify(me).includes(token), false);

    const withoutCsrf = await fetch(`${base}/api/evimed-search/literature/search`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(query),
    });
    assert.equal(withoutCsrf.status, 403);
    assert.equal(requested.length, 0);
    const search = await fetch(`${base}/api/evimed-search/literature/search`, { method: "POST", headers, body: JSON.stringify(query) });
    assert.equal(search.status, 200);
    assert.equal(search.headers.get("cache-control"), "no-store");
    const found = await search.json();
    assert.equal(found.data.items[0].title, "A controlled study");
    assert.equal(JSON.stringify(found).includes(token), false);
    const detailRef = found.data.items[0].detailRef;
    const detail = await fetch(`${base}/api/evimed-search/literature/detail`, {
      method: "POST", headers, body: JSON.stringify({ detailRef }),
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.sections[0].text, "Preserved abstract");

    expired = true;
    const rejected = await fetch(`${base}/api/evimed-search/literature/search`, { method: "POST", headers, body: JSON.stringify(query) });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, "evimed_search_credential_expired");
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 200);
    const count = requested.length;
    const needsLogin = await fetch(`${base}/api/evimed-search/literature/search`, { method: "POST", headers, body: JSON.stringify(query) });
    assert.equal((await needsLogin.json()).code, "evimed_search_login_required");
    assert.equal(requested.length, count);

    const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers, body: "{}" });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
    const afterLogout = await fetch(`${base}/api/evimed-search/literature/detail`, {
      method: "POST", headers, body: JSON.stringify({ detailRef }),
    });
    assert.equal(afterLogout.status, 401);
    assert.equal(requested.length, count);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
