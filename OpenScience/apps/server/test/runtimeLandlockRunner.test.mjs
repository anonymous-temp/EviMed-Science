// The sandbox row's runner (deploy/runtime-dsh/evimed-landlock-run.sh): the kernel's own Landlock launcher, with /dev/shm added to what a
// workspace-write command may write, so Python's multiprocessing, joblib and numba's parallel start-up work inside the sandbox.
//
// What is held here, each against the kernel's own runner and not against a description of it:
//  - the argument translation: the argv recorded from the pinned kernel's `confine` (scripts/ops/sandbox-profile.mjs; the seams job
//    re-records it from the installed closure) for both modes gives, through the runner, the grants the kernel's own Landlock runner
//    gives plus /dev/shm for workspace-write, and the same command tail byte for byte;
//  - every deviation from those two shapes is refused (exit 125, a line beginning `evimed-landlock-run: `), and the launcher is not run;
//  - what the runner may not change, measured with the real launcher where the box enforces Landlock: what is denied (writes outside the
//    grants, including /proc), exit codes (125 from a command, 7, a signal), standard output and error bytes, standard input, the
//    environment (a bash command sees the same one), the pid and process group (the runner is not a process in between, so a cancel's
//    kill of the group kills the command), loopback network access (neither runner restricts it);
//  - the purpose: `multiprocessing.Pool` and `ProcessPoolExecutor` work through the runner and fail through the kernel's own runner;
//  - the failure signatures the socket's sandbox row names match the launcher's own fatal lines and not its informational one.
//
//   EVIMED_LANDLOCK_RUN=<path to the kernel's landlock-run> node --test test/runtimeLandlockRunner.test.mjs
//   EVIMED_KERNEL_MODULES=<node_modules of the kernel closure>  also re-records the profile fixture from the installed kernel
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const runnerSource = await readFile(path.join(repo, "deploy/runtime-dsh/evimed-landlock-run.sh"), "utf8");
const fixture = JSON.parse(await readFile(path.join(repo, "deploy/runtime-dsh/fixtures/sandbox-profile.json"), "utf8"));
const socketPatch = await readFile(path.join(repo, "packages/socket/cordis.patch.yml"), "utf8");

const realLauncher = process.env.EVIMED_LANDLOCK_RUN ?? "";
const landlockWorks = realLauncher !== "" && spawnSync(realLauncher, ["--probe"], { encoding: "utf8" }).status === 0;
const needsLandlock = { skip: !landlockWorks && "needs EVIMED_LANDLOCK_RUN (the kernel's landlock-run) on a kernel that enforces Landlock" };
const python = spawnSync("python3", ["-c", "import multiprocessing.synchronize"], { encoding: "utf8" });
const shmWritable = spawnSync("sh", ["-c", "d=$(mktemp -d /dev/shm/evimed-probe-XXXXXX) && rmdir \"$d\""], { encoding: "utf8" }).status === 0;
const needsPool = { skip: (!landlockWorks && "needs Landlock") || (python.status !== 0 && "needs python3") || (!shmWritable && "needs a writable /dev/shm on this box") };

const scratch = await mkdtemp(path.join(os.tmpdir(), "evimed-landlock-runner-"));
test.after(() => rm(scratch, { recursive: true, force: true }));
let counter = 0;

/**
 * The runner as the image has it, with the two lines a test may change (launcher and shared-memory directory) replaced. The image's
 * own copy reads neither from its environment.
 * @param {{ launcher: string, shm?: string }} options
 */
async function runnerWith({ launcher, shm = "/dev/shm" }) {
  const text = runnerSource
    .replace(/^launcher_pattern=.*$/m, `launcher_pattern='${launcher}'`)
    .replace(/^shm_dir=.*$/m, `shm_dir='${shm}'`);
  assert.notEqual(text, runnerSource, "the two lines the test replaces are still there");
  const file = path.join(scratch, `runner-${(counter += 1)}.sh`);
  await writeFile(file, text);
  await chmod(file, 0o755);
  return file;
}

/** A launcher that records its argv (NUL separated) in $FAKE_OUT and exits 0: what the runner would have executed. */
async function fakeLauncher() {
  const file = path.join(scratch, `fake-launcher-${(counter += 1)}.sh`);
  await writeFile(file, "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done > \"$FAKE_OUT\"\n");
  await chmod(file, 0o755);
  return file;
}

/** @param {string} runner @param {string[]} args @param {Record<string, string>} [env] */
function run(runner, args, env = {}) {
  const out = path.join(scratch, `argv-${(counter += 1)}`);
  const result = spawnSync(runner, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "", FAKE_OUT: out, ...env } });
  return { ...result, out };
}

/** @param {string} file @returns {Promise<string[] | null>} */
async function recorded(file) {
  try { return (await readFile(file, "utf8")).split("\0").slice(0, -1); } catch { return null; }
}

/** The grants of a launcher argv (without its argv[0]): "flag path" pairs before `--`, sorted, and the command after it. @param {string[]} argv */
function parse(argv) {
  const at = argv.indexOf("--");
  const head = argv.slice(0, at);
  const grants = [];
  for (let i = 0; i < head.length; i += 2) grants.push(`${head[i]} ${head[i + 1]}`);
  return { grants: grants.sort(), command: argv.slice(at + 1) };
}

test("the profile fixture is the pin's, and has the two modes the kernel confines", () => {
  const pins = JSON.parse(spawnSync("cat", [path.join(repo, "deps-version.json")], { encoding: "utf8" }).stdout);
  assert.equal(fixture.pin, pins.dsh.version, "re-record with scripts/ops/sandbox-profile.mjs after moving the pin");
  assert.deepEqual(fixture.cases.map((entry) => entry.mode), ["read-only", "workspace-write"]);
  for (const entry of fixture.cases) assert.equal(entry.enforcement, "full", "a custom runner is asserted full by the kernel");
});

test("the profile the kernel hands a custom runner is still what the fixture records (needs the installed closure)", { skip: !process.env.EVIMED_KERNEL_MODULES && "needs EVIMED_KERNEL_MODULES (the kernel closure's node_modules; the seams job runs the same check)" }, async () => {
  const { recordFixture } = await import("../../../scripts/ops/sandbox-profile.mjs");
  const document = await recordFixture(path.resolve(String(process.env.EVIMED_KERNEL_MODULES)));
  assert.deepEqual(document.cases, fixture.cases);
});

test("for each recorded profile the runner gives the grants of the kernel's own Landlock runner, plus /dev/shm for workspace-write", async () => {
  const launcher = await fakeLauncher();
  const runner = await runnerWith({ launcher, shm: "/dev" });
  for (const entry of fixture.cases) {
    const result = run(runner, entry.runnerCommand.slice(1));
    assert.equal(result.status, 0, result.stderr);
    const seen = parse(/** @type {string[]} */ (await recorded(result.out)));
    const builtin = parse(entry.builtin.slice(1));
    const expected = entry.mode === "workspace-write" ? [...builtin.grants, "--rw /dev"].sort() : builtin.grants;
    assert.deepEqual(seen.grants, expected, `${entry.mode}: the grants`);
    assert.deepEqual(seen.command, builtin.command, `${entry.mode}: the command, byte for byte`);
    assert.deepEqual(seen.command, entry.command);
  }
  const workspaceWrite = parse(fixture.cases[1].builtin.slice(1)).grants;
  assert.ok(workspaceWrite.includes("--rw /tmp") && workspaceWrite.includes("--rw /work") && workspaceWrite.includes("--ro /") && workspaceWrite.includes("--rw /dev/null"), "the kernel's own grants are the four this runner reproduces");
});

test("without a shared-memory directory the grants are the kernel's own, and a read-only command never gets one", async () => {
  const launcher = await fakeLauncher();
  const missing = await runnerWith({ launcher, shm: path.join(scratch, "no-such-directory") });
  const write = fixture.cases[1];
  const result = run(missing, write.runnerCommand.slice(1));
  assert.deepEqual(parse(/** @type {string[]} */ (await recorded(result.out))).grants, parse(write.builtin.slice(1)).grants);
  const present = await runnerWith({ launcher, shm: scratch });
  const readOnly = fixture.cases[0];
  assert.deepEqual(parse(/** @type {string[]} */ (await recorded(run(present, readOnly.runnerCommand.slice(1)).out))).grants, parse(readOnly.builtin.slice(1)).grants);
});

test("the command's arguments reach the launcher exactly, whatever they look like", async () => {
  const launcher = await fakeLauncher();
  const runner = await runnerWith({ launcher });
  const profile = fixture.cases[1].runnerCommand.slice(1, fixture.cases[1].runnerCommand.indexOf("--") + 1);
  const awkward = ["bash", "-c", "echo 'a  b'\n--ro-bind / /", "", "--", "-x", "two words", "tab\there"];
  const result = run(runner, [...profile, ...awkward]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parse(/** @type {string[]} */ (await recorded(result.out))).command, awkward);
});

test("any deviation from the two profile shapes is refused by name, and nothing reaches the launcher", async () => {
  const launcher = await fakeLauncher();
  const runner = await runnerWith({ launcher });
  /** @type {Map<string, string[]>} */
  const attempts = new Map();
  for (const entry of fixture.cases) {
    const argv = entry.runnerCommand.slice(1);
    const dashes = argv.indexOf("--");
    for (let i = 0; i < dashes; i += 1) {
      attempts.set(`${entry.mode}: without argument ${i} (${argv[i]})`, [...argv.slice(0, i), ...argv.slice(i + 1)]);
      attempts.set(`${entry.mode}: argument ${i} (${argv[i]}) replaced`, [...argv.slice(0, i), "--unknown-flag", ...argv.slice(i + 1)]);
      attempts.set(`${entry.mode}: an unknown flag inserted at ${i}`, [...argv.slice(0, i), "--unshare-net", ...argv.slice(i)]);
      attempts.set(`${entry.mode}: an unknown value inserted at ${i}`, [...argv.slice(0, i), "/etc", ...argv.slice(i)]);
    }
    attempts.set(`${entry.mode}: no separator`, argv.slice(0, dashes));
    attempts.set(`${entry.mode}: no command`, argv.slice(0, dashes + 1));
  }
  const write = fixture.cases[1].runnerCommand.slice(1);
  const bindAt = write.indexOf("--bind");
  attempts.set("a bind of one directory onto another", [...write.slice(0, bindAt + 2), "/elsewhere", ...write.slice(bindAt + 3)]);
  attempts.set("a bind with an empty workspace", [...write.slice(0, bindAt + 1), "", "", ...write.slice(bindAt + 3)]);
  attempts.set("a tmpfs somewhere else", write.map((word, i) => (i > 0 && write[i - 1] === "--tmpfs" ? "/var" : word)));
  attempts.set("a read-only bind in the writable shape", write.map((word) => (word === "--bind" ? "--ro-bind" : word)));
  attempts.set("nothing at all", []);
  attempts.set("only a separator", ["--", "true"]);
  attempts.set("the profile of a different dialect", ["--ro", "/", "--rw", "/tmp", "--", "true"]);
  assert.ok(attempts.size > 60, `${attempts.size} deviations were tried`);
  for (const [label, args] of attempts) {
    const result = run(runner, args);
    assert.equal(result.status, 125, `${label}: exits 125 (got ${result.status})`);
    assert.match(result.stderr, /^evimed-landlock-run: /, `${label}: names itself`);
    assert.equal(result.stdout, "", `${label}: nothing on standard output`);
    assert.equal(await recorded(result.out), null, `${label}: the launcher was never run`);
  }
});

test("a runner that cannot find the launcher refuses, by name, and runs nothing", async () => {
  const runner = await runnerWith({ launcher: path.join(scratch, "no-launcher-here", "landlock-run") });
  const entry = fixture.cases[1];
  const marker = path.join(scratch, "ran-anyway");
  const result = run(runner, [...entry.runnerCommand.slice(1, entry.runnerCommand.indexOf("--") + 1), "touch", marker]);
  assert.equal(result.status, 125);
  assert.equal(result.stderr, "evimed-landlock-run: the Landlock launcher was not found\n");
  await assert.rejects(access(marker), "the command did not run");
});

test("the socket's sandbox row names the runner, the image carries it, and the signatures separate failure from information", async () => {
  const row = socketPatch.slice(socketPatch.indexOf("- id: sandbox\n"));
  const block = row.slice(0, row.indexOf("\n\n"));
  assert.match(block, /runnerCommand:\n\s+- \/usr\/local\/lib\/evimed\/evimed-landlock-run\n/);
  const signatures = [...block.matchAll(/^\s+- '(.+)'$/gm)].map((match) => match[1]);
  assert.ok(signatures.includes("evimed-landlock-run: "), "the runner's own refusal prefix");
  assert.equal(signatures.some((signature) => /partial enforcement/i.test(signature)), false);
  for (const line of ["landlock-run: partial enforcement (older Landlock ABI)", "landlock-run: partial enforcement"]) {
    assert.equal(signatures.some((signature) => line.toLowerCase().includes(signature.toLowerCase())), false, `${line} is information, never a failure`);
  }
  // Every image recipe copies the runner to the path the row names, and the smoke phase makes it executable.
  for (const recipe of ["Dockerfile", "Dockerfile.delta", "Dockerfile.agentbay"]) {
    const text = await readFile(path.join(repo, "deploy/runtime-dsh", recipe), "utf8");
    assert.match(text, /^COPY deploy\/runtime-dsh\/evimed-landlock-run\.sh \/usr\/local\/lib\/evimed\/evimed-landlock-run$/m, recipe);
  }
  assert.match(await readFile(path.join(repo, "deploy/runtime-dsh/install-runtime.sh"), "utf8"), /chmod 0755 [^\n]*\/usr\/local\/lib\/evimed\/evimed-landlock-run/);
  assert.match(await readFile(path.join(repo, "deploy/runtime-dsh/Dockerfile.delta"), "utf8"), /chmod 0755 [^\n]*\/usr\/local\/lib\/evimed\/evimed-landlock-run/);

  if (!landlockWorks) return;
  // The launcher's own fatal lines, provoked on the real launcher, are each matched by a signature of the row.
  const fatal = [
    spawnSync(realLauncher, ["--nonsense"], { encoding: "utf8" }),
    spawnSync(realLauncher, ["--ro", "/", "--rw", path.join(scratch, "no-such-root"), "--", "true"], { encoding: "utf8" }),
    spawnSync(realLauncher, ["--ro", "/", "--", path.join(scratch, "no-such-command")], { encoding: "utf8" }),
  ];
  for (const result of fatal) {
    assert.equal(result.status, 125);
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("landlock-run: ") && !/partial enforcement/.test(line));
    assert.equal(lines.length, 1, result.stderr);
    assert.ok(signatures.some((signature) => lines[0].toLowerCase().includes(signature.toLowerCase())), `a signature matches: ${lines[0]}`);
  }
});

// ---- the real launcher: what must not change ------------------------------------------------------------------------------

/** The kernel's own Landlock runner for a workspace, as the recording says it is called, with the real launcher. @param {string} workspace */
function builtinArgs(workspace) {
  const entry = fixture.cases[1];
  return entry.builtin.slice(1, entry.builtin.indexOf("--")).map((word) => (word === "/work" ? workspace : word));
}
/** The profile the kernel hands the runner for a workspace. @param {string} workspace */
function kernelProfile(workspace) {
  const entry = fixture.cases[1];
  return entry.runnerCommand.slice(1, entry.runnerCommand.indexOf("--")).map((word) => (word === "/work" ? workspace : word));
}

/**
 * The same command through the kernel's own runner and through ours.
 * @param {string} runner @param {string} workspace @param {string[]} command @param {{ input?: string, env?: Record<string, string> }} [options]
 */
function both(runner, workspace, command, options = {}) {
  const env = options.env ?? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", LANG: "C.UTF-8" };
  const direct = spawnSync(realLauncher, [...builtinArgs(workspace), "--", ...command], { env, input: options.input, cwd: workspace });
  const through = spawnSync(runner, [...kernelProfile(workspace), "--", ...command], { env, input: options.input, cwd: workspace });
  return { direct, through };
}

test("what the kernel's runner denies is still denied, and the bytes, exit codes and environment of a command are the same", needsLandlock, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "evimed-ws-"));
  const runner = await runnerWith({ launcher: realLauncher });
  const probes = [
    ["echo out; echo err >&2; exit 7"],
    ["printf 'no newline'; exit 0"],
    ["exit 125"],
    ["kill -9 $$"],
    ["touch /etc/evimed-probe 2>&1; echo etc=$?"],
    ["touch \"$HOME/.evimed-probe\" 2>&1; echo home=$?"],
    ["touch /usr/local/evimed-probe 2>&1; echo usr=$?"],
    ["echo 1 > /proc/self/oom_score_adj 2>&1; echo oom=$?"],
    ["mkdir /sys/evimed 2>&1; echo sys=$?"],
    ["echo hi > ./in-workspace && cat ./in-workspace; echo ws=$?"],
    ["echo hi > /tmp/evimed-t-$$ && cat /tmp/evimed-t-$$; rm -f /tmp/evimed-t-$$; echo tmp=$?"],
    ["cat /proc/self/status | head -n 3 | cut -d: -f1; echo proc-read=$?"],
    ["head -c 1048576 /dev/zero | tr '\\0' 'x' | wc -c"],
    ["cat"],
    ["env | sort"],
    // The limits and the confinement flags the command inherits: nothing here may differ.
    ["ulimit -a"],
    ["grep -E 'NoNewPrivs|Seccomp|CapEff|CapBnd' /proc/self/status"],
    ["umask; id -u; id -g; pwd"],
  ];
  for (const [script] of probes) {
    const { direct, through } = both(runner, workspace, ["bash", "-c", script], { input: "from stdin\n" });
    assert.equal(through.status, direct.status, `${script}: exit status`);
    assert.equal(through.signal, direct.signal, `${script}: signal`);
    assert.equal(through.stdout.toString("latin1"), direct.stdout.toString("latin1"), `${script}: standard output bytes`);
    assert.equal(through.stderr.toString("latin1"), direct.stderr.toString("latin1"), `${script}: standard error bytes`);
  }
  // The denials really were exercised (a probe that is allowed everywhere would pass the loop above).
  const denied = both(runner, workspace, ["bash", "-c", "touch /etc/evimed-probe 2>/dev/null; echo $?; echo 1 > /proc/self/oom_score_adj 2>/dev/null; echo $?"]);
  assert.equal(denied.through.stdout.toString(), "1\n1\n");
  // The one thing that differs is the point: /dev/shm, which the kernel's own runner denies a command.
  const shm = both(runner, workspace, ["bash", "-c", "touch /dev/shm/evimed-probe-$$ 2>/dev/null && rm -f /dev/shm/evimed-probe-$$ && echo writable || echo denied"]);
  assert.equal(shm.direct.stdout.toString(), "denied\n");
  if (shmWritable) assert.equal(shm.through.stdout.toString(), "writable\n");
  await rm(workspace, { recursive: true, force: true });
});

test("a command that is not bash sees the environment the kernel gave it, but for the working directory dash records", needsLandlock, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "evimed-ws-"));
  const runner = await runnerWith({ launcher: realLauncher });
  const env = { PATH: process.env.PATH ?? "", A: "1", B: "two words", C: "" };
  const { direct, through } = both(runner, workspace, ["/usr/bin/env"], { env });
  const lines = (/** @type {{stdout: Buffer}} */ result) => result.stdout.toString().split("\n").filter((line) => line && !line.startsWith("PWD="));
  assert.deepEqual(lines(through).sort(), lines(direct).sort(), "no variable added or removed beyond PWD");
  const bash = both(runner, workspace, ["bash", "-c", "env | sort"], { env });
  assert.equal(bash.through.stdout.toString(), bash.direct.stdout.toString(), "a bash command, which is what the kernel runs, sees the same environment");
  await rm(workspace, { recursive: true, force: true });
});

test("the runner is not a process in between: the command has the pid, the parent and the process group the launcher gives it, and a cancel reaches it", needsLandlock, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "evimed-ws-"));
  const runner = await runnerWith({ launcher: realLauncher });
  const script = "echo $PPID; ps -o pgid= -p $$ | tr -d ' '";
  const { direct, through } = both(runner, workspace, ["bash", "-c", script]);
  const [ppid, pgid] = through.stdout.toString().trim().split("\n");
  assert.equal(Number(ppid), process.pid, "the command's parent is the process that spawned the runner");
  assert.equal(through.stdout.toString(), direct.stdout.toString());
  const ours = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim();
  assert.equal(pgid, ours, "and its group is the spawner's own: nothing between them started one");

  // A cancel signals the command's process group (the kernel's `fallbackOwner.signal`, kill(-pgid)): everything the command started dies.
  const marker = `7${String(process.pid).slice(-4)}${counter}`;
  const child = spawn(runner, [...kernelProfile(workspace), "--", "bash", "-c", `sleep ${marker} & sleep ${marker}`], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "" }, cwd: workspace });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const alive = () => spawnSync("sh", ["-c", `ps -eo args | grep -c '^sleep ${marker}$' || true`], { encoding: "utf8" }).stdout.trim();
  assert.equal(alive(), "2", "both sleeps are running under the runner");
  const closed = new Promise((resolve) => child.once("close", resolve));
  process.kill(-/** @type {number} */ (child.pid), "SIGTERM");
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(alive(), "0", "the group's SIGTERM stopped the command and what it started");
  await rm(workspace, { recursive: true, force: true });
});

test("network access is the same as under the kernel's runner: a loopback connection works through both", needsLandlock, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "evimed-ws-"));
  const runner = await runnerWith({ launcher: realLauncher });
  const server = createServer((socket) => { socket.end("hello"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const { direct, through } = await new Promise((resolve) => {
    // Asynchronous: the server above lives in this process, which a synchronous spawn would block.
    const results = /** @type {any[]} */ ([]);
    let done = 0;
    const finish = () => { done += 1; if (done === 2) resolve({ direct: results[0], through: results[1] }); };
    const command = ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3`];
    const env = { PATH: process.env.PATH ?? "" };
    for (const [slot, [file, args]] of /** @type {[string, string[]][]} */ ([[realLauncher, [...builtinArgs(workspace), "--", ...command]], [runner, [...kernelProfile(workspace), "--", ...command]]]).entries()) {
      const child = spawn(file, args, { env, cwd: workspace });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", (status) => { results[slot] = { status, out }; finish(); });
    }
  });
  server.close();
  assert.deepEqual(through, direct);
  assert.deepEqual(through, { status: 0, out: "hello" });
  await rm(workspace, { recursive: true, force: true });
});

test("Python's process pools work through the runner and fail through the kernel's own", needsPool, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "evimed-ws-"));
  const runner = await runnerWith({ launcher: realLauncher });
  const pool = "import multiprocessing as mp; p = mp.Pool(2); print(p.map(abs, [-1, -2, -3]), end=''); p.close(); p.join()";
  const executor = "from concurrent.futures import ProcessPoolExecutor as P\nwith P(2) as e: print(list(e.map(abs, [-4, -5])), end='')";
  for (const [label, source, wanted] of /** @type {[string, string, string][]} */ ([["multiprocessing.Pool", pool, "[1, 2, 3]"], ["ProcessPoolExecutor", executor, "[4, 5]"]])) {
    const { direct, through } = both(runner, workspace, ["python3", "-c", source]);
    assert.equal(direct.status === 0, false, `${label} still fails under the kernel's own runner (the defect this runner works around)`);
    assert.match(direct.stderr.toString(), /PermissionError/);
    assert.equal(through.status, 0, `${label}: ${through.stderr.toString()}`);
    assert.equal(through.stdout.toString(), wanted);
  }
  // What a pool leaves in /dev/shm is a pool's to clean up; a writable /dev/shm is not a writable root.
  const outside = both(runner, workspace, ["python3", "-c", "import os\ntry:\n    open('/etc/evimed-probe','w')\nexcept PermissionError:\n    print('denied', end='')"]);
  assert.equal(outside.through.stdout.toString(), "denied");
  await rm(workspace, { recursive: true, force: true });
});
