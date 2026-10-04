// The availability surface through the real app. The app here runs the mock runtime with no database, which is
// the deployment on which the product can say the least — and what it says must be that, not more: no label reads
// "executable", the catalogue is unchanged but for the label, and the operator's export stays behind the operator.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebApiApp } from "../src/server.mjs";

/** The capabilities a researcher can be offered: every manifest under `capabilities/` that is not `visibility: internal`. */
const capabilitiesRoot = new URL("../../../capabilities/", import.meta.url);
const publicCapabilityCount = (await Promise.all((await readdir(capabilitiesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => readFile(new URL(`${entry.name}/capability.yaml`, capabilitiesRoot), "utf8"))))
  .filter((manifest) => !/^visibility:\s*internal\s*$/m.test(manifest)).length;

const adapters = {
  metaAnalysis: "http://meta:8024/api/v1/evimed/meta-analysis", mendelianRandomization: "http://mr:8026/x", bibliometricAnalysis: "http://bib:8027/x",
  researchTopicSelection: "http://topic:8028/x", peerReview: "http://review:8029/x", drugSafetyAnalysis: "http://safety:8025/x",
};

async function withApp(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-availability-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, bootstrapUser: "alice", bootstrapPassword: "correct horse battery staple",
    operatorMetricsToken: "availability-operator-token", evimedAdapterUrls: adapters,
    availabilityFetch: async () => ({ ok: true, json: async () => ({ ready: true, serving: true }) }), ...overrides,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct horse battery staple" }) });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    await fn({ base, headers: { Cookie: cookie } });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("GET /api/availability needs a session and answers every capability and tool the catalogue names", async () => {
  await withApp(async ({ base, headers }) => {
    assert.equal((await fetch(`${base}/api/availability`)).status, 401);
    const response = await fetch(`${base}/api/availability`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { data } = await response.json();
    assert.ok(data.capabilities.length >= 24 && data.tools.length >= 40, `${data.capabilities.length} capabilities, ${data.tools.length} tools`);
    for (const entry of [...data.capabilities, ...data.tools]) {
      assert.ok(["source-planned", "installed", "executable", "limited", "unavailable", "unverified"].includes(entry.state), entry.id);
      assert.match(entry.label, /^[一-鿿]+$/);
      assert.match(entry.text, /[一-鿿]/);
      assert.ok(entry.reason.code && entry.reason.source, `${entry.id} names its reason and where it came from`);
    }
    assert.equal(data.capabilities.some((entry) => entry.state === "executable"), false, "a mock runtime never yields executable");
    assert.equal(data.capabilities.find((entry) => entry.id === "adr-analysis").state, "unverified");
    assert.equal(data.capabilities.find((entry) => entry.id === "adr-analysis").reason.code, "mock-runtime");
    assert.equal((await fetch(`${base}/api/availability`, { method: "POST", headers })).status === 200, false, "read-only");
  });
  // Where an engine was never configured, its capability says so rather than reading as merely unverified.
  await withApp(async ({ base, headers }) => {
    const { data } = await (await fetch(`${base}/api/availability`, { headers })).json();
    const adr = data.capabilities.find((entry) => entry.id === "adr-analysis");
    assert.equal(adr.state, "unavailable");
    assert.ok(["engine-not-configured", "required-tool-not-offered"].includes(adr.reason.code));
    assert.equal(data.tools.find((entry) => entry.id === "drug_safety_analysis").reason.code, "engine-not-configured");
  }, { evimedAdapterUrls: {} });
});

test("GET /api/agents carries the label beside each capability and leaves nothing out for what it says", async () => {
  await withApp(async ({ base, headers }) => {
    const { data } = await (await fetch(`${base}/api/agents`, { headers })).json();
    // Every public capability under `capabilities/`, counted from the manifests: a capability added next
    // month is one more row here, not a number to remember.
    assert.equal(data.length, publicCapabilityCount);
    assert.ok(data.length >= 24, "the catalogue was read");
    for (const agent of data) {
      assert.equal(typeof agent.availability?.state, "string", agent.id);
      assert.equal(agent.availability.id, agent.id);
      assert.equal(agent.availability.version, agent.version, "the label is about the exact version the catalogue lists");
    }
    // Unavailable ones are still listed and still carry everything they carried: availability is a label, never a hide.
    const closed = data.find((agent) => agent.id === "vcr-protocol");
    assert.equal(closed.availability.state, "unavailable");
    assert.ok(closed.requiredTools.length >= 0 && closed.title);
  });
});

test("the operator's export is behind the operator token and carries the deployment's own view", async () => {
  await withApp(async ({ base, headers }) => {
    assert.equal((await fetch(`${base}/api/ops/availability`, { headers })).status, 401, "a session is not the operator");
    assert.equal((await fetch(`${base}/api/ops/availability`)).status, 401);
    const response = await fetch(`${base}/api/ops/availability`, { headers: { Authorization: "Bearer availability-operator-token" } });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.kind, "evimed-availability-export");
    assert.equal(data.deployment.runtimeMode, "mock");
    assert.equal(data.collector.state, "off", "no database, nothing is collected");
    assert.ok(data.states.length >= 60);
    assert.deepEqual(data.records, []);
  });
  await withApp(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/ops/availability`)).status, 404, "no operator token configured, no such route");
  }, { operatorMetricsToken: "" });
});

test("the operators' metrics expose the availability series", async () => {
  await withApp(async ({ base }) => {
    const text = await (await fetch(`${base}/api/ops/metrics`, { headers: { Authorization: "Bearer availability-operator-token" } })).text();
    assert.match(text, /^open_science_availability_enabled 1$/m);
    assert.match(text, /^open_science_availability_subjects\{kind="capability",state="unverified"\} \d+$/m);
    assert.match(text, /^open_science_availability_subjects\{kind="tool",state="unavailable"\} \d+$/m);
    assert.match(text, /^open_science_availability_collector_state\{state="off"\} 1$/m);
  });
});
