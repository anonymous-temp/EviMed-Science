#!/usr/bin/env node
// Does the kernel rollback lever actually roll back?
//
// The flip to the DSH kernel is defended by one argument: it is reversible by a
// config switch. That argument is worth exactly what the switch is worth, and
// the switch was not connected — OPEN_SCIENCE_RUNTIME_KERNEL reached no
// container, so setting it back to `opencode` would have changed nothing and
// reported success. A drill that only reads the configuration would have
// agreed.
//
// So this asks the deployment three separate questions and refuses to accept
// one answer for another:
//
//   1. Which kernel does readiness say it is on? (the config took effect)
//   2. Does a real run reach `succeeded` on it? (the kernel still works)
//   3. How long did each half take? (an operator needs the number before the
//      incident, not during it)
//
// Usage: node scripts/ops/kernel-rollback-drill.mjs <base-url> <expected-kernel>
// with OPEN_SCIENCE_DRILL_USERNAME / OPEN_SCIENCE_DRILL_PASSWORD set.
import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] ?? "").replace(/\/$/, "");
const expectedKernel = String(process.argv[3] ?? "").trim();
assert.ok(baseUrl, "usage: kernel-rollback-drill.mjs <base-url> <expected-kernel>");
assert.ok(["dsh", "opencode"].includes(expectedKernel), `expected kernel must be dsh or opencode, got "${expectedKernel}"`);

const readyTimeoutMs = Number(process.env.OPEN_SCIENCE_DRILL_READY_TIMEOUT_MS ?? 180_000);
const runTimeoutMs = Number(process.env.OPEN_SCIENCE_DRILL_RUN_TIMEOUT_MS ?? 1_500_000);
const expectReady = String(process.env.OPEN_SCIENCE_DRILL_EXPECT_READY ?? "true") !== "false";
const marker = `drill-${Date.now().toString(36)}`;

function log(message) {
  process.stdout.write(`[drill] ${message}\n`);
}

async function json(url, options = {}, expected = 200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
  const body = await response.json().catch(() => null);
  if (response.status !== expected) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${response.status} ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  return { response, body };
}

/**
 * The witness that the lever moved: readiness names the kernel it is on.
 *
 * Waiting on `ok` alone would conflate two answers. The lever moves the kernel;
 * it does not move the release manifest, which pins the runtime image and
 * describes one kernel — so a kernel-only rollback comes up running the right
 * kernel and reporting a release mismatch. That is a true statement about an
 * incomplete rollback, not a failure of the lever, and the two have to be
 * distinguishable. Readiness must still be green for the drill to pass; the
 * exception has to be asked for by name.
 */
async function waitForKernel(kernel) {
  const startedAt = Date.now();
  let last = "no response";
  while (Date.now() - startedAt < readyTimeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      const runtime = body?.data?.checks?.runtime;
      last = `ok=${body?.data?.ok} kernel=${runtime?.kernel ?? "none"}`;
      if (runtime?.kernel === kernel) {
        const red = Object.entries(body?.data?.checks ?? {})
          .filter(([, check]) => check?.ok === false)
          .map(([name, check]) => `${name}:${check.code ?? "no_code"}`);
        if (body?.data?.ok !== true) {
          if (expectReady) {
            throw new Error(`kernel=${kernel} reached, but readiness is not green: ${red.join(", ")}`);
          }
          log(`NOTICE readiness is not green (accepted by OPEN_SCIENCE_DRILL_EXPECT_READY=false): ${red.join(", ")}`);
        }
        return { elapsedMs: Date.now() - startedAt, runtime, red };
      }
    } catch (error) {
      if (String(error?.message ?? "").startsWith("kernel=")) throw error;
      last = String(error?.message ?? error).slice(0, 120);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`readiness never reported kernel=${kernel} within ${readyTimeoutMs}ms (last: ${last})`);
}

async function main() {
  const ready = await waitForKernel(expectedKernel);
  log(`readiness reports kernel=${ready.runtime.kernel} version=${ready.runtime.kernelVersion} after ${ready.elapsedMs}ms`);

  const login = await json(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.OPEN_SCIENCE_DRILL_USERNAME,
      password: process.env.OPEN_SCIENCE_DRILL_PASSWORD,
    }),
  });
  const auth = {
    Cookie: login.response.headers.get("set-cookie")?.split(";")[0] ?? "",
    "X-Open-Science-CSRF": login.body?.data?.csrfToken ?? "",
  };
  assert.ok(auth.Cookie && auth["X-Open-Science-CSRF"], "login did not return session credentials");

  const projectId = `kernel-drill-${marker}`;
  await json(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ id: projectId, name: `Kernel rollback drill ${marker}` }),
  });
  const scoped = { ...auth, "X-Open-Science-Project": projectId };
  let runtimeStarted = false;
  const runStartedAt = Date.now();
  try {
    const started = await json(`${baseUrl}/api/commands/start_runtime`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({}),
    });
    runtimeStarted = true;
    // Asserted, not followed: the control plane reports its own public origin,
    // and a drill that chases that origin measures whether this host can reach
    // it rather than whether the kernel came up.
    const runtimeUrl = String(started.body?.data ?? "");
    assert.ok(runtimeUrl.endsWith("/api/runtime"), `start_runtime returned an unexpected url: ${runtimeUrl}`);
    log(`runtime started after ${Date.now() - runStartedAt}ms`);

    const session = await json(`${baseUrl}/api/runtime/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: "{}",
    });
    const sessionId = session.body?.data?.id;
    assert.ok(sessionId, `session creation returned no id: ${JSON.stringify(session.body).slice(0, 200)}`);
    assert.ok(!/^web_mock_/.test(sessionId), "a mock session id proves no kernel ran");

    // The runtime session and the research session are two records; dispatch
    // reads the second one. Binding open-domain keeps the drill off the
    // specialist delivery gates, which judge a report this brief never asks for.
    await json(`${baseUrl}/api/research-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({ mode: "open-domain" }),
    });

    const dispatched = await json(`${baseUrl}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        sessionId,
        dispatchId: `dispatch-${marker}`,
        // Small on purpose: this drill measures whether the kernel runs, not
        // how well it answers. A long brief would put the model's variability
        // in the middle of a timing an operator has to trust.
        text: `Use the write tool to create exactly artifacts/kernel-drill.txt containing exactly the line ${marker}. Then reply with only that same line.`,
      }),
    }, 202);
    const runId = dispatched.body?.data?.id;
    assert.ok(runId, "dispatch returned no run id");

    const deadline = Date.now() + runTimeoutMs;
    let run = null;
    while (Date.now() < deadline) {
      const listed = await json(`${baseUrl}/api/agent-runs`, { headers: scoped });
      run = listed.body?.data?.find((item) => item.id === runId);
      if (run && run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    assert.equal(
      run?.status,
      "succeeded",
      `run ended as ${run?.status ?? "missing"} (${run?.errorCode ?? "no error code"}) on kernel=${expectedKernel}`,
    );
    log(`run ${runId} succeeded on kernel=${expectedKernel} after ${Date.now() - runStartedAt}ms`);
  } finally {
    if (runtimeStarted) {
      await json(`${baseUrl}/api/commands/stop_runtime`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scoped },
        body: JSON.stringify({}),
      }).catch((error) => log(`stop_runtime failed: ${error.message}`));
    }
    await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      headers: auth,
      signal: AbortSignal.timeout(60_000),
    }).catch(() => {});
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    kernel: expectedKernel,
    kernelVersion: ready.runtime.kernelVersion,
    readyMs: ready.elapsedMs,
    runMs: Date.now() - runStartedAt,
    ...(ready.red.length > 0 ? { readinessRed: ready.red } : {}),
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, kernel: expectedKernel, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
});
