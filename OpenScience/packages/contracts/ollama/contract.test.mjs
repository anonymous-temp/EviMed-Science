import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const pins = JSON.parse(await readFile(new URL("deps-version.json", root), "utf8"));

test("the private embedding image and model resolve from the reviewed pin", async () => {
  const pin = pins.ollama;
  assert.equal(pin.version, "0.33.3");
  assert.equal(pin.contractDir, "packages/contracts/ollama");
  assert.match(pin.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(pin.linuxAmd64Digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(pin.modelManifestDigest, /^sha256:[a-f0-9]{64}$/);

  const compose = await readFile(new URL("deploy/web/docker-compose.memos-engine.yml", root), "utf8");
  const image = `${pin.image}:${pin.version}@${pin.imageDigest}`;
  assert.equal((compose.match(new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 2);
  assert.match(compose, new RegExp(pin.modelManifestDigest.slice("sha256:".length)));
  assert.match(compose, new RegExp(`EVIMED_OLLAMA_MODEL: ${pin.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("model initialization verifies the local registry manifest before serving", async () => {
  const script = await readFile(new URL("deploy/memos-ollama/init-model.sh", root), "utf8");
  assert.match(script, /ollama pull/);
  assert.match(script, /sha256sum/);
  assert.match(script, /blobs\/sha256-\$hex/);
  assert.ok(script.indexOf('if verify_models "$models"') < script.indexOf('ollama pull'), "a verified cache must not contact the registry");
  assert.match(script, /generations\/\$expected/);
  assert.match(script, /mv -Tf "\$temporary_link" "\$store\/current"/);
  assert.match(script, /verify_models "\$generation_models"/);
  assert.match(script, /chown -R 10002:10002/);
});
