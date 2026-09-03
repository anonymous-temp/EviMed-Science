import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createCommandRegistry } from "../src/commands.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("bundled examples resolve independently of the server working directory", () => {
  const configModule = pathToFileURL(path.join(repoRoot, "apps/server/src/config.mjs")).href;
  const source = `import { loadConfig } from ${JSON.stringify(configModule)}; process.stdout.write(loadConfig().examplesDir);`;
  const env = { ...process.env };
  delete env.OPEN_SCIENCE_EXAMPLES_DIR;
  const examplesDir = execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: path.join(repoRoot, "apps/server"),
    encoding: "utf8",
    env,
  });

  assert.equal(examplesDir, path.join(repoRoot, "examples"));
});

function splitDockerWords(line) {
  return line
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

test("the runtime image publishes the label the readiness gate reads, and both readers ask for it", async () => {
  // The readiness gate asked docker for `io.open-science.opencode.version`.
  // The DSH image publishes `io.open-science.dsh.version` and never that one,
  // so `!opencodeVersion` was true and production readiness failed
  // `runtime_image_metadata_missing` on every DSH deployment — a provenance
  // check that could not survive the kernel it was gating, and silent in dev
  // because `config.production` returns before the check runs.
  //
  // One kernel ships now, so there is one image and one label to agree on; the
  // fix that survived the flip is the kernel-neutral label, which the readers
  // ask for by name and the image publishes by name.
  const dsh = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");

  assert.match(dsh, /LABEL io\.open-science\.runtime\.version="\$\{\w+\}"/, "the runtime image publishes no neutral version label");
  assert.match(dsh, /LABEL io\.open-science\.runtime\.kernel="dsh"/, "the runtime image does not name its kernel");

  // The negative control, and the production failure itself: the image
  // genuinely does not carry the label the old reader asked for. Without this
  // the assertions above would pass just as well against the broken reader.
  // Matched as a LABEL instruction, not as a mention: the first version of this
  // assertion was a substring check, and it matched the comment three lines
  // above explaining the defect. A check that counts mentions is the same
  // mistake as a scan that counts tool calls the model never makes.
  assert.ok(
    !/^LABEL io\.open-science\.opencode\.version=/m.test(dsh),
    "the runtime image must not be made to answer under the retired kernel's name",
  );

  // Both readers ask docker for the neutral label, and neither still asks for
  // the retired kernel's. The fallback existed so an image built before the
  // neutral label was added still reported metadata; the only image a
  // deployment may now launch is the one built from the Dockerfile above, and
  // an image that answers only under the retired name is one this control
  // plane cannot start. A reader still accepting it would report provenance
  // for an image that cannot run, which is worse than reporting none.
  //
  // Asked as the docker format template rather than as a substring, for the
  // same reason as the LABEL check above: both files explain this history in
  // prose, and a mention is not a read.
  for (const file of ["apps/server/src/server.mjs", "apps/server/src/runtimeControllerServer.mjs"]) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    assert.ok(
      source.includes('{{index .Config.Labels "io.open-science.runtime.version"}}'),
      `${file} does not read the neutral label`,
    );
    assert.ok(
      !source.includes('{{index .Config.Labels "io.open-science.opencode.version"}}'),
      `${file} still reads the retired kernel's label`,
    );
  }
});

test("every skill root the runtime image ships is a root the release manifest binds", async () => {
  // The two lists were inverted. `runtime/skills/community` is COPYed into the
  // DSH image and mounted as the fourth preset root — 20 files of third-party
  // prose that every run is told to follow — and was bound by nothing: not the
  // manifest, not a ledger, not the licence gate. `capability-skills` holds the
  // bodies delegation pre-injects into every child's prompt and was equally
  // unbound. Meanwhile `runtime/skills/external/ai4s-skills` carried a digest
  // and is not in the DSH image at all.
  //
  // An edit to any file under the unbound roots — an accidental in-place
  // change, a bad re-vendor, a deliberate one — changes what every run is
  // instructed to do and passes ci:web, the release manifest and the kernel
  // loader without a word.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const generator = await readFile(path.join(repoRoot, "scripts/ops/generate-release-manifest.mjs"), "utf8");

  // What the image copies into the preset root the kernel reads, plus the
  // capability bodies. Read as COPY instructions, not as mentions.
  const shipped = [...dockerfile.matchAll(/^COPY\s+(runtime\/skills\/[\w.-]+|capability-skills)\s/gm)].map((match) => match[1]);
  assert.ok(shipped.length >= 4, `expected the image to ship several skill roots, found ${JSON.stringify(shipped)}`);

  const bound = new Set([...generator.matchAll(/"((?:runtime\/skills\/|capability-skills)[^"]*)"/g)].map((match) => match[1]));
  const unbound = [...new Set(shipped)].filter((source) => !bound.has(source)).sort();
  assert.deepEqual(unbound, [], "a model-facing instruction tree that ships with no digest can change under every run silently");

  // Negative control: the check must be able to fail. A root the image does not
  // ship is not required to be bound, and a bound root that is not shipped is
  // not an error — only the shipped-and-unbound direction is.
  assert.equal(bound.has("runtime/skills/does-not-exist"), false);
  assert.ok(bound.has("runtime/skills/external/ai4s-skills"), "the OpenCode delivery path's root stays bound while that kernel is selectable");

  // Delivery and binding are different questions and must stay different lists.
  // `config.runtimeSkillDirs` says which directories the OpenCode path COPIES
  // into a project; the DSH image bakes its roots in instead. Adding a baked-in
  // root to the delivery list made the host runtime try to deliver a tree it
  // must not, surfacing as a 409 where a timeout was expected. The manifest
  // list is a superset of the delivery list, which is what keeps
  // `runtimeReleasePolicyError`'s membership check satisfiable.
  const config = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");
  const delivered = new Set([...config.matchAll(/rootDir, "((?:runtime\/skills|capability-skills)[^"]*)"/g)].map((match) => match[1]));
  assert.ok(delivered.size > 0, "the delivery list must still exist");
  const unbacked = [...delivered].filter((source) => !bound.has(source));
  assert.deepEqual(unbacked, [], "every delivered root must be bound, or readiness fails release_manifest_mismatch");
  assert.equal(delivered.has("capability-skills"), false, "the DSH image bakes this in; the OpenCode path must not copy it");
});

test("the workflow that gates every PR runs the gates ci:web runs", async () => {
  // web.yml is the only check on PRs and main, and it ran no ESLint at all —
  // so a lint failure, a server type error, a committed secret, an unvendored
  // community skill or a SaaS-alignment drift could each merge. The local
  // pipeline caught them; nothing that runs without a person did.
  //
  // Derived from `ci:web` rather than hand-listed, because a hand-listed copy
  // is what drifted: the point is that adding a gate to `ci:web` and forgetting
  // CI has to fail here.
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/web.yml"), "utf8");

  /** Expand a script into the leaf scripts it runs. */
  const leaves = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const body = pkg.scripts?.[name];
    if (!body) return [name];
    // Only names that are themselves scripts. `audit:dependencies` runs
    // `pnpm audit --prod`, and `audit` is pnpm's builtin, not a gate anyone
    // schedules — treating it as one asked CI to run a command that does not
    // exist.
    const called = [...body.matchAll(/pnpm (?:run )?([\w:-]+)/g)]
      .map((match) => match[1])
      .filter((child) => Object.hasOwn(pkg.scripts ?? {}, child));
    return called.length ? called.flatMap((child) => leaves(child, seen)) : [name];
  };

  // Steps CI satisfies by a different but equivalent invocation. Each is a
  // deliberate equivalence, not a hole: recorded here so the exception is
  // visible rather than absent.
  const equivalents = {
    "test:server": /pnpm --filter @ai4s\/server test\b/,
    test: /pnpm --filter @ai4s\/desktop test\b/,
    typecheck: /pnpm --filter @ai4s\/desktop typecheck\b/,
    "build:web": /pnpm --filter @ai4s\/desktop build\b/,
    "audit:capabilities": /pnpm check:capabilities\b/,
    // `pnpm test:packages`, which CI runs, is exactly these four.
    "test:domain": /pnpm test:packages\b/,
    "test:port": /pnpm test:packages\b/,
    "test:socket": /pnpm test:packages\b/,
    "test:contracts": /pnpm test:packages\b/,
    // `pnpm lint`, which CI now runs, chains desktop + server + domain + port
    // + socket. Verified against package.json rather than assumed.
    "lint:server": /pnpm lint\b/,
    "lint:domain": /pnpm lint\b/,
    "lint:port": /pnpm lint\b/,
    "lint:socket": /pnpm lint\b/,
  };

  const required = [...new Set(leaves("ci:web"))];
  assert.ok(required.length >= 8, `ci:web should expand to several gates, got ${JSON.stringify(required)}`);

  const missing = required.filter((name) => {
    if (new RegExp(`pnpm (?:run )?${name.replace(/[:]/g, "[:]")}(?![\\w:-])`).test(workflow)) return false;
    const alt = equivalents[name];
    return !(alt && alt.test(workflow));
  });
  assert.deepEqual(missing, [], "these gates run locally and nothing runs them on a pull request");
});

test("web Dockerfile only copies sources that exist in the build context", async () => {
  const dockerfilePath = path.join(repoRoot, "deploy/web/Dockerfile");
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const missing = [];

  for (const rawLine of dockerfile.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("COPY ") || line.includes("--from=")) continue;
    const words = splitDockerWords(line);
    let parts = words.slice(1);
    while (parts[0]?.startsWith("--")) parts = parts.slice(1);
    const sources = parts.slice(0, -1);
    for (const source of sources) {
      if (!existsSync(path.join(repoRoot, source))) missing.push(source);
    }
  }

  assert.deepEqual(missing, []);
});

test("web Dockerfile embeds immutable OCI release metadata", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG APP_VERSION=0\.1\.3/);
  assert.match(dockerfile, /ARG RELEASE_ID=untracked/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.version="\$\{RELEASE_ID\}"/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision="\$\{SOURCE_REVISION\}"/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.created="\$\{BUILD_CREATED\}"/);
  assert.match(dockerfile, /LABEL io\.open-science\.app\.version="\$\{APP_VERSION\}"/);
  assert.match(dockerfile, /ENV OPEN_SCIENCE_RELEASE_ID=\$\{RELEASE_ID\}/);
  assert.match(dockerfile, /pnpm --filter @ai4s\/server deploy --prod \/server/);
  assert.match(dockerfile, /COPY --from=build \/server \.\/apps\/server/);
});

test("web Dockerfile applies the configured npm registry before Corepack downloads pnpm", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  const registryArg = dockerfile.indexOf("ARG NPM_REGISTRY=");
  const corepackRegistry = dockerfile.indexOf("ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}");
  const corepackPrepare = dockerfile.indexOf("corepack prepare pnpm@9.4.0 --activate");

  assert.ok(registryArg >= 0);
  assert.ok(corepackRegistry > registryArg);
  assert.ok(corepackPrepare > corepackRegistry);
});

test("web image packages the isolated backup scheduler runtime", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  assert.match(dockerfile, /apk add --no-cache aws-cli bash coreutils docker-cli tar/);
  assert.match(dockerfile, /COPY --from=build \/app\/scripts\/ops \.\/scripts\/ops/);
  assert.match(dockerfile, /COPY --from=build \/app\/examples\/climate-trends \.\/examples\/climate-trends/);
  assert.match(dockerfile, /ENV OPEN_SCIENCE_EXAMPLES_DIR=\/app\/examples/);
});

test("hosted command registry explicitly covers every registered Tauri command", async () => {
  const tauriEntry = await readFile(path.join(repoRoot, "apps/desktop/src-tauri/src/lib.rs"), "utf8");
  const handlerBlock = tauriEntry.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(handlerBlock, "Tauri command registration block must be discoverable");

  const desktopCommands = [...handlerBlock.matchAll(/\b[a-z_]+::([a-z_][a-z0-9_]*)\s*,?/g)]
    .map((match) => match[1])
    .sort();
  const hostedCommands = createCommandRegistry({ config: {}, runtimeManager: {} }).list();
  const missing = desktopCommands.filter((command) => !hostedCommands.includes(command));

  assert.deepEqual(missing, [], `Hosted command registry is missing: ${missing.join(", ")}`);
});

test("Docker build context excludes deployment secrets and generated manifests", async () => {
  const dockerignore = await readFile(path.join(repoRoot, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^\*\*\/\.env\.\*$/m);
  assert.match(dockerignore, /^\*\*\/secrets$/m);
  assert.match(dockerignore, /^deploy\/web\/release-manifest\.json$/m);
});

test("production compose isolates runtimes behind the internal model gateway network", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_NETWORK_MODE:.*open-science-runtime-internal/);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME:.*open-science-runtime-internal/);
  assert.match(compose, /OPEN_SCIENCE_MODEL_GATEWAY_INTERNAL_URL:.*http:\/\/open-science-web:8787\/internal\/model\/v1/);
  assert.match(compose, /OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_INTERNAL_URL:.*http:\/\/open-science-web:8787\/internal\/sources\/v1\/fetch/);
  assert.match(compose, /OPEN_SCIENCE_DEEPSEEK_PROVIDER_ENABLED:.*true/);
  assert.match(compose, /OPEN_SCIENCE_REQUIRE_ALL_SPECIALIST_ADAPTERS:.*true/);
  assert.match(compose, /networks:\n\s+runtime-internal:\n\s+name:.*\n\s+internal: true/);
  assert.match(compose, /open-science-web:[\s\S]*?networks:\n\s+- default\n\s+- runtime-internal/);
});

test("production compose requires PostgreSQL control-plane state and a healthy provisioned Memos service", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const envExample = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.match(compose, /evimed-postgres:\n\s+image: postgres:16\.14-bookworm/);
  assert.match(compose, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/postgres-password/);
  assert.match(compose, /evimed-memos:\n\s+image: \$\{OPEN_SCIENCE_MEMOS_CONTAINER_IMAGE:-evimed-memos:0\.31\.1-evimed\}/);
  assert.match(compose, /dockerfile: OpenScience\/deploy\/memos\/Dockerfile/);
  assert.match(compose, /MEMOS_DRIVER: postgres/);
  assert.match(compose, /MEMOS_DSN_FILE: \/run\/secrets\/memos-dsn/);
  assert.match(compose, /evimed-memos-bootstrap:[\s\S]*scripts\/ops\/provision-memos\.mjs/);
  assert.match(compose, /OPEN_SCIENCE_STATE_STORE: postgres/);
  assert.match(compose, /OPEN_SCIENCE_REQUIRE_SHARED_STATE_STORE: "true"/);
  assert.match(compose, /OPEN_SCIENCE_DATABASE_URL_FILE: \/run\/secrets\/database-url/);
  assert.match(compose, /OPEN_SCIENCE_MEMOS_URL: http:\/\/evimed-memos:5230/);
  assert.match(compose, /OPEN_SCIENCE_MEMOS_ACCESS_TOKEN_FILE: \/run\/memos-integration\/access-token/);
  assert.match(compose, /OPEN_SCIENCE_REQUIRE_MEMOS: "true"/);
  assert.match(compose, /evimed-memos-bootstrap:\n\s+condition: service_completed_successfully/);
  for (const name of [
    "OPEN_SCIENCE_POSTGRES_PASSWORD_HOST_FILE",
    "OPEN_SCIENCE_DATABASE_URL_HOST_FILE",
    "OPEN_SCIENCE_MEMOS_DSN_HOST_FILE",
    "OPEN_SCIENCE_MEMOS_ADMIN_PASSWORD_HOST_FILE",
  ]) {
    assert.match(envExample, new RegExp(`^${name}=`, "m"));
  }
});

test("production compose exposes every specialist adapter configured by the server", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const envExample = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const config = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");
  const adapterEnvs = [...config.matchAll(/\["[^"]+", "(EVIMED_[A-Z0-9_]+_URL)"\]/g)]
    .map((match) => match[1]);

  assert.ok(adapterEnvs.length >= 15, "the specialist adapter registry should remain complete");
  for (const envName of adapterEnvs) {
    assert.match(compose, new RegExp(`\\b${envName}:`), `${envName} is missing from Docker Compose`);
    assert.match(envExample, new RegExp(`^${envName}=`, "m"), `${envName} is missing from .env.example`);
  }
});

test("web compose defaults to the hosted docker runtime boundary", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const metaStart = compose.indexOf("\n  evimed-meta-agent:\n    image:");
  const controllerStart = compose.indexOf("\n  open-science-runtime-controller:\n    image:");
  const runtimeImageStart = compose.indexOf("\n  dsh-runtime-image:");
  // Every slice below is bounded by these three offsets: a marker that stopped
  // matching would return -1 and hand the assertions a slice of the whole file
  // (or of nothing), which passes for the wrong reason.
  assert.ok(metaStart > 0 && controllerStart > metaStart && runtimeImageStart > controllerStart, "the compose service order this test slices by has changed");
  const webService = compose.slice(
    compose.indexOf("  open-science-web:"),
    metaStart,
  );
  const metaService = compose.slice(metaStart, controllerStart);
  const controllerService = compose.slice(
    controllerStart,
    runtimeImageStart,
  );
  assert.match(compose, /NODE_ENV:\s+\$\{NODE_ENV:-production\}/);
  assert.match(compose, /OPEN_SCIENCE_DEPLOYMENT_PROFILE:\s+\$\{OPEN_SCIENCE_DEPLOYMENT_PROFILE:-controlled-pilot\}/);
  assert.match(compose, /image:\s+\$\{OPEN_SCIENCE_WEB_CONTAINER_IMAGE:-open-science-web:0\.1\.3\}/);
  assert.match(compose, /RELEASE_ID:\s+\$\{OPEN_SCIENCE_RELEASE_ID:\?set OPEN_SCIENCE_RELEASE_ID\}/);
  assert.match(compose, /SOURCE_REVISION:\s+\$\{OPEN_SCIENCE_SOURCE_REVISION:\?set OPEN_SCIENCE_SOURCE_REVISION\}/);
  assert.match(compose, /BUILD_CREATED:\s+\$\{OPEN_SCIENCE_BUILD_CREATED:\?set OPEN_SCIENCE_BUILD_CREATED\}/);
  assert.match(
    compose,
    /APK_MIRROR:\s+\$\{OPEN_SCIENCE_APK_MIRROR:-https:\/\/dl-cdn\.alpinelinux\.org\/alpine\}/,
  );
  assert.match(
    compose,
    /NPM_REGISTRY:\s+\$\{OPEN_SCIENCE_NPM_REGISTRY:-https:\/\/registry\.npmjs\.org\}/,
  );
  assert.match(
    compose,
    /APT_MIRROR:\s+\$\{OPEN_SCIENCE_APT_MIRROR:-http:\/\/deb\.debian\.org\/debian\}/,
  );
  assert.match(
    compose,
    /DEBIAN_SECURITY_MIRROR:\s+\$\{OPEN_SCIENCE_DEBIAN_SECURITY_MIRROR:-http:\/\/deb\.debian\.org\/debian-security\}/,
  );
  assert.match(
    compose,
    /PIP_INDEX_URL:\s+\$\{OPEN_SCIENCE_PIP_INDEX_URL:-https:\/\/pypi\.org\/simple\}/,
  );
  assert.match(
    compose,
    /GITHUB_DOWNLOAD_PREFIX:\s+\$\{OPEN_SCIENCE_GITHUB_DOWNLOAD_PREFIX:-\}/,
  );
  assert.match(compose, /OPEN_SCIENCE_RELEASE_MANIFEST_FILE:\s+\/run\/open-science\/release-manifest\.json/);
  assert.match(compose, /OPEN_SCIENCE_AUTH_MODE:\s+\$\{OPEN_SCIENCE_AUTH_MODE:-local\}/);
  assert.match(webService, /127\.0\.0\.1:\$\{OPEN_SCIENCE_API_PORT:-8787\}:8787/);
  assert.doesNotMatch(webService, /- "8787:8787"/);
  assert.match(webService, /OPEN_SCIENCE_TRUST_PROXY:\s+\$\{OPEN_SCIENCE_TRUST_PROXY:-true\}/);
  assert.match(compose, /OPEN_SCIENCE_DEV_AUTH:\s+\$\{OPEN_SCIENCE_DEV_AUTH:-false\}/);
  assert.match(compose, /OPEN_SCIENCE_BOOTSTRAP_PASSWORD:\s+\$\{OPEN_SCIENCE_BOOTSTRAP_PASSWORD:-\}/);
  assert.match(compose, /OPEN_SCIENCE_OIDC_CLIENT_SECRET_FILE:\s+\$\{OPEN_SCIENCE_OIDC_CLIENT_SECRET_FILE:-\}/);
  assert.match(compose, /OPEN_SCIENCE_OIDC_CLIENT_AUTH_METHOD:\s+\$\{OPEN_SCIENCE_OIDC_CLIENT_AUTH_METHOD:-client_secret_basic\}/);
  assert.match(compose, /OPEN_SCIENCE_OIDC_FLOW_SECRET_FILE:\s+\$\{OPEN_SCIENCE_OIDC_FLOW_SECRET_FILE:-\}/);
  assert.match(compose, /OPEN_SCIENCE_SESSION_TTL_MS:\s+\$\{OPEN_SCIENCE_SESSION_TTL_MS:-604800000\}/);
  assert.match(compose, /OPEN_SCIENCE_OPERATOR_METRICS_TOKEN:\s+\$\{OPEN_SCIENCE_OPERATOR_METRICS_TOKEN:-\}/);
  assert.match(compose, /OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE:\s+\$\{OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE:-\}/);
  assert.match(compose, /OPEN_SCIENCE_BACKUP_MODE:\s+\$\{OPEN_SCIENCE_BACKUP_MODE:-disabled\}/);
  assert.match(compose, /OPEN_SCIENCE_BACKUP_DIR:\s+\$\{OPEN_SCIENCE_BACKUP_DIR:-\/backups\}/);
  assert.match(compose, /OPEN_SCIENCE_BACKUP_RETENTION_DAYS:\s+\$\{OPEN_SCIENCE_BACKUP_RETENTION_DAYS:-0\}/);
  assert.match(compose, /OPEN_SCIENCE_RESTORE_DRILL_ACK:\s+\$\{OPEN_SCIENCE_RESTORE_DRILL_ACK:-false\}/);
  // DSH is the only kernel: `config.mjs` throws on "opencode" by name, so a
  // compose default of anything but "kernel" is a stack that cannot boot.
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_MODE:\s+\$\{OPEN_SCIENCE_RUNTIME_MODE:-kernel\}/);
  assert.match(compose, /OPEN_SCIENCE_ALLOW_MOCK_RUNTIME:\s+\$\{OPEN_SCIENCE_ALLOW_MOCK_RUNTIME:-false\}/);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_SANDBOX_MODE:\s+\$\{OPEN_SCIENCE_RUNTIME_SANDBOX_MODE:-docker\}/);
  assert.match(webService, /OPEN_SCIENCE_RUNTIME_CONTROLLER_MODE:\s+socket/);
  assert.match(webService, /OPEN_SCIENCE_ALLOW_DIRECT_DOCKER_CONTROL:\s+"false"/);
  assert.doesNotMatch(webService, /OPEN_SCIENCE_BACKUP_PASSPHRASE(?:_FILE)?:/);
  assert.match(webService, /OPEN_SCIENCE_BACKUP_STATE_FILE:\s+\$\{OPEN_SCIENCE_BACKUP_STATE_FILE:-\/backups\/\.open-science-backup-state\.json\}/);
  assert.match(webService, /OPEN_SCIENCE_BACKUP_HEALTH_GRACE_SECONDS:\s+\$\{OPEN_SCIENCE_BACKUP_HEALTH_GRACE_SECONDS:-1800\}/);
  assert.match(webService, /open-science-runtime-control:\/run\/open-science-controller:ro/);
  assert.match(webService, /open-science-backups:\/backups:ro/);
  assert.doesNotMatch(webService, /\/var\/run\/docker\.sock/);
  assert.match(webService, /EVIMED_META_ANALYSIS_URL:.*http:\/\/evimed-meta-agent:8024\/api\/v1\/evimed\/meta-analysis/);
  assert.match(webService, /target:\s+\/run\/secrets\/evimed-workload-signing-key/);
  assert.match(webService, /security_opt:\s*\n\s+- no-new-privileges:true/);
  assert.match(webService, /cap_drop:\s*\n\s+- ALL/);
  assert.match(webService, /read_only:\s+true/);
  assert.match(webService, /\/tmp:rw,nosuid,nodev,noexec,size=\$\{OPEN_SCIENCE_WEB_TMPFS_SIZE:-128m\}/);
  assert.match(metaService, /context:\s+\.\.\/\.\.\/\.\.\/项目代码\/meta/);
  assert.match(metaService, /dockerfile:\s+Dockerfile\.evimed/);
  assert.match(metaService, /EVIMED_WORKLOAD_SIGNING_SECRET_FILE:\s+\/run\/secrets\/evimed-workload-signing-key/);
  assert.match(metaService, /LLM_API_KEY_FILE:\s+\/run\/secrets\/deepseek-api-key/);
  assert.match(metaService, /LLM_MODEL:\s+deepseek-v4-pro/);
  assert.match(metaService, /open-science-data:\/data/);
  assert.match(metaService, /security_opt:\s*\n\s+- no-new-privileges:true/);
  assert.match(metaService, /cap_drop:\s*\n\s+- ALL/);
  assert.match(metaService, /read_only:\s+true/);
  assert.doesNotMatch(metaService, /^\s+ports:/m);
  assert.match(controllerService, /command:\s+\["node", "apps\/server\/src\/runtimeControllerIndex\.mjs"\]/);
  assert.match(controllerService, /open-science-data:\/data:ro/);
  assert.match(controllerService, /open-science-runtime-control:\/run\/open-science-controller/);
  assert.match(controllerService, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(
    controllerService,
    /group_add:\s*\n\s+- "\$\{OPEN_SCIENCE_DOCKER_SOCKET_GID:\?set OPEN_SCIENCE_DOCKER_SOCKET_GID\}"/,
  );
  // The controller's caps come from the `x-runtime-caps` anchor now, so they are
  // not text inside its own block. What matters is unchanged and is asserted
  // where it is true: the anchor defines all four with these defaults, and the
  // controller merges it. Scanning its block for the literals would have made
  // sharing one definition look like deleting the check.
  assert.match(controllerService, /<<: \*runtime-caps/, "the controller must take the shared caps");
  assert.match(webService, /<<: \*runtime-caps/, "and so must the web service, or they can disagree again");
  const capAnchor = compose.slice(compose.indexOf("x-runtime-caps: &runtime-caps"), compose.indexOf("\nservices:"));
  assert.match(capAnchor, /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS:\s+\$\{OPEN_SCIENCE_MAX_CONCURRENT_KERNELS:-2\}/);
  assert.match(capAnchor, /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER:\s+\$\{OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER:-1\}/);
  assert.match(capAnchor, /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES:\s+\$\{OPEN_SCIENCE_MAX_RUNNING_RUNTIMES:-8\}/);
  assert.match(capAnchor, /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER:\s+\$\{OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER:-4\}/);
  assert.doesNotMatch(controllerService, /^\s+ports:/m);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_DATA_VOLUME:\s+\$\{OPEN_SCIENCE_DATA_VOLUME:-open-science-data\}/);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_TRANSPORT:\s+\$\{OPEN_SCIENCE_RUNTIME_TRANSPORT:-unix\}/);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_NETWORK_MODE:\s+\$\{OPEN_SCIENCE_RUNTIME_NETWORK_MODE:-open-science-runtime-internal\}/);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME:\s+\$\{OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME:-open-science-runtime-internal\}/);
  assert.match(compose, /image:\s+caddy:\$\{OPEN_SCIENCE_CADDY_VERSION:-\d+\.\d+\.\d+-alpine\}/);
  assert.match(compose, /OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS:\s+\$\{OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS:-false\}/);
  assert.match(
    compose,
    /OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK:\s+\$\{OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK:-false\}/,
  );
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_READ_ONLY_ROOT:\s+\$\{OPEN_SCIENCE_RUNTIME_READ_ONLY_ROOT:-true\}/);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_TMPFS:\s+\$\{OPEN_SCIENCE_RUNTIME_TMPFS:-\/tmp:rw,nosuid,nodev,size=64m\}/);
  assert.match(
    compose,
    /OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS:\s+\$\{OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS:-30000\}/,
  );
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_SKILL_DIRS:\s+\$\{OPEN_SCIENCE_RUNTIME_SKILL_DIRS-runtime\/skills\/core,runtime\/skills\/external\/ai4s-skills,runtime\/skills\/curated-scientific,runtime\/skills\/office\}/);
  assert.match(compose, /OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME:\s+\$\{OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME:-false\}/);
  assert.match(compose, /OPEN_SCIENCE_ALLOW_DIRECT_SHELL:\s+\$\{OPEN_SCIENCE_ALLOW_DIRECT_SHELL:-false\}/);
  assert.match(compose, /OPEN_SCIENCE_ENABLE_KERNEL:\s+\$\{OPEN_SCIENCE_ENABLE_KERNEL:-false\}/);
  assert.match(compose, /OPEN_SCIENCE_KERNEL_SANDBOX_MODE:\s+\$\{OPEN_SCIENCE_KERNEL_SANDBOX_MODE:-docker\}/);
  assert.match(compose, /OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL:\s+\$\{OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL:-false\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_JSON_BYTES:\s+\$\{OPEN_SCIENCE_MAX_JSON_BYTES:-12582912\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_FILE_BYTES:\s+\$\{OPEN_SCIENCE_MAX_FILE_BYTES:-52428800\}/);
  assert.match(compose, /OPEN_SCIENCE_PROXY_MAX_BODY_SIZE:\s+\$\{OPEN_SCIENCE_PROXY_MAX_BODY_SIZE:-73408512\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES:\s+\$\{OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES:-10000\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES:\s+\$\{OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES:-10000\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_ARCHIVE_BYTES:\s+\$\{OPEN_SCIENCE_MAX_ARCHIVE_BYTES:-1073741824\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES:\s+\$\{OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES:-10000\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_LOG_READ_BYTES:\s+\$\{OPEN_SCIENCE_MAX_LOG_READ_BYTES:-1048576\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_LOG_FILE_BYTES:\s+\$\{OPEN_SCIENCE_MAX_LOG_FILE_BYTES:-10485760\}/);
  assert.match(compose, /OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES:\s+\$\{OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES:-1048576\}/);
  assert.match(compose, /OPEN_SCIENCE_KERNEL_TIMEOUT_MS:\s+\$\{OPEN_SCIENCE_KERNEL_TIMEOUT_MS:-10000\}/);
  assert.match(compose, /OPEN_SCIENCE_EXAMPLES_DIR:\s+\/app\/examples/);
  assert.match(compose, /OPEN_SCIENCE_MAX_QUEUED_TASKS:\s+\$\{OPEN_SCIENCE_MAX_QUEUED_TASKS:-100\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT:\s+\$\{OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT:-25\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS:\s+\$\{OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS:-64\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT:\s+\$\{OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT:-8\}/);
  assert.match(compose, /OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS:\s+\$\{OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS:-120000\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES:\s+\$\{OPEN_SCIENCE_MAX_RUNNING_RUNTIMES:-8\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER:\s+\$\{OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER:-4\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS:\s+\$\{OPEN_SCIENCE_MAX_CONCURRENT_KERNELS:-2\}/);
  assert.match(compose, /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER:\s+\$\{OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER:-1\}/);
  assert.match(compose, /open-science-backups:\/backups/);
  assert.match(compose, /open-science-data:[\s\S]*name:\s+\$\{OPEN_SCIENCE_DATA_VOLUME:-open-science-data\}/);
  assert.match(compose, /source:\s+\$\{OPEN_SCIENCE_RELEASE_MANIFEST_HOST_FILE:-\.\/release-manifest\.json\}/);
  assert.match(compose, /target:\s+\/run\/open-science\/release-manifest\.json/);
  assert.match(compose, /\/api\/ready/);
});

test("backup compose overlay runs an unexposed least-privilege encrypted scheduler", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.backup.yml"), "utf8");
  const backupStart = compose.indexOf("  open-science-backup:");
  const backupService = compose.slice(backupStart, compose.indexOf("\nsecrets:"));
  // Defaults to local, but as a default the operator can override: a literal
  // here and a literal in the SaaS overlay made the winning value depend on the
  // order the -f files were passed.
  assert.match(compose, /OPEN_SCIENCE_BACKUP_MODE:\s+\$\{OPEN_SCIENCE_BACKUP_MODE:-local\}/);
  assert.match(compose, /OPEN_SCIENCE_BACKUP_ENCRYPTION_ACK:\s+"true"/);
  assert.match(compose, /OPEN_SCIENCE_RESTORE_DRILL_ACK:\s+"true"/);
  assert.match(backupService, /command:\s+\["node", "scripts\/ops\/backup-scheduler\.mjs", "run"\]/);
  assert.match(backupService, /profiles:\s+\["backup"\]/);
  assert.match(backupService, /open-science-data:\/data:ro/);
  assert.match(backupService, /open-science-backups:\/backups/);
  assert.match(backupService, /OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE:\s+\/run\/secrets\/backup-passphrase/);
  assert.match(backupService, /target:\s+backup-passphrase/);
  assert.match(backupService, /mode:\s+0400/);
  assert.match(backupService, /backup-scheduler\.mjs", "health"/);
  assert.match(backupService, /no-new-privileges:true/);
  assert.match(backupService, /cap_drop:\s*\n\s+- ALL/);
  assert.match(backupService, /read_only:\s+true/);
  assert.doesNotMatch(backupService, /^\s+ports:/m);
  assert.match(compose, /OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE:-\.\/secrets\/backup-passphrase\.txt/);
});

test("OIDC compose overlay mounts separate file-backed client and flow secrets", async () => {
  const overlay = await readFile(path.join(repoRoot, "deploy/web/docker-compose.oidc.yml"), "utf8");
  assert.match(overlay, /OPEN_SCIENCE_AUTH_MODE:\s+oidc/);
  assert.match(overlay, /OPEN_SCIENCE_BOOTSTRAP_PASSWORD:\s+""/);
  assert.match(overlay, /OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE:\s+""/);
  assert.match(overlay, /OPEN_SCIENCE_OIDC_CLIENT_SECRET_FILE:\s+\/run\/secrets\/oidc_client_secret/);
  assert.match(overlay, /OPEN_SCIENCE_OIDC_FLOW_SECRET_FILE:\s+\/run\/secrets\/oidc_flow_secret/);
  assert.match(overlay, /oidc-client-secret\.txt/);
  assert.match(overlay, /oidc-flow-secret\.txt/);
});

test("individual SaaS overlay opts in explicitly and requires external recovery evidence", async () => {
  const overlay = await readFile(path.join(repoRoot, "deploy/web/docker-compose.saas.yml"), "utf8");
  assert.match(overlay, /OPEN_SCIENCE_DEPLOYMENT_PROFILE:\s+individual-saas/);
  assert.match(overlay, /OPEN_SCIENCE_BACKUP_MODE:\s+\$\{OPEN_SCIENCE_BACKUP_MODE:-external\}/);
  assert.match(overlay, /OPEN_SCIENCE_BACKUP_EXTERNAL_ACK:\s+\$\{OPEN_SCIENCE_BACKUP_EXTERNAL_ACK:\?/);
  assert.match(overlay, /OPEN_SCIENCE_RESTORE_DRILL_ACK:\s+\$\{OPEN_SCIENCE_RESTORE_DRILL_ACK:\?/);
});

test("local-auth compose overlay mounts the bootstrap password as a read-only Docker secret", async () => {
  const overlay = await readFile(path.join(repoRoot, "deploy/web/docker-compose.local-auth.yml"), "utf8");
  assert.match(overlay, /OPEN_SCIENCE_AUTH_MODE:\s+local/);
  assert.match(overlay, /OPEN_SCIENCE_BOOTSTRAP_PASSWORD:\s+""/);
  assert.match(overlay, /OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE:\s+\/run\/secrets\/bootstrap-password/);
  assert.match(overlay, /target:\s+bootstrap-password/);
  assert.match(overlay, /mode:\s+0400/);
  assert.match(overlay, /OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE:-\.\/secrets\/bootstrap-password\.txt/);
});

test("web Caddy proxy caps browser upload body size", async () => {
  const caddyfile = await readFile(path.join(repoRoot, "deploy/web/Caddyfile"), "utf8");
  assert.match(
    caddyfile,
    /request_body\s*\{[\s\S]*max_size\s+\{\$OPEN_SCIENCE_PROXY_MAX_BODY_SIZE:73408512\}/,
  );
  assert.match(caddyfile, /header_up X-Forwarded-For \{remote_host\}/);
  assert.match(caddyfile, /@internal path \/internal\/\*/);
  assert.match(caddyfile, /respond @internal 404/);
});

test("web compose includes a buildable runtime image profile with every download digest-pinned", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.match(compose, /dsh-runtime-image:/);
  assert.match(
    compose,
    /image:\s+\$\{OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE:-open-science-runtime:dsh-0\.1\.2-alpha\.5-uv-0\.11\.26\}/,
  );
  assert.match(compose, /dockerfile:\s+deploy\/runtime-dsh\/Dockerfile/);
  assert.match(compose, /profiles:\s+\["runtime-image"\]/);
  // The kernel arrives as an npm global at a pinned version rather than as a
  // fetched archive, so what is version-pinned and what is digest-pinned are
  // different lists now. Both still have to be pinned.
  assert.match(compose, /DSH_VERSION:\s+\$\{OPEN_SCIENCE_DSH_VERSION:-0\.1\.2-alpha\.5\}/);
  assert.match(compose, /DSH_CORDIS_VERSION:\s+\$\{OPEN_SCIENCE_DSH_CORDIS_VERSION:-4\.0\.2\}/);
  assert.match(compose, /SOCKET_VERSION:\s+\$\{OPEN_SCIENCE_SOCKET_VERSION:-0\.1\.0\}/);
  assert.match(compose, /UV_VERSION:\s+\$\{OPEN_SCIENCE_UV_VERSION:-0\.11\.26\}/);
  for (const name of [
    "UV_SHA256_AMD64",
    "UV_SHA256_ARM64",
    "UV_LICENSE_MIT_SHA256",
  ]) {
    assert.match(compose, new RegExp(`${name}:\\s+\\$\\{OPEN_SCIENCE_${name}:-[a-f0-9]{64}\\}`));
  }
  // The retired kernel is not a build this stack can still produce. Left
  // behind, its service claimed OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE — the one
  // name the control plane launches — so `--profile runtime-image build`
  // tagged the wrong image with it.
  assert.equal(compose.includes("deploy/runtime-opencode/"), false, "compose still builds the retired kernel's image");
  assert.equal(/OPEN_SCIENCE_OPENCODE_\w+/.test(compose), false, "compose still passes the retired kernel's build arguments");
});

// One image ships, so there is one Dockerfile with tools to pin, and this test
// reads it. It read the retired kernel's copy until that tree was deleted on
// 2026-09-02; almost none of what it checks was ever about OpenCode — the
// scientific stack, the architecture handling, the retry budget and the
// redistributed licenses are properties of whichever image a deployment
// launches, and they would have been silently lost had the assertions gone out
// with the file that happened to hold them.
//
// Two of them were genuinely about the retired kernel and have no successor:
// the OpenCode archive digests and the separately fetched OpenCode license.
// The kernel is an npm global now, so there is no archive to digest and its
// license ships inside the package. What binds it instead is the publish-date
// filter and the whole-tree version assertion, checked below in their place.
test("the runtime image pins and verifies tools, architectures, and licenses", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG TARGETARCH$/m);
  assert.doesNotMatch(dockerfile, /^ARG TARGETARCH=/m);
  assert.match(dockerfile, /ARG DSH_VERSION=0\.1\.2-alpha\.5/);
  assert.match(dockerfile, /ARG UV_VERSION=0\.11\.26/);
  // Both architectures of both downloads. `NODE_SHA256_ARM64` used to be absent
  // from this list and empty in the Dockerfile, where the verification sat
  // behind `if [ -n "$NODE_SHA256" ]` -- so an arm64 build fetched Node over
  // the network and untarred it into /usr/local with nothing checked, while a
  // test named for pinning architectures passed. An empty pin now fails the
  // build, and this list is what stops one from being emptied again.
  for (const name of [
    "NODE_SHA256_AMD64",
    "NODE_SHA256_ARM64",
    "UV_SHA256_AMD64",
    "UV_SHA256_ARM64",
    "UV_LICENSE_MIT_SHA256",
  ]) {
    assert.match(dockerfile, new RegExp(`^ARG ${name}=[a-f0-9]{64}$`, "m"));
  }
  // The guard itself, not just the pins: a pin can only be trusted if a missing
  // one stops the build rather than skipping the check.
  assert.match(dockerfile, /if \[ -z "\$\{NODE_SHA256\}" \]; then .*refusing to install an unverified runtime.*exit 1; fi/);
  // The kernel's substitute for an archive digest. `npm install
  // @deepseek-ai/dsh@0.1.2-alpha.5` on its own resolved a root at alpha.3 with
  // 213 subpackages at alpha.4 and reported success, so the date filter states
  // the request and the scan over every installed package is the guarantee.
  assert.match(dockerfile, /^ARG DSH_PUBLISHED_BEFORE=\d{4}-\d{2}-\d{2}T/m);
  assert.match(dockerfile, /--before="\$\{DSH_PUBLISHED_BEFORE\}"/);
  // The floor survives, wherever the packages sit: alpha.5 nests the 223
  // subpackages under the pin instead of hoisting them, so the scan tries both
  // roots and this asserts a plausibility floor still exists rather than which
  // directory it counts.
  assert.match(dockerfile, /length >= 50/);
  assert.match(dockerfile, /filter\(\(\[, v\]\) => v !== pin\)/);
  assert.match(dockerfile, /LABEL io\.open-science\.dsh\.version="\$\{DSH_VERSION\}"/);
  assert.match(dockerfile, /LABEL io\.open-science\.uv\.version="\$\{UV_VERSION\}"/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision="\$\{SOURCE_REVISION\}"/);
  assert.match(dockerfile, /amd64\).*NODE_ARCH="x64";.*UV_TRIPLE="x86_64-unknown-linux-gnu"/s);
  assert.match(dockerfile, /arm64\).*NODE_ARCH="arm64";.*UV_TRIPLE="aarch64-unknown-linux-gnu"/s);
  assert.match(dockerfile, /node-v\$\{NODE_VERSION\}-linux-\$\{NODE_ARCH\}\.tar\.xz/);
  assert.match(dockerfile, /uv-\$\{UV_TRIPLE\}\.tar\.gz/);
  assert.match(dockerfile, /--http1\.1 --fail --show-error --location --retry 5 --retry-all-errors/);
  assert.match(dockerfile, /--connect-timeout 20 --max-time 600/);
  assert.match(dockerfile, /--speed-limit 1024 --speed-time 60 --continue-at -/);
  // Three fetches now rather than four — Node, uv, and uv's license — because
  // the kernel is no longer downloaded.
  assert.equal((dockerfile.match(/curl "\$\{curl_args\[@\]\}"/g) ?? []).length, 3);
  // Counting `sha256sum -c -` occurrences says three checks are written, not
  // that three run: one of them sat inside a conditional that was false on
  // arm64 and this count was three throughout. The assertion above -- that a
  // missing pin exits non-zero -- is what makes the count mean "verified".
  assert.equal((dockerfile.match(/sha256sum -c -/g) ?? []).length, 3);
  assert.doesNotMatch(
    dockerfile,
    /if \[ -n "\$\{(NODE|UV)_SHA256\}" \]; then/,
    "a checksum guarded by its own presence is a checksum that can be skipped by leaving the pin empty",
  );
  assert.match(dockerfile, /uv\/\$\{UV_VERSION\}\/LICENSE-MIT/);
  assert.match(dockerfile, /\/usr\/share\/licenses\/uv\/LICENSE-MIT/);
  assert.match(dockerfile, /python-is-python3/);
  assert.match(dockerfile, /ripgrep/);
  assert.match(dockerfile, /r-base-core/);
  assert.match(dockerfile, /r-recommended/);
  assert.match(dockerfile, /ENV VIRTUAL_ENV=\/opt\/evimed\/venv/);
  assert.match(dockerfile, /uv venv "\$\{VIRTUAL_ENV\}" --python \/usr\/bin\/python3/);
  assert.match(dockerfile, /uv pip install --python "\$\{VIRTUAL_ENV\}\/bin\/python"/);
  assert.doesNotMatch(dockerfile, /uv pip install --system/);
  for (const packageName of [
    "ipykernel",
    "jupyterlab",
    "matplotlib",
    "numpy",
    "openpyxl",
    "pandas",
    "pypdf",
    "scikit-learn",
    "scipy",
    "statsmodels",
  ]) {
    assert.match(dockerfile, new RegExp(`${packageName.replace("-", "\\-")}==\\d+\\.`));
  }
  assert.match(dockerfile, /importlib\.import_module\(package\)/);
  assert.match(dockerfile, /RUN Rscript -e 'stopifnot\(getRversion\(\) >= "4\.0\.0"/);
  assert.match(dockerfile, /\bsocat\b/);
  assert.match(dockerfile, /COPY deploy\/runtime-dsh\/open-science-dsh-serve\.sh/);
  assert.match(dockerfile, /CMD \["dsh", "--version"\]/);

  const launcher = await readFile(
    path.join(repoRoot, "deploy/runtime-dsh/open-science-dsh-serve.sh"),
    "utf8",
  );
  // The kernel is reachable only on loopback, and only through a 0600 unix
  // socket the control plane mounts. OpenCode was told to bind loopback with
  // `--hostname`; DSH's web host refuses a bind-all host outright, so the
  // loopback half of the property is asserted where it is still written down —
  // the address socat bridges the socket to.
  assert.match(launcher, /UNIX-LISTEN:\$\{socket\},fork,unlink-early,mode=0600/);
  assert.match(launcher, /"TCP:127\.0\.0\.1:\$\{port\}"/);
});

test("drug-safety specialist writes its response cache to a writable mount", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const start = compose.indexOf("\n  evimed-drug-safety-agent:\n");
  const end = compose.indexOf("\n  evimed-drug-evidence-adapter:\n", start);
  const service = compose.slice(start, end);

  assert.match(service, /CACHE_DIR:\s+\/tmp\/openfda-cache/);
  assert.match(service, /\/tmp:rw,nosuid,nodev,size=1g/);
});

test("web deployment env example documents required hosted settings", async () => {
  const env = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.match(env, /NODE_ENV=production/);
  assert.match(env, /OPEN_SCIENCE_DEPLOYMENT_PROFILE=controlled-pilot/);
  assert.match(env, /OPEN_SCIENCE_API_PORT=8787/);
  assert.match(env, /OPEN_SCIENCE_TRUST_PROXY=true/);
  assert.match(env, /OPEN_SCIENCE_APP_VERSION=0\.1\.3/);
  assert.match(env, /OPEN_SCIENCE_RELEASE_ID=replace-with-release-id/);
  assert.match(env, /OPEN_SCIENCE_SOURCE_REVISION=replace-with-the-40-character-source-revision/);
  assert.match(env, /OPEN_SCIENCE_BUILD_CREATED=replace-with-rfc3339-build-time/);
  assert.match(env, /OPEN_SCIENCE_WEB_CONTAINER_IMAGE=open-science-web:0\.1\.3/);
  assert.match(env, /OPEN_SCIENCE_APK_MIRROR=https:\/\/dl-cdn\.alpinelinux\.org\/alpine/);
  assert.match(env, /OPEN_SCIENCE_NPM_REGISTRY=https:\/\/registry\.npmjs\.org/);
  assert.match(env, /OPEN_SCIENCE_APT_MIRROR=http:\/\/deb\.debian\.org\/debian/);
  assert.match(env, /OPEN_SCIENCE_DEBIAN_SECURITY_MIRROR=http:\/\/deb\.debian\.org\/debian-security/);
  assert.match(env, /OPEN_SCIENCE_PIP_INDEX_URL=https:\/\/pypi\.org\/simple/);
  assert.match(env, /OPEN_SCIENCE_GITHUB_DOWNLOAD_PREFIX=/);
  assert.match(env, /OPEN_SCIENCE_RELEASE_MANIFEST_HOST_FILE=\.\/release-manifest\.json/);
  assert.match(env, /OPEN_SCIENCE_DATA_VOLUME=open-science-data/);
  assert.match(env, /OPEN_SCIENCE_DOCKER_SOCKET_GID=replace-with-docker-socket-gid/);
  assert.match(env, /stat -c '%g' \/var\/run\/docker\.sock/);
  assert.match(env, /OPEN_SCIENCE_AUTH_MODE=local/);
  assert.match(env, /^OPEN_SCIENCE_BOOTSTRAP_PASSWORD=$/m);
  assert.match(env, /OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE=\.\/secrets\/bootstrap-password\.txt/);
  assert.match(env, /pnpm configure:local-auth/);
  assert.match(env, /OPEN_SCIENCE_SESSION_TTL_MS=604800000/);
  assert.match(env, /OPEN_SCIENCE_OIDC_ISSUER=/);
  assert.match(env, /OPEN_SCIENCE_OIDC_CLIENT_ID=/);
  assert.match(env, /OPEN_SCIENCE_OIDC_CLIENT_AUTH_METHOD=client_secret_basic/);
  assert.match(env, /OPEN_SCIENCE_OIDC_ALLOWED_GROUPS=/);
  assert.match(env, /OPEN_SCIENCE_OIDC_ALLOWED_EMAIL_DOMAINS=/);
  assert.match(env, /OPEN_SCIENCE_OIDC_SECRETS_DIR=\.\/secrets/);
  assert.match(env, /OPEN_SCIENCE_OPERATOR_METRICS_TOKEN=replace-with-a-long-random-scrape-token/);
  assert.match(env, /OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE=/);
  assert.match(env, /OPEN_SCIENCE_MONITORING_SECRETS_DIR=\.\/secrets/);
  assert.match(env, /OPEN_SCIENCE_PROMETHEUS_VERSION=v3\.13\.0/);
  assert.match(env, /OPEN_SCIENCE_ALERTMANAGER_VERSION=v0\.33\.1/);
  assert.match(env, /OPEN_SCIENCE_BLACKBOX_EXPORTER_VERSION=v0\.28\.0/);
  assert.match(env, /OPEN_SCIENCE_GRAFANA_VERSION=13\.1\.0/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_MODE=local/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_DIR=\/backups/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_RETENTION_DAYS=30/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_ENCRYPTION_ACK=false/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE=\.\/secrets\/backup-passphrase\.txt/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS=86400/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_HEALTH_GRACE_SECONDS=1800/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_RETRY_SECONDS=300/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_MAX_FAILURES=3/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_RESTORE_DRILL_EVERY=1/);
  assert.match(env, /OPEN_SCIENCE_BACKUP_TMPFS_SIZE=2g/);
  assert.match(env, /OPEN_SCIENCE_RESTORE_DRILL_ACK=false/);
  assert.match(env, /OPEN_SCIENCE_OBJECT_BACKUP_URI=/);
  assert.match(env, /OPEN_SCIENCE_OBJECT_BACKUP_SSE=AES256/);
  // The kernel pin, read back from the one place versions are written, so the
  // example a deployment copies cannot document a kernel the release manifest
  // does not record. The kernel is an npm global at a pinned version rather
  // than a fetched archive, so it is version-pinned here and digest-pinned
  // nowhere; uv is still fetched, so its archives and licence text still are.
  const pins = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
  assert.match(env, new RegExp(`^OPEN_SCIENCE_DSH_VERSION=${pins.dsh.version.replace(/\./g, "\\.")}$`, "m"));
  assert.match(env, new RegExp(`^OPEN_SCIENCE_DSH_CORDIS_VERSION=${pins.dsh.cordis.replace(/\./g, "\\.")}$`, "m"));
  assert.match(env, /^OPEN_SCIENCE_SOCKET_VERSION=0\.1\.0$/m);
  assert.match(env, /OPEN_SCIENCE_UV_VERSION=0\.11\.26/);
  assert.match(env, /OPEN_SCIENCE_UV_SHA256_AMD64=[a-f0-9]{64}/);
  assert.match(env, /OPEN_SCIENCE_UV_SHA256_ARM64=[a-f0-9]{64}/);
  assert.match(env, /OPEN_SCIENCE_UV_LICENSE_MIT_SHA256=[a-f0-9]{64}/);
  assert.match(env, /^OPEN_SCIENCE_RUNTIME_MODE=kernel$/m);
  // An example that still sets a variable `config.mjs` refuses by name is an
  // example that produces a stack which throws on boot. Read out of config.mjs
  // rather than listed here, so retiring the next variable cannot leave this
  // check behind.
  const configSource = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");
  const refusalStart = configSource.indexOf("for (const [oldName, remedy] of [");
  const refusalEnd = configSource.indexOf("if (process.env[oldName])", refusalStart);
  assert.ok(refusalStart > 0 && refusalEnd > refusalStart, "config.mjs no longer refuses retired variables in the shape this test reads");
  const refused = [...configSource.slice(refusalStart, refusalEnd).matchAll(/\["(OPEN_SCIENCE_[A-Z0-9_]+)",/g)]
    .map((match) => match[1]);
  assert.ok(refused.length >= 3, `expected config.mjs to still refuse retired variables by name, found ${JSON.stringify(refused)}`);
  for (const name of refused) {
    assert.equal(new RegExp(`^${name}=`, "m").test(env), false, `${name} is refused at startup but still set in .env.example`);
  }
  assert.match(env, /OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_CONTROLLER_TIMEOUT_MS=30000/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_CONTROLLER_POLL_MS=500/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_PROXY_CONNECT_TIMEOUT_MS=90000/);
  // The same image name and tag the compose default builds: a deployment that
  // copies this file and runs `--profile runtime-image build` must end up
  // launching the image it just built.
  const composeForEnv = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const composeRuntimeImage = composeForEnv.match(/\$\{OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE:-([^}]+)\}/)?.[1];
  assert.equal(composeRuntimeImage, "open-science-runtime:dsh-0.1.2-alpha.5-uv-0.11.26");
  assert.match(env, new RegExp(`^OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE=${composeRuntimeImage.replace(/[.]/g, "\\.")}$`, "m"));
  assert.match(env, /OPEN_SCIENCE_RUNTIME_TRANSPORT=unix/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_NETWORK_MODE=open-science-runtime-internal/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME=open-science-runtime-internal/);
  assert.match(env, /OPEN_SCIENCE_DEEPSEEK_API_KEY_HOST_FILE=\.\/secrets\/deepseek-api-key\.txt/);
  assert.match(env, /OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_HOST_FILE=\.\/secrets\/model-gateway-signing-key\.txt/);
  assert.match(env, /OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_HOST_FILE=\.\/secrets\/evimed-workload-signing-key\.txt/);
  assert.match(env, /EVIMED_META_ANALYSIS_URL=http:\/\/evimed-meta-agent:8024\/api\/v1\/evimed\/meta-analysis/);
  assert.match(env, /EVIMED_META_AGENT_IMAGE=evimed-meta-agent:0\.9\.0/);
  assert.match(env, /OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=false/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=false/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_READ_ONLY_ROOT=true/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_TMPFS=\/tmp:rw,nosuid,nodev,size=64m/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS=30000/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_SKILL_DIRS=runtime\/skills\/core,runtime\/skills\/external\/ai4s-skills,runtime\/skills\/curated-scientific/);
  assert.match(env, /OPEN_SCIENCE_ALLOW_DIRECT_SHELL=false/);
  assert.match(env, /OPEN_SCIENCE_ENABLE_KERNEL=false/);
  assert.match(env, /OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker/);
  assert.match(env, /OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL=false/);
  assert.match(env, /OPEN_SCIENCE_PROXY_MAX_BODY_SIZE=73408512/);
  assert.match(env, /OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES=10000/);
  assert.match(env, /OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES=10000/);
  assert.match(env, /OPEN_SCIENCE_MAX_ARCHIVE_BYTES=1073741824/);
  assert.match(env, /OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES=10000/);
  assert.match(env, /OPEN_SCIENCE_MAX_LOG_FILE_BYTES=10485760/);
  assert.match(env, /OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES=1048576/);
  assert.match(env, /OPEN_SCIENCE_KERNEL_TIMEOUT_MS=10000/);
  assert.match(env, /OPEN_SCIENCE_MAX_CONCURRENT_TASKS_PER_PROJECT=1/);
  assert.match(env, /OPEN_SCIENCE_MAX_QUEUED_TASKS=100/);
  assert.match(env, /OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT=25/);
  assert.match(env, /OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS=64/);
  assert.match(env, /OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT=8/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS=120000/);
  assert.match(env, /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES=8/);
  assert.match(env, /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER=4/);
  assert.match(env, /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS=2/);
  assert.match(env, /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER=1/);
  assert.match(env, /# NODE_ENV=development/);
  assert.match(env, /OPEN_SCIENCE_RUNTIME_MODE=mock/);
  assert.match(env, /OPEN_SCIENCE_ALLOW_MOCK_RUNTIME=true/);
});

test("monitoring compose pins components, keeps consoles local, and shares file-backed secrets", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.monitoring.yml"), "utf8");
  assert.match(compose, /prom\/prometheus:\$\{OPEN_SCIENCE_PROMETHEUS_VERSION:-v3\.13\.0\}/);
  assert.match(compose, /prom\/blackbox-exporter:\$\{OPEN_SCIENCE_BLACKBOX_EXPORTER_VERSION:-v0\.28\.0\}/);
  assert.match(compose, /prom\/alertmanager:\$\{OPEN_SCIENCE_ALERTMANAGER_VERSION:-v0\.33\.1\}/);
  assert.match(compose, /grafana\/grafana:\$\{OPEN_SCIENCE_GRAFANA_VERSION:-13\.1\.0\}/);
  assert.match(compose, /OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE:\s+\/run\/secrets\/operator_metrics_token/);
  assert.match(compose, /prometheus_operator_metrics_token:\s*\n\s+file:.*prometheus-operator-metrics-token\.txt/);
  assert.match(compose, /GF_SECURITY_ADMIN_PASSWORD__FILE:\s+\/run\/secrets\/grafana_admin_password/);
  assert.match(compose, /--config\.file=\/run\/secrets\/alertmanager_config/);
  assert.match(compose, /127\.0\.0\.1:\$\{OPEN_SCIENCE_PROMETHEUS_PORT:-9090\}:9090/);
  assert.match(compose, /127\.0\.0\.1:\$\{OPEN_SCIENCE_ALERTMANAGER_PORT:-9093\}:9093/);
  assert.match(compose, /127\.0\.0\.1:\$\{OPEN_SCIENCE_GRAFANA_PORT:-3000\}:3000/);
  assert.match(compose, /--storage\.tsdb\.retention\.time=\$\{OPEN_SCIENCE_PROMETHEUS_RETENTION_TIME:-30d\}/);
  assert.match(compose, /--storage\.tsdb\.retention\.size=\$\{OPEN_SCIENCE_PROMETHEUS_RETENTION_SIZE:-10GB\}/);
});

test("monitoring configs scrape protected metrics, probe health/readiness, alert, and provision a dashboard", async () => {
  const monitoringDir = path.join(repoRoot, "deploy/web/monitoring");
  const prometheus = JSON.parse(await readFile(path.join(monitoringDir, "prometheus.json"), "utf8"));
  const blackbox = JSON.parse(await readFile(path.join(monitoringDir, "blackbox.json"), "utf8"));
  const rules = JSON.parse(await readFile(path.join(monitoringDir, "open-science.rules.json"), "utf8"));
  const datasource = JSON.parse(
    await readFile(path.join(monitoringDir, "grafana/provisioning/datasources/prometheus.json"), "utf8"),
  );
  const provider = JSON.parse(
    await readFile(path.join(monitoringDir, "grafana/provisioning/dashboards/open-science.json"), "utf8"),
  );
  const dashboard = JSON.parse(
    await readFile(path.join(monitoringDir, "grafana/dashboards/open-science-operations.json"), "utf8"),
  );

  const jobs = new Map(prometheus.scrape_configs.map((job) => [job.job_name, job]));
  assert.equal(jobs.get("open-science-web").metrics_path, "/api/ops/metrics");
  assert.equal(jobs.get("open-science-web").authorization.credentials_file, "/run/secrets/operator_metrics_token");
  assert.deepEqual(jobs.get("open-science-web").static_configs[0].targets, ["open-science-web:8787"]);
  assert.deepEqual(jobs.get("open-science-health").static_configs[0].targets, [
    "http://open-science-web:8787/api/health",
  ]);
  assert.deepEqual(jobs.get("open-science-readiness").static_configs[0].targets, [
    "http://open-science-web:8787/api/ready",
  ]);
  assert.equal(blackbox.modules.http_2xx.http.follow_redirects, false);

  const alerts = rules.groups.flatMap((group) => group.rules);
  const names = alerts.map((rule) => rule.alert);
  assert.equal(new Set(names).size, names.length);
  for (const required of [
    "OpenScienceApiMetricsUnavailable",
    "OpenScienceHealthProbeFailed",
    "OpenScienceReadinessProbeFailed",
    "OpenScienceApiServerErrors",
    "OpenScienceTaskQueueNearCapacity",
    "OpenScienceRuntimeQuotaMonitorGap",
  ]) {
    assert.equal(names.includes(required), true, `missing alert ${required}`);
  }
  assert.equal(alerts.every((rule) => rule.for && rule.labels?.severity && rule.annotations?.summary), true);

  assert.equal(datasource.datasources[0].uid, "prometheus");
  assert.equal(datasource.datasources[0].editable, false);
  assert.equal(provider.providers[0].options.path, "/var/lib/grafana/dashboards");
  assert.equal(dashboard.uid, "open-science-operations");
  assert.equal(dashboard.refresh, "15s");
  const expressions = dashboard.panels.flatMap((panel) => panel.targets ?? []).map((target) => target.expr);
  assert.equal(expressions.some((expr) => expr.includes("open_science_http_requests_total")), true);
  assert.equal(expressions.some((expr) => expr.includes("open_science_http_request_duration_seconds_bucket")), true);
  assert.equal(expressions.some((expr) => expr.includes("open_science_readiness_check")), true);
});

test("root package exposes the deployment smoke test script", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["smoke:deployment"], /scripts\/ops\/deployment-smoke\.mjs/);
  assert.match(pkg.scripts["preflight:host"], /scripts\/ops\/host-preflight\.mjs/);
  assert.match(pkg.scripts["migrate:data"], /scripts\/ops\/migrate-data-dir\.sh/);
  assert.match(pkg.scripts["configure:monitoring"], /scripts\/ops\/configure-monitoring\.mjs/);
  assert.match(pkg.scripts["check:monitoring"], /configure-monitoring\.mjs --check/);
  assert.match(pkg.scripts["probe:monitoring"], /configure-monitoring\.mjs --probe/);
  assert.match(pkg.scripts["configure:oidc"], /scripts\/ops\/configure-oidc\.mjs/);
  assert.match(pkg.scripts["check:oidc"], /configure-oidc\.mjs --check/);
  assert.match(pkg.scripts["configure:local-auth"], /scripts\/ops\/configure-local-auth\.mjs/);
  assert.match(pkg.scripts["check:local-auth"], /configure-local-auth\.mjs --check/);
  assert.match(pkg.scripts["configure:production-state"], /scripts\/ops\/configure-production-state\.mjs/);
  assert.match(pkg.scripts["check:production-state"], /configure-production-state\.mjs --check/);
  assert.match(pkg.scripts["release:manifest"], /scripts\/ops\/generate-release-manifest\.mjs/);
  assert.match(pkg.scripts["check:release-manifest"], /generate-release-manifest\.mjs --check/);
  assert.match(pkg.scripts["verify:release-manifest"], /generate-release-manifest\.mjs --check --verify-images/);
  assert.match(pkg.scripts["backup:object"], /object-backup\.mjs upload/);
  assert.match(pkg.scripts["restore:object"], /object-backup\.mjs download/);
  assert.match(pkg.scripts["probe:object"], /object-backup\.mjs probe/);
  assert.match(pkg.scripts["audit:dependencies"], /pnpm audit --prod --audit-level moderate/);
  assert.match(pkg.scripts["audit:saas-alignment"], /scripts\/ops\/audit-saas-alignment\.mjs/);
  assert.match(pkg.scripts["ci:web"], /pnpm audit:saas-alignment/);
  assert.match(pkg.scripts["ci:web"], /pnpm audit:dependencies/);
});

test("release workflows enforce source credential and quality gates before packaging", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const buildWorkflow = await readFile(path.join(repoRoot, ".github/workflows/build.yml"), "utf8");

  assert.equal(packageJson.scripts["audit:source-secrets"], "node scripts/ops/audit-source-secrets.mjs");
  assert.match(packageJson.scripts["ci:web"], /audit:source-secrets/);
  assert.match(buildWorkflow, /quality:/);
  assert.match(buildWorkflow, /build:\n\s+needs: quality/);
  assert.match(buildWorkflow, /pnpm ci:web/);
  assert.match(buildWorkflow, /pnpm check:tauri/);
});

test("Hosted E2E targets a real deployed release while the mock flow is labeled as a contract test", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const serverPackage = JSON.parse(await readFile(path.join(repoRoot, "apps/server/package.json"), "utf8"));
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/web.yml"), "utf8");
  const script = await readFile(path.join(repoRoot, "scripts/ops/hosted-production-e2e.mjs"), "utf8");
  assert.match(serverPackage.scripts["test:contract"], /hosted-web\.e2e\.test\.mjs/);
  assert.match(serverPackage.scripts["test:e2e"], /hosted-production-e2e\.mjs/);
  assert.match(rootPackage.scripts["test:web:e2e"], /@ai4s\/server test:e2e/);
  assert.doesNotMatch(rootPackage.scripts["ci:web"], /test:web:e2e/);
  assert.match(workflow, /Test mock hosted API contract[\s\S]*test:contract/);
  assert.match(workflow, /hosted-production-e2e:/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /OPEN_SCIENCE_E2E_BASE_URL: \$\{\{ secrets\.OPEN_SCIENCE_E2E_BASE_URL \}\}/);
  assert.match(workflow, /run: pnpm test:web:e2e/);
  assert.doesNotMatch(workflow, /Test Hosted Web E2E/);
  // The runtime proof used to be a single negative -- "not the retired kernel"
  // -- which a deployment running no kernel at all would also satisfy. The
  // script now names what it requires instead, as two separate claims: a
  // sandboxed Docker runtime, and that the runtime is DSH. Both are listed
  // because a deployment can satisfy one without the other.
  for (const proof of [
    'checks.runtime?.mode !== "kernel"',
    'checks.runtime?.kernel !== "dsh"',
    'checks.stateStore?.mode !== "postgres"',
    'checks.memory?.connected !== true',
    // The model is named by the deployment, not by this list: the receipt
    // certifies whichever certified model actually answered, and the pilot
    // serves `deepseek-v4-flash`. Both proofs are still here — the gateway must
    // serve a certified model, and the ledger must show the run went through
    // DeepSeek — stated against that value instead of one of its members.
    'supportedDeepSeekModels.has(String(checks.modelGateway?.model ?? ""))',
    'checks.runtime?.sandboxMode !== "docker"',
    'run.runtimeAgent !== "evimed-adr-analysis"',
    'run.model !== `deepseek/${certifiedModel}`',
    'agent.requiredInputs?.includes("drug")',
    'run.artifacts?.includes(requiredPath)',
    'item.kind === "preference"',
    'memoryRecord.evidenceCount < 1',
    'language: "python"',
    'language: "r"',
  ]) assert.equal(script.includes(proof), true, `Hosted E2E is missing proof: ${proof}`);
  assert.equal(script.includes("mock-agent-artifact.md"), false);
});

test("Web CI includes a Linux Docker Compose release and real runtime smoke job", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/web.yml"), "utf8");
  assert.match(workflow, /docker-hosted:/);
  assert.match(workflow, /runs-on:\s+ubuntu-22\.04/);
  assert.match(workflow, /run:\s+pnpm audit:dependencies/);
  assert.match(workflow, /--profile runtime-image build/);
  assert.match(workflow, /pnpm release:manifest/);
  assert.match(workflow, /pnpm verify:release-manifest/);
  assert.match(workflow, /pnpm configure:monitoring/);
  assert.match(workflow, /pnpm configure:backup/);
  assert.match(workflow, /pnpm check:backup/);
  assert.match(workflow, /pnpm configure:local-auth/);
  assert.match(workflow, /docker-compose\.local-auth\.yml/);
  assert.equal(/OPEN_SCIENCE_BOOTSTRAP_PASSWORD=ci-/.test(workflow), false);
  assert.match(workflow, /docker pull "caddy:\$\{OPEN_SCIENCE_CADDY_VERSION\}"/);
  assert.match(workflow, /pnpm preflight:host --env-file deploy\/web\/\.env\.ci/);
  assert.match(workflow, /test\/deepseekCompatibility\.test\.mjs/);
  assert.match(workflow, /OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY=false/);
  assert.match(workflow, /OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE=false/);
  assert.match(workflow, /OPEN_SCIENCE_TRUST_PROXY=true/);
  assert.match(workflow, /OPEN_SCIENCE_DOCKER_SOCKET_GID=\$\(stat -c '%g' \/var\/run\/docker\.sock\)/);
  assert.match(workflow, /OPEN_SCIENCE_DOCKER_SOCKET_GID=\$\{OPEN_SCIENCE_DOCKER_SOCKET_GID\}/);
  assert.match(workflow, /chmod 600 deploy\/web\/\.env\.ci/);
  assert.match(workflow, /docker-compose\.backup\.yml/);
  assert.match(workflow, /--profile backup/);
  assert.match(workflow, /Verify runtime binaries and preserved licenses/);
  assert.match(workflow, /docker run --rm --network none/);
  assert.match(workflow, /\/usr\/share\/licenses\/uv\/LICENSE-MIT/);
  // The kernel arrives as an npm global rather than as a fetched binary, so what
  // CI can check is that the launcher resolves at the pinned version and that
  // the profile the image pre-composed survived the build — an image whose
  // profile failed to compose starts fine and then answers nothing.
  // One image name, and it is the one the server reads: `config.mjs` resolves
  // `runtimeContainerImage` from OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE and
  // nothing else. A second name meant CI proved one image and started another.
  assert.match(workflow, /docker run --rm --network none\s+"\$\{OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE\}"/);
  assert.equal(
    workflow.includes("OPEN_SCIENCE_DSH_RUNTIME_CONTAINER_IMAGE"),
    false,
    "a second runtime image name is a build CI verifies and never launches",
  );
  assert.match(workflow, /dump-config\.baseline\.json/);
  assert.match(workflow, /dsh --version/);
  assert.match(workflow, /--profile backup --profile monitoring --profile tls up -d/);
  assert.match(workflow, /OPEN_SCIENCE_PUBLIC_URL=https:\/\/localhost/);
  assert.match(workflow, /OPEN_SCIENCE_DOMAIN=localhost/);
  assert.match(workflow, /curl -kfsS https:\/\/localhost\/api\/ready/);
  assert.match(workflow, /caddy:\/data\/caddy\/pki\/authorities\/local\/root\.crt/);
  assert.match(workflow, /NODE_EXTRA_CA_CERTS=\/tmp\/open-science-caddy-root\.crt pnpm preflight:host --env-file deploy\/web\/\.env\.ci --online/);
  assert.match(workflow, /OPEN_SCIENCE_RUNTIME_TRANSPORT=unix/);
  assert.match(workflow, /OPEN_SCIENCE_RUNTIME_NETWORK_MODE=open-science-runtime-internal/);
  assert.match(workflow, /OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME=open-science-runtime-internal/);
  assert.match(workflow, /OPEN_SCIENCE_ENABLE_KERNEL=true/);
  assert.match(workflow, /OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker/);
  assert.match(workflow, /Verify Docker socket privilege boundary/);
  assert.match(workflow, /Web API container must not mount \/var\/run\/docker\.sock/);
  assert.match(workflow, /Web API controller mount must be read-only/);
  assert.match(workflow, /\.HostConfig\.GroupAdd/);
  assert.match(workflow, /grep -Fx "\$OPEN_SCIENCE_DOCKER_SOCKET_GID"/);
  assert.match(workflow, /Backup container must not mount \/var\/run\/docker\.sock/);
  assert.match(workflow, /\.Destination \"\/backups\".*\.RW/);
  assert.match(workflow, /\.Destination \"\/data\".*\.RW/);
  assert.match(workflow, /endsWith\('\.tar\.gz\.enc'\)/);
  assert.match(workflow, /\.Destination \"\/run\/open-science-controller\".*\.RW/);
  assert.match(workflow, /ps -q open-science-runtime-controller/);
  assert.equal(workflow.includes("OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true"), false);
  assert.match(workflow, /OPEN_SCIENCE_SMOKE_BASE_URL:\s+https:\/\/localhost/);
  assert.equal(workflow.includes("OPEN_SCIENCE_SMOKE_ALLOW_HTTP"), false);
  assert.match(workflow, /OPEN_SCIENCE_SMOKE_RUNTIME:\s+"true"/);
  assert.match(workflow, /OPEN_SCIENCE_SMOKE_RUNTIME_PROMPT:\s+"false"/);
  assert.match(workflow, /OPEN_SCIENCE_SMOKE_KERNEL:\s+"true"/);
  assert.match(workflow, /OPEN_SCIENCE_SMOKE_REQUIRE_DOCKER_KERNEL:\s+"true"/);
  assert.match(workflow, /docker ps -aq --filter label=open-science\.web\.runtime=true/);
  assert.match(workflow, /docker ps -aq --filter label=open-science\.web\.kernel=true/);
  assert.match(workflow, /--profile backup --profile monitoring --profile tls down -v --remove-orphans/);
  assert.equal(workflow.includes("open-science-opencode:latest"), false);
});

// A scheduler that threw past its failure threshold exited, the container
// restarted it, it read the count back, exceeded the threshold again, and took
// a full backup on the way. The circuit breaker was a backup every two minutes:
// eight 403 MB archives inside a quarter of an hour, until the disk filled and
// the filling was itself the failure being retried.
test("the backup scheduler stops retrying past its failure threshold instead of exiting", async () => {
  const source = await readFile(path.join(repoRoot, "OpenScience/scripts/ops/backup-scheduler.mjs"), "utf8")
    .catch(() => readFile(path.join(repoRoot, "scripts/ops/backup-scheduler.mjs"), "utf8"));
  const loop = source.slice(source.indexOf("while (!stopping)"), source.indexOf("for (const signal of"));
  assert.doesNotMatch(
    loop,
    /consecutiveFailures >= config\.maxFailures\) throw/,
    "exiting on the threshold makes the restart policy retry it",
  );
  assert.match(loop, /backup\.circuit_open/, "an open circuit is announced");
  assert.match(loop, /exhausted \? config\.intervalSeconds : config\.retrySeconds/, "an open circuit waits the full interval");
});

// Age alone does not bound a directory: every archive written during a retry
// storm is younger than the retention window, so nothing is eligible while the
// disk fills.
test("backup retention bounds the archive count, not only their age", async () => {
  const retention = path.join(repoRoot, "OpenScience/scripts/ops/backup-retention.mjs");
  const file = existsSync(retention) ? retention : path.join(repoRoot, "scripts/ops/backup-retention.mjs");
  const { mkdtemp, writeFile: write, utimes, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "os-backup-retention-"));
  // Twenty archives, all written now — none older than any sane window.
  for (let i = 0; i < 20; i += 1) {
    const stamp = `2026081${Math.floor(i / 10)}T${String(i).padStart(2, "0")}0000Z`;
    const name = path.join(dir, `open-science-data-${stamp}.tar.gz.enc`);
    await write(name, "archive", "utf8");
    await write(`${name}.sha256`, "hash", "utf8");
    const when = new Date(Date.now() - i * 60_000);
    await utimes(name, when, when);
  }
  execFileSync(process.execPath, [file, "prune", dir, "30"], { encoding: "utf8" });
  const left = (await readdir(dir)).filter((name) => name.endsWith(".enc"));
  assert.ok(left.length <= 14, `retention left ${left.length} archives, none of them old enough to expire`);
  assert.ok(left.length > 0, "retention must not empty the directory");
});

// The agent runtime image has to be buildable by the deploy stack, and it has
// to be built under the one image name the control plane launches. The DSH
// image existed for a while with nothing in the deploy stack referencing it;
// then it was referenced under a second variable while the retired kernel's
// service held OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE, which is the only name
// `config.mjs` resolves `runtimeContainerImage` from. CI therefore built the
// retired kernel under the launched name, verified the DSH image under the
// other name, and started neither of the two it had proven.
test("the runtime-image profile builds exactly one image, under the name the server launches", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const services = compose.split(/\n {2}(?=[a-z])/);
  const inProfile = services
    .filter((block) => /^[a-z][\w.-]*:/.test(block) && /\n {4}profiles: \["runtime-image"\]/.test(block))
    .map((block) => block.slice(0, block.indexOf(":")));
  assert.deepEqual(inProfile, ["dsh-runtime-image"], "one kernel ships, so one service may answer to --profile runtime-image");

  const block = services.find((item) => item.startsWith("dsh-runtime-image:"));
  assert.match(
    block,
    /image: \$\{OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE:-/,
    "the built image must carry the name config.mjs resolves runtimeContainerImage from",
  );
  assert.match(block, /dockerfile: deploy\/runtime-dsh\/Dockerfile/);
  assert.match(block, /DSH_VERSION: \$\{OPEN_SCIENCE_DSH_VERSION/);

  // And the pinned version comes from the one place versions are written.
  const pins = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
  assert.match(compose, new RegExp(`OPEN_SCIENCE_DSH_VERSION:-${pins.dsh.version.replace(/\./g, "\\.")}`));
});

// The build actually has to run, not merely reference plausible-looking paths.
// Every `COPY <src> ...` naming a path inside the repository (as opposed to a
// path produced earlier in the same build stage) has to exist on disk before
// `docker build` starts, or the build fails on that line. Two of these
// (`deploy/runtime-dsh/socket`, `deploy/runtime-dsh/capability-skills`) never
// existed — the real sources are `packages/socket` and `capability-skills` at
// the repo root — so the image could never have been built.
test("every COPY source the DSH runtime Dockerfile names exists in the repository", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const copies = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+$/gm)].map((match) => match[1]);
  assert.ok(copies.length >= 5, `only found ${copies.length} COPY instructions; the extraction pattern has drifted`);
  for (const source of copies) {
    // `deploy/runtime-dsh/capabilities` is the one committed exception: a
    // compiled artifact (`capability.yaml` → JSON), not a source directory, so
    // its absence on a machine that never ran `pnpm build:capabilities` is not
    // this test's concern.
    if (source === "deploy/runtime-dsh/capabilities") continue;
    const stat = await lstat(path.join(repoRoot, source)).catch(() => null);
    assert.ok(stat, `COPY source "${source}" does not exist in the repository`);
  }
  // And the two sources that were missing are now the real ones, by name —
  // catching a COPY line that resolves to *something* but the wrong something
  // (e.g. pointed back at an empty deploy/runtime-dsh/socket someone created
  // to silence the check above) is what this half asserts.
  assert.match(dockerfile, /^COPY packages\/socket \/opt\/evimed\/socket$/m);
  assert.match(dockerfile, /^COPY capability-skills \/opt\/evimed\/capability-skills$/m);
});

// G-class bug, confirmed by construction rather than by inspection: `/runtime`
// is bind-mounted per project at container start (session logs belong on that
// project's own volume), and a bind mount replaces everything under its
// target. A profile pre-installed at build time under `/runtime/dsh-home` —
// the same path the running container is later told to use — would be built,
// baked into the image, and then be invisible to every container that ever
// actually starts: DSH would reinitialize (and re-fetch its plugins over the
// network) on every single boot, silently defeating the entire point of
// pre-initializing anything.
test("the profile is pre-initialized outside the path the runtime volume mounts over", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const seedMatch = dockerfile.match(/^ENV DSH_HOME_SEED=(\S+)$/m);
  assert.ok(seedMatch, "the build-time profile must be initialized at a seed path distinct from the runtime DSH_HOME");
  const seedPath = seedMatch[1];
  assert.equal(seedPath.startsWith("/runtime"), false, `DSH_HOME_SEED (${seedPath}) is under /runtime and would be shadowed by the runtime volume mount, same as the bug this test exists to catch`);

  const runtimeMatch = dockerfile.match(/^ENV DSH_HOME=(\S+)$/m);
  assert.ok(runtimeMatch);
  const runtimeDshHomeModule = await import("../src/runtimeManager.mjs");
  assert.equal(runtimeMatch[1], runtimeDshHomeModule.runtimeDshHome, "the image's runtime DSH_HOME must match what the control plane sets with --env at container start");

  // The plugin install and dump-config baseline must run against the seed
  // path, not the runtime path — otherwise this test's own premise (the
  // profile is built at a path the volume mount cannot shadow) is false.
  assert.match(dockerfile, /DSH_HOME="\$\{DSH_HOME_SEED\}" dsh plugin --profile evimed-runtime add/);
  assert.match(dockerfile, /DSH_HOME="\$\{DSH_HOME_SEED\}" dsh --profile evimed-runtime --dump-config/);

  // And the entrypoint has to actually move it into place before dsh starts:
  // pre-initializing a profile nothing ever copies out of the seed is the same
  // failure by a different route.
  const entrypoint = await readFile(path.join(repoRoot, "deploy/runtime-dsh/open-science-dsh-serve.sh"), "utf8");
  assert.match(entrypoint, /DSH_HOME_SEED/);
  assert.match(entrypoint, /cp -a "\$\{DSH_HOME_SEED\}\/\." "\$\{DSH_HOME\}\/"/);
  // Idempotent: a restarted or resumed project must not re-copy over a profile
  // it (or a prior boot) already wrote to, which could silently discard
  // whatever the control plane's own profile patch had already laid down.
  assert.match(entrypoint, /\[ ! -d "\$\{DSH_HOME\}\/profiles\/\$\{profile\}" \]/);
});

// Confirmed against a real installed `dsh` binary: `--patch` is a *launcher*
// flag, resolved before the web app's own arguments begin — `dsh --profile web
// --no-open --port 0 --patch x.yml` answers "error: unknown option '--patch'"
// and exits, because by the time the parser reaches it the app's own flags
// have already started. `dsh --profile web --patch x.yml --no-open --port 0`
// is the only ordering that boots. A container that got this wrong would fail
// this exact way on every single start.
test("the entrypoint places --patch before the web app's own arguments", async () => {
  const entrypoint = await readFile(path.join(repoRoot, "deploy/runtime-dsh/open-science-dsh-serve.sh"), "utf8");
  const invocation = entrypoint.split("\n").find((line) => line.trimStart().startsWith("dsh --profile"));
  assert.ok(invocation, "the serve script must launch the kernel");
  const patchIndex = invocation.indexOf("${patch_args[@]}");
  const noOpenIndex = invocation.indexOf("--no-open");
  assert.ok(patchIndex >= 0, "the launcher-level --patch must be assembled and passed");
  assert.ok(noOpenIndex >= 0);
  assert.ok(patchIndex < noOpenIndex, "--patch (a launcher flag) must precede --no-open (the web app's own flag)");

  // And it is conditional: a deployment with the DeepSeek provider disabled
  // never has `syncRuntimeDshProfile` write a patch file, so the entrypoint
  // must not hand `dsh` a `--patch` pointed at a file that was never written.
  assert.match(entrypoint, /\[ -f "\$\{patch_file\}" \]/);
});

test("every capability's skill bodies are shipped, because delegation injects them rather than loading them", async () => {
  // `skillsLoaded` is answerable by construction only if the bodies exist to be
  // injected. A capability naming a skill with no body would delegate a child
  // with a "## 方法" section that is silently short — no error, no missing
  // file at runtime, just a child told less than the manifest promised, and a
  // completion check that now accepts the injection receipt as proof.
  const { readdir } = await import("node:fs/promises");
  const capabilitiesDir = path.join(repoRoot, "capabilities");
  const bodiesDir = path.join(repoRoot, "capability-skills");

  const bodies = new Set((await readdir(bodiesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  const capabilities = (await readdir(capabilitiesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(capabilities.length >= 10, `expected the capability catalogue, found ${capabilities.length}`);

  let checked = 0;
  const missing = [];
  for (const capability of capabilities) {
    const yaml = await readFile(path.join(capabilitiesDir, capability, "capability.yaml"), "utf8").catch(() => null);
    if (yaml === null) continue;
    const block = yaml.match(/^skills:\s*\n((?:\s*-\s*.+\n)+)/m);
    const named = block ? [...block[1].matchAll(/-\s*(\S+)/g)].map((match) => match[1]) : [];
    assert.ok(named.length > 0, `${capability} declares no skills; the manifest requires skills[] for exactly this reason`);
    checked += 1;
    for (const skill of named) if (!bodies.has(skill)) missing.push(`${capability} -> ${skill}`);
  }
  // The sweep must prove it swept: a walk that read nothing reads as a clean
  // catalogue.
  assert.equal(checked, capabilities.length, `only ${checked} of ${capabilities.length} capabilities were read`);
  assert.deepEqual(missing, [], "a capability naming a body that does not ship delegates a child told less than promised");

  // And the tree that holds them has to be in the image, or none of this is
  // reachable at runtime.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY capability-skills /m, "the bodies must ship");
});

test("every source tree the runtime image executes is bound by the release manifest", async () => {
  // Two faces of one blind spot, both found on 2026-08-26.
  //
  // `packages/socket`, `packages/domain` and `packages/harness-port` are COPYed
  // into the runtime image and run INSIDE the container. Nothing compared the
  // image's copy against the working tree, so a day of delivery-gate fixes
  // synced with every md5 verified and never ran; and the release manifest
  // bound none of the three, so the release record could not say which code the
  // image contained either. It bound `deploy/runtime-opencode/Dockerfile` — the
  // kernel on its way out — and not `deploy/runtime-dsh`.
  //
  // Derived from the Dockerfile's own COPY lines rather than listed here: the
  // point is that adding a tree to the image and forgetting the manifest has to
  // fail.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const generator = await readFile(path.join(repoRoot, "scripts/ops/generate-release-manifest.mjs"), "utf8");

  const copied = [...dockerfile.matchAll(/^COPY\s+(packages\/[\w.-]+)\s/gm)].map((match) => match[1]);
  assert.ok(copied.length >= 3, `expected the image to copy several packages, found ${JSON.stringify(copied)}`);

  const bound = new Set([...generator.matchAll(/^\s*"([^"]+)",/gm)].map((match) => match[1]));
  const unbound = [...new Set(copied)].filter((tree) => !bound.has(tree)).sort();
  assert.deepEqual(unbound, [], "the release cannot say which code these run");

  // The image's own build definition is part of what a release ships.
  assert.ok(bound.has("deploy/runtime-dsh"), "the runtime image's build definition must be bound");

  // Negative control: the check must be able to fail. A tree the image does not
  // copy is not required to be bound.
  assert.equal(bound.has("packages/not-a-real-package"), false);
});

// --- check:runtime-image ------------------------------------------------
//
// This check exists because a day of delivery-gate fixes synced, verified, and
// never ran: the gate executes inside the container and the image predated
// them. Its first version then had the mirror-image defect — it called every
// image stale, because `packages/socket` ships 20 files and the built image has
// 175 under the same path (the Dockerfile `cp -a`s the skill tree in there).
// Both failures look identical from the outside, so both get a control here.

test("the image carrying more files than the tree ships is not staleness", async () => {
  const { differingFiles } = await import(
    pathToFileURL(path.join(repoRoot, "scripts/ops/check-runtime-image-current.mjs")).href
  );
  const here = new Map([["index.mjs", "a".repeat(64)], ["src/run.mjs", "b".repeat(64)]]);
  const there = new Map([
    ...here,
    // What the build lands there and the tree never had.
    ["presets/evimed-universal/skills/core/deep-research/SKILL.md", "c".repeat(64)],
  ]);

  assert.deepEqual(differingFiles(here, there), []);
});

test("a shipped file the image does not have, or has differently, is staleness", async () => {
  const { differingFiles } = await import(
    pathToFileURL(path.join(repoRoot, "scripts/ops/check-runtime-image-current.mjs")).href
  );
  const here = new Map([["index.mjs", "a".repeat(64)], ["src/run.mjs", "b".repeat(64)], ["src/gate.mjs", "c".repeat(64)]]);
  const there = new Map([["index.mjs", "a".repeat(64)], ["src/run.mjs", "d".repeat(64)], ["src/gate.mjs", "MISSING"]]);

  assert.deepEqual(differingFiles(here, there).sort(), ["src/gate.mjs", "src/run.mjs"]);
});

/** A stand-in `docker` that replies with whatever `body` makes of the script it
 *  is given on stdin, so the reader is exercised for real rather than mocked. */
async function withFakeDocker(body, run) {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "fake-docker-"));
  const bin = path.join(dir, "docker");
  await writeFile(bin, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(bin, 0o755);
  try {
    return await run(bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an image that answers about fewer files than it was asked about is an error, not a pass", async () => {
  const modulePath = path.join(repoRoot, "scripts/ops/check-runtime-image-current.mjs");
  const asked = ["index.mjs", "src/run.mjs", "src/gate.mjs"];

  const answers = await withFakeDocker(
    // Replies for the first two paths only — the shape a truncated read takes.
    `cat > /dev/null; echo "${"a".repeat(64)} index.mjs"; echo "${"b".repeat(64)} src/run.mjs"`,
    async (bin) => {
      const source = `import { hashInsideImage } from ${JSON.stringify(pathToFileURL(modulePath).href)};`
        + `process.stdout.write(JSON.stringify(hashInsideImage("/opt/evimed/socket", ${JSON.stringify(asked)})));`;
      return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
        encoding: "utf8",
        env: { ...process.env, OPEN_SCIENCE_RUNTIME_CONTAINER_BIN: bin, OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE: "fake:test" },
      });
    },
  );

  const parsed = JSON.parse(answers);
  assert.equal(parsed.hashes, undefined, "a partial answer must not be handed back as if it were complete");
  assert.match(parsed.error, /answered for 2 of 3 files/);
  assert.match(parsed.error, /src\/gate\.mjs/);
});

test("the reader asks the image about every shipped path, and reports the ones it lacks", async () => {
  const modulePath = path.join(repoRoot, "scripts/ops/check-runtime-image-current.mjs");
  const asked = ["index.mjs", "src/gate.mjs"];
  const helloSha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

  // A real `sh` running the real script against a directory holding only one of
  // the two files: proof the MISSING branch is produced by the shipped script,
  // not by the test describing what it hopes the script does.
  const answers = await withFakeDocker(
    'script=$(cat); root=$(mktemp -d); mkdir -p "$root/src"; printf "hello" > "$root/index.mjs";'
    + ' printf "%s\\n" "$script" | sed "s#^cd \\"/opt/evimed/socket\\"#cd \\"$root\\"#" | sh',
    async (bin) => {
      const source = `import { hashInsideImage } from ${JSON.stringify(pathToFileURL(modulePath).href)};`
        + `const r = hashInsideImage("/opt/evimed/socket", ${JSON.stringify(asked)});`
        + `process.stdout.write(JSON.stringify(r.hashes ? [...r.hashes] : { error: r.error ?? "no hashes and no error" }));`;
      return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
        encoding: "utf8",
        env: { ...process.env, OPEN_SCIENCE_RUNTIME_CONTAINER_BIN: bin, OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE: "fake:test" },
      });
    },
  );

  assert.deepEqual(new Map(JSON.parse(answers)), new Map([["index.mjs", helloSha], ["src/gate.mjs", "MISSING"]]));
});

test("every agent whose completion requires a loaded skill can actually reach that skill in the DSH image", async () => {
  // `open-domain-answer` is the default line for an unrouted question. Its
  // agent.yaml requires `skillsLoaded`, but its skill body lived only in
  // `runtime/skills/evimed`, which the DSH Dockerfile did not COPY, and it is
  // not a delegated capability so nothing ever injected it either. The check
  // therefore failed on every DSH open-domain run and the reply was stamped
  // "The open-domain-answer skill was not loaded in this turn" — a deployment
  // fault rendered to the reader as doubt about the answer.
  //
  // Derived from the manifests rather than a list, so the next agent added with
  // `skillsLoaded` and no delivery route fails here instead of in production.
  const { readdir } = await import("node:fs/promises");
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const copiedSources = dockerfile
    .split("\n")
    .filter((line) => /^COPY\s/.test(line))
    .map((line) => splitDockerWords(line)[1])
    .filter(Boolean);

  const agentDirs = await readdir(path.join(repoRoot, "runtime/skills/evimed"), { withFileTypes: true });
  let checked = 0;
  for (const entry of agentDirs) {
    if (!entry.isDirectory()) continue;
    const manifest = await readFile(
      path.join(repoRoot, "runtime/skills/evimed", entry.name, "agent.yaml"),
      "utf8",
    ).catch(() => null);
    if (!manifest || !/^\s*-\s*skillsLoaded\s*$/m.test(manifest)) continue;
    const skill = manifest.match(/^skill:\s*(\S+)\s*$/m)?.[1];
    assert.ok(skill, `${entry.name}/agent.yaml requires skillsLoaded but names no skill`);
    checked += 1;

    // Two routes exist and either is sufficient: delegation injects a
    // capability body, or the kernel reads it from a shipped preset root.
    const injected = existsSync(path.join(repoRoot, "capability-skills", skill));
    const shipped = copiedSources.some((source) => source === `runtime/skills/evimed/${skill}`);
    assert.ok(
      injected || shipped,
      `${skill} requires skillsLoaded, but it is neither a capability body under capability-skills/`
      + ` nor COPYed into the runtime image — so the check can never pass on DSH`,
    );
  }
  assert.ok(checked >= 4, `expected to check several agents, checked ${checked} — the walk found nothing`);
});

test("the skill's list of artifact-preserving tools matches the tools that actually preserve", async () => {
  // The skill told runs that "only two tools preserve an artifact you may
  // cite". That was true when it was written and false the moment the EviMed
  // guideline connector started writing one: the file landed on disk and
  // nothing told the model it could be cited, so a run following its
  // instructions would still refuse to bind a claim to a guideline it had
  // preserved.
  //
  // Derived from the connectors, not from a list here, so the next tool that
  // starts preserving fails this instead of silently going unused.
  const { readdir } = await import("node:fs/promises");
  const mcpDir = path.join(repoRoot, "runtime/mcp/evimed-research");
  const preserving = [];
  for (const entry of await readdir(mcpDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
    const source = await readFile(path.join(mcpDir, entry.name), "utf8");
    // A module preserves when it builds a path under .evimed-sources AND
    // writes to it. Naming the directory in a comment is not preserving.
    if (/["']\.evimed-sources["']/.test(source) && /_atomic_write\s*\(/.test(source)) {
      preserving.push(entry.name);
    }
  }
  assert.ok(preserving.length >= 2, `expected the preserving modules, found ${preserving.join(", ") || "none"}`);

  const skill = await readFile(
    path.join(repoRoot, "runtime/skills/evimed/clinical-evidence-synthesis/SKILL.md"),
    "utf8",
  );
  const claimed = /\b(?:Only\s+)?(two|three|four|five)\s+tools preserve an artifact/i.exec(skill);
  assert.ok(claimed, "the skill must state how many tools preserve an artifact");
  const words = { two: 2, three: 3, four: 4, five: 5 };

  assert.equal(
    words[claimed[1].toLowerCase()],
    preserving.length,
    `the skill says ${claimed[1]} tools preserve, but ${preserving.length} modules do: ${preserving.join(", ")}`,
  );
});

test("a capability's two skill copies never drift apart by more than their known kernel differences", async () => {
  // Eleven capabilities ship their SKILL.md twice: `runtime/skills/evimed/<id>/`
  // for the OpenCode rollback kernel and `capability-skills/<id>/` for DSH,
  // which prefixes every MCP tool name with `mcp__evimed__`. The vocabulary
  // rewriter keeps the NAMES in step and edits each tree in place — it never
  // copies one to the other — so prose can diverge silently while
  // `check:skill-vocabulary` still reports "up to date".
  //
  // It did. A correction written into the runtime copy today never reached the
  // DSH copy, which is the one a delegated run actually reads: that file kept
  // telling every run only two tools preserve an artifact, hours after a third
  // one started to.
  //
  // Some divergence is legitimate — skill-resource paths differ because the
  // kernels mount them differently, and one line has a preflight the other does
  // not. So this pins the SIZE of the divergence per capability rather than
  // demanding none: an edit made to one copy and not the other moves the count,
  // and moving it is what has to be noticed.
  const { readdir } = await import("node:fs/promises");
  const strip = (text) => text.replaceAll("mcp__evimed__", "");
  // Measured 2026-08-27 after syncing the artifact-preservation correction, then
  // raised by 17 on 2026-08-29 when the two fixed pre-delivery steps were added
  // to the DSH bodies — which is where they had to go, because that is the tree
  // the image ships and the tree in which capability packages exist at all.
  // `runtime/skills/evimed/` is the OpenCode rollback kernel and stays untouched
  // by plan (it is deleted at the kernel flip), so this divergence is deliberate
  // and one-directional.
  //
  // Raising an entry means a deliberate kernel-specific edit; a capability
  // absent here must have identical copies.
  // Raised by one on 2026-08-31 when the two DSH trees were merged into one
  // document: the authored copy's fuller revision-notes sentence went into the
  // shipped copy, which the OpenCode tree does not have. Deliberate and
  // one-directional, like the entry above — that tree is deleted at the flip.
  //
  // Lowered on 2026-09-02 by the kernel flip itself, in the other direction:
  // four script invocations in the OpenCode copies still resolved through
  // `$XDG_CONFIG_HOME/opencode/skills/...`, a profile path that no longer
  // exists, and were rewritten to the workspace-relative form the DSH copies
  // already used. clinical-evidence-synthesis 31→30 (verify_preserved.py),
  // dataset-research-scoping 28→26 (profile_dataset.py, preflight.py) and
  // research-topic-selection 28→27 (preflight.py) — one line each, matching
  // the lines changed. Convergence, so the bound gets tighter, not looser.
  const knownDivergence = {
    "adr-analysis": 18,
    "bibliometric-analysis": 18,
    "clinical-evidence-synthesis": 30,
    "comprehensive-drug-evaluation": 18,
    "dataset-research-scoping": 26,
    "drug-selection": 18,
    "mendelian-randomization": 18,
    "meta-analysis": 18,
    "off-label-analysis": 18,
    "peer-review": 18,
    "research-topic-selection": 27,
  };

  const dshRoot = path.join(repoRoot, "capability-skills");
  let checked = 0;
  const wrong = [];
  for (const entry of await readdir(dshRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dshFile = path.join(dshRoot, entry.name, "SKILL.md");
    const openCodeFile = path.join(repoRoot, "runtime/skills/evimed", entry.name, "SKILL.md");
    if (!existsSync(dshFile) || !existsSync(openCodeFile)) continue;
    checked += 1;
    const [dsh, openCode] = await Promise.all([readFile(dshFile, "utf8"), readFile(openCodeFile, "utf8")]);
    // Compared as sets, not line by line: the copies differ in length, and a
    // positional diff then reports every line after the first insertion as
    // changed — 143 false differences where there were 15.
    const dshLines = strip(dsh).split("\n");
    const openCodeLines = new Set(strip(openCode).split("\n"));
    const onlyDsh = dshLines.filter((line) => line.trim() && !openCodeLines.has(line)).length;
    const allowed = knownDivergence[entry.name] ?? 0;
    if (onlyDsh !== allowed) wrong.push(`${entry.name}: ${onlyDsh} DSH-only lines, expected ${allowed}`);
  }

  assert.ok(checked >= 11, `expected both copies of every capability, compared ${checked}`);
  assert.deepEqual(
    wrong,
    [],
    `the two copies drifted: ${wrong.join("; ")} — an edit to one has to be made in both,`
    + " and a deliberate kernel difference has to be recorded in knownDivergence",
  );
});

test("a package that can be typechecked is typechecked by the pipeline", async () => {
  // `packages/socket` and `packages/harness-port` each shipped a `typecheck`
  // script and neither was ever called: `test:web` linted them and stopped
  // there. Between them they had 210 type errors, and among those were four
  // dead `call.agent ?? …` fallbacks — `ToolCall` has no `agent`, so the right
  // branch was always the one taken — plus one live defect where a RETRIED
  // subagent was spawned with `parent: undefined` while the first attempt got a
  // real parent. A whole package outside the type gate is how that survives.
  //
  // The rule is not "every package must have a typecheck script"; it is that a
  // package which HAS one is a package whose author expected it to run.
  const root = new URL("../../../", import.meta.url);
  const rootPackage = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const pipeline = String(rootPackage.scripts?.["test:web"] ?? "");
  assert.ok(pipeline, "test:web is the pipeline this asserts about");

  const packagesDir = new URL("packages/", root);
  const names = (await readdir(packagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(names.length >= 4, `only ${names.length} packages found — the scan did not read the workspace`);

  let checked = 0;
  for (const name of names) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(new URL(`${name}/package.json`, packagesDir), "utf8"));
    } catch {
      continue;
    }
    if (!manifest?.scripts?.typecheck) continue;
    checked += 1;
    // The alias has to run THIS package's typecheck, not merely mention the
    // package. Matching on the name alone passed through `lint:socket`, which
    // is in the pipeline and checks nothing about types — the first version of
    // this test stayed green with `typecheck:socket` deleted from `test:web`,
    // which is the exact failure it was written to prevent.
    const invoked = Object.entries(rootPackage.scripts ?? {})
      .filter(([alias, body]) => (
        pipeline.includes(`pnpm ${alias}`)
        && String(body).includes(manifest.name)
        && /(^|\s)typecheck(\s|$)/.test(String(body))
      ))
      .map(([alias]) => alias);
    assert.ok(
      invoked.length > 0,
      `${manifest.name} has a typecheck script that test:web never runs — add an alias and put it in the pipeline`,
    );
  }
  assert.ok(checked >= 3, `only ${checked} packages declare a typecheck script — the scan found too few to be meaningful`);
});

test("a command the record says we have is a command that exists", async () => {
  // PROGRESS.md said "新增 pnpm check:dsh-upstream" on the day the script was
  // written AND removed — it turned out to duplicate `matrix:upstream`, the
  // removal was right, and the line stayed. A record that names a command
  // nobody can run is worse than no record: the next reader budgets for a tool
  // that is not there, and finds out at the moment they need it.
  //
  // The same shape as the rest of this family, one layer up: a present-tense
  // claim nothing checks. Scripts are a closed set, so this is code's job.
  const root = new URL("../../../", import.meta.url);
  const rootPackage = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const declared = new Set(Object.keys(rootPackage.scripts ?? {}));
  assert.ok(declared.size > 20, `only ${declared.size} scripts declared — the manifest did not load`);

  const documents = ["PROGRESS.md", "AGENTS.md", "README.md"];
  let scanned = 0;
  let mentions = 0;
  for (const name of documents) {
    let text;
    try {
      text = await readFile(new URL(name, root), "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    // `pnpm <script>` only. Bare `pnpm install`, `pnpm --filter …` and shell
    // pipelines are not claims about this manifest.
    for (const [, script] of text.matchAll(/(?:^|[\s`(])pnpm ([a-z][a-z0-9]*(?::[a-z0-9-]+)+)/g)) {
      mentions += 1;
      assert.ok(
        declared.has(script),
        `${name} tells a reader to run \`pnpm ${script}\`, and package.json has no such script`,
      );
    }
  }
  assert.equal(scanned, documents.length, "a document in the list could not be read");
  assert.ok(mentions >= 5, `only ${mentions} pnpm commands found across the docs — the scan did not read them`);
});

test("every capability fixes the two pre-delivery steps instead of leaving them to the model", async () => {
  // Plan item A3. `manuscript-humanize` was named by one capability of eleven
  // and `traceability-review` by none — so a register pass and a citation sweep
  // happened when the model thought of them, which is on the easy runs and not
  // the hard ones. They are steps of the capability now.
  //
  // Asserted on the package the delegated run reads, not on prose anywhere: a
  // capability added next month gets the same two steps or fails here.
  //
  // It was asserted on the wrong file for two days. `capabilities/<id>/SKILL.md`
  // is the authored copy; the image ships `capability-skills/` and the runtime
  // is pointed at it by EVIMED_CAPABILITY_SKILLS_DIR, so that is what a
  // delegated child actually reads — and all eleven shipped bodies named
  // neither step. The test was green the whole time. Both copies are checked
  // now, because the one that ships is the one that matters and the one that is
  // authored is the one a person edits.
  const root = new URL("../../../capabilities/", import.meta.url);
  const shippedRoot = new URL("../../../capability-skills/", import.meta.url);
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(names.length >= 10, `only ${names.length} capabilities found — the scan did not read the tree`);

  for (const name of names) {
    let skill;
    try {
      skill = await readFile(new URL(`${name}/SKILL.md`, root), "utf8");
    } catch {
      assert.fail(`${name} has no SKILL.md`);
    }
    const shipped = await readFile(new URL(`${name}/SKILL.md`, shippedRoot), "utf8").catch(() => null);
    assert.ok(shipped !== null, `${name} has no shipped body under capability-skills/, so a delegated child reads nothing`);
    for (const step of ["traceability-review", "manuscript-humanize"]) {
      assert.ok(skill.includes(step), `${name}/SKILL.md does not name ${step} as a pre-delivery step`);
      assert.ok(shipped.includes(step), `capability-skills/${name}/SKILL.md does not name ${step}; the authored copy is not what the run reads`);
    }
    // The outlet has to be pointed at wherever the ban is stated, or the ban is
    // the only thing the run reads.
    assert.ok(
      skill.includes("revision-notes.md"),
      `${name}/SKILL.md bans backstage prose from the report without naming where it goes`,
    );
  }
});

test("the release receipt renews without anyone watching, and health tracks the receipt not the attempt", async () => {
  // Plan D7. The receipt attests that the model gateway ran a live probe, so it
  // expires in 24 hours by design — that window is the point, not the defect.
  // Nothing renewed it, `/api/ready` answered `deepseek_release_receipt_stale`
  // every day, and a red light that is always red is one everybody skips.
  const root = new URL("../../../", import.meta.url);
  const scheduler = await readFile(new URL("scripts/ops/release-receipt-scheduler.mjs", root), "utf8");
  const compose = await readFile(new URL("deploy/web/docker-compose.receipt.yml", root), "utf8");

  // Minting goes through the one command an operator already runs by hand. A
  // second way to produce receipts would be a second thing to keep signing
  // correctly.
  assert.match(scheduler, /deepseek-kernel-release-gate\.mjs/, "the scheduler must mint through the existing gate");
  assert.ok(!/signDeepSeekReleaseReceipt|RECEIPT_MAC_DOMAIN/.test(scheduler), "the scheduler must not sign receipts itself");

  // Renewal has to beat the deadline with room to retry. Half of 24h.
  assert.match(scheduler, /OPEN_SCIENCE_RECEIPT_INTERVAL_SECONDS", 43_200/, "renewal must be scheduled well inside the receipt's life");

  // Health is about remaining life, not the last attempt: a failed renewal with
  // twenty hours left is a warning and the same failure with one is an outage.
  assert.match(scheduler, /healthGraceSeconds/);
  assert.match(scheduler, /no receipt has been minted/, "never minted must read as unknown, not as healthy");

  // Secrets by path, never by value — the standing rule for this deployment.
  assert.match(compose, /OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_FILE: \/run\/secrets\//);
  assert.match(compose, /OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE: \/run\/secrets\//);
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(compose), "no literal key may appear in a compose file");

  // And the scheduler redacts before anything reaches a log or the state file:
  // a provider error is exactly where a key or an endpoint leaks.
  assert.match(scheduler, /function operationalError/);
  assert.match(scheduler, /<redacted>/);

  const rootPackage = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  for (const script of ["receipt:renew", "receipt:health"]) {
    assert.ok(rootPackage.scripts?.[script], `package.json is missing ${script}`);
  }
});

test("the image's install cutoff admits the version the image pins", async () => {
  // A coupled value that must move with the pin and is not a version string,
  // so no sweep for the old pin can find it. It was left at 2026-09-01 while
  // the pin moved to a release published on 2026-09-02: `npm install
  // --before=<cutoff> @deepseek-ai/dsh@<pin>` then asks the registry for a
  // version that did not exist yet, and the image cannot build the version
  // named three lines above the cutoff. An adversarial review predicted
  // exactly this of a tool that moved versions and nothing else; the review
  // was right, and this is the check that would have caught it.
  //
  // The publish instant comes from the registry rather than a table here: a
  // second copy of "when was this published" is a second thing to get wrong.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const pin = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8")).dsh.version;
  const cutoff = /^ARG DSH_PUBLISHED_BEFORE=(\S+)$/m.exec(dockerfile)?.[1];
  assert.ok(cutoff, "the Dockerfile no longer declares DSH_PUBLISHED_BEFORE; this check has stopped checking");

  const response = await fetch("https://registry.npmjs.org/@deepseek-ai%2Fdsh", { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, "the registry did not answer; this assertion cannot be made offline");
  const published = (await response.json())?.time?.[pin];
  assert.ok(published, `the registry has no publish time for the pinned ${pin}`);
  assert.ok(
    Date.parse(cutoff) >= Date.parse(published),
    `--before=${cutoff} precedes the publication of ${pin} (${published}); the image cannot install the version it pins`,
  );
});

test("an ops script shipped in the web image can resolve the workspace packages it imports", async () => {
  // `pnpm deploy` puts them under `apps/server/node_modules`, and Node resolves
  // upwards from the importing file — so `/app/scripts/ops/x.mjs` never reaches
  // them. Four shipped scripts import `@evimed/domain`, including the release
  // gate, and every one of them died on `Cannot find package` the first time
  // one ran inside the image.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /ln -s apps\/server\/node_modules \/app\/node_modules/,
    "the image must let /app resolve the workspace packages the shipped ops scripts import",
  );

  // And the list this protects is derived, not remembered: any ops script that
  // imports a workspace package needs it.
  const opsDir = path.join(repoRoot, "scripts/ops");
  const importers = [];
  for (const name of await readdir(opsDir)) {
    if (!name.endsWith(".mjs")) continue;
    const source = await readFile(path.join(opsDir, name), "utf8");
    if (/from "@evimed\//.test(source)) importers.push(name);
  }
  assert.ok(
    importers.length > 0,
    "no ops script imports a workspace package any more — delete the link and this test together",
  );
});

test("every repository-root file the server reads at load is in the web image", async () => {
  // `config.mjs` reads `deps-version.json` while it is being imported, so a
  // missing one is not a misconfiguration — the process cannot start, and says
  // ENOENT during module resolution. It became a config dependency during the
  // kernel migration, after the last image was built, and the first image built
  // from that code could not load its own config.
  //
  // Derived from the source rather than listed here: a second file read the
  // same way must be copied too, and nobody will remember to update a list.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  const serverSrc = path.join(repoRoot, "apps/server/src");
  const rootFiles = new Set();
  for (const name of await readdir(serverSrc)) {
    if (!name.endsWith(".mjs")) continue;
    const source = await readFile(path.join(serverSrc, name), "utf8");
    for (const match of source.matchAll(/["'`]\.\.\/\.\.\/\.\.\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)["'`]/g)) {
      rootFiles.add(match[1]);
    }
  }
  assert.ok(rootFiles.size > 0, "the scan found nothing, so it proves nothing about the image");
  for (const file of rootFiles) {
    assert.ok(
      dockerfile.includes(`/app/${file} ./${file}`),
      `apps/server/src reads ${file} from the repository root, and the web image does not copy it`,
    );
  }
});

test("the receipt scheduler declares the same runtime caps as the web service", async () => {
  // The controller compares its caller's caps against its own and refuses on
  // any difference. Three services must agree; two of them share the
  // `x-runtime-caps` anchor, and the third is in an overlay file — compose
  // parses each file alone, so an anchor cannot reach it. This is what an
  // anchor would have guaranteed, across the boundary an anchor cannot cross.
  const [main, receipt] = await Promise.all([
    readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8"),
    readFile(path.join(repoRoot, "deploy/web/docker-compose.receipt.yml"), "utf8"),
  ]);
  const caps = (text) => Object.fromEntries(
    [...text.matchAll(/^\s*(OPEN_SCIENCE_MAX_(?:RUNNING_RUNTIMES|CONCURRENT_KERNELS)(?:_PER_USER)?):\s*(\S+)\s*$/gm)]
      .map((match) => [match[1], match[2]]),
  );
  const declared = caps(main);
  const scheduler = caps(receipt);
  assert.equal(Object.keys(declared).length, 4, "the anchor must still define all four caps");
  assert.deepEqual(scheduler, declared, "a cap the scheduler does not share is a mint refused a day later");
});

test("the preset root the control plane configures is the one the image's own smoke proves", async () => {
  // `roots` is scanned FOR presets, so the value has to be the directory that
  // contains `evimed-universal`, not `evimed-universal` itself. It was the
  // latter, and the kernel answered `preset "evimed-universal" not found
  // (available: standard, ptc, minimal, cordis, skills)` — which lists the
  // built-ins and reads like ours was never built.
  //
  // Compared against `build-smoke-patch.yml`, because that file is what the
  // image build actually mounts a session with: if these two disagree, one of
  // them is describing a deployment that does not work, and the build smoke is
  // the one that ran.
  const [manager, smoke, dockerfile] = await Promise.all([
    readFile(path.join(repoRoot, "apps/server/src/runtimeManager.mjs"), "utf8"),
    readFile(path.join(repoRoot, "deploy/runtime-dsh/build-smoke-patch.yml"), "utf8"),
    readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8"),
  ]);
  const configured = manager.match(/presetRoot:\s*"([^"]+)"/)?.[1];
  const proven = smoke.match(/- id: agent-presets[\s\S]*?- path:\s*(\S+)/)?.[1];
  const built = dockerfile.match(/^ARG DSH_PRESET_ROOT=(\S+)/m)?.[1];
  assert.ok(configured && proven && built, "all three must state a preset root");
  assert.equal(configured, proven, "the control plane must configure the root the build smoke mounts a session with");
  assert.equal(configured, built, "and the root the image actually creates");
});

test("the hosted e2e accepts any certified model, not one written into it", async () => {
  // Which certified model serves is a deployment decision — the pilot runs
  // `deepseek-v4-flash` — and the release receipt certifies whichever one
  // actually answered. The gate asked for `deepseek-v4-pro` by literal in four
  // places and refused a deployment that was green, naming a model nobody had
  // configured; three of the others would have had the run write one model's
  // name and judged it against another's.
  const e2e = await readFile(path.join(repoRoot, "scripts/ops/hosted-production-e2e.mjs"), "utf8");
  const code = e2e.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /deepseek-v4-(pro|flash)/, "the e2e must not name a model; it reads the certified set");
  assert.match(code, /supportedDeepSeekModels/, "and it must read that set from the gateway that defines it");

  // The certified set has more than one member, or the assertion above is a
  // statement about a single-model deployment rather than about the check.
  const gateway = await readFile(path.join(repoRoot, "apps/server/src/modelGateway.mjs"), "utf8");
  const listed = gateway.match(/supportedDeepSeekModels = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\)/)?.[1] ?? "";
  assert.ok(
    (listed.match(/"deepseek-[a-z0-9-]+"/g) ?? []).length >= 2,
    "more than one model must be certified, or nothing here is being decided",
  );
});
