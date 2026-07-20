#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicSourceGatewayHandler,
  PUBLIC_SOURCE_ALLOWED_HOSTS,
  PUBLIC_SOURCE_ALLOWED_POST_ENDPOINTS,
} from "../../apps/server/src/publicSourceGateway.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");
const auditToken = "evimed-connector-audit-token";
const forwarded = [];
const selectedSourceCount = process.argv.filter((value) => value === "--source").length;
let priorGatewayEvidence = null;
try {
  const prior = JSON.parse(await fs.readFile(path.join(resultsDir, "connector-probe-v3.json"), "utf8"));
  priorGatewayEvidence = prior.summary?.gatewayEvidence ?? null;
} catch {
  // A first audit has no prior evidence to merge.
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-connector-gateway-"));
const modelConfig = path.join(temporary, "opencode.json");
await fs.writeFile(modelConfig, JSON.stringify({
  provider: { deepseek: { options: { apiKey: auditToken } } },
}), { mode: 0o600 });

const handler = createPublicSourceGatewayHandler({
  publicSourceGatewayTimeoutMs: 60_000,
  publicSourceGatewayMaxResponseBytes: 4 * 1024 * 1024,
}, {
  assertActiveModelGatewayToken(token) {
    if (token !== auditToken) throw new Error("inactive audit runtime");
    return { userId: "capability-audit", projectId: "connector-gateway" };
  },
}, {
  fetchImpl: async (url, options) => {
    forwarded.push({ host: url.hostname.toLowerCase(), path: url.pathname, method: options.method });
    return fetch(url, options);
  },
});
const server = createServer(handler);

function listen() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close() {
  return new Promise((resolve) => {
    server.close(resolve);
    // The audit client may leave keep-alive sockets open after its last probe.
    // No requests are still in flight once the child exits, so close them
    // explicitly instead of allowing a completed release gate to hang.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function runPython(gatewayUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [
      path.join(here, "run_connector_audit.py"),
      "--require-production-gateway",
      ...process.argv.slice(2),
    ], {
      cwd: path.resolve(here, "../.."),
      env: {
        ...process.env,
        EVIMED_PUBLIC_SOURCE_GATEWAY_URL: gatewayUrl,
        EVIMED_MODEL_CONFIG_FILE: modelConfig,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`connector audit terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function attachGatewayEvidence() {
  const v3File = path.join(resultsDir, "connector-probe-v3.json");
  const document = JSON.parse(await fs.readFile(v3File, "utf8"));
  const hosts = [...new Set(forwarded.map((item) => item.host))].sort();
  const bundledDatasetCount = Array.isArray(document.summary?.bundledDatasetSources)
    ? document.summary.bundledDatasetSources.length
    : 0;
  const minimumRequests = selectedSourceCount
    ? selectedSourceCount * 2
    : (Number(document.summary?.registered ?? 0) - bundledDatasetCount) * 2;
  if (forwarded.length < minimumRequests || forwarded.some((item) => (
    !PUBLIC_SOURCE_ALLOWED_HOSTS.has(item.host)
    || (item.method !== "GET" && (item.method !== "POST" || !PUBLIC_SOURCE_ALLOWED_POST_ENDPOINTS.has(`${item.host}${item.path}`)))
  ))) {
    throw new Error("gateway forwarding evidence is incomplete or contains a non-allowlisted request");
  }
  const prior = selectedSourceCount ? priorGatewayEvidence : null;
  const methods = new Map(Object.entries(prior?.methods ?? {}));
  for (const method of new Set(forwarded.map((item) => item.method))) {
    methods.set(method, Number(methods.get(method) ?? 0) + forwarded.filter((item) => item.method === method).length);
  }
  document.summary.gatewayEvidence = {
    handler: "apps/server/src/publicSourceGateway.mjs",
    forwardedRequests: Number(prior?.forwardedRequests ?? 0) + forwarded.length,
    allowedHostsReached: [...new Set([...(prior?.allowedHostsReached ?? []), ...hosts])].sort(),
    methods: Object.fromEntries([...methods].sort(([left], [right]) => left.localeCompare(right))),
    allRequestsAllowlistedHttpsRead: true,
  };
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  await Promise.all(["connector-probe-v2.json", "connector-probe-v3.json"].map((name) => (
    fs.writeFile(path.join(resultsDir, name), payload)
  )));
}

let exitCode = 1;
try {
  await listen();
  const address = server.address();
  exitCode = await runPython(`http://127.0.0.1:${address.port}/internal/sources/v1/fetch`);
  await attachGatewayEvidence();
} finally {
  if (server.listening) await close();
  await fs.rm(temporary, { recursive: true, force: true });
}
process.exitCode = exitCode;
