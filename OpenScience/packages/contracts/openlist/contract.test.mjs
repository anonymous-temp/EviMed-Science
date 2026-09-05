/**
 * The openlist pin's contract test.
 *
 * Hidden knowledge: what has to hold before this dependency's pin may move.
 * The version is defined once and the narrow boundary names every endpoint it
 * calls, so the nightly matrix can replay the same contract when the pin moves.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const depsVersions = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));

test("the pin is defined once, in the one place pins live", () => {
  const pin = depsVersions["openlist"];
  assert.ok(pin, "openlist is missing from deps-version.json");
  assert.match(pin.version, /^\d+\.\d+/, "a pin must be an exact version, not a range");
  assert.equal(pin.contractDir, "packages/contracts/openlist");
  assert.ok(String(pin.notes ?? "").length > 20, "a pin carries the reason it is what it is");
});

test("the connector stays on the reviewed file API and same-origin byte proxy", async () => {
  const source = await readFile(new URL("../../../apps/server/src/openListClient.mjs", import.meta.url), "utf8");
  for (const endpoint of ["/api/fs/list", "/api/fs/get", "/api/fs/link"]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.match(source, /redirect: "error"/);
  assert.match(source, /`\$\{this\.baseUrl\}\/p/);
});
