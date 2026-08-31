#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workspaceRoot = path.resolve(repoRoot, "..");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const base = option("base", "http://127.0.0.1:8798").replace(/\/$/, "");
const corpusPath = path.resolve(option("corpus", path.join(here, "corpus-v3/manifest.json")));
const label = option("label", "baseline").replace(/[^a-zA-Z0-9_-]/g, "-");
const start = Number(option("start", "0"));
const limit = Number(option("limit", "50"));
const concurrency = Number(option("concurrency", "1"));
const username = option("user", process.env.OPEN_SCIENCE_EVAL_USERNAME ?? "evimed");
// The ceiling used to be 30 minutes, written when every case in this corpus ran
// on the open-domain answer line and finished in two. Today the same prompts
// route to a file-delivery specialist: the first one measured took 38.8. A
// ceiling below the run time turns every case into a timeout and reports it as
// a platform failure.
const runTimeoutMs = Number(option("run-timeout-ms", process.env.OPEN_SCIENCE_EVAL_RUN_TIMEOUT_MS ?? String(75 * 60 * 1000)));
const requestedCaseIds = option("cases", "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const outputDir = path.join(here, "runs", label);
const passwordFile = path.join(workspaceRoot, ".evimed-local", "secrets", "bootstrap-password");

if (!Number.isInteger(start) || start < 0) throw new Error("--start must be a non-negative integer");
if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be between 1 and 50");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
  throw new Error("--concurrency must be between 1 and 3");
}

async function jsonFetch(url, options = {}, expectOk = true) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (expectOk && !response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${response.status} ${JSON.stringify(data)}`);
  }
  return { response, data };
}

async function command(name, args, headers) {
  return jsonFetch(`${base}/api/commands/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(args ?? {}),
  });
}

async function waitForRun(runId, headers) {
  const started = Date.now();
  while (Date.now() - started < runTimeoutMs) {
    const listed = await jsonFetch(`${base}/api/agent-runs?limit=200`, { headers });
    const run = listed.data?.data?.find((item) => item.id === runId);
    if (run && !["queued", "dispatching", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Run ${runId} did not reach a terminal state within ${Math.round(runTimeoutMs / 60000)} minutes`);
}

// The control plane's own transcript shape, not a kernel's: `role` at the top
// level, and parts of type text | reasoning | tool. The browser stopped speaking
// a kernel's vocabulary and so did this.
function messageText(messages, role) {
  return messages
    .filter((message) => message.role === role)
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function toolTrace(messages) {
  return messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "tool")
    .map((part) => ({
      tool: part.tool ?? "",
      status: part.status ?? "",
      callId: part.callId ?? "",
      input: part.input ?? null,
      output: typeof part.output === "string" ? part.output.slice(0, 20_000) : null,
      error: part.error ?? null,
    }));
}

async function captureArtifacts(paths, headers) {
  const captured = [];
  for (const artifactPath of paths ?? []) {
    try {
      const artifact = await command("read_artifact", { path: artifactPath }, headers);
      captured.push({
        path: artifactPath,
        encoding: artifact.data?.data?.encoding ?? "",
        data: artifact.data?.data?.data ?? "",
      });
    } catch (error) {
      captured.push({ path: artifactPath, error: String(error) });
    }
  }
  return captured;
}

async function ensureProject(headers) {
  const projectId = "eval-title-to-paper-v1";
  const existing = await jsonFetch(`${base}/api/projects`, { headers });
  const projects = existing.data?.data ?? [];
  if (!projects.some((project) => project.id === projectId)) {
    await jsonFetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ id: projectId, name: "题目到正文开放获取评测" }),
    });
  }
  return projectId;
}

async function runCase(testCase, context) {
  const resultPath = path.join(outputDir, `${testCase.caseId}.json`);
  try {
    const existing = JSON.parse(await fs.readFile(resultPath, "utf8"));
    if (existing.run?.status === "succeeded" && existing.assistantText) {
      if (!Array.isArray(existing.artifacts)) {
        existing.artifacts = await captureArtifacts(
          existing.run?.artifacts,
          context.scopedHeaders,
        );
        await fs.writeFile(resultPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
      }
      process.stdout.write(`[skip] ${testCase.caseId} ${testCase.title}\n`);
      return existing;
    }
  } catch {}

  process.stdout.write(`[start] ${testCase.caseId} ${testCase.title}\n`);
  // POST /api/runtime/sessions, not a passthrough to the kernel: the runtime
  // pass-through route was retired with the OpenCode kernel, and this harness
  // was still calling it — so it could not run against DSH at all.
  const session = await jsonFetch(`${base}/api/runtime/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...context.scopedHeaders },
    body: "{}",
  });
  const sessionId = session.data?.data?.id;
  if (!sessionId) throw new Error("The control plane returned no session id");
  await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...context.scopedHeaders },
    body: JSON.stringify({ mode: "open-domain" }),
  });
  const dispatchId = `eval_${label}_${testCase.caseId}`.replace(/[^a-zA-Z0-9_]/g, "_");
  const dispatched = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...context.scopedHeaders },
    body: JSON.stringify({ sessionId, dispatchId, text: testCase.prompt }),
  });
  const terminal = await waitForRun(dispatched.data.data.id, context.scopedHeaders);
  const transcript = await jsonFetch(
    `${base}/api/runtime/sessions/${encodeURIComponent(sessionId)}/transcript`,
    { headers: context.scopedHeaders },
  );
  const messages = Array.isArray(transcript.data?.data?.messages) ? transcript.data.data.messages : [];
  const record = {
    schemaVersion: 1,
    label,
    caseId: testCase.caseId,
    category: testCase.category,
    title: testCase.title,
    prompt: testCase.prompt,
    sessionId,
    run: terminal,
    routedTo: terminal?.effectiveAgentId ?? null,
    routeReason: terminal?.effectiveRouteReason ?? null,
    userText: messageText(messages, "user"),
    assistantText: messageText(messages, "assistant"),
    toolTrace: toolTrace(messages),
    artifacts: await captureArtifacts(terminal.artifacts, context.scopedHeaders),
    capturedAt: new Date().toISOString(),
  };
  await fs.writeFile(resultPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(
    `[done] ${testCase.caseId} ${terminal.status} ${record.assistantText.length} chars ${record.toolTrace.length} tools\n`,
  );
  return record;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const corpus = JSON.parse(await fs.readFile(corpusPath, "utf8"));
  const cases = requestedCaseIds.length > 0
    ? corpus.cases.filter((testCase) => requestedCaseIds.includes(testCase.caseId))
    : corpus.cases.slice(start, start + limit);
  if (requestedCaseIds.length > 0 && cases.length !== new Set(requestedCaseIds).size) {
    const found = new Set(cases.map((testCase) => testCase.caseId));
    const missing = [...new Set(requestedCaseIds)].filter((caseId) => !found.has(caseId));
    throw new Error(`Unknown --cases values: ${missing.join(", ")}`);
  }
  const password = (await fs.readFile(passwordFile, "utf8")).trim();
  const login = await jsonFetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrf = login.data?.data?.csrfToken ?? "";
  if (!cookie || !csrf) throw new Error("Local EviMed login did not return cookie and CSRF token");
  const authHeaders = { Cookie: cookie, "X-Open-Science-CSRF": csrf };
  const projectId = await ensureProject(authHeaders);
  const scopedHeaders = { ...authHeaders, "X-Open-Science-Project": projectId };
  // Still booted through the control plane; its URL is no longer a thing this
  // harness talks to.
  await command("start_runtime", {}, scopedHeaders);
  const context = { scopedHeaders };
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await runCase(cases[index], context);
      } catch (error) {
        const failed = {
          schemaVersion: 1,
          label,
          caseId: cases[index].caseId,
          category: cases[index].category,
          title: cases[index].title,
          prompt: cases[index].prompt,
          error: String(error?.stack ?? error),
          capturedAt: new Date().toISOString(),
        };
        await fs.writeFile(
          path.join(outputDir, `${cases[index].caseId}.json`),
          `${JSON.stringify(failed, null, 2)}\n`,
          "utf8",
        );
        results[index] = failed;
        process.stdout.write(`[error] ${cases[index].caseId} ${String(error)}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const summary = {
    schemaVersion: 1,
    label,
    corpusPath,
    startedAtCase: start,
    requestedCases: cases.length,
    succeeded: results.filter((result) => result.run?.status === "succeeded").length,
    failed: results.filter((result) => result.run?.status !== "succeeded").length,
    totalAssistantCharacters: results.reduce(
      (total, result) => total + (result.assistantText?.length ?? 0),
      0,
    ),
    totalArtifactCharacters: results.reduce(
      (total, result) => total + (result.artifacts ?? []).reduce(
        (artifactTotal, artifact) => artifactTotal + (artifact.encoding === "utf8" ? artifact.data.length : 0),
        0,
      ),
      0,
    ),
    completedAt: new Date().toISOString(),
    cases: results.map((result) => ({
      caseId: result.caseId,
      status: result.run?.status ?? "error",
      runId: result.run?.id ?? "",
      assistantCharacters: result.assistantText?.length ?? 0,
      artifactCharacters: (result.artifacts ?? []).reduce(
        (total, artifact) => total + (artifact.encoding === "utf8" ? artifact.data.length : 0),
        0,
      ),
      toolCalls: result.toolTrace?.length ?? 0,
    })),
  };
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed) process.exitCode = 1;
}

await main();
