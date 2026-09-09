// The recall index is a third-party server holding derived copies of user
// memories. What it may reach, and what may reach it, is the whole of its
// security story — it has no authentication of its own beyond a key this
// control plane holds, so the boundary is the network and the compose file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const overlayFile = path.join(root, "deploy/web/docker-compose.openviking.yml");
const baseFile = path.join(root, "deploy/web/docker-compose.yml");

const overlay = YAML.parse(await readFile(overlayFile, "utf8"));
const base = YAML.parse(await readFile(baseFile, "utf8"));
const versions = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8"));

test("the index is reachable from the control plane and from nowhere else", () => {
  const service = overlay.services["evimed-openviking"];
  assert.deepEqual(service.networks, ["memory-recall-internal"]);
  assert.equal(overlay.networks["memory-recall-internal"].internal, true);
  // A published port would put a store of derived user memories on the host's
  // interfaces, behind nothing but a key that lives in the same stack.
  assert.ok(!("ports" in service), "the index must not publish a port");
  assert.ok(
    overlay.services["open-science-web"].networks.includes("memory-recall-internal"),
    "the control plane is not on the index's network, so recall could never reach it",
  );
  // The runtime container's network is not the index's. A run must reach
  // memories through the capsule tools on the control plane, never directly.
  assert.ok(!service.networks.includes("runtime-internal"));
});

test("the image is the pinned one, by the tag that actually exists", () => {
  const expected = `${versions.openviking.image}:${versions.openviking.imageTag}`;
  for (const name of ["evimed-openviking", "evimed-openviking-secrets-init"]) {
    assert.match(
      overlay.services[name].image,
      new RegExp(`\\$\\{OPEN_SCIENCE_OPENVIKING_IMAGE:-${expected.replaceAll(".", "\\.")}\\}`),
      `${name} does not default to the pinned image`,
    );
  }
  assert.equal(versions.openviking.imageTag, `v${versions.openviking.version}`);
});

test("the bot gateway is off, because it is the one part that wants the internet", () => {
  assert.equal(overlay.services["evimed-openviking"].environment.OPENVIKING_WITH_BOT, "0");
});

test("the configuration carrying the model credential is a mounted file, not an environment value", () => {
  const service = overlay.services["evimed-openviking"];
  assert.equal(service.environment.OPENVIKING_CONFIG_FILE, "/run/openviking-secrets/ov.conf");
  // The image accepts OPENVIKING_CONF_CONTENT, which would put the whole
  // configuration — credentials included — into `docker inspect` output.
  assert.ok(!("OPENVIKING_CONF_CONTENT" in service.environment));
  assert.ok(service.volumes.some((entry) => String(entry).includes("evimed-openviking-secrets:/run/openviking-secrets:ro")));
});

test("the secrets init copies with a private mode and refuses a configuration that would crash-loop", async () => {
  const init = overlay.services["evimed-openviking-secrets-init"];
  assert.equal(init.network_mode, "none", "the secret copier has no reason to reach a network");
  assert.equal(init.restart, "no");
  const script = init.command.join("\n");
  assert.match(script, /os\.chmod\(temporary, 0o600\)/);
  assert.match(script, /os\.replace\(temporary, target\)/, "a partially written secret must never be readable under its final name");
  // A malformed ov.conf makes the server exit before it is healthy, and the
  // only symptom is a container that keeps restarting.
  assert.match(script, /json\.loads/);
});

test("selecting the provider is possible without this overlay, and says so in readiness", () => {
  // Compose passes environment item by item. Levers listed only in an overlay
  // are invisible to a deployment that does not compose it, which is how an
  // operator ends up setting a variable that does nothing at all.
  const web = base.services["open-science-web"].environment;
  for (const key of [
    "OPEN_SCIENCE_MEMORY_INDEX_PROVIDER",
    "OPEN_SCIENCE_MEMORY_INDEX_STRICT",
    "OPEN_SCIENCE_OPENVIKING_URL",
    "OPEN_SCIENCE_OPENVIKING_ACCOUNT",
    "OPEN_SCIENCE_OPENVIKING_REQUEST_TIMEOUT_MS",
  ]) {
    assert.ok(key in web, `${key} is not passed by the base stack`);
  }
  assert.match(web.OPEN_SCIENCE_MEMORY_INDEX_PROVIDER, /:-builtin\}$/, "a deployment must default to needing nothing deployed");
});

test("the overlay is in the release manifest, so a release records what it shipped", async () => {
  const generator = await readFile(path.join(root, "scripts/ops/generate-release-manifest.mjs"), "utf8");
  assert.ok(
    generator.includes("deploy/web/docker-compose.openviking.yml"),
    "a release would not hash this overlay, so its content would not be recorded",
  );
});
