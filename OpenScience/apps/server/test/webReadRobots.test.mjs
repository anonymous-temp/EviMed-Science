// robots.txt as RFC 9309 reads it, plus the one documented deviation: a
// robots.txt that cannot be fetched allows the read.
import assert from "node:assert/strict";
import test from "node:test";

import { webReadError } from "../src/webReadNetwork.mjs";
import { parseRobotsTxt, robotsVerdict, RobotsPolicy } from "../src/webReadRobots.mjs";

const verdict = (text, path, productToken) => robotsVerdict(parseRobotsTxt(text), { path, productToken });

test("the longest matching rule wins and a tie goes to allow", () => {
  const text = [
    "User-agent: *",
    "Disallow: /guidance/",
    "Allow: /guidance/ng136",
    "Disallow: /*.pdf$",
    "Allow: /tie",
    "Disallow: /tie",
  ].join("\n");
  assert.equal(verdict(text, "/guidance/ng100").allowed, false);
  assert.equal(verdict(text, "/guidance/ng136/chapter/Recommendations").allowed, true);
  assert.equal(verdict(text, "/files/guideline.pdf").allowed, false);
  assert.equal(verdict(text, "/files/guideline.pdf?download=1").allowed, true, "`$` anchors the end of the path");
  assert.equal(verdict(text, "/tie").allowed, true);
  assert.equal(verdict(text, "/elsewhere").allowed, true);
  assert.equal(verdict(text, "/robots.txt").allowed, true);
});

test("our own group replaces the star group, matched case-insensitively", () => {
  const text = [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: evimedbot",
    "Disallow: /private/",
    "Crawl-delay: 3",
  ].join("\n");
  assert.equal(verdict(text, "/xxgk/ggtg/index.html").allowed, true);
  assert.equal(verdict(text, "/private/a").allowed, false);
  assert.equal(verdict(text, "/xxgk/").crawlDelayMs, 3_000);
  // Another crawler's product token is not ours.
  assert.equal(verdict(text, "/xxgk/", "OtherBot").allowed, false);
});

test("an empty Disallow and a file without groups allow everything", () => {
  assert.equal(verdict("User-agent: *\nDisallow:\n", "/any").allowed, true);
  assert.equal(verdict("<html><body>WAF challenge</body></html>", "/any").allowed, true);
  // Rules before any user-agent line belong to no group.
  assert.equal(verdict("Disallow: /\n", "/any").allowed, true);
});

test("non-ASCII paths are compared percent-encoded", () => {
  const text = "User-agent: *\nDisallow: /通知/\n";
  assert.equal(verdict(text, "/%E9%80%9A%E7%9F%A5/1.html").allowed, false);
  assert.equal(verdict(text, "/%e9%80%9a%e7%9f%a5/1.html").allowed, false, "escapes compare case-insensitively");
});

function policy(responder) {
  const requests = [];
  const transport = async ({ url }) => {
    requests.push(url.href);
    return responder(url);
  };
  return { policy: new RobotsPolicy({ transport, userAgent: "EviMedBot/1.0 (+test)" }), requests };
}

const body = (status, text = "", headers = {}) => ({ status, headers, body: Buffer.from(text) });

test("a fetched robots.txt is honoured and cached per origin; concurrent checks share one fetch", async () => {
  const { policy: robots, requests } = policy(() => body(200, "User-agent: *\nDisallow: /secret\n"));
  const [first, second] = await Promise.all([
    robots.check(new URL("https://site.example.org/open")),
    robots.check(new URL("https://site.example.org/secret/page")),
  ]);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.source, "rules");
  await robots.check(new URL("https://site.example.org/other"));
  assert.deepEqual(requests, ["https://site.example.org/robots.txt"]);
});

test("4xx means no rules; server errors and silence allow the read and say so", async () => {
  for (const [responder, source] of [
    [() => body(404), "none"],
    [() => body(403, "<html>WAF</html>"), "none"],
    [() => body(412, "<script>$_ts=window['$_ts']</script>"), "none"],
    [() => body(500), "unreachable"],
    [() => { throw webReadError(502, "web_read_upstream_unavailable", "reset"); }, "unreachable"],
    [() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, "unreachable"],
  ]) {
    const { policy: robots } = policy(responder);
    const check = await robots.check(new URL("https://waf.example.org/page"));
    assert.equal(check.allowed, true);
    assert.equal(check.source, source);
  }
  // A defect in this code is not an unreachable robots.txt and is not swallowed.
  const { policy: broken } = policy(() => { throw new TypeError("bug"); });
  await assert.rejects(broken.check(new URL("https://waf.example.org/page")), TypeError);
});

test("a robots.txt redirect is followed, and a redirect inward is treated as unreachable", async () => {
  const { policy: robots, requests } = policy((url) => {
    if (url.hostname === "moved.example.org") return body(301, "", { location: "https://new.example.org/robots.txt" });
    if (url.hostname === "new.example.org") return body(200, "User-agent: *\nDisallow: /\n");
    return body(302, "", { location: "http://127.0.0.1/robots.txt" });
  });
  assert.equal((await robots.check(new URL("https://moved.example.org/x"))).allowed, false);
  const inward = await robots.check(new URL("https://sneaky.example.org/x"));
  assert.equal(inward.allowed, true);
  assert.equal(inward.source, "unreachable");
  assert.ok(!requests.some((href) => href.includes("127.0.0.1")), "the inward hop was never requested");
});
