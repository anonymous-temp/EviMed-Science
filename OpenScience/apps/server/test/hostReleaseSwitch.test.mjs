// host-release-switch.sh run end to end against a docker that is a script.
//
// hostReleaseScripts.test.mjs reads the release scripts as text; this runs
// the switch, because what it is for is an order of docker operations and a
// verdict on what docker reports back, and both are behaviour. The fake keeps
// a small state file — containers, their compose hashes, start times and bind
// mounts — answers the handful of commands the switch issues, and logs every
// call. A bind "through current" of a container that started before the move
// reads as link count 0 (the release it resolved was deleted, as on
// 2026-09-26) until the container is restarted.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NEW = "1cf308956b6e";
const PROJECT = "web";

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require("fs");
const file = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, args.join(" ") + "\n");
const save = () => {
  // A background inspect must see a whole snapshot while restart updates it.
  const next = file + "." + process.pid + ".next";
  fs.writeFileSync(next, JSON.stringify(state));
  fs.renameSync(next, file);
};
const now = () => new Date().toISOString();
const byService = (service) => Object.entries(state.containers).find(([, c]) => c.service === service);
const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const out = (text) => process.stdout.write(text);
const [command] = args;
if (command === "compose") {
  if (args.includes("config")) { out(Object.entries(state.compose).map(([s, h]) => s + " " + h).join("\n") + "\n"); process.exit(0); }
  const up = args.indexOf("--no-deps");
  if (args.includes("up") && up >= 0) {
    for (const service of args.slice(up + 1)) {
      const [name, c] = byService(service);
      Object.assign(c, { hash: state.compose[service], startedAt: now(), stale: false });
      state.containers[name] = c;
    }
    save(); process.exit(0);
  }
  process.exit(0);
}
if (command === "ps") {
  const filters = args.flatMap((a, i) => (a === "--filter" ? [args[i + 1]] : []));
  const service = filters.map((f) => f.match(/^label=com\.docker\.compose\.service=(.+)$/)?.[1]).find(Boolean);
  const all = args.includes("-a");
  const names = Object.entries(state.containers)
    .filter(([, c]) => (all || c.running) && (!service || c.service === service))
    .map(([n]) => n);
  out(names.map((n) => n + "\n").join("")); process.exit(0);
}
if (command === "inspect") {
  const format = flag("-f"); const c = state.containers[args[args.length - 1]];
  if (!c) process.exit(1);
  if (format.includes("config-hash")) out(c.hash + "\n");
  else if (format.includes("project.working_dir")) out(c.workingDir + "\n");
  else if (format.includes(".State.StartedAt")) out(c.startedAt + "\n");
  else if (format.includes(".Destination")) out(c.binds.map((b) => b.destination + "\n").join(""));
  else if (format.includes(".Source")) out(c.binds.map((b) => b.source + "\n").join(""));
  process.exit(0);
}
if (command === "restart") {
  const c = state.containers[args[1]];
  c.startedAt = now();
  if (!state.restartDoesNotHelp) c.stale = false;
  save(); process.exit(0);
}
if (command === "exec") {
  const [, name, ...rest] = args;
  if (rest[0] === "stat") {
    const c = state.containers[name];
    const bind = c.binds.find((b) => b.destination === rest[3]);
    out((c.stale && bind.source.startsWith(state.current + "/") ? "0" : "1") + "\n"); process.exit(0);
  }
  if (rest[0] === "printenv") { out(state.runtimeImage + "\n"); process.exit(0); }
  const script = rest.join(" ");
  if (script.includes("/api/ready")) { out((state.ready ?? "ok 27 - backup=ok") + "\n"); process.exit(0); }
  if (script.includes("/api/ops/maintenance?activity=1")) { out((state.activity ?? "0 0 0") + "\n"); process.exit(0); }
  if (script.includes("/api/health")) process.exit(0);
  process.exit(1);
}
if (command === "run" && flag("--entrypoint") === "sh") {
  // The post-release walk, in the runtime image.
  state.walks = (state.walks ?? 0) + 1; save();
  if (state.walkExit === 1) out("FAIL files@desktop: 9 kinds of control (budget 8)\n");
  process.exit(state.walkExit ?? 0);
}
if (command === "run") {
  // The skill-digest check: the image's node over the roots it names.
  const roots = args.slice(args.indexOf("-") + 1);
  for (const root of roots) out(JSON.stringify({ path: root, ...(state.imageDigests[root] ?? { missing: true }) }) + "\n");
  process.exit(0);
}
if (command === "logs") process.exit(0);
process.stderr.write("fake docker: unhandled " + args.join(" ") + "\n");
process.exit(2);
`;

/** A host with one built release, a live stack and a docker that is a script. */
async function host({ restartDoesNotHelp = false, imageDigestMatches = true, walkExit = undefined, ready = undefined } = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "release-switch-"));
  const rel = path.join(root, "releases", NEW, "OpenScience");
  const web = path.join(rel, "deploy/web");
  await mkdir(path.join(web, "monitoring"), { recursive: true });
  await mkdir(path.join(rel, "scripts/ops"), { recursive: true });
  for (const script of ["configure-monitoring.mjs", "check-runtime-skill-digests.mjs"]) {
    await copyFile(path.join(repoRoot, "scripts/ops", script), path.join(rel, "scripts/ops", script));
  }
  const skill = { name: "core", source: "runtime/skills/core", files: 25, digest: "sha256:recorded" };
  await writeFile(path.join(web, "release-manifest.json"), JSON.stringify({ runtime: { image: `open-science-runtime:x-${NEW}` }, skills: [skill] }));
  await writeFile(path.join(web, ".env"), "OPEN_SCIENCE_PUBLIC_HEALTH_URL=https://evimed.example.org/api/health\n");
  await writeFile(path.join(web, "monitoring/open-science.rules.json"), "{}\n");
  await mkdir(path.join(root, "shared", `ops-source-${NEW}`), { recursive: true });
  await writeFile(path.join(root, "shared", `ops-source-${NEW}`, "compose.builtin.override.yml"), "services: {}\n");
  await mkdir(path.join(root, "shared/secrets"), { recursive: true });
  await writeFile(path.join(root, "shared/secrets/postgres-password.txt"), "x\n");

  const current = path.join(root, "current");
  const through = `${current}/OpenScience/deploy/web`;
  const old = "2026-09-24T07:05:00.123456789Z";
  const container = (service, hash, binds, extra = {}) => ({ service, hash, running: true, startedAt: old, workingDir: through, binds, stale: false, ...extra });
  const state = {
    current,
    runtimeImage: `open-science-runtime:x-${NEW}`,
    restartDoesNotHelp,
    walkExit,
    // The readiness line the switch's probe prints (`<ok|notok> <checks> <failing but backup> backup=<code>`).
    ready,
    compose: { "open-science-web": "new", prometheus: "same", "evimed-postgres": "same", "open-science-release-receipt": "same" },
    containers: {
      [`${PROJECT}-open-science-web-1`]: container("open-science-web", "old", [{ source: `${through}/release-manifest.json`, destination: "/run/open-science/release-manifest.json" }], { stale: true }),
      // Resolved `current` on 09-24; the release it resolved is gone.
      [`${PROJECT}-prometheus-1`]: container("prometheus", "same", [{ source: `${through}/monitoring/open-science.rules.json`, destination: "/etc/prometheus/rules/open-science.rules.json" }], { stale: true }),
      [`${PROJECT}-evimed-postgres-1`]: container("evimed-postgres", "same", [{ source: `${root}/shared/secrets/postgres-password.txt`, destination: "/run/secrets/postgres-password" }]),
      [`${PROJECT}-open-science-release-receipt-1`]: container("open-science-release-receipt", "same", [{ source: `${through}/release-manifest.json`, destination: "/run/open-science/release-manifest.json" }], { stale: true }),
    },
    imageDigests: {
      "/opt/evimed/socket/presets/evimed-universal/skills/core": imageDigestMatches ? { files: 25, digest: "sha256:recorded" } : { files: 25, digest: "sha256:the-base-image-copy" },
    },
  };
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "docker"), FAKE_DOCKER);
  await chmod(path.join(bin, "docker"), 0o755);
  // The switch polls with `sleep`; a readiness that never turns ok would
  // otherwise hold a test for the switch's full eight minutes.
  await writeFile(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(bin, "sleep"), 0o755);
  await writeFile(path.join(root, "docker-state.json"), JSON.stringify(state));
  if (walkExit !== undefined) {
    await writeFile(path.join(root, "shared/secrets/walk-password"), "x\n");
    await writeFile(path.join(root, "shared/ui-walk.env"), [
      "OPEN_SCIENCE_WALK_BASE_URL=https://evimed.example.org",
      "OPEN_SCIENCE_WALK_USER=cdss-access",
      `OPEN_SCIENCE_WALK_PASSWORD_HOST_FILE=${root}/shared/secrets/walk-password`,
      "",
    ].join("\n"));
  }
  return { root, rel };
}

function runSwitch(root, flags = []) {
  // The release's `.env` is the only source of the probe URLs: `node
  // --env-file` never overrides a variable the caller already has.
  const env = { ...process.env };
  delete env.OPEN_SCIENCE_PUBLIC_HEALTH_URL;
  delete env.OPEN_SCIENCE_EDGE_PROXY_URL;
  return new Promise((resolve) => {
    execFile("bash", [path.join(repoRoot, "scripts/ops/host-release-switch.sh"), NEW, ...flags], {
      env: {
        ...env,
        PATH: `${path.join(root, "bin")}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
        EVIMED_ROOT: root,
        EVIMED_COMPOSE_PROJECT: PROJECT,
        FAKE_DOCKER_STATE: path.join(root, "docker-state.json"),
        FAKE_DOCKER_LOG: path.join(root, "docker.log"),
      },
      timeout: 60_000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

const skip = process.platform === "win32";

test("the switch restarts what still reads the previous release through current, and proves it from inside", { skip }, async () => {
  const { root, rel } = await host();
  try {
    const result = await runSwitch(root, ["--no-prune"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /restarted: web-prometheus-1/);
    // Nothing that binds only outside `current`, and not the receipt, which
    // the mint restarts after web answers as the new release.
    assert.doesNotMatch(result.stdout, /restarted: web-evimed-postgres-1/);
    assert.doesNotMatch(result.stdout, /restarted: web-open-science-release-receipt-1/);
    assert.match(result.stdout, /(\d+) bind\(s\) verified live inside their containers, 0 unverified/);
    const calls = (await readFile(path.join(root, "docker.log"), "utf8")).split("\n");
    const up = calls.findIndex((line) => line.includes(" up -d --no-deps open-science-web"));
    const restart = calls.indexOf(`restart ${PROJECT}-prometheus-1`);
    assert.ok(up >= 0 && restart > up, "prometheus is restarted after the changed services are recreated");
    assert.ok(calls.some((line) => line.startsWith(`exec ${PROJECT}-prometheus-1 stat -c %h /etc/prometheus/rules/open-science.rules.json`)));
    // The probe targets were written from the release's `.env` before the move.
    const tls = JSON.parse(await readFile(path.join(rel, "deploy/web/monitoring/targets/tls.json"), "utf8"));
    assert.deepEqual(tls[0], { targets: ["https://evimed.example.org/api/health"], labels: { probe: "public-tls" } });
    // ...and Alertmanager's route to the control plane's alert receiver, the
    // one delivery every alert has (until 2026-09-28 they were all dropped).
    assert.match(result.stdout, /=== alert receiver follows the release ===/);
    const alertmanager = JSON.parse(await readFile(path.join(rel, "deploy/web/secrets/alertmanager.json"), "utf8"));
    assert.equal(alertmanager.receivers[0].webhook_configs[0].url, "http://open-science-web:8787/api/ops/alerts");
    assert.match(result.stdout, /every skill tree the manifest records is in open-science-runtime:x-1cf308956b6e/);
    assert.match(result.stdout, /UI WALK NOT RUN: .*ui-walk\.env is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unhealthy backup is reported loudly but holds nothing: the switch finishes and walks", { skip }, async () => {
  // 2026-09-26 and 09-27: the backup failed its start-up cycle over a run's
  // symlink, and web — then waiting on the backup's health — never started.
  // Web no longer waits on it; neither may the switch.
  const { root } = await host({ walkExit: 0, ready: "ok 27 - backup=backup_scheduler_unhealthy" });
  try {
    const result = await runSwitch(root, ["--no-prune"]);
    assert.equal(result.code, 1, "the switch must not read as clean while backups are failing");
    assert.match(result.stdout, /=== BACKUP IS UNHEALTHY \(backup_scheduler_unhealthy\): the site is served regardless/);
    // Past the readiness gate that guards retention, to the digest check.
    assert.doesNotMatch(result.stdout, /readiness is not ok/);
    assert.match(result.stdout, /every skill tree the manifest records is in/);
    assert.match(result.stdout, /=== switched to evimed-1cf308956b6e-1 ===/);
    assert.match(result.stdout, /UI walk passed/);
    const lines = result.stdout.trim().split("\n");
    assert.match(lines.at(-1), /^=== RELEASE evimed-1cf308956b6e-1 IS LIVE, BUT THE BACKUP IS UNHEALTHY \(backup_scheduler_unhealthy\)/,
      "and it is the switch's last word");
    // It waited for the backup's own retry before saying so, and minted once:
    // a failing backup is not something a second mint can change.
    const calls = (await readFile(path.join(root, "docker.log"), "utf8")).split("\n");
    assert.equal(calls.filter((line) => line.includes("/api/ready")).length, 80);
    assert.equal(calls.filter((line) => line === `restart ${PROJECT}-open-science-release-receipt-1`).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("any other failing check still stops the switch before retention, backup healthy or not", { skip }, async () => {
  for (const ready of ["notok 27 runtime backup=ok", "notok 27 runtime backup=backup_scheduler_unhealthy"]) {
    const { root } = await host({ ready });
    try {
      const result = await runSwitch(root);
      assert.equal(result.code, 1);
      assert.match(result.stdout, /readiness is not ok; leaving old releases in place/);
      assert.doesNotMatch(result.stdout, /=== retention ===/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a receipt that did not mint is minted once more even while the backup is failing", { skip }, async () => {
  const { root } = await host({ ready: "notok 27 modelGateway backup=backup_scheduler_unhealthy" });
  try {
    const result = await runSwitch(root);
    assert.match(result.stdout, /receipt did not mint \(notok 27 modelGateway backup=backup_scheduler_unhealthy\); minting once more/);
    const calls = (await readFile(path.join(root, "docker.log"), "utf8")).split("\n");
    assert.equal(calls.filter((line) => line === `restart ${PROJECT}-open-science-release-receipt-1`).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a container that still reads a deleted file after the restarts fails the switch before retention", { skip }, async () => {
  const { root } = await host({ restartDoesNotHelp: true });
  try {
    const result = await runSwitch(root);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /DELETED web-prometheus-1: \/etc\/prometheus\/rules\/open-science\.rules\.json \(link count 0/);
    assert.match(result.stdout, /bind\(s\) read a deleted file; the switch is not done/);
    assert.doesNotMatch(result.stdout, /=== retention ===/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a runtime image that does not carry the manifest's skill trees fails the switch before retention", { skip }, async () => {
  const { root } = await host({ imageDigestMatches: false });
  try {
    const result = await runSwitch(root);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /DIFFERS runtime\/skills\/core/);
    assert.match(result.stdout, /does not match this release's manifest; leaving old releases in place/);
    assert.doesNotMatch(result.stdout, /=== retention ===/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the live pages are walked after the switch, and a failed walk says the release is live and fails", { skip }, async () => {
  // Fusion audit F-G2: the walk was red against production on five counts and
  // ran in no release step, so nobody saw it.
  for (const [walkExit, code, said] of [
    [0, 0, /UI walk passed; report in .*shared\/ui-walk\/1cf308956b6e/],
    [1, 1, /RELEASE evimed-1cf308956b6e-1 IS LIVE, BUT THE UI WALK FAILED/],
    [2, 1, /RELEASE evimed-1cf308956b6e-1 IS LIVE, BUT THE UI WALK COULD NOT RUN \(exit 2\)/],
  ]) {
    const { root } = await host({ walkExit });
    try {
      const result = await runSwitch(root, ["--no-prune"]);
      assert.equal(result.code, code, result.stdout + result.stderr);
      assert.match(result.stdout, said, result.stdout + result.stderr);
      assert.match(result.stdout, /=== switched to evimed-1cf308956b6e-1 ===/);
      const calls = await readFile(path.join(root, "docker.log"), "utf8");
      const walk = calls.split("\n").find((line) => line.startsWith("run ") && line.includes("--entrypoint sh"));
      assert.ok(walk, "the walk ran in a container");
      assert.match(walk, /open-science-runtime:x-1cf308956b6e/, "in the release's own runtime image");
      assert.match(walk, /-v \S+\/shared\/secrets\/walk-password:\/run\/walk\/password:ro/, "with the password as a read-only file, not a value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("runs in flight stop the switch before anything moves, unless it is told to reap them", { skip }, async () => {
  const { root } = await host();
  try {
    const stateFile = path.join(root, "docker-state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    await writeFile(stateFile, JSON.stringify({ ...state, activity: "2 0 1" }));
    const refused = await runSwitch(root, ["--no-prune"]);
    assert.equal(refused.code, 3, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /REFUSED: 2 agent run\(s\), 0 product job\(s\), 1 busy runtime\(s\) in flight/);
    assert.doesNotMatch(refused.stdout, /=== current -> /, "current did not move");
    const calls = (await readFile(path.join(root, "docker.log"), "utf8")).split("\n");
    assert.equal(calls.some((line) => line.includes(" up -d ")), false, "nothing was recreated");
    const forced = await runSwitch(root, ["--no-prune", "--allow-active"]);
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    assert.match(forced.stdout, /--allow-active: switching anyway/);
    assert.match(forced.stdout, /=== current -> /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an idle release switches, and an unreadable one warns rather than stops", { skip }, async () => {
  const { root } = await host();
  try {
    const idle = await runSwitch(root, ["--no-prune"]);
    assert.equal(idle.code, 0, idle.stdout + idle.stderr);
    assert.match(idle.stdout, /nothing in flight/);
    const stateFile = path.join(root, "docker-state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    await writeFile(stateFile, JSON.stringify({ ...state, activity: "unknown HTTP 404" }));
    const unknown = await runSwitch(root, ["--no-prune"]);
    assert.equal(unknown.code, 0, unknown.stdout + unknown.stderr);
    assert.match(unknown.stdout, /WARNING: could not read the live release's activity \(HTTP 404\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the plan names the containers the switch would restart, and restarts none", { skip }, async () => {
  const { root } = await host();
  try {
    const result = await runSwitch(root, ["--plan"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const listed = result.stdout.slice(result.stdout.indexOf("bind through current"));
    assert.match(listed, /web-prometheus-1/);
    assert.doesNotMatch(listed, /web-evimed-postgres-1|release-receipt/);
    const calls = await readFile(path.join(root, "docker.log"), "utf8");
    assert.doesNotMatch(calls, /^restart /m);
    assert.doesNotMatch(calls, / up -d /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
