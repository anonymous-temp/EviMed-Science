// Replaying the outside world so a paired evaluation measures the change.
//
// The rule this file exists to hold is the first one: a missing fixture is a
// failure, never a fall-through to the network. "Replay if we have it,
// otherwise fetch" produces a corpus that is reproducible for some requests and
// live for others, and nothing afterwards can say which were which.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXTURE_MISSING_CODE,
  FIXTURE_MISSING_STATUS,
  createRecordedFetch,
  fixtureKey,
  resolveGatewayFetch,
} from "../src/recordedGateway.mjs";

/** @param {(dir: string) => Promise<void>} body */
async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "os-fixtures-"));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("the key is the upstream request, so two bodies to one endpoint are two fixtures", () => {
  const one = fixtureKey("POST", "https://api.example/search", JSON.stringify({ q: "aspirin" }));
  const two = fixtureKey("POST", "https://api.example/search", JSON.stringify({ q: "warfarin" }));
  assert.notEqual(one, two);
  assert.equal(one, fixtureKey("post", "https://api.example/search", JSON.stringify({ q: "aspirin" })), "the method is case-folded");
  assert.equal(fixtureKey("GET", "https://api.example/x"), fixtureKey("GET", "https://api.example/x", ""));
  assert.match(one, /^[a-f0-9]{64}$/);
});

test("a missing fixture answers 599 and never reaches the network", async () => {
  await withTempDir(async (dir) => {
    let liveCalls = 0;
    /** @type {string[]} */
    const misses = [];
    const fetchImpl = createRecordedFetch({
      fixturesDir: dir,
      fetchImpl: async () => { liveCalls += 1; return new Response("live", { status: 200 }); },
      onMiss: (request) => misses.push(request.url),
    });
    const response = await fetchImpl("https://api.example/absent");
    assert.equal(response.status, FIXTURE_MISSING_STATUS);
    const body = await response.json();
    assert.equal(body.error, FIXTURE_MISSING_CODE);
    assert.match(body.message, /https:\/\/api\.example\/absent/);
    assert.equal(liveCalls, 0, "a miss must not fall through to the real network");
    assert.deepEqual(misses, ["https://api.example/absent"]);
  });
});

test("a present fixture is replayed byte for byte, including its status and headers", async () => {
  await withTempDir(async (dir) => {
    const key = fixtureKey("GET", "https://api.example/one");
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify({
      key, method: "GET", url: "https://api.example/one", status: 429,
      headers: { "content-type": "application/json", "retry-after": "30" },
      body: JSON.stringify({ hits: [1, 2, 3] }),
    }));
    const fetchImpl = createRecordedFetch({ fixturesDir: dir, fetchImpl: async () => { throw new Error("network"); } });
    const response = await fetchImpl("https://api.example/one");
    assert.equal(response.status, 429, "an upstream failure is part of what must replay identically");
    assert.equal(response.headers.get("retry-after"), "30");
    assert.deepEqual(await response.json(), { hits: [1, 2, 3] });

    // Twice, identically — the property the whole corpus rests on.
    const again = await fetchImpl("https://api.example/one");
    assert.deepEqual(await again.json(), { hits: [1, 2, 3] });
  });
});

test("recording writes a replayable fixture and passes the live answer through", async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = createRecordedFetch({
      recordDir: dir,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const response = await fetchImpl("https://api.example/two", { method: "POST", body: JSON.stringify({ q: "x" }) });
    assert.deepEqual(await response.json(), { ok: true }, "the caller still gets the live answer");

    const key = fixtureKey("POST", "https://api.example/two", JSON.stringify({ q: "x" }));
    const record = JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8"));
    assert.equal(record.status, 200);
    assert.equal(record.url, "https://api.example/two");
    assert.equal(record.encoding, undefined, "text is stored as text so a corpus diff is readable");

    // And the recording replays.
    const replay = createRecordedFetch({ fixturesDir: dir, fetchImpl: async () => { throw new Error("network"); } });
    assert.deepEqual(await (await replay("https://api.example/two", { method: "POST", body: JSON.stringify({ q: "x" }) })).json(), { ok: true });
  });
});

test("a binary body survives the round trip", async () => {
  await withTempDir(async (dir) => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const fetchImpl = createRecordedFetch({
      recordDir: dir,
      fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    await fetchImpl("https://api.example/paper.pdf");
    const key = fixtureKey("GET", "https://api.example/paper.pdf");
    const record = JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8"));
    assert.equal(record.encoding, "base64");

    const replay = createRecordedFetch({ fixturesDir: dir, fetchImpl: async () => { throw new Error("network"); } });
    const response = await replay("https://api.example/paper.pdf");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  });
});

test("neither knob set leaves the real fetch exactly as it was", async () => {
  const original = async () => new Response("ok");
  assert.equal(createRecordedFetch({ fetchImpl: original }), original);
  assert.equal(resolveGatewayFetch({}, original), original);
});

test("setting both knobs is refused, because that is the fall-through by another name", () => {
  assert.throws(
    () => resolveGatewayFetch({ OPEN_SCIENCE_GATEWAY_FIXTURES: "/a", OPEN_SCIENCE_GATEWAY_RECORD: "/b" }),
    /never both/,
  );
});

test("the MCP server derives the same key from the same triple", async () => {
  // One key law, two languages. Two fixture stores keyed differently would mean
  // an evaluation that is reproducible on one path and live on the other.
  const { execFileSync } = await import("node:child_process");
  const root = new URL("../../../runtime/mcp/evimed-research/", import.meta.url).pathname;
  const cases = [
    ["GET", "https://api.example/x", ""],
    ["POST", "https://api.example/search", JSON.stringify({ q: "aspirin" })],
  ];
  for (const [method, url, body] of cases) {
    const out = execFileSync("python3", ["-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import fixtures; print(fixtures.fixture_key(sys.argv[2], sys.argv[3], sys.argv[4]))",
      root, method, url, body], { encoding: "utf8" }).trim();
    assert.equal(out, fixtureKey(method, url, body), `${method} ${url}`);
  }
});
