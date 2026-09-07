/**
 * The mineru pin's contract test.
 *
 * Hidden knowledge: what has to hold before this dependency's pin may move.
 * MinerU runs as the `evimed-document-parser` service (deploy/document-parser,
 * composed by deploy/web/docker-compose.ingestion.yml). The version is written
 * once in deps-version.json and copied into the image's requirements, the
 * parser's own health answer, the control plane's health check and the compose
 * image tag and healthcheck. A pin bump that misses one copy leaves a parser
 * whose health answer the control plane refuses — every source stuck in
 * `queued` with a healthy-looking container — so the copies are asserted here,
 * in the same shape as the DSH test.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const depsVersions = JSON.parse(await readFile(new URL("deps-version.json", root), "utf8"));
const pin = depsVersions["mineru"];

test("the pin is defined once, in the one place pins live", () => {
  assert.ok(pin, "mineru is missing from deps-version.json");
  assert.match(pin.version, /^\d+\.\d+\.\d+$/, "a pin must be an exact version, not a range");
  assert.equal(pin.pipPackage, "mineru");
  assert.equal(pin.contractDir, "packages/contracts/mineru");
  assert.ok(String(pin.notes ?? "").length > 20, "a pin carries the reason it is what it is");
});

test("every derived copy of the pin equals it", async () => {
  const copies = [
    { file: "deploy/document-parser/requirements.txt", pattern: /^mineru\[pipeline\]==(\S+)$/m },
    { file: "deploy/document-parser/parser_service.py", pattern: /^MINERU_VERSION = "([^"]+)"$/m },
    { file: "apps/server/src/documentParserClient.mjs", pattern: /mineruVersion !== "([^"]+)"/ },
    { file: "deploy/web/docker-compose.ingestion.yml", pattern: /evimed-document-parser:(\d+\.\d+\.\d+)\}/ },
    { file: "deploy/web/docker-compose.ingestion.yml", pattern: /data\.get\('mineruVersion'\)=='([^']+)'/ },
  ];
  for (const copy of copies) {
    const text = await readFile(new URL(copy.file, root), "utf8");
    const found = text.match(copy.pattern)?.[1];
    assert.ok(found, `${copy.file} no longer carries the pin in the expected shape`);
    assert.equal(found, pin.version, `${copy.file} pins ${found}, deps-version.json says ${pin.version}`);
  }
});

test("the parser image only ever installs the pinned mineru, and keeps its plain-text fallback", async () => {
  const requirements = await readFile(new URL("deploy/document-parser/requirements.txt", root), "utf8");
  const versions = [...requirements.matchAll(/^mineru\S*==(\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(versions)], [pin.version]);
  assert.match(requirements, /^pypdf==/m, "the fallback parser must stay pinned beside mineru");
  const service = await readFile(new URL("deploy/document-parser/parser_service.py", root), "utf8");
  assert.match(service, /"plain-text"/, "the fallback extractor must still be reachable when mineru fails");
});
