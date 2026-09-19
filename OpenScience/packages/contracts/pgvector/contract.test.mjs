/**
 * The pgvector pin's contract test.
 *
 * Hidden knowledge: what has to hold before this dependency's pin may move.
 * The control plane's PostgreSQL runs pgvector's build of the official
 * postgres:16 image, so the knowledge-base index can use a vector column. The
 * image is written once in deps-version.json and copied into the production
 * compose file and the CI service; a copy that drifts runs production on one
 * image and tests on another, which is the gap this repository's pins exist to
 * close. The index itself never requires the extension — it creates it where
 * it can and skips the vector leg where it cannot — and that property is held
 * here too, because a migration that demanded the extension would take the
 * whole control plane down on a plain postgres image.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const deps = JSON.parse(await readFile(new URL("deps-version.json", root), "utf8"));
const pin = deps.pgvector;
const reference = `${pin?.image}:${pin?.imageTag}@${pin?.imageDigest}`;

test("the pin is defined once, exact and digest-bound", () => {
  assert.ok(pin, "pgvector is missing from deps-version.json");
  assert.match(pin.version, /^0\.8\.\d+$/, "0.8 or later: iterative index scans keep filtered searches whole");
  assert.equal(pin.imageTag, `${pin.version}-pg16-bookworm`);
  assert.match(pin.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(pin.linuxAmd64Digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(pin.contractDir, "packages/contracts/pgvector");
  assert.ok(String(pin.notes ?? "").length > 40, "a pin carries the reason it is what it is");
  // Production ran postgres:16.14 before the swap; the image may not step back.
  const [major, minor] = pin.postgres.split(".").map(Number);
  assert.equal(major, 16);
  assert.ok(minor >= 14, `PostgreSQL ${pin.postgres} is older than the 16.14 production ran`);
});

test("production and CI run the pinned image, by digest", async () => {
  const compose = await readFile(new URL("deploy/web/docker-compose.yml", root), "utf8");
  const service = compose.split("\n  evimed-postgres:\n")[1]?.split("\n  evimed-openviking:\n")[0] ?? "";
  assert.ok(service, "the evimed-postgres service block was not found; the read is wrong, not the file");
  assert.equal(service.match(/^    image: (\S+)$/m)?.[1], reference);
  const workflow = await readFile(new URL("../.github/workflows/web.yml", root), "utf8");
  assert.equal(workflow.match(/services:\n\s+postgres:\n(?:\s+#.*\n)*\s+image: (\S+)/)?.[1], reference);
});

test("the index creates the extensions only where they exist, and never requires them", async () => {
  const source = await readFile(new URL("apps/server/src/kbPersistence.mjs", root), "utf8");
  assert.match(source, /FROM pg_available_extensions WHERE name=\$1/);
  assert.match(source, /SAVEPOINT kb_extension/);
  assert.match(source, /CREATE EXTENSION IF NOT EXISTS/);
  assert.doesNotMatch(source, /CREATE EXTENSION vector;/, "an unconditional CREATE EXTENSION fails the whole migration on a plain image");
});
