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

const elapsedMs = (run) => {
  const started = process.hrtime.bigint();
  const result = run();
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};

test("a hostile pattern costs a verdict milliseconds, not the event loop", () => {
  // The 2026-09-20 release's security review reproduced it: these patterns were
  // compiled to backtracking RegExps, and four wildcards against a
  // 200-character path took 10 s, five against 120 took 16 s — eight against
  // 220 never finished, which is why the cases here are ones the old code
  // does finish: a regression fails this test instead of hanging the suite.
  for (const [stars, length] of [[4, 200], [5, 120]]) {
    const text = `User-agent: *\nDisallow: /${"*a".repeat(stars)}*b\n`;
    const { result, ms } = elapsedMs(() => verdict(text, `/${"a".repeat(length)}`));
    assert.equal(result.allowed, true, "no b, no match");
    assert.ok(ms < 1_000, `${stars} wildcards against ${length} characters took ${ms.toFixed(0)} ms`);
  }
  // The most work the caps allow: the longest path, as many rules as one
  // verdict weighs, each scanning all of it, spread over repeated groups.
  const repeated = ("User-agent: *\n" + "Disallow: /*b\n".repeat(1_000)).repeat(36);
  const { ms } = elapsedMs(() => verdict(repeated, `/${"a".repeat(2_040)}`));
  assert.ok(ms < 1_000, `a capped verdict took ${ms.toFixed(0)} ms`);
});

test("wildcards and the end anchor mean what the old expressions meant", () => {
  // The expressions this matcher replaced, as the oracle: safe on inputs this
  // small, and the reading the rest of this file's cases were written against.
  const oracle = (pattern, path) => {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const expression = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(path);
  };
  // A 32-bit generator read from its high bits: the first draft multiplied
  // past 2^53, its low bits collapsed to zero, and every case was "/" against
  // "/" — which is why the outcomes are counted below.
  let seed = 20260920;
  const next = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * limit);
  };
  const word = (alphabet, length) => Array.from({ length }, () => alphabet[next(alphabet.length)]).join("");
  const outcomes = { matched: 0, unmatched: 0 };
  for (let round = 0; round < 10_000; round += 1) {
    // Every other round puts a literal `$` inside patterns and paths.
    const literalDollar = round % 2 === 1;
    const pattern = `/${word(literalDollar ? "ab*$" : "ab*", next(8))}${next(2) ? "$" : ""}`;
    const path = `/${word(literalDollar ? "ab$" : "ab", next(10))}`;
    const expected = oracle(pattern, path);
    outcomes[expected ? "matched" : "unmatched"] += 1;
    const text = `User-agent: *\nDisallow: ${pattern}\n`;
    assert.equal(verdict(text, path).allowed, !expected, `pattern ${pattern} against ${path}`);
  }
  assert.ok(outcomes.matched > 1_000 && outcomes.unmatched > 1_000, `the cases did not vary: ${JSON.stringify(outcomes)}`);
});

test("rules are capped in length, in number per verdict, and past the file's size limit", () => {
  // A rule longer than any URL web reading accepts is ignored, however much
  // it would match.
  assert.equal(verdict(`User-agent: *\nDisallow: /${"*".repeat(2_048)}\n`, "/any").allowed, true);
  assert.equal(verdict(`User-agent: *\nDisallow: /${"*".repeat(2_046)}\n`, "/any").allowed, false, "one at the limit is read");
  // Two thousand rules are weighed, the groups naming us combined first;
  // what comes after is ignored.
  const filler = (count) => Array.from({ length: count }, (_, index) => `Disallow: /filler-${index}/`).join("\n");
  assert.equal(verdict(`User-agent: *\n${filler(1_999)}\nDisallow: /private\n`, "/private/a").allowed, false);
  assert.equal(verdict(`User-agent: *\n${filler(2_000)}\nDisallow: /private\n`, "/private/a").allowed, true);
  assert.equal(verdict(`User-agent: *\n${filler(1_500)}\n\nUser-agent: *\n${filler(500)}\nDisallow: /private\n`, "/private/a").allowed, true);
  // Content past the first 512 KiB is not read.
  const padded = (size) => `User-agent: *\n#${"x".repeat(size)}\nDisallow: /\n`;
  assert.equal(verdict(padded(400 * 1024), "/any").allowed, false);
  assert.equal(verdict(padded(512 * 1024), "/any").allowed, true);
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
