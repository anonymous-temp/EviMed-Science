#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalMemos, registerMemosCleanup } from "./local-memos.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const secretsDir = path.resolve(rootDir, "..", ".evimed-local", "secrets");
const staticDir = path.join(rootDir, "apps", "desktop", "dist");
const memosRoot = path.resolve(rootDir, "..", "记忆模块");
const memosDataDir = path.resolve(rootDir, "..", ".evimed-local", "memos");

process.env.OPEN_SCIENCE_LOCAL_AUTO_CONFIG ??= "true";
process.env.OPEN_SCIENCE_PORT ??= "8798";
process.env.OPEN_SCIENCE_AUTH_MODE ??= "local";
process.env.OPEN_SCIENCE_BOOTSTRAP_USER ??= "evimed";
// This wrapper is intentionally local-only. Production deployments keep the
// container runtime boundary and never inherit this host-runtime opt-in.
process.env.OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME ??= "true";
process.env.OPEN_SCIENCE_ENABLE_KERNEL ??= "true";
process.env.OPEN_SCIENCE_KERNEL_SANDBOX_MODE ??= "host";
process.env.OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL ??= "true";
if (existsSync(staticDir)) process.env.OPEN_SCIENCE_STATIC_DIR ??= staticDir;

const deepseekKey = path.join(secretsDir, "deepseek.api-key");
if (!existsSync(deepseekKey)) {
  process.stderr.write(
    `DeepSeek is not configured. Put the API key in ${deepseekKey} with mode 600, then restart.\n`,
  );
}

const evimedKey = path.join(secretsDir, "evimed.api-key");
if (!existsSync(evimedKey)) {
  process.stderr.write(
    `EviMed evidence search is not configured. Put the API key in ${evimedKey} with mode 600, then restart.\n`,
  );
}

const memosProcess = await ensureLocalMemos({
  memosRoot,
  dataDir: memosDataDir,
  accessTokenFile: path.join(secretsDir, "memos.pat"),
  enabled: process.env.OPEN_SCIENCE_START_LOCAL_MEMOS !== "false",
});
registerMemosCleanup(memosProcess);

await import("../../apps/server/src/index.mjs");
