import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_HEALTH_URL = "http://127.0.0.1:8081/api/v1/instance/profile";

export async function isMemosReady({
  healthUrl = DEFAULT_HEALTH_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForMemos({
  healthUrl = DEFAULT_HEALTH_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  intervalMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await isMemosReady({ healthUrl, fetchImpl })) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return false;
}

export async function ensureLocalMemos({
  memosRoot,
  dataDir,
  accessTokenFile,
  enabled = true,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  stderr = process.stderr,
} = {}) {
  if (!enabled || !existsSync(accessTokenFile)) return null;
  if (await isMemosReady({ fetchImpl })) return null;
  if (!existsSync(memosRoot)) {
    throw new Error(`Memos source directory is missing: ${memosRoot}`);
  }

  const child = spawnImpl(
    "go",
    ["run", "./cmd/memos", "--addr", "127.0.0.1", "--port", "8081", "--data", dataDir],
    { cwd: memosRoot, stdio: "inherit" },
  );
  child.once("error", (error) => {
    stderr.write(`Failed to start local Memos: ${error.message}\n`);
  });

  const ready = await waitForMemos({ fetchImpl });
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error("Local Memos did not become ready within 60 seconds.");
  }
  return child;
}

export function registerMemosCleanup(child, processRef = process) {
  if (!child) return;
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  processRef.once("exit", stop);
}
