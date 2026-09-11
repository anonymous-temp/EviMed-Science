// The recall index is a third-party server holding derived copies of user
// memories. What it may reach, and what may reach it, is the whole of its
// security story — it has no authentication of its own beyond a key this
// control plane holds, so the boundary is the network and the compose file.
//
// It moved out of an overlay and into the base stack on 2026-09-11, because
// both recall paths now rank through it: a deployment that forgot the overlay
// would have degraded to term matching and said nothing.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baseFile = path.join(root, "deploy/web/docker-compose.yml");

const base = YAML.parse(await readFile(baseFile, "utf8"));
const versions = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8"));

test("the index is reachable from the control plane and from nowhere else", () => {
  const service = base.services["evimed-openviking"];
  assert.ok(service.networks.includes("memory-recall-internal"));
  assert.equal(base.networks["memory-recall-internal"].internal, true);
  // A published port would put a store of derived user memories on the host's
  // interfaces, behind nothing but a key that lives in the same stack.
  assert.ok(!("ports" in service), "the index must not publish a port");
  assert.ok(
    base.services["open-science-web"].networks.includes("memory-recall-internal"),
    "the control plane is not on the index's network, so recall could never reach it",
  );
  // The runtime container's network is not the index's. A run must reach
  // memories through the capsule tools on the control plane, never directly.
  assert.ok(!service.networks.includes("runtime-internal"));
  // Nor the default network: everything on that one would reach the index.
  assert.ok(!service.networks.includes("default"));
});

test("the index has egress, on a network nothing else joins", () => {
  // It had none while the embedder was a container beside it. Embeddings are
  // computed by DashScope now, so the one thing it must reach is the public
  // internet — and the network that lets it is dedicated, because a second
  // member would inherit the index along with the egress.
  const service = base.services["evimed-openviking"];
  assert.ok(service.networks.includes("memory-index-egress"));
  assert.ok(Object.hasOwn(base.networks, "memory-index-egress"));
  assert.notEqual(base.networks["memory-index-egress"]?.internal, true, "an internal network cannot reach the embedding API");
  const members = Object.entries(base.services)
    .filter(([, definition]) => (definition?.networks ?? []).includes?.("memory-index-egress"))
    .map(([name]) => name);
  assert.deepEqual(members, ["evimed-openviking"]);
});

test("the image is the pinned one, by tag and by digest", () => {
  const expected = `${versions.openviking.image}:${versions.openviking.imageTag}@${versions.openviking.imageDigest}`;
  for (const name of ["evimed-openviking", "evimed-openviking-init"]) {
    assert.equal(
      base.services[name].image,
      `\${OPEN_SCIENCE_OPENVIKING_IMAGE:-${expected}}`,
      `${name} does not default to the pinned image`,
    );
  }
  assert.equal(versions.openviking.imageTag, `v${versions.openviking.version}`);
  assert.match(versions.openviking.imageDigest, /^sha256:[a-f0-9]{64}$/);
});

test("the bot gateway is off, because it is the one part that wants the internet", () => {
  assert.equal(base.services["evimed-openviking"].environment.OPENVIKING_WITH_BOT, "0");
});

test("the configuration carrying the model credential is a mounted file, not an environment value", () => {
  const service = base.services["evimed-openviking"];
  assert.equal(service.environment.OPENVIKING_CONFIG_FILE, "/run/openviking-secrets/ov.conf");
  // The image accepts OPENVIKING_CONF_CONTENT, which would put the whole
  // configuration — credentials included — into `docker inspect` output.
  assert.ok(!("OPENVIKING_CONF_CONTENT" in service.environment));
  assert.ok(service.volumes.some((entry) => String(entry).includes("evimed-openviking-secrets:/run/openviking-secrets:ro")));
});

test("the server runs unprivileged, which takes a data directory made for it first", () => {
  const service = base.services["evimed-openviking"];
  assert.equal(service.user, "10001:10001");
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.ok(service.security_opt.includes("no-new-privileges:true"));
  // The server mkdirs `storage.workspace` as that uid while loading its
  // configuration, and an empty named volume is re-populated from the image on
  // every mount — which resets its root to root:root. Chowning the volume
  // itself does not stick; creating the directory inside it does.
  const init = base.services["evimed-openviking-init"];
  const script = init.command.join("\n");
  assert.match(script, /os\.chown\(data, 10001, 10001\)/);
  assert.ok(script.includes("'/data/data'"), "the init must create the workspace inside the data volume");
  assert.ok(init.volumes.some((entry) => String(entry) === "evimed-openviking-data:/data"));
  assert.deepEqual(init.cap_drop, ["ALL"]);
  assert.deepEqual(init.cap_add, ["CHOWN"], "root without CAP_CHOWN cannot give the directory away");
});

test("the secrets init copies with a private mode and refuses a configuration that would crash-loop", () => {
  const init = base.services["evimed-openviking-init"];
  assert.equal(init.network_mode, "none", "the secret copier has no reason to reach a network");
  assert.equal(init.restart, "no");
  const script = init.command.join("\n");
  assert.match(script, /os\.chmod\(temporary, 0o600\)/);
  assert.match(script, /os\.replace\(temporary, target\)/, "a partially written secret must never be readable under its final name");
  // A malformed ov.conf makes the server exit before it is healthy, and the
  // only symptom is a container that keeps restarting.
  assert.match(script, /json\.loads/);
});

test("the control plane waits for the index and carries both keys it needs", () => {
  const web = base.services["open-science-web"];
  assert.equal(web.depends_on["evimed-openviking"].condition, "service_healthy");
  assert.equal(web.environment.OPEN_SCIENCE_OPENVIKING_API_KEY_FILE, "/run/openviking-secrets/api-key");
  // The reranker runs here rather than in the index: `/search/find` never
  // reranks, and `/search/search`, which does, returns nothing for this
  // layout because it navigates by directory abstracts no model generates.
  assert.equal(web.environment.OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE, "/run/secrets/dashscope-api-key");
  assert.ok(
    web.volumes.some((entry) => String(entry?.target ?? entry) === "/run/secrets/dashscope-api-key"),
    "the key file is named but never mounted, so the reranker would read nothing",
  );
});

test("the provider a deployment gets by default is the one it starts", () => {
  // Compose passes environment item by item, so this lever is in the base file
  // together with the service it selects. It defaulted to `builtin` while the
  // index was an overlay; the index ships now, and a default naming something
  // the stack does not run is how an operator ends up measuring nothing.
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
  assert.match(web.OPEN_SCIENCE_MEMORY_INDEX_PROVIDER, /:-openviking\}$/);
  assert.match(web.OPEN_SCIENCE_OPENVIKING_URL, /:-http:\/\/evimed-openviking:1933\}$/);
});

test("the index image is in the release manifest, so a release records what it shipped", async () => {
  const generator = await readFile(path.join(root, "scripts/ops/generate-release-manifest.mjs"), "utf8");
  assert.match(generator, /name: "openviking"/, "a release would not record which index image it ran");
  assert.match(generator, /OPEN_SCIENCE_OPENVIKING_IMAGE_ID/);
  // The overlay is gone; a generator still hashing it would fail on a missing
  // path, and one still naming it would record a file nobody composes.
  assert.ok(!generator.includes("docker-compose.openviking.yml"));
});

test("the embedding the index runs is pinned, because every stored vector came from it", () => {
  // The ov.conf is rendered from these pins by configure-production-state, so
  // this file is where an embedding change is made — and making it here is what
  // forces a `pnpm rebuild:memory-index --all`: every stored vector was
  // produced by the model and dimension recorded here, and a mixture of two is
  // an index that ranks by nothing.
  const pin = versions.openviking;
  // The host only. This provider appends `/compatible-mode/v1` itself, and a
  // base that already carries it would request a path that does not exist.
  assert.equal(pin.embedding.apiBase, "https://dashscope.aliyuncs.com");
  assert.ok(pin.embedding.model.length > 0);
  assert.equal(typeof pin.embedding.dimension, "number");
  // The reranker's endpoint is a complete URL: it is posted to verbatim.
  assert.ok(pin.rerank.apiBase.startsWith("https://dashscope.aliyuncs.com/"));
  assert.ok(pin.rerank.timeoutMs > 0);
});
