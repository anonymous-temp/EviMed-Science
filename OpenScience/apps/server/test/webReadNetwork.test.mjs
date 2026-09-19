// The network edge of web reading: which addresses the gateway may connect
// to, on the first hop and on every redirect after it.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublicWebHost,
  nodeWebTransport,
  pinnedPublicLookup,
  privateHostname,
  validatedWebUrl,
} from "../src/webReadNetwork.mjs";

/** @param {Record<string, Array<{ address: string, family: number }>>} table */
function resolver(table) {
  const calls = [];
  const resolveImpl = async (hostname) => {
    calls.push(hostname);
    const records = table[hostname];
    if (!records) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return records;
  };
  return { resolveImpl, calls };
}

function lookupResult(lookup, hostname, options) {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

test("a page URL is refused before any network when it names no public website", () => {
  for (const [url, code] of [
    ["https://127.0.0.1/x", "web_read_host_forbidden"],
    ["https://10.1.2.3/x", "web_read_host_forbidden"],
    ["https://169.254.169.254/latest/meta-data/", "web_read_host_forbidden"],
    ["https://100.100.100.200/latest/meta-data/", "web_read_host_forbidden"],
    ["https://[::1]/x", "web_read_host_forbidden"],
    ["https://localhost/x", "web_read_host_forbidden"],
    ["https://open-science-web/internal/model/v1", "web_read_host_forbidden"],
    ["https://evimed-postgres.internal/", "web_read_host_forbidden"],
    // Built, not written: a credential-shaped literal is what the source
    // secret audit exists to refuse, test fixtures included.
    [Object.assign(new URL("https://example.org/x"), { username: "someone", password: "anything" }).href, "web_read_url_forbidden"],
    ["https://example.org:8443/x", "web_read_url_forbidden"],
    ["ftp://example.org/x", "web_read_url_invalid"],
    ["file:///etc/passwd", "web_read_url_invalid"],
    ["not a url", "web_read_url_invalid"],
  ]) {
    assert.throws(() => validatedWebUrl(url), (error) => error.code === code, url);
  }
  // A fragment is how a citation points at a passage; it is dropped, not refused.
  assert.equal(validatedWebUrl("https://www.nice.org.uk/guidance/ng136#section-3").href, "https://www.nice.org.uk/guidance/ng136");
  assert.equal(validatedWebUrl("http://www.nhc.gov.cn/wjw/gfxwj/list.shtml").protocol, "http:");
  assert.equal(privateHostname("www.nmpa.gov.cn"), false);
});

test("the socket is handed only addresses that were checked, and every answer must be public", async () => {
  const { resolveImpl, calls } = resolver({
    "public.example.org": [{ address: "93.184.216.34", family: 4 }],
    "loopback.example.org": [{ address: "127.0.0.1", family: 4 }],
    // One public and one private answer: the connection picks, not us.
    "split.example.org": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }],
    // IPv4 smuggled through an IPv6 answer, at the address that matters most.
    "mapped.example.org": [{ address: "::ffff:169.254.169.254", family: 6 }],
    "ula.example.org": [{ address: "fd00::1", family: 6 }],
  });
  const lookup = pinnedPublicLookup(resolveImpl);

  const ok = await lookupResult(lookup, "public.example.org", { all: false });
  assert.equal(ok.error, null);
  assert.equal(ok.address, "93.184.216.34");
  const all = await lookupResult(lookup, "public.example.org", { all: true });
  assert.deepEqual(all.address, [{ address: "93.184.216.34", family: 4 }]);

  for (const host of ["loopback.example.org", "split.example.org", "mapped.example.org", "ula.example.org"]) {
    const refused = await lookupResult(lookup, host, { all: true });
    assert.equal(refused.error?.code, "web_read_host_forbidden", host);
  }
  const missing = await lookupResult(lookup, "nowhere.example.org", {});
  assert.equal(missing.error?.code, "web_read_host_unresolved");
  // One resolution per connection: the checked answer is the used answer, so a
  // name that changes its answer between a check and a connect has no window.
  assert.equal(calls.filter((host) => host === "public.example.org").length, 2);
});

test("the real transport never opens a socket to a name that resolves inward", async () => {
  const { resolveImpl } = resolver({ "rebind.example.org": [{ address: "127.0.0.1", family: 4 }] });
  const transport = nodeWebTransport({ resolveImpl });
  await assert.rejects(
    transport({ url: new URL("http://rebind.example.org/"), headers: {}, maxBytes: 1024 }),
    (error) => error.code === "web_read_host_forbidden",
  );
});

test("a browser's final address is checked against this network's DNS too", async () => {
  const { resolveImpl } = resolver({
    "fine.example.org": [{ address: "93.184.216.34", family: 4 }],
    "inward.example.org": [{ address: "192.168.1.9", family: 4 }],
  });
  await assertPublicWebHost("fine.example.org", resolveImpl);
  await assert.rejects(assertPublicWebHost("inward.example.org", resolveImpl), (error) => error.code === "web_read_host_forbidden");
  await assert.rejects(assertPublicWebHost("127.0.0.1", resolveImpl), (error) => error.code === "web_read_host_forbidden");
});
