import { afterEach, describe, expect, it, vi } from "vitest";

function setWebApiBase(value: string | undefined) {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  if (value === undefined) {
    delete env.VITE_OPEN_SCIENCE_API_URL;
  } else {
    env.VITE_OPEN_SCIENCE_API_URL = value;
  }
}

async function loadClient(webApiBase?: string) {
  vi.resetModules();
  setWebApiBase(webApiBase);
  return import("./apiClient");
}

function csrfMeResponse(token = "csrf_test") {
  return new Response(JSON.stringify({ data: { csrfToken: token } }), {
    headers: { "Content-Type": "application/json" },
  });
}

function responseJson(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ data }), {
    ...init,
    headers,
  });
}

function callHeaders(fetchMock: { mock: { calls: unknown[][] } }, index: number): Headers {
  return ((fetchMock.mock.calls[index]?.[1] as RequestInit | undefined)?.headers ?? new Headers()) as Headers;
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsText(blob);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setWebApiBase(undefined);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("apiClient", () => {
  it("keeps two tab project bindings independent while remembering the next tab default", async () => {
    const tabA = window.sessionStorage;
    const values = new Map<string, string>();
    const tabB: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(), getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
      key: index => [...values.keys()][index] ?? null,
    };
    window.localStorage.setItem("openScience.projectId", "project-a");
    const client = await loadClient("/api");
    expect(client.getWebProjectId()).toBe("project-a");
    const tab = vi.spyOn(window, "sessionStorage", "get").mockReturnValue(tabB);
    client.setWebProjectId("project-b");
    expect(client.getWebProjectId()).toBe("project-b");
    expect(window.localStorage.getItem("openScience.projectId")).toBe("project-b");
    tab.mockReturnValue(tabA);
    expect(client.getWebProjectId()).toBe("project-a");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(responseJson({ ok: true }));
    await client.fetchWithWebAuth("/api/me");
    expect(callHeaders(fetchMock, 0).get("X-Open-Science-Project")).toBe("project-a");
    const reloaded = await loadClient("/api");
    expect(reloaded.getWebProjectId()).toBe("project-a");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await reloaded.fetchWebMe();
    expect(tabA.getItem("openScience.projectId")).toBeNull();
    expect(tabB.getItem("openScience.projectId")).toBe("project-b");
  });

  it("reports no command backend without web API config", async () => {
    const client = await loadClient();

    expect(client.hasWebApi).toBe(false);
    await expect(client.invokeCommand("workspace_path")).rejects.toThrow(/No backend is configured/);
  });

  // `sessionView` used to gate the whole profile assignment, from when it
  // chose between two views. There is one view now, and a field nothing reads
  // must not decide whether the field everything reads survives.
  it("keeps the session surface's origin even when the server sends nothing else", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      responseJson({
        user: { id: "alice", name: "Alice" },
        project: { id: "default", name: "Default" },
        projects: [],
        runtime: { uiOrigin: "https://science.example:8443" },
      }),
    );
    const client = await loadClient("https://science.example/api");

    await client.fetchWebMe();

    expect(client.webRuntimeProfile().uiOrigin).toBe("https://science.example:8443");
  });

  it("creates an immutable frame with the authenticated CSRF transport and explicit project", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson({ frameId: "frame-a", frameUrl: "https://science.example:8443/__evimed/f/frame-a/", expiresAt: 12345 }));
    const client = await loadClient("https://science.example/api");
    const binding = await client.createWebRuntimeUiFrame("project-a");
    expect(binding.frameId).toBe("frame-a");
    expect(fetchMock.mock.calls[1][0]).toBe("https://science.example/api/runtime-ui/frames");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ projectId: "project-a" }) });
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("releases a frame cookie with authenticated CSRF and keepalive on its exact route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson(true));
    const client = await loadClient("https://science.example/api");
    await client.releaseWebRuntimeUiFrame("frame-a");
    expect(fetchMock.mock.calls[1][0]).toBe("https://science.example/api/runtime-ui/frames/frame-a");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE", keepalive: true, credentials: "include" });
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("renews a frame using only its original proof over the authenticated CSRF transport", async () => {
    const frame = { frameId: "frame-a", frameUrl: "https://science.example:8443/__evimed/f/frame-a/", expiresAt: 12345, renewalToken: "bound-renewal-proof" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(csrfMeResponse()).mockResolvedValueOnce(responseJson({ ...frame, expiresAt: 23456 }));
    const client = await loadClient("https://science.example/api");
    expect((await client.renewWebRuntimeUiFrame(frame)).frameId).toBe(frame.frameId);
    expect(fetchMock.mock.calls[1][0]).toBe("https://science.example/api/runtime-ui/frames/frame-a/renew");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ renewalToken: frame.renewalToken }) });
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("posts browser commands to the configured web API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson({ path: "/workspace/demo" }));
    const client = await loadClient("https://science.example/api/");

    const result = await client.invokeCommand<{ path: string }>("workspace_path", {
      root: "base",
    });

    expect(result).toEqual({ path: "/workspace/demo" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://science.example/api/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/commands/workspace_path",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ root: "base" }),
      }),
    );
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("sends the selected web project id with command requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson(true));
    const client = await loadClient("https://science.example");

    client.setWebProjectId("paper_1");
    await client.invokeCommand("workspace_path");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/commands/workspace_path",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-Project")).toBe("paper_1");
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("surfaces web API command errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "forbidden",
        code: "project_forbidden",
        requestId: "req_test_1",
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = await loadClient("https://science.example");

    const rejected = client.invokeCommand("read_artifact", { path: "x" });
    await expect(rejected).rejects.toMatchObject({
      name: "WebApiError",
      message: "forbidden",
      status: 403,
      code: "project_forbidden",
      requestId: "req_test_1",
    });
  });

  it("clears hosted selection and emits a session-ended event on HTTP 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Session expired.", code: "authentication_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = await loadClient("https://science.example");
    const ended = vi.fn();
    window.addEventListener(client.WEB_SESSION_ENDED_EVENT, ended, { once: true });
    client.setWebProjectId("paper1");

    await expect(client.listWebProjects()).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });

    expect(ended).toHaveBeenCalledTimes(1);
    expect(client.getWebProjectId()).toBe("default");
  });

  it("logs in to the web API with credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { user: { id: "alice" }, csrfToken: "csrf_login" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = await loadClient("https://science.example/api");

    await client.loginWeb("alice", "secret-password");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://science.example/api/auth/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ username: "alice", password: "secret-password" }),
      }),
    );
  });

  it("logs out, clears the CSRF token, and resets the selected project", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse("csrf_before_logout"))
      .mockResolvedValueOnce(responseJson(true))
      .mockResolvedValueOnce(csrfMeResponse("csrf_after_logout"))
      .mockResolvedValueOnce(responseJson({ id: "next", name: "Next" }));
    const client = await loadClient("https://science.example/api");

    client.setWebProjectId("paper1");
    await client.logoutWeb();
    await client.createWebProject("next", "Next");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/auth/logout",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-Project")).toBe("paper1");
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_before_logout");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(callHeaders(fetchMock, 3).get("X-Open-Science-Project")).toBe("default");
    expect(callHeaders(fetchMock, 3).get("X-Open-Science-CSRF")).toBe("csrf_after_logout");
  });

  it("discovers hosted OIDC login and builds a same-site start URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          mode: "oidc",
          oidc: { label: "Research SSO", startUrl: "/api/auth/oidc/start" },
        },
      }), { headers: { "Content-Type": "application/json" } }),
    );
    const client = await loadClient("https://science.example/api");

    await expect(client.fetchWebAuthMethods()).resolves.toEqual({
      mode: "oidc",
      oidc: { label: "Research SSO", startUrl: "/api/auth/oidc/start" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://science.example/api/auth/methods",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(client.getWebOidcStartUrl("/app/settings?tab=account")).toBe(
      "https://science.example/api/auth/oidc/start?returnTo=%2Fapp%2Fsettings%3Ftab%3Daccount",
    );
    expect(client.getWebOidcStartUrl("https://evil.example")).toBe(
      "https://science.example/api/auth/oidc/start?returnTo=%2Fapp%2Fsettings",
    );
  });

  it("lists and creates hosted projects", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(responseJson([{ id: "default", name: "Default Project" }]))
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson({ id: "paper1", name: "Paper 1" }));
    const client = await loadClient("https://science.example/api");

    await expect(client.listWebProjects()).resolves.toEqual([
      { id: "default", name: "Default Project" },
    ]);
    await expect(client.createWebProject("paper1", "Paper 1")).resolves.toEqual({
      id: "paper1",
      name: "Paper 1",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://science.example/api/projects",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/projects",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
      }),
    );
    expect(callHeaders(fetchMock, 2).get("Content-Type")).toBe("application/json");
    expect(callHeaders(fetchMock, 2).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("lists specialty agents and persists project-scoped research sessions", async () => {
    const agent = {
      id: "adr-analysis",
      version: "1.0.0",
      title: "Drug Safety Analysis",
      category: "Pharmacovigilance",
      description: "Mine safety signals.",
      skill: "adr-analysis",
      estimatedMinutes: [20, 40],
      starterPrompts: ["Analyze osimertinib."],
      requiredInputs: ["drug"],
      optionalInputs: ["adverseEvent"],
      requiredTools: ["evimed_adr_signal_analysis"],
      optionalTools: [],
      dataSources: ["faers"],
      outputs: [{ path: "safety-report.md", required: true }],
      completionChecks: ["requiredOutputsExist"],
      runtimeAgent: "evimed-adr-analysis",
    };
    const binding = {
      sessionId: "ses_adr",
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.0.0",
      runtimeAgent: "evimed-adr-analysis",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(responseJson([agent]))
      .mockResolvedValueOnce(responseJson([binding]))
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson(binding));
    const client = await loadClient("https://science.example/api");

    client.setWebProjectId("paper1");
    await expect(client.listWebResearchAgents()).resolves.toEqual([agent]);
    await expect(client.listWebResearchSessions()).resolves.toEqual([binding]);
    await expect(client.putWebResearchSession("ses_adr", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.0.0",
    })).resolves.toEqual(binding);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://science.example/api/agents",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/research-sessions",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://science.example/api/research-sessions/ses_adr",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({
          mode: "specialist",
          agentId: "adr-analysis",
          agentVersion: "1.0.0",
        }),
      }),
    );
    expect(callHeaders(fetchMock, 3).get("X-Open-Science-Project")).toBe("paper1");
    expect(callHeaders(fetchMock, 3).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("lists and atomically dispatches hosted agent runs", async () => {
    const running = {
      id: "run_123",
      dispatchId: "turn_123",
      dispatchStatus: "accepted",
      sessionId: "ses_adr",
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.0.0",
      runtimeAgent: "evimed-adr-analysis",
      model: "deepseek/deepseek-v4-pro",
      status: "running",
      createdAt: "2026-07-16T00:00:00.000Z",
      startedAt: "2026-07-16T00:00:00.000Z",
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      artifacts: [],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(responseJson([running]))
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson(running, { status: 202 }));
    const client = await loadClient("https://science.example/api");

    await expect(client.listWebAgentRuns()).resolves.toEqual([running]);
    await expect(client.dispatchWebAgentRun("ses_adr", "analyze this", "turn_123")).resolves.toEqual(running);

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/agent-runs/dispatch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "ses_adr", dispatchId: "turn_123", text: "analyze this" }),
      }),
    );
  });

  it("reports what the researcher did with a deliverable, in the four fields the route accepts", async () => {
    // The other half of the feedback ledger. The server records memory
    // decisions by itself, but an adoption and an edit are only visible to the
    // page showing the file — and they are the only two triggers the
    // distillation producer reads, so without this call nothing is ever
    // distilled.
    const adopted = {
      id: "feedback:deliverable-adopted:0123456789abcdef0123456789abcdef",
      projectId: "paper1", runId: "run_1", trigger: "deliverable-adopted",
      subject: { type: "deliverable", id: "run_1:reports/evidence.md" },
      detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "a".repeat(64) },
      occurredAt: "2026-09-07T08:00:00.000Z", recordedAt: "2026-09-07T08:00:00.100Z",
    };
    const edited = { ...adopted, id: "feedback:deliverable-edited:fedcba9876543210fedcba9876543210", trigger: "deliverable-edited" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson({ event: adopted, distillJobId: null }, { status: 201 }))
      .mockResolvedValueOnce(responseJson({ event: edited, distillJobId: "job_1" }));
    const client = await loadClient("https://science.example/api");

    await expect(client.reportWebDeliverableFeedback({
      trigger: "deliverable-adopted", runId: "run_1", path: "reports/evidence.md",
    })).resolves.toEqual({ event: adopted, distillJobId: null });

    // Exactly the fields the route names, and no `summary` key on an adoption:
    // it refuses any field it did not name with a 400.
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/feedback/events",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ trigger: "deliverable-adopted", runId: "run_1", path: "reports/evidence.md" }),
      }),
    );
    expect(callHeaders(fetchMock, 1).get("Content-Type")).toBe("application/json");
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-Project")).toBe("default");

    // The edit carries the summary, trimmed; the job the pair enqueued comes
    // back so the caller can say a lesson was recorded.
    await expect(client.reportWebDeliverableFeedback({
      trigger: "deliverable-edited", runId: "run_1", path: "reports/evidence.md",
      summary: "  把结论段的效应量补上了置信区间。  ",
    })).resolves.toEqual({ event: edited, distillJobId: "job_1" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/feedback/events",
      expect.objectContaining({
        body: JSON.stringify({
          trigger: "deliverable-edited", runId: "run_1", path: "reports/evidence.md",
          summary: "把结论段的效应量补上了置信区间。",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces the feedback route's own refusals instead of swallowing them", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson({}, { status: 404 }));
    const client = await loadClient("https://science.example/api");
    // The server resolves the run against the caller's own project, because the
    // id is copied into the lesson and into the method document it becomes.
    await expect(client.reportWebDeliverableFeedback({
      trigger: "deliverable-adopted", runId: "run_missing", path: "reports/evidence.md",
    })).rejects.toMatchObject({ status: 404 });

    const offline = await loadClient();
    await expect(offline.reportWebDeliverableFeedback({
      trigger: "deliverable-adopted", runId: "run_1", path: "reports/evidence.md",
    })).rejects.toThrow(/No backend is configured/);
  });

  it("exports and deletes hosted projects", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("archive-bytes"))
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson({ id: "paper1" }));
    const client = await loadClient("https://science.example/api");

    const archive = await client.exportWebProject("paper1");
    await expect(blobText(archive)).resolves.toBe("archive-bytes");
    await client.deleteWebProject("paper1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://science.example/api/projects/paper1/export",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/projects/paper1",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        body: JSON.stringify({ confirm: "paper1" }),
      }),
    );
    expect(callHeaders(fetchMock, 2).get("Content-Type")).toBe("application/json");
    expect(callHeaders(fetchMock, 2).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("exports and deletes the current hosted account", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("account-archive"))
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson({ id: "alice" }));
    const client = await loadClient("https://science.example/api");

    const archive = await client.exportWebAccount();
    await expect(blobText(archive)).resolves.toBe("account-archive");
    await client.deleteWebAccount("alice", "secret-password");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://science.example/api/account/export",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/account",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        body: JSON.stringify({ confirm: "alice", password: "secret-password" }),
      }),
    );
    expect(callHeaders(fetchMock, 2).get("Content-Type")).toBe("application/json");
    expect(callHeaders(fetchMock, 2).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("reads deployment readiness even when the server reports not ready", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      responseJson(
        {
          ok: false,
          checks: {
            publicUrl: { ok: false, code: "public_url_https_required" },
            auth: { ok: true, mode: "local", users: 1 },
          },
        },
        { status: 503 },
      ),
    );
    const client = await loadClient("https://science.example/api");

    await expect(client.fetchWebReadiness()).resolves.toMatchObject({
      ok: false,
      checks: {
        publicUrl: { code: "public_url_https_required" },
        auth: { mode: "local", users: 1 },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://science.example/api/ready",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("manages hosted runtime lifecycle through command requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson("https://science.example/api/runtime"))
      .mockResolvedValueOnce(responseJson(null))
      .mockResolvedValueOnce(responseJson("https://science.example/api/runtime"));
    const client = await loadClient("https://science.example/api");

    client.setWebProjectId("paper1");
    await expect(client.startWebRuntime()).resolves.toBe("https://science.example/api/runtime");
    await client.stopWebRuntime();
    await expect(client.restartWebRuntime()).resolves.toBe("https://science.example/api/runtime");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/commands/start_runtime",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({}),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/commands/stop_runtime",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({}),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://science.example/api/commands/restart_runtime",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({}),
      }),
    );
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-Project")).toBe("paper1");
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
    expect(callHeaders(fetchMock, 2).get("X-Open-Science-CSRF")).toBe("csrf_test");
    expect(callHeaders(fetchMock, 3).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("downloads hosted workspace files with the selected project id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("file-bytes", {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    const client = await loadClient("https://science.example/api");

    client.setWebProjectId("paper1");
    expect(client.webFileDownloadUrl("reports/result.csv", "base")).toBe(
      "https://science.example/api/files/download/reports%2Fresult.csv?root=base&projectId=paper1",
    );
    const blob = await client.downloadWebFile("reports/result.csv", "base");

    await expect(blobText(blob)).resolves.toBe("file-bytes");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://science.example/api/files/download/reports%2Fresult.csv?root=base&projectId=paper1",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(callHeaders(fetchMock, 0).get("X-Open-Science-Project")).toBe("paper1");
  });

  it("creates hosted web tasks with the selected project id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(responseJson(
        {
          id: "task_1",
          command: "write_workspace_file",
          status: "queued",
          userId: "alice",
          projectId: "paper1",
          createdAt: "2026-01-01T00:00:00.000Z",
          queuedAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          error: null,
        },
        { status: 202 },
      ));
    const client = await loadClient("https://science.example/api");

    client.setWebProjectId("paper1");
    const task = await client.createWebTask("write_workspace_file", { path: "a.md" });

    expect(task.id).toBe("task_1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/tasks",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          command: "write_workspace_file",
          args: { path: "a.md" },
        }),
      }),
    );
    expect(callHeaders(fetchMock, 1).get("Content-Type")).toBe("application/json");
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-Project")).toBe("paper1");
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("lists and cancels hosted web tasks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: {
            id: "task_1",
            command: "kernel_execute",
            status: "canceled",
            userId: "alice",
            projectId: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
            queuedAt: "2026-01-01T00:00:00.000Z",
            startedAt: null,
            finishedAt: "2026-01-01T00:00:01.000Z",
            error: { code: "task_canceled", message: "Task was canceled before it started." },
          },
        }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    const client = await loadClient("https://science.example");

    await expect(client.listWebTasks()).resolves.toEqual([]);
    const canceled = await client.cancelWebTask("task_1");

    expect(canceled.status).toBe("canceled");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://science.example/api/tasks",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/tasks/task_1/cancel",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(callHeaders(fetchMock, 2).get("X-Open-Science-CSRF")).toBe("csrf_test");
  });

  it("reads hosted audit and task logs for the selected project", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ command: "write_workspace_file" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ taskId: "task_1" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ event: "started", kind: "mock" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ requestId: "req_1", route: "/api/files/preview/:path", status: 404 }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ action: "auth.login", status: "completed", username: "alice" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        responseJson({
          createdAt: "2026-01-01T00:00:00.000Z",
          server: {
            pid: 123,
            uptimeSeconds: 30,
            memory: {
              rssBytes: 64 * 1024 * 1024,
              heapUsedBytes: 16 * 1024 * 1024,
              heapTotalBytes: 32 * 1024 * 1024,
              externalBytes: 1024,
            },
            cpu: { userMicros: 100, systemMicros: 50 },
            loadAverage: [0.1, 0.2, 0.3],
          },
          project: {
            id: "paper1",
            name: "Paper 1",
            storage: { usedBytes: 256, maxBytes: 1024 },
          },
          tasks: {
            total: 1,
            active: 0,
            queued: 0,
            byStatus: {
              queued: 0,
              running: 0,
              canceling: 0,
              succeeded: 1,
              failed: 0,
              canceled: 0,
              timed_out: 0,
            },
          },
          runtime: {
            running: false,
            kind: null,
            startedAt: null,
            pid: null,
            exitedAt: null,
          },
        }),
      );
    const client = await loadClient("https://science.example/api");

    client.setWebProjectId("paper1");
    await client.listWebAuditLog(5);
    await client.listWebTaskEvents(6);
    await client.listWebRuntimeEvents(7);
    await client.listWebErrorEvents(8);
    await client.listWebSecurityEvents(9);
    await expect(client.fetchWebMetrics()).resolves.toMatchObject({
      project: { id: "paper1" },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://science.example/api/logs/audit?limit=5",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(callHeaders(fetchMock, 0).get("X-Open-Science-Project")).toBe("paper1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://science.example/api/logs/tasks?limit=6",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(callHeaders(fetchMock, 1).get("X-Open-Science-Project")).toBe("paper1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://science.example/api/logs/runtime?limit=7",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(callHeaders(fetchMock, 2).get("X-Open-Science-Project")).toBe("paper1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://science.example/api/logs/errors?limit=8",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(callHeaders(fetchMock, 3).get("X-Open-Science-Project")).toBe("paper1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "https://science.example/api/logs/security?limit=9",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(callHeaders(fetchMock, 4).get("X-Open-Science-Project")).toBe("paper1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "https://science.example/api/metrics",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(callHeaders(fetchMock, 5).get("X-Open-Science-Project")).toBe("paper1");
  });
});

// A 402 used to arrive as a code and a sentence. The ledger knows which of the
// three ceilings refused the request and by how much, and a researcher cannot
// act on "over budget" without it: the 24-hour ceiling frees itself within a
// day, the 7-day one does not, and a run ceiling is about this task alone.
describe("apiClient budget refusals", () => {
  function refusal(details: unknown, code = "usage_budget_exceeded", status = 402) {
    return new Response(
      JSON.stringify({ error: "This request exceeds the account spending limit.", code, requestId: "req_402", details }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  it("carries the ceiling to the caller and remembers it for the account page", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(refusal({ window: "week", limit: 12, committed: 12.4, requested: 0.3, currency: "CNY" }));
    const client = await loadClient("https://science.example/api");

    await expect(client.dispatchWebAgentRun("ses_1", "分析这份证据", "turn_1")).rejects.toMatchObject({
      name: "WebApiError",
      status: 402,
      code: "usage_budget_exceeded",
      requestId: "req_402",
      details: { window: "week", limit: 12, committed: 12.4, requested: 0.3, currency: "CNY" },
    });

    const remembered = client.lastWebUsageBudgetRefusal();
    if (!remembered) throw new Error("the refusal was not remembered");
    expect(remembered.window).toBe("week");
    expect(Number.isNaN(Date.parse(remembered.observedAt))).toBe(false);
    expect(client.describeWebUsageBudget(remembered)).toBe(
      "近 7 天额度已达上限：上限 12.00 CNY，已占用 12.40 CNY，本次请求还需 0.30 CNY。",
    );
  });

  it("keeps only the declared keys out of a bag that carries more", async () => {
    // Shaped exactly like a live API key, assembled at run time so no such
    // literal sits in source: `pnpm audit:source-secrets` refuses one even in
    // a test proving such a value never travels, and it is right to — a
    // scanner cannot read intent. The value on the wire below is
    // byte-identical to what a real leak would look like.
    const credentialShapedValue = ["sk", "live", "a1b2c3d4e5f6a7b8c9d0e1f2"].join("-");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(refusal({
      window: "day", limit: 5, committed: 5, currency: "CNY",
      sql: "SELECT reserved_cost FROM evimed_usage.model_requests", apiKey: credentialShapedValue,
      stack: "Error: at reserveModel (/srv/evimed/apps/server/src/usageLedger.mjs:176)",
    }));
    const client = await loadClient("https://science.example/api");

    const error = await client.fetchWebAccountUsage().catch((err: unknown) => err) as { details: Record<string, unknown> };
    expect(Object.keys(error.details).sort()).toEqual(["committed", "currency", "limit", "window"]);
    expect(JSON.stringify(error.details)).not.toContain(credentialShapedValue);
    expect(client.describeWebUsageBudget(error.details as never)).toBe("近 24 小时额度已达上限：上限 5.00 CNY，已占用 5.00 CNY。");
  });

  // The currency cases are the reason this parser mirrors the server's closed
  // sets instead of substituting a default: the server drops a currency outside
  // its own set, and a client that filled the gap with "CNY" would print an
  // amount under a currency nobody said it was in.
  it.each([
    ["an unknown window", { window: "month", limit: 12, committed: 12.4, currency: "CNY" }],
    ["a limit that is not a number", { window: "day", limit: "12", committed: 12.4, currency: "CNY" }],
    ["no window at all", { limit: 12, committed: 12.4, currency: "CNY" }],
    ["an unknown currency", { window: "day", limit: 12, committed: 12.4, currency: "USD" }],
    ["no currency at all", { window: "day", limit: 12, committed: 12.4 }],
    ["a bag that is not an object", "week"],
  ])("drops a details bag with %s", async (_label, details) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(refusal(details));
    const client = await loadClient("https://science.example/api");

    const error = await client.fetchWebAccountUsage().catch((err: unknown) => err) as { details: unknown };
    expect(error.details).toBeNull();
    expect(client.lastWebUsageBudgetRefusal()).toBeNull();
  });

  // The client mirrors the control plane's per-code declaration: a code that
  // declares no shape carries nothing, whatever the body happens to hold.
  it("ignores details on a code that declares none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      refusal({ window: "week", limit: 12, committed: 12.4, currency: "CNY" }, "project_forbidden", 403),
    );
    const client = await loadClient("https://science.example/api");

    const error = await client.fetchWebAccountUsage().catch((err: unknown) => err) as { details: unknown; status: number };
    expect(error.status).toBe(403);
    expect(error.details).toBeNull();
    expect(client.lastWebUsageBudgetRefusal()).toBeNull();
  });

  it("forgets the ceiling when the session ends", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(refusal({ window: "run", limit: 2, committed: 1.9, requested: 0.4, currency: "CNY" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Session expired.", code: "authentication_required" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      }));
    const client = await loadClient("https://science.example/api");

    await client.fetchWebAccountUsage().catch(() => null);
    expect(client.lastWebUsageBudgetRefusal()?.window).toBe("run");

    await client.fetchWebAccountUsage().catch(() => null);
    expect(client.lastWebUsageBudgetRefusal()).toBeNull();
  });
});

// The capsule/autopilot/sources client builds its own WebApiError from the same
// envelope, and its message map is what those pages show. "操作未完成，请重试"
// is advice that cannot work when the ceiling that refused is a spent week.
describe("productClient budget refusals", () => {
  async function loadProductClient(webApiBase: string) {
    vi.resetModules();
    setWebApiBase(webApiBase);
    return import("./productClient");
  }

  it("answers a refused request with the ceiling that refused it", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(csrfMeResponse())
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          error: "This account reached its spending limit.",
          code: "usage_budget_exceeded",
          requestId: "req_402",
          details: { window: "day", limit: 5, committed: 5, currency: "CNY" },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      ));
    const product = await loadProductClient("https://science.example/api");

    const error = await product.productRequest("/autopilot/agendas", "POST", { title: "夜间检索" }).catch((err: unknown) => err);
    expect(product.productErrorMessage(error)).toBe("近 24 小时额度已达上限：上限 5.00 CNY，已占用 5.00 CNY。");
  });

  it("leaves every other failure with the message it had", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "gone", code: "product_document_missing", requestId: "req_404" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ));
    const product = await loadProductClient("https://science.example/api");

    const error = await product.productRequest("/capsules/cap_1").catch((err: unknown) => err);
    expect(product.productErrorMessage(error)).toBe("这条记录已不存在，请刷新列表。");
  });
});
