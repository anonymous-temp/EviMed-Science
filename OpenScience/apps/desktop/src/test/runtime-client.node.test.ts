// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuntimeClient, type RuntimeEvent } from "@ai4s/sdk";
import { startMockRuntimeServer, type MockRuntimeServer } from "@ai4s/sdk/mock-server";

let server: MockRuntimeServer;

beforeAll(async () => {
  server = await startMockRuntimeServer(0);
});
afterAll(async () => {
  await server.close();
});

async function waitFor(pred: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function capturePromptBody(text: string, agent?: string, model?: string | null) {
  let promptBody: unknown;
  const capturePrompt: typeof fetch = async (_input, init) => {
    promptBody = JSON.parse(String(init?.body));
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new RuntimeClient({ fetchImpl: capturePrompt });
  await client.sendPrompt("ses_specialty", text, agent, model);
  return promptBody;
}

describe("RuntimeClient ↔ a kernel over HTTP + SSE", () => {
  it("pins an agent and model on a prompt turn", async () => {
    const promptBody = await capturePromptBody(
      "analyze",
      "evimed-adr-analysis",
      "deepseek/deepseek-v4-pro",
    );

    expect(promptBody).toMatchObject({
      parts: [{ type: "text", text: "analyze" }],
      agent: "evimed-adr-analysis",
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    });
  });

  it("keeps the unpinned prompt body byte-compatible", async () => {
    const promptBody = await capturePromptBody("open research");

    expect(promptBody).toEqual({
      parts: [{ type: "text", text: "open research" }],
    });
  });

  it("splits a model identifier only at its first slash", async () => {
    const promptBody = await capturePromptBody(
      "analyze",
      "evimed-adr-analysis",
      "provider/org/model",
    );

    expect(promptBody).toMatchObject({
      model: { providerID: "provider", modelID: "org/model" },
    });
  });

  it("connects, creates a session, sends a prompt, and streams normalized events", async () => {
    const events: RuntimeEvent[] = [];
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));

    await client.connect();
    expect(client.getStatus()).toBe("ready");

    const sessionId = await client.createSession();
    expect(sessionId).toBe("ses_mock");

    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const types = events.map((e) => e.type);
    expect(types).toContain("text.updated");
    expect(types).toContain("tool.updated");

    // Text streams live: each message.part.delta yields the accumulated text,
    // it does not sit silent until the full part arrives at text-end.
    const p1 = events
      .filter((e): e is Extract<RuntimeEvent, { type: "text.updated" }> =>
        e.type === "text.updated" && e.partId === "p1",
      )
      .map((e) => e.text);
    expect(p1).toContain("Planning ");
    expect(p1[p1.length - 1]).toBe("Planning the analysis. ");

    const toolDone = events.find(
      (e): e is Extract<RuntimeEvent, { type: "tool.updated" }> =>
        e.type === "tool.updated" && e.status === "success",
    );
    expect(toolDone?.title).toContain("literature-search");

    client.close();
    expect(client.getStatus()).toBe("offline");
  });

  it("lists slash commands (config commands + skills, one merged list)", async () => {
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const commands = await client.listCommands();
    expect(commands.map((c) => c.name)).toEqual(["init", "analyze-data"]);
    expect(commands[1].source).toBe("skill");
  });

  it("runs a shell command: bash tool part + session.idle stream back", async () => {
    const events: RuntimeEvent[] = [];
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    await client.runShell("ses_mock", "pwd");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    const bash = events.find(
      (e): e is Extract<RuntimeEvent, { type: "tool.updated" }> =>
        e.type === "tool.updated" && e.tool === "bash",
    );
    expect(bash?.status).toBe("success");
    expect(bash?.output).toContain("/ws/mock");
    client.close();
  });

  it("runs a slash command: a normal agent turn streams back", async () => {
    const events: RuntimeEvent[] = [];
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    await client.runCommand("ses_mock", "init", "focus on tests");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    expect(events.map((e) => e.type)).toContain("text.updated");
    client.close();
  });

  it("maps time.completed onto history messages and aborts a session", async () => {
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "run a literature review");
    const messages = await client.getMessages(sessionId);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.completed).toBe(2); // the turn is over — the reconcile signal
    await expect(client.abortSession(sessionId)).resolves.toBeUndefined();
    client.close();
  });

  it("reports an error status when the server is unreachable", async () => {
    const client = new RuntimeClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.connect()).rejects.toBeTruthy();
    expect(client.getStatus()).toBe("error");
  });

  it("disposes the cached instance after credential changes, so providers refresh", async () => {
    // The server caches its provider list per instance; PUT/DELETE /auth alone
    // leaves it stale (the new provider never appears in the UI). Verified on
    // opencode 1.17.13: POST /instance/dispose makes the change visible.
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });

    server.requests.length = 0;
    await client.setProviderApiKey("mock", "sk-123");
    expect(server.requests).toEqual(["PUT /auth/mock", "POST /instance/dispose"]);

    server.requests.length = 0;
    await client.removeProviderAuth("mock");
    expect(server.requests).toEqual(["DELETE /auth/mock", "POST /instance/dispose"]);

    server.requests.length = 0;
    await client.oauthCallback("mock", 0);
    expect(server.requests).toEqual([
      "POST /provider/mock/oauth/callback",
      "POST /instance/dispose",
    ]);
  });

  it("disposes the workspace instance too when scoped to a directory", async () => {
    // Sessions run on the per-directory instance — if only the default one
    // were disposed, chats would keep a stale provider list until restart.
    const client = new RuntimeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      directory: "/ws/dir",
    });
    server.requests.length = 0;
    await client.setProviderApiKey("mock", "sk-123");
    expect(server.requests).toEqual([
      "PUT /auth/mock",
      "POST /instance/dispose",
      "POST /instance/dispose?directory=%2Fws%2Fdir",
    ]);
  });

  it("cancels a pending browser-login wait via the AbortSignal", async () => {
    // "auto" OAuth callbacks wait for the browser redirect — cancelling in
    // the UI must abort the request, not leak it on the sidecar.
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    server.requests.length = 0;
    const abort = new AbortController();
    const pending = client.oauthCallback("slow", 0, undefined, abort.signal);
    await waitFor(() => server.requests.includes("POST /provider/slow/oauth/callback"));
    abort.abort();
    await expect(pending).rejects.toThrow();
    // An aborted login must not dispose the instance (nothing changed).
    expect(server.requests.filter((r) => r.includes("dispose"))).toEqual([]);
  });

  it("surfaces the server's diagnostic message when saving a key fails", async () => {
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await expect(client.setProviderApiKey("bad", "nope")).rejects.toThrow(/invalid key format/);
  });

  it("sends Basic auth on API calls when a password is set", async () => {
    // The sidecar now REQUIRES auth (OPENCODE_SERVER_PASSWORD) — every fetch
    // must carry the Authorization header or the server answers 401.
    const seen: (string | undefined)[] = [];
    const capturing: typeof fetch = (input, init) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.["Authorization"]);
      return fetch(input, init);
    };
    const client = new RuntimeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: "pw-secret",
      fetchImpl: capturing,
    });
    await client.createSession();
    expect(seen[0]).toBe("Basic " + Buffer.from("opencode:pw-secret").toString("base64"));
  });

  it("keeps the EventSource stream when a password is set, authenticating via auth_token", async () => {
    // EventSource cannot set headers, but it is the reliable SSE path in the
    // WKWebView — the server accepts the same Basic payload as ?auth_token=.
    const urls: string[] = [];
    class FakeEventSource {
      static instance: FakeEventSource | null = null;

      onopen: (() => void) | null = null;
      onmessage: unknown = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        urls.push(url);
        FakeEventSource.instance = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    try {
      const client = new RuntimeClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        password: "pw-secret",
        directory: "/ws/dir",
      });
      const statuses: string[] = [];
      client.onStatus((status) => statuses.push(status));
      await client.connect();
      expect(client.getStatus()).toBe("ready");
      const token = Buffer.from("opencode:pw-secret").toString("base64");
      expect(urls[0]).toContain(`auth_token=${encodeURIComponent(token)}`);
      expect(urls[0]).toContain(`directory=${encodeURIComponent("/ws/dir")}`);
      // A failure after the first open leaves EventSource alive so the browser
      // can reconnect it; the next open restores the client to ready.
      const source = FakeEventSource.instance;
      expect(source).not.toBeNull();
      source!.onerror?.();
      expect(client.getStatus()).toBe("connecting");
      source!.onopen?.();
      expect(client.getStatus()).toBe("ready");
      expect(statuses.slice(-2)).toEqual(["connecting", "ready"]);
      client.close();
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    }
  });
});
