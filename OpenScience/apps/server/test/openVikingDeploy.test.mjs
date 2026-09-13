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

// Compose accepts `networks:` as a list or as a mapping, and a membership walk
// that understands only one of them reports an empty result for the other —
// which reads exactly like "nobody else joined".
function networksOf(definition) {
  const networks = definition?.networks;
  if (Array.isArray(networks)) return networks.map((entry) => String(entry));
  if (networks && typeof networks === "object") return Object.keys(networks);
  return [];
}

/** The uid a service runs as. No `user:` means root, which is uid 0. */
function uidOf(service) {
  return Number.parseInt(String(service?.user ?? "0").split(":")[0], 10);
}

/** `volume:/target[:mode]` → the target path this service mounts it at. */
function mountTarget(service, volume) {
  const entry = (service?.volumes ?? [])
    .map((item) => String(item))
    .find((item) => item.startsWith(`${volume}:`));
  return entry ? entry.split(":")[1] : null;
}

test("the index is reachable from the control plane and from nowhere else", () => {
  const service = base.services["evimed-openviking"];
  assert.ok(networksOf(service).includes("memory-recall-internal"));
  assert.equal(base.networks["memory-recall-internal"].internal, true);
  // A published port would put a store of derived user memories on the host's
  // interfaces, behind nothing but a key that lives in the same stack.
  assert.ok(!("ports" in service), "the index must not publish a port");
  assert.ok(
    networksOf(base.services["open-science-web"]).includes("memory-recall-internal"),
    "the control plane is not on the index's network, so recall could never reach it",
  );
  // The runtime container's network is not the index's. A run must reach
  // memories through the capsule tools on the control plane, never directly.
  assert.ok(!networksOf(service).includes("runtime-internal"));
  // Nor the default network: everything on that one would reach the index.
  assert.ok(!networksOf(service).includes("default"));
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
    .filter(([, definition]) => networksOf(definition).includes("memory-index-egress"))
    .map(([name]) => name);
  assert.deepEqual(members, ["evimed-openviking"]);
  // The walk itself: a filter that matched nothing would pass every assertion
  // above, so it has to be shown reading the form the file is written in.
  assert.ok(networksOf(base.services["evimed-openviking"]).length >= 2, "the network walk read nothing");
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

test("the server runs unprivileged, which takes a data directory made for it first", async () => {
  const service = base.services["evimed-openviking"];
  assert.equal(service.user, "10001:10001");
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.ok(service.security_opt.includes("no-new-privileges:true"));
  // The server mkdirs `storage.workspace` as that uid while loading its
  // configuration, and an empty named volume is re-populated from the image on
  // every mount — which resets its root to root:root. Chowning the volume
  // itself does not stick; creating the directory inside it does.
  //
  // Which directory that is, is not a literal here: the renderer decides the
  // workspace, the server mounts the volume at one path and the init at
  // another, and the two only meet if the path is derived from all three. They
  // disagreed silently once — the server would have written into its container
  // layer while both tests stayed green.
  const renderer = await readFile(path.join(root, "scripts/ops/configure-production-state.mjs"), "utf8");
  const workspace = /workspace: "([^"]+)"/.exec(renderer)?.[1];
  assert.ok(workspace, "the rendered configuration names no storage.workspace");
  const serverMount = mountTarget(service, "evimed-openviking-data");
  assert.equal(serverMount, "/app/.openviking", "the index does not mount the data volume it stores into");
  assert.ok(workspace.startsWith(`${serverMount}/`), `the workspace ${workspace} is not inside the mounted volume`);

  const init = base.services["evimed-openviking-init"];
  const initMount = mountTarget(init, "evimed-openviking-data");
  assert.ok(initMount, "the init does not mount the data volume it prepares");
  const prepared = `${initMount}${workspace.slice(serverMount.length)}`;
  const script = init.command.join("\n");
  assert.ok(script.includes(`'${prepared}'`), `the init prepares no ${prepared}, which is where the server will write`);
  // The directory *and* what is already inside it. An upgrade from a release
  // that ran this image as root arrives with a volume of root-owned index
  // files; giving away only the directory leaves every one of them unreadable
  // to the uid that has to read them, and the index then starts, stays healthy
  // and answers nothing.
  assert.match(script, /os\.walk\(data, topdown=False/);
  assert.match(script, /os\.lchown\(path, 10001, 10001\)/);
  // Children first and the directory last, because this process cannot list a
  // directory it has already given away and a failed listing comes back empty
  // rather than raised. The order is what makes an interrupted run restartable.
  assert.ok(script.indexOf("for path in below + [str(data)]") > script.indexOf("os.walk(data, topdown=False"),
    "the listing must be taken before anything is given away");
  assert.match(script, /raise SystemExit\('cannot read the memory index data directory/,
    "an unreadable listing while the directory is still root-owned must fail loudly");
  assert.deepEqual(init.cap_drop, ["ALL"]);
  assert.deepEqual(init.cap_add, ["CHOWN"], "root without CAP_CHOWN cannot give the directory away");
});

test("the one-shot never changes a mode it can no longer change", () => {
  // It holds CAP_CHOWN and not CAP_FOWNER, so `chmod` succeeds only while the
  // path is still its own: after the chown, and on every later run, the kernel
  // answers EPERM and the one-shot exits non-zero — which stops the index by
  // `service_completed_successfully` and, through it, the whole stack. This is
  // an ordering property, and ordering is what the previous version got wrong.
  const init = base.services["evimed-openviking-init"];
  const script = init.command.join("\n");
  assert.ok(!init.cap_add.includes("FOWNER"), "the assertions below are the alternative to holding FOWNER");
  const chmodTargets = [...script.matchAll(/os\.chmod\(([A-Za-z_]+),/g)].map((match) => match[1]);
  assert.deepEqual(chmodTargets, ["temporary"], "only a freshly created path may be chmod'ed, and only before it is given away");
  assert.ok(
    script.indexOf("os.chmod(temporary, 0o600)") < script.indexOf("os.chown(temporary, owner, owner)"),
    "the copied secret is chmod'ed after it is given away, which needs CAP_FOWNER",
  );
  // The directory carries its mode from `mkdir`, which is the creating call and
  // therefore needs nothing.
  assert.match(script, /data\.mkdir\(parents=True, exist_ok=True, mode=0o700\)/);
});

test("every protected file is owned by the uid of the container that reads it", () => {
  // Both readers drop every capability, so neither has DAC_OVERRIDE: for them
  // a 0600 file owned by somebody else is not a warning, it is EACCES. The
  // index reads its configuration as 10001, the control plane reads the API
  // key as root, and the one-shot that copies them must give each away
  // accordingly — the wrong owner leaves a server that can never start and a
  // recall that can never authenticate.
  const index = base.services["evimed-openviking"];
  const web = base.services["open-science-web"];
  const init = base.services["evimed-openviking-init"];
  const script = init.command.join("\n");
  const owners = new Map(
    [...script.matchAll(/\('\/input\/[\w.-]+', '([\w.-]+)', (\d+)\)/g)].map((match) => [match[1], Number(match[2])]),
  );
  assert.equal(owners.size, 2, "the init copies files without naming an owner for each");
  assert.deepEqual(web.cap_drop, ["ALL"], "root here is subject to the mode bits, which is why the owner matters");

  const configFile = path.posix.basename(index.environment.OPENVIKING_CONFIG_FILE);
  assert.equal(owners.get(configFile), uidOf(index), `${configFile} is unreadable to the uid the index runs as`);
  const keyFile = path.posix.basename(web.environment.OPEN_SCIENCE_OPENVIKING_API_KEY_FILE);
  assert.equal(owners.get(keyFile), uidOf(web), `${keyFile} is unreadable to the uid the control plane runs as`);
  assert.notEqual(uidOf(index), uidOf(web), "one owner would do if the two ran as the same uid; they do not");
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

test("the control plane starts after the index, and not only if the index is well", () => {
  const web = base.services["open-science-web"];
  // Ranking is the index's job and recall degrades without it, so an index
  // that is up but unwell must not keep the product down. `service_healthy`
  // here would also put a third party's API — the embedder the health probe
  // could reach for — between an operator and `docker compose up`.
  assert.equal(web.depends_on["evimed-openviking"].condition, "service_started");
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

test("the index's health says whether the index answers, not whether DashScope does", () => {
  // `/health` is served by the process itself and needs no credential; it is
  // also the endpoint the recorded contract fixtures came off. `/ready` adds an
  // embedding probe, so a rate-limited or unpaid account would show here as a
  // broken index — and anything that then waits on this condition would be
  // waiting on a third party.
  const probe = base.services["evimed-openviking"].healthcheck.test.join(" ");
  assert.ok(probe.includes("/health"), "the health probe does not name the endpoint it reads");
  assert.ok(!probe.includes("/ready"), "the health probe reaches the embedding API");
  // `openviking-entrypoint --healthcheck` is what this was: a flag no upstream
  // source we read defines, on a script whose other job is starting a server.
  assert.ok(!probe.includes("--healthcheck"), "the probe relies on an unverified entrypoint flag");
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
