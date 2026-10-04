// The composed control plane serves the skill packages beside the capabilities through the availability projection
// the catalogue already reads, and nothing in the catalogue is hidden by a label.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebApiApp } from "../src/server.mjs";

test("GET /api/availability lists the shipped skills with their package and label, and every capability still lists", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-skill-supply-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true });
  const address = await app.listen(0, "127.0.0.1");
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const body = (await (await fetch(`${base}/api/availability`)).json()).data;
    assert.ok(body.skills.length >= 60, `${body.skills.length} skills`);
    const cheminformatics = body.skills.find((/** @type {any} */ entry) => entry.id === "curated/cheminformatics");
    assert.equal(cheminformatics.package.origin, "curated");
    assert.equal(cheminformatics.package.licenceText, "MIT");
    assert.match(cheminformatics.package.sourceText, /scientific-agent-skills/);
    // A mock runtime never claims a skill is installed: nothing a mock did is a fact about a real kernel.
    assert.ok(body.skills.every((/** @type {any} */ entry) => entry.state === "unverified" || entry.state === "limited"));
    assert.equal(body.skills.find((/** @type {any} */ entry) => entry.id === "office/xlsx").reason.code, "mock-runtime");
    const agents = (await (await fetch(`${base}/api/agents`)).json()).data;
    assert.equal(agents.length, body.capabilities.filter((/** @type {any} */ entry) => agents.some((/** @type {any} */ agent) => agent.id === entry.id)).length, "no capability is dropped");
    assert.ok(body.capabilities.every((/** @type {any} */ entry) => entry.package?.name === entry.id || entry.reason.code === "not-in-this-deployment"));
    assert.equal(JSON.stringify(body).includes("sha256\":\"" + "0".repeat(64)), false);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
