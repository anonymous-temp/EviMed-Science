#!/usr/bin/env node
/**
 * What the kernel's local sandbox appends to a custom runner, recorded from the installed kernel itself.
 *
 * `deploy/runtime-dsh/evimed-landlock-run.sh` is the sandbox row's `runnerCommand`: the kernel prepends it to the
 * bwrap-dialect profile `bwrapProfileArgs` builds and to the command, and the runner turns that profile into the
 * Landlock launcher's grants. The runner accepts exactly the profiles dsh-sandbox-local builds today and refuses anything
 * else, so a kernel that changes the profile must be noticed where the kernel is installed, not at the first command of a
 * running session. This module drives the kernel's own `LocalSandboxProvider.confine` for both modes, once with its own
 * Landlock runner and once with a `runnerCommand`, and records both argvs:
 *
 *   node scripts/ops/sandbox-profile.mjs <node_modules of the kernel closure>           write the fixture
 *   node scripts/ops/sandbox-profile.mjs <node_modules of the kernel closure> --check   exit 1 when the fixture differs
 *
 * `verify-harness-seams.mjs` runs the check against the pinned closure; `apps/server/test/runtimeLandlockRunner.test.mjs`
 * replays the recorded argvs through the runner (and, with EVIMED_KERNEL_MODULES, re-records them first).
 *
 * @module sandbox-profile
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
export const FIXTURE = path.join(repo, "deploy/runtime-dsh/fixtures/sandbox-profile.json");

/** Stand-ins for the paths of the image, so the record does not depend on a machine. */
const LAUNCHER = "/launcher/landlock-run";
const RUNNER = "/runner/evimed-landlock-run";
const WORKSPACE = "/work";
const COMMAND = ["bash", "-c", "true"];

/**
 * The argv the kernel produces for each mode, with its own Landlock runner and with a custom runner.
 * @param {string} sandboxLocalDir the installed `@deepseek-ai/dsh-sandbox-local` directory
 * @returns {Promise<{ cases: { mode: string, workspaceRoot: string, command: string[], builtin: string[], runnerCommand: string[], enforcement: string }[] }>}
 */
export async function recordProfiles(sandboxLocalDir) {
  const { LocalSandboxProvider } = await import(pathToFileURL(path.join(sandboxLocalDir, "lib", "index.js")).href);
  /** The provider without a kernel around it: `confine` reads these fields and nothing of the context. @param {{ runnerCommand?: string[], runnerFailureSignatures?: string[] }} config */
  const provider = (config) => {
    const p = Object.create(LocalSandboxProvider.prototype);
    p.runnerCommand = config.runnerCommand?.length ? config.runnerCommand : undefined;
    p.configuredRunnerFailureSignatures = config.runnerFailureSignatures ?? [];
    p.probeTimeoutMs = 5000;
    p.internals = { probeBwrap: () => false, probeLandlock: () => "full", landlockLauncher: LAUNCHER };
    p.workspaceGrants = new Map();
    p.tempCapabilities = new Map();
    return p;
  };
  const cases = [];
  for (const mode of ["read-only", "workspace-write"]) {
    const policy = { mode, workspaceRoot: WORKSPACE };
    const builtin = await provider({}).confine(COMMAND, policy);
    const custom = await provider({ runnerCommand: [RUNNER], runnerFailureSignatures: ["x"] }).confine(COMMAND, policy);
    cases.push({ mode, workspaceRoot: WORKSPACE, command: COMMAND, builtin: builtin.argv, runnerCommand: custom.argv, enforcement: custom.enforcement });
  }
  return { cases };
}

/** @param {string} modulesDir @returns {string} */
export function sandboxLocalDir(modulesDir) {
  return path.join(modulesDir, "@deepseek-ai", "dsh-sandbox-local");
}

/**
 * The document the fixture holds, from an installed closure.
 * @param {string} modulesDir
 */
export async function recordFixture(modulesDir) {
  const pins = JSON.parse(readFileSync(path.join(repo, "deps-version.json"), "utf8"));
  const kernel = JSON.parse(readFileSync(path.join(modulesDir, "@deepseek-ai", "dsh", "package.json"), "utf8"));
  if (kernel.version !== pins.dsh.version) throw new Error(`the closure is ${kernel.version}, the pin is ${pins.dsh.version}; record from the pinned closure`);
  const { cases } = await recordProfiles(sandboxLocalDir(modulesDir));
  return {
    $comment: "What dsh-sandbox-local's `confine` returns for the two modes (read-only, workspace-write): `builtin` is its own Landlock runner's argv, `runnerCommand` the argv it hands a custom runner (the sandbox row's runnerCommand: deploy/runtime-dsh/evimed-landlock-run.sh, the runner's `--ro-bind / / --dev /dev ...` profile, then `--`, then the command). Recorded by scripts/ops/sandbox-profile.mjs from the installed closure of the pin, with stand-in paths; never edit by hand. The runner accepts exactly these two shapes and refuses everything else.",
    pin: pins.dsh.version,
    placeholders: { launcher: LAUNCHER, runner: RUNNER },
    cases,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modules, flag] = process.argv.slice(2);
  if (!modules) {
    process.stderr.write("usage: sandbox-profile.mjs <node_modules of the kernel closure> [--check]\n");
    process.exit(2);
  }
  const document = await recordFixture(path.resolve(modules));
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (flag === "--check") {
    const current = readFileSync(FIXTURE, "utf8");
    if (current !== text) {
      process.stderr.write("deploy/runtime-dsh/fixtures/sandbox-profile.json differs from what the installed kernel produces; re-read evimed-landlock-run.sh against the new profile, then re-record (node scripts/ops/sandbox-profile.mjs <node_modules>)\n");
      process.exit(1);
    }
    process.stdout.write("sandbox profile fixture matches the installed kernel\n");
  } else {
    writeFileSync(FIXTURE, text);
    process.stdout.write(`recorded ${document.cases.length} profiles at ${document.pin} -> ${path.relative(process.cwd(), FIXTURE)}\n`);
  }
}
