import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BROWSER_SESSION_CREDENTIAL_KEY,
  BROWSER_SESSION_SECRET_BYTES,
  browserSessionCookie,
  browserSessionCookieName,
  browserSessionCredentialRecord,
  generateBrowserSessionSecret,
} from "../src/dshBrowserAuth.mjs";
import { mockAcceptsBrowserSession, startMockDshRuntime } from "../src/mockDshRuntime.mjs";

/**
 * Where a live 0.1.2 kernel and its secret sit when one is up on this machine.
 * A live check beats a self-consistent one, and this whole cookie exists
 * because 0.1.1 needed none — so when the binary is here, it gets asked.
 */
const LIVE_KERNEL_URL = process.env.DSH_LIVE_KERNEL_URL ?? "http://127.0.0.1:45011";
const LIVE_SECRET_FILE = process.env.DSH_LIVE_SECRET_FILE ?? "/tmp/dsh-probe/minted-secret.txt";

/** @param {Buffer} value */
const base64url = (value) => value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
/** @param {string} text */
const fromBase64url = (text) => Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4), "base64");

/** @param {string} cookie @returns {{ name: string, version: string, body: string, signature: string, payload: Record<string, any> }} */
function dissect(cookie) {
  const index = cookie.indexOf("=");
  const name = cookie.slice(0, index);
  const [version, body, signature] = cookie.slice(index + 1).split(".");
  return { name, version, body, signature, payload: JSON.parse(fromBase64url(body).toString("utf8")) };
}

/** One `client-request` envelope for a unary call. */
const listEnvelope = (rpcId) => JSON.stringify({
  type: "client-request",
  rpcId,
  method: "session/list",
  payload: { args: { _request: {} } },
});

test("the cookie name is sha256 of the authority, in the kernel's own encoding", () => {
  const authority = "runtime-alice-paper1:8080";
  // Recomputed here rather than imported, so this asserts the formula and not
  // just that the module agrees with itself.
  const expected = `dsh-auth-${base64url(createHash("sha256").update(authority).digest())}`;
  assert.equal(browserSessionCookieName(authority), expected);

  // Pinned to a name a live 0.1.2-alpha.3 kernel accepted on 2026-09-01: the
  // same POST answered 200 with this cookie and 401 without it. A formula that
  // still agrees with itself after drifting from the kernel's is exactly the
  // failure this line exists to catch.
  assert.equal(browserSessionCookieName("127.0.0.1:45011"), "dsh-auth-cG3AlRxjrx5fdk32xTEJTthT6diAUmUl1fXPhGc1OWk");

  assert.throws(() => browserSessionCookieName(""), /authority/);
  assert.throws(() => browserSessionCookieName("   "), /authority/);
});

test("a cookie minted for another authority is a different cookie, in both halves", () => {
  // The binding is the part that bites: the kernel derives the name from the
  // `Host` header it received, so a cookie for the URL we dialled rather than
  // the host the container sees reads as "not authenticated" with nothing said
  // about a name mismatch.
  const secret = generateBrowserSessionSecret();
  const now = 1_788_000_000_000;
  const mine = browserSessionCookie({ secret, authority: "127.0.0.1:8080", now });
  const theirs = browserSessionCookie({ secret, authority: "runtime:8080", now });

  const a = dissect(mine);
  const b = dissect(theirs);
  assert.notEqual(a.name, b.name, "the name carries the authority, so the kernel never even looks for the other one");
  assert.notEqual(a.body, b.body, "and the signed payload carries it too, so a renamed cookie is still refused");
  assert.notEqual(a.signature, b.signature);
  assert.equal(a.payload.authority, "127.0.0.1:8080");
  assert.equal(b.payload.authority, "runtime:8080");
  assert.equal(a.payload.version, 1);
  assert.equal(a.payload.issuedAt, now);
  assert.ok(a.payload.expiresAt > a.payload.issuedAt);

  // Same authority and same secret is deterministic at a fixed clock: the whole
  // point of minting it ourselves is that it is available before the container
  // has booted, which requires it not to depend on anything the container says.
  assert.equal(browserSessionCookie({ secret, authority: "127.0.0.1:8080", now }), mine);
});

test("a tampered signature is a different value, and an independent verifier refuses it", async () => {
  const secret = generateBrowserSessionSecret();
  const authority = "127.0.0.1:8080";
  const cookie = browserSessionCookie({ secret, authority });
  const { name, body, signature } = dissect(cookie);

  // The signature is HMAC-SHA256 over the encoded payload, keyed by the stored
  // secret — recomputed here, again, rather than trusted.
  assert.equal(signature, base64url(createHmac("sha256", fromBase64url(secret)).update(body).digest()));

  const flip = (text) => text.slice(0, -1) + (text.at(-1) === "A" ? "B" : "A");
  const tamperedSignature = `${name}=v1.${body}.${flip(signature)}`;
  assert.notEqual(tamperedSignature, cookie);

  // A payload edited to claim another authority cannot be re-signed without the
  // secret, so it keeps the old signature and stops verifying.
  const liftedBody = base64url(Buffer.from(JSON.stringify({ ...dissect(cookie).payload, authority: "evil:1" }), "utf8"));
  const tamperedPayload = `${name}=v1.${liftedBody}.${signature}`;

  const accepts = (cookieHeader) => mockAcceptsBrowserSession({ secret, authority, cookieHeader });
  assert.equal(accepts(cookie), true, "the untampered cookie must verify, or the rest of this test proves nothing");
  assert.equal(accepts(tamperedSignature), false);
  assert.equal(accepts(tamperedPayload), false);
  assert.equal(accepts(undefined), false);
  assert.equal(accepts(`${name}=v1.${body}`), false, "a cookie with no signature at all is not a cookie");
  assert.equal(accepts(`${name}=v2.${body}.${signature}`), false, "an unknown version is refused rather than assumed");
  // Right cookie, wrong door: the same bytes sent to another authority.
  assert.equal(mockAcceptsBrowserSession({ secret, authority: "elsewhere:1", cookieHeader: cookie }), false);
  // Right cookie, wrong key.
  assert.equal(mockAcceptsBrowserSession({ secret: generateBrowserSessionSecret(), authority, cookieHeader: cookie }), false);
  // Expired.
  assert.equal(
    mockAcceptsBrowserSession({ secret, authority, cookieHeader: browserSessionCookie({ secret, authority, now: 1, lifetimeMs: 1 }) }),
    false,
  );
});

test("a secret the kernel would refuse is refused here first", () => {
  const secret = generateBrowserSessionSecret();
  assert.equal(fromBase64url(secret).byteLength, BROWSER_SESSION_SECRET_BYTES);
  assert.match(secret, /^[A-Za-z0-9_-]+$/, "the kernel reads this out of YAML; padding and slashes have no business there");
  assert.notEqual(generateBrowserSessionSecret(), secret, "a fixed secret would be a shared one");

  assert.throws(() => browserSessionCookie({ secret: "not base64url!!", authority: "a:1" }), /base64url/);
  assert.throws(() => browserSessionCookie({ secret: base64url(randomBytes(16)), authority: "a:1" }), /32 bytes/);
  assert.throws(() => browserSessionCookie({ secret, authority: "" }), /authority/);
});

test("the credential record is the kernel's key and shape, returned as data", () => {
  const secret = generateBrowserSessionSecret();
  const record = browserSessionCredentialRecord({ secret });
  assert.equal(record.key, BROWSER_SESSION_CREDENTIAL_KEY);
  assert.equal(record.key, "client-connection/browser-session");
  assert.deepEqual(record.record, { kind: "grant", payload: { version: 1, secret } });
  assert.throws(() => browserSessionCredentialRecord({ secret: "short" }), /base64url|32 bytes/);
});

test("a kernel that authenticates refuses the unauthenticated request, and accepts ours", async () => {
  // Against the mock, which verifies with its own HMAC rather than by calling
  // the minter back — so this is two implementations agreeing, not one.
  const mock = await startMockDshRuntime({ pingIntervalMs: 0 });
  try {
    const post = (cookie) => fetch(`${mock.url}/api/session/list`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: listEnvelope("auth-test"),
    });

    const none = await post(null);
    assert.equal(none.status, 401);
    assert.equal(await none.text(), "unauthorized");

    const elsewhere = await post(browserSessionCookie({ secret: mock.secret, authority: "somewhere-else:9999" }));
    assert.equal(elsewhere.status, 401, "the authority binding is real, and it is silent about being the reason");
    await elsewhere.text();

    const good = await post(mock.cookie);
    assert.equal(good.status, 200);
    const envelope = await good.json();
    assert.equal(envelope.result.ok, true);
  } finally {
    await mock.close();
  }
});

test("the live 0.1.2 kernel accepts this cookie and refuses everything near it", async (t) => {
  // Opt-out by absence, never by silence: if there is no kernel here this says
  // it was skipped and why, rather than passing as a check that ran.
  /** @type {string | null} */
  let secret = null;
  try {
    secret = (await readFile(LIVE_SECRET_FILE, "utf8")).trim();
  } catch {
    t.skip(`no live kernel secret at ${LIVE_SECRET_FILE}; the mock-kernel test above is what ran instead`);
    return;
  }
  const authority = new URL(LIVE_KERNEL_URL).host;
  const post = (cookie) => fetch(`${LIVE_KERNEL_URL}/api/session/list`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: listEnvelope("live-auth-test"),
    signal: AbortSignal.timeout(4_000),
  });

  /** @type {Response} */
  let unauthenticated;
  try {
    unauthenticated = await post(null);
  } catch {
    t.skip(`no live kernel answering at ${LIVE_KERNEL_URL}; the mock-kernel test above is what ran instead`);
    return;
  }
  assert.equal(unauthenticated.status, 401, "0.1.2 authenticates even on loopback");
  await unauthenticated.text();

  const accepted = await post(browserSessionCookie({ secret, authority }));
  assert.equal(accepted.status, 200, "the minted cookie is the one the kernel was looking for");
  const envelope = await accepted.json();
  assert.equal(envelope.type, "server-response");
  assert.equal(envelope.result.ok, true);

  const wrongAuthority = await post(browserSessionCookie({ secret, authority: "somewhere-else:9999" }));
  assert.equal(wrongAuthority.status, 401);
  await wrongAuthority.text();

  const cookie = browserSessionCookie({ secret, authority });
  const tampered = await post(cookie.slice(0, -3) + (cookie.endsWith("AAA") ? "BBB" : "AAA"));
  assert.equal(tampered.status, 401);
  await tampered.text();
});
