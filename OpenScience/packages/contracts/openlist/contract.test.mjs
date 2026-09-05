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

test("the pin is defined once, in the one place pins live", async () => {
  const pin = depsVersions["openlist"];
  const compose = await readFile(new URL("../../../deploy/web/docker-compose.ingestion.yml", import.meta.url), "utf8");
  assert.ok(pin, "openlist is missing from deps-version.json");
  assert.match(pin.version, /^\d+\.\d+/, "a pin must be an exact version, not a range");
  assert.match(pin.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(pin.linuxAmd64Digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(pin.contractDir, "packages/contracts/openlist");
  assert.ok(String(pin.notes ?? "").length > 20, "a pin carries the reason it is what it is");
  assert.equal((compose.match(new RegExp(`${pin.image}:v${pin.version}@${pin.imageDigest}`, "g")) ?? []).length, 3);
});

test("the connector stays on the reviewed file API and same-origin byte proxy", async () => {
  const source = await readFile(new URL("../../../apps/server/src/openListClient.mjs", import.meta.url), "utf8");
  for (const endpoint of ["/api/fs/list", "/api/fs/get", "/api/fs/link"]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.match(source, /redirect: "error"/);
  assert.match(source, /`\$\{this\.baseUrl\}\/p/);
});

test("deployment derives its internal token without writing a secret to compose metadata", async () => {
  const compose = await readFile(new URL("../../../deploy/web/docker-compose.ingestion.yml", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../../../deploy/openlist/bootstrap.sh", import.meta.url), "utf8");
  assert.match(compose, /evimed-openlist-bootstrap:/);
  assert.match(compose, /network_mode: none/);
  assert.match(compose, /openlist-admin-password/);
  assert.match(compose, /evimed-openlist-secrets:\/run\/openlist-secrets:ro/);
  assert.match(bootstrap, /admin set "\$password"/);
  assert.match(bootstrap, /admin token/);
  assert.match(bootstrap, /chown -R 1001:1001 \/opt\/openlist\/data/);
  assert.doesNotMatch(compose, /OPEN_SCIENCE_OPENLIST_TOKEN_HOST_FILE/);
});
