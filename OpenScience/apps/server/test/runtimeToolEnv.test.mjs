import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRuntimeLaunchPlan, runtimeTmpDir } from "../src/runtimeManager.mjs";
import { definedInstallPhases } from "../../../scripts/ops/runtime-install-phases.mjs";

// What the model's shell commands run with, inside the sandbox the kernel puts them in (2026-10-31).
//
// The bash tool starts every command under dsh-sandbox-local's Landlock launcher, whose grants are fixed: read the whole
// tree, write /tmp, the workspace and /dev/null. Four things followed that the runs of the first benchmark round hit and
// the tests below hold:
//   - TMPDIR (the kernel's spill directory under /runtime) is not writable to a command, so `Rscript -e` died;
//   - a command cannot raise its own oom_score_adj (/proc is read-only to it), so a process beside the kernel does;
//   - GNU timeout moves its command out of the process group the kernel signals, so `job_kill` did not stop it;
//   - /tmp is the only writable place a cache can go.
// Measured on the runtime image with the real launcher and production container flags; these tests run the real scripts
// under real bash and real processes, and say so where the sandbox itself cannot be had.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const runtimeDir = path.join(repoRoot, "deploy", "runtime-dsh");
const toolEnv = path.join(runtimeDir, "evimed-tool-env.sh");
const guardScript = path.join(runtimeDir, "evimed-oom-guard.sh");
const shimDir = path.join(runtimeDir, "tool-bin");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");
const gnuTimeout = spawnSync("timeout", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU coreutils") === true;

/** The shim directory the tool environment prepends, as the image installs it. */
const IMAGE_SHIM_DIR = "/usr/local/lib/evimed/tool-bin";

/**
 * A bash with the tool environment as the kernel's shells get it: BASH_ENV set, standard input /dev/null (the bash tool has
 * no stdin to give). Not a socket: Debian's bash takes a socket on standard input for "started by rshd" and sources
 * /etc/bash.bashrc instead of BASH_ENV, and a pipe spawned by Node is a socketpair. Input to feed is piped by a shell.
 */
function bash(args, { env = {}, input = undefined } = {}) {
  const options = {
    env: { PATH: process.env.PATH, HOME: os.homedir(), ...env, BASH_ENV: toolEnv },
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (input === undefined) return spawnSync("bash", args, options);
  return spawnSync("sh", ["-c", 'printf %s "$EVIMED_TEST_INPUT" | bash "$@"', "sh", ...args], { ...options, env: { ...options.env, EVIMED_TEST_INPUT: input } });
}

test("the files the image carries for the model's shell commands are executable where they must be, and every build copies them to the same places", async () => {
  for (const file of [guardScript, path.join(shimDir, "timeout")]) {
    assert.doesNotThrow(() => accessSync(file, constants.X_OK), `${file} must be executable`);
  }
  const wanted = {
    "deploy/runtime-dsh/evimed-oom-guard.sh": "/usr/local/bin/evimed-oom-guard",
    "deploy/runtime-dsh/evimed-tool-env.sh": "/usr/local/lib/evimed/evimed-tool-env.sh",
    "deploy/runtime-dsh/tool-bin/timeout": `${IMAGE_SHIM_DIR}/timeout`,
    "deploy/runtime-dsh/open-science-dsh-serve.sh": "/usr/local/bin/open-science-dsh-serve",
  };
  for (const name of ["Dockerfile", "Dockerfile.agentbay", "Dockerfile.delta"]) {
    const text = await read(`deploy/runtime-dsh/${name}`);
    const copies = Object.fromEntries([...text.matchAll(/^COPY (deploy\/runtime-dsh\/\S+) (\S+)$/gmu)].map((match) => [match[1], match[2]]));
    for (const [source, destination] of Object.entries(wanted)) assert.equal(copies[source], destination, `${name} must copy ${source} to ${destination}`);
  }
  // Modes are set by the serve phase of a full build and by the delta's own line, the same set in both.
  const phase = definedInstallPhases(await read("deploy/runtime-dsh/install-runtime.sh")).get("serve") ?? "";
  const delta = await read("deploy/runtime-dsh/Dockerfile.delta");
  for (const [where, text] of [["the serve phase", phase], ["the delta", delta]]) {
    const executable = /chmod 0755 ([^;\n]+)/u.exec(text)?.[1] ?? "";
    for (const file of ["/usr/local/bin/open-science-dsh-serve", "/usr/local/bin/evimed-oom-guard", `${IMAGE_SHIM_DIR}/timeout`]) {
      assert.ok(executable.split(/\s+/).includes(file), `${where} must make ${file} executable`);
    }
    assert.match(text, /chmod 0644 \/usr\/local\/lib\/evimed\/evimed-tool-env\.sh/);
  }
});

test("the serve script hands the tool environment to the kernel only when the image has it, starts the guard beside the kernel and stops it with the kernel", async () => {
  const serve = await read("deploy/runtime-dsh/open-science-dsh-serve.sh");
  assert.match(serve, /tool_env=\/usr\/local\/lib\/evimed\/evimed-tool-env\.sh\nif \[ -f "\$\{tool_env\}" \]; then export BASH_ENV="\$\{tool_env\}"; fi/);
  // Exported before the kernel is started, or the kernel's shells would not have it.
  assert.ok(serve.indexOf("export BASH_ENV") < serve.indexOf('dsh --profile "${profile}"'));
  assert.match(serve, /if \[ -x \/usr\/local\/bin\/evimed-oom-guard \]; then\n {2}\/usr\/local\/bin\/evimed-oom-guard &\n {2}guard_pid=\$!\nfi/);
  const cleanup = serve.slice(serve.indexOf("cleanup() {"), serve.indexOf("trap cleanup"));
  assert.match(cleanup, /kill [^\n]*guard_pid/);
  assert.match(cleanup, /wait [^\n]*guard_pid/);
  // The guard is not one of the processes whose end ends the container: the kernel and the bridge are.
  assert.match(serve, /wait -n "\$\{dsh_pid\}" "\$\{socat_pid\}"\n/);
  // The scripts' own paths in the image are the ones the Dockerfile copies them to.
  const env = await read("deploy/runtime-dsh/evimed-tool-env.sh");
  assert.ok(env.includes(IMAGE_SHIM_DIR));
});

test("the kernel's TMPDIR becomes /tmp for the commands, and only the kernel's TMPDIR does", async () => {
  // The literal in the script is the launch plan's constant: one changed without the other is a TMPDIR nobody replaces.
  assert.equal(runtimeTmpDir, "/runtime/tmp");
  assert.ok((await read("deploy/runtime-dsh/evimed-tool-env.sh")).includes(`${runtimeTmpDir} | ${runtimeTmpDir}/)`));

  assert.equal(bash(["-c", 'printf %s "$TMPDIR"'], { env: { TMPDIR: "/runtime/tmp" } }).stdout, "/tmp");
  assert.equal(bash(["-c", 'printf %s "$TMPDIR"'], { env: { TMPDIR: "/runtime/tmp/" } }).stdout, "/tmp");
  // A TMPDIR a command (or the person who wrote the script) chose is theirs, in this shell and in a nested one.
  assert.equal(bash(["-c", 'printf %s "$TMPDIR"'], { env: { TMPDIR: "/workspace/own" } }).stdout, "/workspace/own");
  assert.equal(bash(["-c", 'export TMPDIR=/workspace/own; bash -c \'printf %s "$TMPDIR"\''], { env: { TMPDIR: "/runtime/tmp" } }).stdout, "/workspace/own");
  // Exported: what the command starts (R, Python) sees it.
  assert.equal(bash(["-c", "python3 -c 'import os; print(os.environ[\"TMPDIR\"], end=\"\")'"], { env: { TMPDIR: "/runtime/tmp" } }).stdout, "/tmp");
  // No TMPDIR at all is not an error under `set -u`.
  assert.equal(bash(["-u", "-c", "printf ok"], { env: {} }).stdout, "ok");
});

test("the tool environment is silent, keeps the command's exit status and standard input, and is safe under set -e, -u and pipefail", async () => {
  for (const options of [[], ["-e"], ["-u"], ["-eu"], ["-o", "pipefail"], ["-eu", "-o", "pipefail"]]) {
    const quiet = bash([...options, "-c", "true"], { env: { TMPDIR: "/runtime/tmp" } });
    assert.equal(quiet.status, 0, options.join(" "));
    assert.equal(quiet.stdout, "", options.join(" "));
    assert.equal(quiet.stderr, "", options.join(" "));
  }
  const passed = bash(["-c", "cat; exit 7"], { input: "from the pipe\n", env: { TMPDIR: "/runtime/tmp" } });
  assert.equal(passed.stdout, "from the pipe\n");
  assert.equal(passed.status, 7);
  // The shim directory is put in front once: a nested shell finds it there and leaves it.
  const nested = bash(["-c", 'bash -c \'bash -c "printf %s \\"\\$PATH\\""\''], { env: { TMPDIR: "/runtime/tmp" } }).stdout;
  assert.equal(nested.split(":").filter((entry) => entry === IMAGE_SHIM_DIR).length, 1);
  assert.equal(nested.split(":")[0], IMAGE_SHIM_DIR);
  // Not set for an interactive shell or a plain `sh`: BASH_ENV is bash's own, for non-interactive shells.
  assert.equal(spawnSync("sh", ["-c", 'printf %s "$TMPDIR"'], { env: { PATH: process.env.PATH, TMPDIR: "/runtime/tmp", BASH_ENV: toolEnv }, encoding: "utf8" }).stdout, "/runtime/tmp");
});

/** The processes whose command line carries `marker`, from /proc. */
function processesWith(marker) {
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker) && Number(entry) !== process.pid) found.push(Number(entry));
    } catch { /* gone between the listing and the read */ }
  }
  return found;
}

/**
 * Stop a command the way the kernel stops one it was asked to cancel (dsh-subprocess-local: spawn detached, SIGTERM to the
 * negative pid, SIGKILL after the grace period if the group still has a member), and report what is still running after.
 */
async function cancelLikeTheKernel(command) {
  const marker = `${3000 + Math.floor(Math.random() * 1e6)}.${process.pid}`;
  const child = spawn("bash", ["-c", command.replaceAll("MARK", marker)], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: "/runtime/tmp" },
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await wait(700);
    assert.ok(processesWith(marker).length > 0, "the command must be running before it is cancelled");
    process.kill(-child.pid, "SIGTERM");
    await exited;
    await wait(500);
    let groupAlive = true;
    try { process.kill(-child.pid, 0); } catch { groupAlive = false; }
    return { survivors: processesWith(marker), groupAlive };
  } finally {
    for (const pid of processesWith(marker)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}

test("a cancelled command is stopped with what it started: GNU timeout leaves the group the kernel signals, the wrapper does not", { skip: !gnuTimeout && "needs GNU coreutils timeout" }, async () => {
  const pipeline = "timeout 3000 sleep MARK | cat";
  // The control, and the defect the wrapper exists for: GNU timeout puts the command in a process group of its own, so the
  // group the kernel signalled held only the shell and `cat`. The group was empty afterwards, which is what the kernel reads
  // as stopped, and the command was still running (Life_000: `job_kill` answered "requested cancellation" and python went on).
  const unwrapped = await cancelLikeTheKernel(pipeline);
  assert.equal(unwrapped.groupAlive, false);
  assert.ok(unwrapped.survivors.length > 0);
  // With the wrapper first on PATH, as the tool environment puts the image's copy: it is in the signalled group, passes the
  // signal on, and the real timeout signals the command and its tree.
  const wrapped = await cancelLikeTheKernel(`export PATH=${shimDir}:"$PATH"; ${pipeline}`);
  assert.deepEqual(wrapped.survivors, [], "nothing the wrapped command started is left running");
  // A command that is not a pipeline was never affected (bash runs it as the group's own leader), and stays stopped.
  const single = await cancelLikeTheKernel(`export PATH=${shimDir}:"$PATH"; timeout 3000 bash -c "sleep MARK & wait"`);
  assert.deepEqual(single.survivors, []);
});

test("the timeout wrapper is the real timeout to everything but a cancellation: arguments, standard input, exit status, expiry", { skip: !gnuTimeout && "needs GNU coreutils timeout" }, () => {
  const run = (command, input) => spawnSync("bash", ["-c", `export PATH=${shimDir}:"$PATH"; ${command}`], { encoding: "utf8", input, env: { PATH: process.env.PATH }, timeout: 20000 });
  assert.equal(run("command -v timeout").stdout.trim(), path.join(shimDir, "timeout"));
  assert.equal(run("timeout 5 cat", "from the pipe\n").stdout, "from the pipe\n");
  assert.equal(run("timeout 5 sh -c 'exit 7'; echo rc=$?").stdout, "rc=7\n");
  assert.equal(run("timeout 0.3 sleep 5; echo rc=$?").stdout, "rc=124\n", "expiry is the real timeout's: 124");
  assert.equal(run("timeout -s KILL 0.3 sleep 5; echo rc=$?").stdout, "rc=137\n", "options reach the real timeout");
  assert.equal(run("timeout --preserve-status 0.3 sleep 5; echo rc=$?").stdout, "rc=143\n");
  assert.equal(run("timeout 5 /no/such/command 2>/dev/null; echo rc=$?").stdout, "rc=127\n");
  assert.equal(run("timeout --no-such-option true 2>/dev/null; echo rc=$?").stdout, "rc=125\n");
  assert.match(run("timeout --version").stdout, /GNU coreutils/);
  // The command keeps the signal handling the real timeout gives it: SIGINT is the interpreter's own, not ignored.
  assert.match(run("timeout 5 python3 -c 'import signal; print(signal.getsignal(signal.SIGINT))'").stdout, /default_int_handler/);
});

/** Wait until `check` returns something truthy; resolves with it, or throws after `ms`. */
async function until(check, ms, what) {
  for (let spent = 0; spent <= ms; spent += 100) {
    const value = check();
    if (value) return value;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const adjOf = (pid) => {
  try { return readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim(); } catch { return null; }
};

test("the OOM guard raises the processes of a model shell call and what they start, and no other process", async (t) => {
  const own = adjOf(process.pid);
  if (own === "1000") t.skip("the test process is already at the guard's score");
  const guard = spawn("bash", [guardScript], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  guard.stdout.on("data", (chunk) => { said += chunk; });
  const started = [];
  try {
    await until(() => said.includes("oom_score_adj 1000"), 5000, "the guard to announce itself");
    // A model shell call: the environment carries DSH_SHELL=1, as the kernel gives it. It starts a child and a pipeline.
    const tool = spawn("bash", ["-c", "sleep 60 | sleep 60 & sleep 60"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, DSH_SHELL: "1" } });
    started.push(tool);
    // Something else of the kernel's: no marker.
    const helper = spawn("sleep", ["60"], { stdio: "ignore", env: { PATH: process.env.PATH } });
    started.push(helper);
    await until(() => adjOf(tool.pid) === "1000", 6000, "the model's shell to be raised");
    await until(() => {
      const children = readFileSync(`/proc/${tool.pid}/task/${tool.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      return children.length > 0 && children.every((pid) => adjOf(pid) === "1000");
    }, 6000, "what the shell started to be raised too");
    assert.equal(adjOf(helper.pid), own, "a process without the marker keeps its score");
    assert.equal(adjOf(process.pid), own, "and so does the test itself");
  } finally {
    for (const child of started) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
    }
    guard.kill("SIGKILL");
    for (const pid of processesWith("sleep\u000060")) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
});

test("the OOM guard ends with the process that started it, and a failure to raise a score is not its end", async () => {
  // Started the way the serve script starts it, as a child of a shell that is then killed.
  const holder = spawn("bash", ["-c", `bash ${JSON.stringify(guardScript)} >/dev/null 2>&1 & echo $!; exec sleep 600`], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  holder.stdout.on("data", (chunk) => { output += chunk; });
  try {
    const guardPid = Number(await until(() => output.trim() || null, 5000, "the guard's pid"));
    assert.ok(Number.isInteger(guardPid) && guardPid > 1);
    await wait(1200);
    assert.doesNotThrow(() => process.kill(guardPid, 0), "the guard runs while its parent does");
    holder.kill("SIGKILL");
    await until(() => {
      try { process.kill(guardPid, 0); return false; } catch { return true; }
    }, 5000, "the guard to end with its parent");
  } finally {
    holder.kill("SIGKILL");
  }
});

// The sandbox itself. The launcher is the one the kernel installs (`@deepseek-ai/node-addon-system-<platform>`); a machine
// without it, or without Landlock, cannot show this, and the suite then says so by skipping. Run it with
//   EVIMED_LANDLOCK_RUN=<path to landlock-run> node --test test/runtimeToolEnv.test.mjs
const landlockRun = process.env.EVIMED_LANDLOCK_RUN ?? "";
const landlockWorks = landlockRun !== "" && spawnSync(landlockRun, ["--probe"], { encoding: "utf8" }).status === 0;

test("inside the kernel's sandbox a command cannot raise its own score, and the guard outside raises it", { skip: !landlockWorks && "needs EVIMED_LANDLOCK_RUN (the kernel's landlock-run) on a kernel with Landlock" }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "evimed-landlock-"));
  const sandboxed = (script, env = {}) => spawn(landlockRun, ["--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", workspace, "--", "bash", "-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, ...env },
  });
  const guard = spawn("bash", [guardScript], { stdio: "ignore" });
  try {
    const own = await new Promise((resolve) => {
      const child = sandboxed("echo 1000 > /proc/self/oom_score_adj 2>&1; echo rc=$?");
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out));
    });
    assert.match(own, /rc=1/, "writing its own score is refused inside the sandbox");
    const outside = await new Promise((resolve) => {
      const child = sandboxed("sleep 3; cat /proc/self/oom_score_adj", { DSH_SHELL: "1" });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out.trim()));
    });
    assert.equal(outside, "1000", "the guard, outside the sandbox, raised the sandboxed command's score");
  } finally {
    guard.kill("SIGKILL");
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the launch plan gives a command a cache place it can write, and leaves the kernel's own configuration read-only to it", () => {
  const plan = buildRuntimeLaunchPlan(
    {
      dataDir: "/tmp/os-dsh-toolenv",
      runtimeKernel: "dsh",
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeTransport: "unix",
      runtimeNetworkMode: "none",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false,
      runtimeTmpfs: "/tmp:rw,nosuid,nodev,size=64m",
    },
    { id: "p1", userId: "u1", rootDir: "/tmp/os-dsh-toolenv/p1", workspaceDir: "/tmp/os-dsh-toolenv/p1/workspace", runtimeDir: "/tmp/os-dsh-toolenv/p1/runtime" },
    4096,
  );
  const envOf = (name) => plan.args.filter((arg, index) => typeof arg === "string" && arg.startsWith(`${name}=`) && plan.args[index - 1] === "--env");
  // Under /tmp, the one place besides the workspace the sandbox lets a command write.
  assert.deepEqual(envOf("MPLCONFIGDIR"), ["MPLCONFIGDIR=/tmp/matplotlib"]);
  assert.deepEqual(envOf("NUMBA_CACHE_DIR"), ["NUMBA_CACHE_DIR=/tmp/numba-cache"]);
  const tmpfs = plan.args[plan.args.indexOf("--tmpfs") + 1];
  assert.ok(tmpfs.startsWith("/tmp:"), "and /tmp is the bounded tmpfs, not a place on the project volume");
  // The security property that stays: the kernel's configuration is where the sandbox cannot write.
  assert.deepEqual(envOf("XDG_CONFIG_HOME"), ["XDG_CONFIG_HOME=/runtime/xdg-config"]);
  assert.deepEqual(envOf("TMPDIR"), [`TMPDIR=${runtimeTmpDir}`], "the kernel's own temp root is unchanged: the commands' is the startup file's to set");
  assert.ok(!plan.args.some((arg) => typeof arg === "string" && /^(BASH_ENV|MPLCONFIGDIR=\/runtime|NUMBA_CACHE_DIR=\/runtime)/.test(arg)), "BASH_ENV belongs to the image's serve script, never the launch plan");
  void statSync;
});
