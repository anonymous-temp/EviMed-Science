#!/usr/bin/env node
import { randomBytes } from "node:crypto";

// Host-importable on purpose: this script runs from a release directory that
// has no `node_modules`, and `modelGateway.mjs` imports nothing outside Node.
import { supportedDeepSeekModels } from "../../apps/server/src/modelGateway.mjs";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * What this run observed but does not judge.
 *
 * This gate proves platform properties — ready, kernel up, the run completed,
 * the deliverable landed, the receipt matches, the gate ran, the ledger is
 * right — and every one of those is decidable. A judgement about what the model
 * chose to write into a delivered file is not, and one of them was blocking:
 * across four runs on one acceptance stack, with the adapter reaching openFDA
 * every time, signals.csv had data rows in one run and none in the next. A
 * check that is neither deterministic nor budgeted is exactly what "ship it as
 * a notice until a distribution exists" was written for.
 *
 * Notices carry the observed value, because "downgraded to a notice" and
 * "deleted" differ only in whether anybody can still see the number.
 * @type {{ code: string, observed: string }[]}
 */
const notices = [];

/** @param {string} code @param {string} observed */
function notice(code, observed) {
  notices.push({ code, observed });
}

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw failure("hosted_e2e_configuration_missing", `${name} is required.`);
  return value;
}

function baseUrl() {
  const parsed = new URL(required("OPEN_SCIENCE_E2E_BASE_URL"));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw failure("hosted_e2e_base_url_invalid", "OPEN_SCIENCE_E2E_BASE_URL must be an HTTP(S) origin.");
  }
  return parsed.origin;
}

async function jsonFetch(url, options = {}, expected = null) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { throw failure("hosted_e2e_response_invalid", `${url} returned invalid JSON.`); }
  }
  if (expected == null ? !response.ok : response.status !== expected) {
    const code = body?.code ?? body?.data?.code ?? "unexpected_status";
    throw failure("hosted_e2e_request_failed", `${options.method ?? "GET"} ${new URL(url).pathname} -> ${response.status} (${code})`);
  }
  return { response, body };
}

async function command(base, name, args, headers) {
  return jsonFetch(`${base}/api/commands/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(args ?? {}),
  });
}

async function authenticate(base) {
  const cookie = String(process.env.OPEN_SCIENCE_E2E_SESSION_COOKIE ?? "").trim();
  const csrf = String(process.env.OPEN_SCIENCE_E2E_CSRF_TOKEN ?? "").trim();
  if (cookie && csrf) return { Cookie: cookie, "X-Open-Science-CSRF": csrf };
  const result = await jsonFetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: required("OPEN_SCIENCE_E2E_USERNAME"),
      password: required("OPEN_SCIENCE_E2E_PASSWORD"),
    }),
  });
  const sessionCookie = result.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrfToken = result.body?.data?.csrfToken ?? "";
  if (!sessionCookie || !csrfToken) throw failure("hosted_e2e_auth_invalid", "Authentication did not return session credentials.");
  return { Cookie: sessionCookie, "X-Open-Science-CSRF": csrfToken };
}

async function waitForRun(base, runId, headers) {
  const deadline = Date.now() + Number(process.env.OPEN_SCIENCE_E2E_RUN_TIMEOUT_MS ?? 1_800_000);
  while (Date.now() < deadline) {
    const listed = await jsonFetch(`${base}/api/agent-runs`, { headers });
    const run = listed.body?.data?.find((item) => item.id === runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw failure("hosted_e2e_run_timeout", "The production agent run did not reach a terminal state.");
}

/**
 * The mechanical half: did the memory pipeline run at all?
 *
 * `recordRun` writes a run-summary record before it extracts anything, so this
 * record existing proves the pipeline executed, built sources from the
 * transcript, and that the memory service accepted a write. That is a property
 * of this deployment and stays blocking — without it, "the extractor produced
 * nothing" and "the extractor never ran" arrive as the same silence, which is
 * the shape this whole gate exists to refuse.
 */
async function waitForRunSummary(base, headers, projectId, runId) {
  const deadline = Date.now() + Number(process.env.OPEN_SCIENCE_E2E_MEMORY_TIMEOUT_MS ?? 180_000);
  const key = `run.${runId}`.toLowerCase();
  const url = `${base}/api/memory/records?scope=project&kind=run_summary&scopeId=${encodeURIComponent(projectId)}&pageSize=100`;
  while (Date.now() < deadline) {
    const listed = await jsonFetch(url, { headers });
    const record = (listed.body?.data ?? []).find((item) => String(item.key ?? "").toLowerCase() === key);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw failure(
    "hosted_e2e_memory_pipeline_missing",
    `No run-summary memory record for ${runId}: the memory pipeline did not run, or the memory service refused its write.`,
  );
}

async function waitForMemoryRecord(base, headers, initialIds, marker) {
  // Longer than the extraction's own budget, which is the point.
  //
  // This waited 90s for a pipeline the server gives 120s
  // (`memoryExtractionTimeoutMs`), so an extraction that was merely slow lost a
  // race it had not been told it was in, and the gate reported it as "the
  // conversation produced no structured memory" — a content verdict about a
  // timing accident. Same shape as the batch harness waiting 30 minutes for
  // runs that take forty.
  const deadline = Date.now() + Number(process.env.OPEN_SCIENCE_E2E_MEMORY_TIMEOUT_MS ?? 180_000);
  while (Date.now() < deadline) {
    const profile = await jsonFetch(`${base}/api/memory/profile`, { headers });
    const record = profile.body?.data?.records?.find((item) =>
      !initialIds.has(item.id)
      && item.scope === "user"
      && item.kind === "preference"
      && JSON.stringify(item).includes(marker)
    );
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  // Not a verdict any more: whether the extractor found a durable preference in
  // this particular conversation is the model's behaviour, and the caller
  // records it instead of failing on it.
  return null;
}

/**
 * @param {Record<string, any>} ready
 * @returns {string} the certified model this deployment actually serves
 */
function assertReady(ready) {
  const checks = ready?.data?.checks;
  if (!ready?.data?.ok || !checks) throw failure("hosted_e2e_not_ready", "The hosted deployment is not ready.");
  // `mode` is the runtime's shape and `kernel` names which kernel the image
  // actually carries; readiness reports both on every branch. This pinned the
  // retired kernel's mode name, a value `/api/ready` can no longer produce, so
  // the gate would have refused every deployment of the current kernel at its
  // first request — in the same hour the kernel is switched and it is most
  // needed. Both halves stay: "sandboxed Docker runtime" and "the DSH kernel"
  // are separate claims, and a deployment can satisfy one without the other.
  if (checks.runtime?.mode !== "kernel" || checks.runtime?.sandboxMode !== "docker") {
    throw failure("hosted_e2e_runtime_not_real", "Hosted E2E requires the Docker kernel runtime.");
  }
  if (checks.runtime?.kernel !== "dsh") {
    throw failure(
      "hosted_e2e_runtime_kernel_unexpected",
      `Hosted E2E requires the DSH kernel; the deployment reports ${checks.runtime?.kernel ?? "no kernel"}.`,
    );
  }
  if (checks.kernel?.enabled !== true || checks.kernel?.sandboxMode !== "docker") {
    throw failure("hosted_e2e_kernel_not_real", "Hosted E2E requires the Docker notebook kernel.");
  }
  if (checks.stateStore?.mode !== "postgres" || checks.stateStore?.shared !== true) {
    throw failure("hosted_e2e_state_not_shared", "Hosted E2E requires the PostgreSQL state store.");
  }
  if (checks.memory?.required !== true || checks.memory?.connected !== true) {
    throw failure("hosted_e2e_memory_not_connected", "Hosted E2E requires a connected Memos service.");
  }
  // Which certified model serves is a deployment decision — the pilot runs
  // `deepseek-v4-flash` — and the receipt certifies whichever one actually
  // answered rather than a name written here. This asked for `deepseek-v4-pro`
  // by literal and refused a deployment that was green, with a message naming
  // a model nobody had configured. The list comes from the gateway's own
  // certified set, which is where that decision is made.
  if (checks.modelGateway?.enabled !== true || !supportedDeepSeekModels.has(String(checks.modelGateway?.model ?? ""))) {
    throw failure(
      "hosted_e2e_deepseek_not_ready",
      `Hosted E2E requires a certified DeepSeek gateway and release receipt; readiness reports ${JSON.stringify(checks.modelGateway?.model ?? null)}, certified are ${[...supportedDeepSeekModels].join(", ")}.`,
    );
  }
  if (checks.release?.tracked !== true) {
    throw failure("hosted_e2e_release_untracked", "Hosted E2E requires immutable release provenance.");
  }
  return String(checks.modelGateway.model);
}

async function main() {
  const base = baseUrl();
  const ready = await jsonFetch(`${base}/api/ready`);
  // The model this deployment certified, carried through every assertion below
  // instead of written out again. Three of them named `deepseek-v4-pro` by
  // literal while the pilot serves `deepseek-v4-flash`, so the run would have
  // been asked to write one model's name and judged against another's.
  const certifiedModel = assertReady(ready.body);
  const auth = await authenticate(base);
  const marker = randomBytes(12).toString("hex");
  const knowledgeMarker = `KB_${marker}`;
  const memoryMarker = `MEM_${marker}`;
  const preferenceMarker = `PREF_${marker}`;
  const projectId = `e2e-${marker}`;
  const initialProfile = await jsonFetch(`${base}/api/memory/profile`, { headers: auth });
  const initialRecordIds = new Set((initialProfile.body?.data?.records ?? []).map((record) => record.id));
  let memoId = null;
  let projectCreated = false;
  let scoped = null;
  let runtimeStarted = false;
  try {
    const project = await jsonFetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ id: projectId, name: `Hosted production E2E ${marker}` }),
    });
    if (project.body?.data?.id !== projectId) throw failure("hosted_e2e_project_invalid", "Project creation returned the wrong identity.");
    projectCreated = true;
    scoped = { ...auth, "X-Open-Science-Project": projectId };

    const memo = await jsonFetch(`${base}/api/memory/memos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ content: `Production memory evidence marker ${memoryMarker}` }),
    });
    memoId = memo.body?.data?.id ?? null;
    if (!memoId) throw failure("hosted_e2e_memory_create_failed", "Memos did not return a persisted memo id.");

    await jsonFetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        filename: "knowledge-base/production-e2e-evidence.txt",
        encoding: "base64",
        data: Buffer.from(`Production knowledge evidence marker ${knowledgeMarker}\n`, "utf8").toString("base64"),
      }),
    });

    const runtime = await command(base, "start_runtime", {}, scoped);
    runtimeStarted = true;
    // The control plane's own surface, not a kernel's. This used to assert a
    // per-kernel pass-through base `/api/<kernel>/:projectId`, a route retired
    // when the browser stopped speaking a kernel's protocol — so this gate
    // would have failed on its first request against the deployment it is
    // meant to certify. `dsh` is the whole kernel vocabulary now, so it is the
    // whole guard.
    const runtimeUrl = runtime.body?.data;
    if (typeof runtimeUrl !== "string" || !runtimeUrl.endsWith("/api/runtime")) {
      throw failure("hosted_e2e_runtime_url_invalid", "The hosted runtime URL is invalid.");
    }
    if (/dsh/.test(runtimeUrl)) {
      throw failure("hosted_e2e_runtime_url_invalid", "start_runtime handed back a kernel-shaped URL.");
    }
    const agents = await jsonFetch(`${base}/api/agents`, { headers: scoped });
    const agent = agents.body?.data?.find((item) => item.id === "adr-analysis");
    if (!agent?.version || agent.runtimeAgent !== "evimed-adr-analysis") {
      throw failure("hosted_e2e_specialist_missing", "The drug-safety specialist is not registered.");
    }
    if (!agent.requiredInputs?.includes("drug") || !agent.requiredTools?.includes("drug_safety_analysis")) {
      throw failure("hosted_e2e_specialist_contract_invalid", "The drug-safety specialist input or tool contract is incomplete.");
    }
    for (const requiredPath of ["safety-report.md", "signals.csv"]) {
      if (!agent.outputs?.some((output) => output.path === requiredPath && output.required === true)) {
        throw failure("hosted_e2e_specialist_contract_invalid", `The specialist does not require ${requiredPath}.`);
      }
    }
    const session = await jsonFetch(`${runtimeUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: "{}",
    });
    const sessionId = session.body?.data?.id;
    if (!sessionId) throw failure("hosted_e2e_session_invalid", "The control plane returned no real session id.");
    if (/^web_mock_/.test(sessionId)) throw failure("hosted_e2e_runtime_not_real", "Mock session ids are forbidden in production E2E.");
    await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({ mode: "specialist", agentId: agent.id, agentVersion: agent.version }),
    });

    const artifactPath = "artifacts/hosted-production-e2e.json";
    const dispatched = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        sessionId,
        dispatchId: `dispatch-${marker}`,
        text: [
          "Analyze aspirin (drug=aspirin) with the registered drug-safety specialist.",
          "Call drug_safety_analysis with action=capabilities, then action=start, then poll status with waitSeconds=45 until terminal.",
          "Use the managed specialist data and artifacts; do not synthesize signal values or substitute model knowledge for FAERS statistics.",
          "Write the required safety-report.md and signals.csv files. Preserve source scope, analysis period, suspect binding, counts, and signal metrics, and state spontaneous-reporting limitations.",
          `Use the automatically retrieved knowledge marker ${knowledgeMarker} and Memos memory marker ${memoryMarker}.`,
          `请记住：我的长期回答偏好是先呈现证据确定性，再给建议；偏好校验码是 ${preferenceMarker}。`,
          `Use the write tool to create exactly ${artifactPath} as valid JSON with keys marker, knowledge, memory, agent, and model.`,
          `The values must be exactly ${marker}, ${knowledgeMarker}, ${memoryMarker}, evimed-adr-analysis, and ${certifiedModel}.`,
          "Do not invent or transform either evidence marker.",
        ].join("\n"),
      }),
    }, 202);
    const run = await waitForRun(base, dispatched.body?.data?.id, scoped);
    if (run?.status !== "succeeded") {
      throw failure("hosted_e2e_agent_run_failed", `The real specialist run ended as ${run?.status ?? "missing"} (${run?.errorCode ?? "no_error_code"}).`);
    }
    if (run.mode !== "specialist" || run.runtimeAgent !== "evimed-adr-analysis" || run.model !== `deepseek/${certifiedModel}`) {
      throw failure("hosted_e2e_provenance_invalid", "The agent-run ledger does not prove specialist DeepSeek routing.");
    }
    for (const requiredPath of ["safety-report.md", "signals.csv"]) {
      if (!run.artifacts?.includes(requiredPath)) {
        throw failure("hosted_e2e_specialist_output_untracked", `The run ledger does not track ${requiredPath}.`);
      }
    }
    const transcript = await jsonFetch(
      `${runtimeUrl}/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { headers: scoped },
    );
    const messages = transcript.body?.data?.messages ?? [];
    if (!Array.isArray(messages) || !messages.some((message) => message?.role === "user")) {
      throw failure("hosted_e2e_transcript_invalid", "The run transcript carries no user message.");
    }
    // Independent confirmation that the specialist actually ran, read from the
    // transcript rather than from the ledger that already claims it.
    //
    // The old check read `info.agent` off the retired kernel's own message
    // record. The control plane's transcript has no per-message agent — it is
    // deliberately kernel-neutral — so the equivalent evidence is its own tool
    // appearing in the run: a package that merely says it routed to the drug
    // safety agent, without ever calling it, fails here.
    const calledTools = messages
      .flatMap((message) => message?.parts ?? [])
      .filter((part) => part?.type === "tool")
      .map((part) => String(part.tool ?? ""));
    if (!calledTools.some((tool) => tool.includes("drug_safety_analysis"))) {
      throw failure(
        "hosted_e2e_specialist_not_pinned",
        `The transcript shows no drug_safety_analysis call, so the specialist did not run (tools: ${[...new Set(calledTools)].slice(0, 12).join(", ") || "none"}).`,
      );
    }
    const artifact = await command(base, "read_artifact", { path: artifactPath }, scoped);
    const artifactText = artifact.body?.data?.data;
    if (artifact.body?.data?.encoding !== "utf8" || typeof artifactText !== "string") {
      throw failure("hosted_e2e_artifact_missing", "The real artifact was not persisted.");
    }
    let evidence;
    try { evidence = JSON.parse(artifactText); } catch { throw failure("hosted_e2e_artifact_invalid", "The production artifact is not valid JSON."); }
    assertExact(evidence, { marker, knowledge: knowledgeMarker, memory: memoryMarker, agent: "evimed-adr-analysis", model: certifiedModel });

    const safetyReport = await command(base, "read_artifact", { path: "safety-report.md" }, scoped);
    const reportText = safetyReport.body?.data?.data;
    if (safetyReport.body?.data?.encoding !== "utf8" || typeof reportText !== "string" || reportText.length < 800) {
      throw failure("hosted_e2e_safety_report_invalid", "The production safety report is missing or too small for a substantive result.");
    }
    const normalizedReport = reportText.toLowerCase();
    if (!(normalizedReport.includes("aspirin") || reportText.includes("阿司匹林"))
      || !(normalizedReport.includes("faers") || normalizedReport.includes("openfda"))
      || !(reportText.includes("局限") || normalizedReport.includes("limitation"))) {
      throw failure("hosted_e2e_safety_report_invalid", "The production safety report lacks drug, provenance, or limitation content.");
    }
    const signals = await command(base, "read_artifact", { path: "signals.csv" }, scoped);
    const signalsText = signals.body?.data?.data;
    // Delivery is the platform's job and stays blocking: the file has to exist,
    // be readable, and not be empty.
    if (signals.body?.data?.encoding !== "utf8" || typeof signalsText !== "string" || !signalsText.trim()) {
      throw failure("hosted_e2e_signals_invalid", "The production signal table is missing or empty.");
    }
    // Whether the specialist transcribed the figures it retrieved into rows is
    // the model's habit, not a property of this deployment. Recorded, not judged
    // — and if it should be required, it belongs in the adr-analysis-report
    // contract where a workspace artifact is mechanically decidable, after a
    // distribution says how often it happens.
    const signalRows = signalsText.split(/\r?\n/).filter(Boolean).length - 1;
    if (signalRows < 1) notice("signals_table_has_no_data_rows", `signals.csv carried a header and ${signalRows < 0 ? 0 : signalRows} data row(s)`);
    const signalHeader = signalsText.split(/\r?\n/, 1)[0].toLowerCase();
    if (!signalHeader.includes(",") || !/(ror|prr|ebgm|\bic\b)/.test(signalHeader)) {
      throw failure("hosted_e2e_signals_invalid", "The production signal table does not expose a disproportionality metric.");
    }

    // Mechanical first, and blocking: the pipeline ran and the memory service
    // took its write.
    await waitForRunSummary(base, scoped, projectId, run.id);

    const memoryRecord = await waitForMemoryRecord(base, scoped, initialRecordIds, preferenceMarker);
    if (!memoryRecord) {
      // Content, and recorded rather than judged. Measured 2026-09-01 on one
      // acceptance stack, same brief and same code: one run proposed six
      // candidates and adopted six, the next proposed none and rejected none —
      // the extractor simply returned nothing. Twenty-three messages holding no
      // durable fact is a legitimate outcome, and it is indistinguishable from
      // model reticence, so it joins the same distribution as the signals table
      // before anyone decides where the requirement belongs.
      const finished = await jsonFetch(`${base}/api/agent-runs`, { headers: scoped });
      const counts = (finished.body?.data ?? []).find((item) => item.id === run.id)?.qualityNotices
        ?.find((line) => String(line).includes("记忆抽取未产出记录"));
      notice(
        "memory_extraction_produced_no_preference",
        counts ? String(counts) : "the run recorded no extraction counts",
      );
    } else {
      // Six conditions under one message meant a run told you the memory was
      // wrong without telling you which part, and the record is deleted with
      // the project moments later — so the answer was gone before anyone could
      // look.
      const memoryFaults = [
        memoryRecord.scope !== "user" ? `scope=${memoryRecord.scope}` : null,
        memoryRecord.kind !== "preference" ? `kind=${memoryRecord.kind}` : null,
        memoryRecord.origin !== "explicit" ? `origin=${memoryRecord.origin}` : null,
        memoryRecord.status !== "active" ? `status=${memoryRecord.status}` : null,
        memoryRecord.evidenceCount < 1 ? `evidenceCount=${memoryRecord.evidenceCount}` : null,
        memoryRecord.evidence?.some((item) => item.quote?.includes(preferenceMarker))
          ? null
          : `no evidence quote carries the marker (quotes=${(memoryRecord.evidence ?? []).length})`,
      ].filter(Boolean);
      if (memoryFaults.length) {
        // Still blocking, and deliberately so: since the client now applies the
        // memory service's own bounds before sending, no model output should be
        // able to produce an invalid record. If this fires it is our defect —
        // which is exactly what it caught last time.
        throw failure(
          "hosted_e2e_memory_evidence_invalid",
          `The structured preference memory is not explicit, evidenced and active: ${memoryFaults.join("; ")}.`,
        );
      }
    }

    await command(base, "write_workspace_file", {
      path: "e2e/kernel.ipynb",
      content: `${JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })}\n`,
    }, scoped);
    const python = await command(base, "kernel_execute", {
      language: "python",
      notebook: "e2e/kernel.ipynb",
      root: "workspace",
      code: "import numpy as np, pandas as pd\nfrom scipy import stats\nprint(float(stats.gmean(np.array([1.0, 4.0]))))\nprint(int(pd.Series([1,2,3]).sum()))",
    }, scoped);
    if (!python.body?.data?.ok || !python.body.data.stdout.includes("2.0") || !python.body.data.stdout.includes("6")) {
      throw failure("hosted_e2e_python_kernel_failed", "The production Python scientific kernel failed.");
    }
    const r = await command(base, "kernel_execute", {
      language: "r",
      notebook: "e2e/kernel.ipynb",
      root: "workspace",
      code: "cat(mean(c(1,2,3)), '\\n')",
    }, scoped);
    if (!r.body?.data?.ok || !r.body.data.stdout.includes("2")) {
      throw failure("hosted_e2e_r_kernel_failed", "The production R kernel failed.");
    }
    // The kernel identity is printed, not just asserted: "which kernel did the
    // release gate actually certify" is the question this run is the only
    // record of.
    const runtimeCheck = ready.body.data.checks.runtime;
    process.stdout.write(
      `hosted production E2E ok: release=${ready.body.data.checks.release.releaseId}`
      + ` kernel=${runtimeCheck.kernel}@${runtimeCheck.kernelVersion ?? "unknown"} project=${projectId}\n`,
    );
  } finally {
    if (runtimeStarted && scoped) {
      await command(base, "stop_runtime", {}, scoped).catch(() => {});
    }
    if (memoId) {
      await jsonFetch(`${base}/api/memory/memos/${encodeURIComponent(memoId)}`, {
        method: "DELETE",
        headers: auth,
      }).catch(() => {});
    }
    if (scoped) {
      const profile = await jsonFetch(`${base}/api/memory/profile`, { headers: scoped }).catch(() => null);
      for (const record of profile?.body?.data?.records ?? []) {
        if (initialRecordIds.has(record.id)) continue;
        if (record.scopeId !== projectId && !JSON.stringify(record).includes(preferenceMarker)) continue;
        await jsonFetch(`${base}/api/memory/records/${encodeURIComponent(record.id)}`, {
          method: "DELETE",
          headers: scoped,
        }).catch(() => {});
      }
      for (const state of ["normal", "archived"]) {
        const memos = await jsonFetch(`${base}/api/memory/memos?state=${state}`, { headers: auth }).catch(() => null);
        for (const memo of memos?.body?.data ?? []) {
          if (!memo.content?.split("\n").includes(`- Project: ${projectId}`)) continue;
          await jsonFetch(`${base}/api/memory/memos/${encodeURIComponent(memo.id)}`, {
            method: "DELETE",
            headers: auth,
          }).catch(() => {});
        }
      }
    }
    if (projectCreated) {
      await jsonFetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ confirm: projectId }),
      }).catch(() => {});
    }
  }
}

function assertExact(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw failure("hosted_e2e_artifact_invalid", "The production artifact has the wrong shape.");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw failure("hosted_e2e_artifact_evidence_mismatch", `The production artifact field ${key} is incorrect.`);
  }
}

function reportNotices() {
  if (!notices.length) {
    process.stdout.write("hosted production e2e: every mechanical assertion passed, no notices\n");
    return;
  }
  process.stdout.write(`hosted production e2e: every mechanical assertion passed, with ${notices.length} notice(s)\n`);
  for (const entry of notices) process.stdout.write(`  notice ${entry.code}: ${entry.observed}\n`);
}

main().then(reportNotices).catch((error) => {
  process.stderr.write(`${error?.code ?? "hosted_production_e2e_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
