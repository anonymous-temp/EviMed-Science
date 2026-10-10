import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError, type WebAgentRun } from "@/lib/apiClient";

const mocks = vi.hoisted(() => ({
  putWebResearchSession: vi.fn(),
  listWebResearchSessions: vi.fn(),
  dispatchWebAgentRun: vi.fn(),
  cancelWebAgentRun: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  putWebResearchSession: mocks.putWebResearchSession,
  listWebResearchSessions: mocks.listWebResearchSessions,
  dispatchWebAgentRun: mocks.dispatchWebAgentRun,
  cancelWebAgentRun: mocks.cancelWebAgentRun,
}));

import { bindConversationCapability, dispatchResearch, newResearchSessionId, rerouteRun } from "./dispatch";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function run(over: Partial<WebAgentRun> = {}): WebAgentRun {
  return {
    id: "run_1",
    sessionId: "web-1",
    status: "running",
    mode: "specialist",
    agentId: "clinical-evidence-synthesis",
    effectiveAgentId: "clinical-evidence-synthesis",
    question: "≥70 岁人群阿司匹林一级预防",
    artifacts: [],
    ...over,
  } as WebAgentRun;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls = [];
  mocks.putWebResearchSession.mockImplementation(async (sessionId: string, selection: unknown) => {
    mocks.calls.push(`put:${sessionId}:${JSON.stringify(selection)}`);
    return { sessionId };
  });
  mocks.dispatchWebAgentRun.mockImplementation(async (sessionId: string, text: string, dispatchId: string) => {
    mocks.calls.push(`dispatch:${sessionId}:${text}:${dispatchId}`);
    return run({ id: "run_2", sessionId, question: text });
  });
  mocks.cancelWebAgentRun.mockImplementation(async (id: string) => {
    mocks.calls.push(`cancel:${id}`);
    return run({ id, status: "canceled" });
  });
});

describe("dispatchResearch", () => {
  it("binds a fresh session to the capability before dispatching into it", async () => {
    const result = await dispatchResearch({ kind: "capability", agentId: "meta-analysis", agentVersion: "1.0.0" }, "  他汀与肝损伤  ");

    expect(mocks.calls).toHaveLength(2);
    const [put, dispatch] = mocks.calls;
    expect(put).toMatch(/^put:web-[0-9a-f]{24}:\{"mode":"specialist","agentId":"meta-analysis","agentVersion":"1\.0\.0"\}$/);
    const sessionId = put.split(":")[1];
    // The same session, the trimmed question, and a dispatch id the server's
    // `safeId` accepts.
    expect(dispatch.startsWith(`dispatch:${sessionId}:他汀与肝损伤:`)).toBe(true);
    expect(dispatch.split(":")[3]).toMatch(SAFE_ID);
    expect(result.sessionId).toBe(sessionId);
  });

  it("leaves the choice to the router for an open-domain request", async () => {
    await dispatchResearch({ kind: "open-domain" }, "阿司匹林的出血风险有多大？");
    expect(mocks.calls[0]).toContain(':{"mode":"open-domain"}');
  });

  it("refuses an empty question without calling the API", async () => {
    await expect(dispatchResearch({ kind: "open-domain" }, "   ")).rejects.toThrow();
    expect(mocks.calls).toEqual([]);
  });

  it("mints session ids both the control plane and the frame accept, never the same twice", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newResearchSessionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(SAFE_ID);
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,160}$/);
    }
  });
});

describe("rerouteRun", () => {
  // A binding cannot change once it exists, so the new line is a new session.
  it("stops the running run, then starts the same question in a new session", async () => {
    const next = await rerouteRun(run(), { kind: "open-domain" }, "≥70 岁人群阿司匹林一级预防");

    expect(mocks.calls[0]).toBe("cancel:run_1");
    expect(mocks.calls[1]).toContain(':{"mode":"open-domain"}');
    expect(mocks.calls[1]).not.toContain("put:web-1:");
    expect(next.id).toBe("run_2");
  });

  it("starts the new run even when the old one had already ended", async () => {
    mocks.cancelWebAgentRun.mockRejectedValueOnce(new WebApiError("finished", { status: 409, code: "agent_run_not_active" }));
    await expect(rerouteRun(run(), { kind: "open-domain" }, "问题")).resolves.toMatchObject({ id: "run_2" });
  });

  it("does not start a second run when the first could not be stopped", async () => {
    mocks.cancelWebAgentRun.mockRejectedValueOnce(new WebApiError("unavailable", { status: 503, code: "runtime_unavailable" }));
    await expect(rerouteRun(run(), { kind: "open-domain" }, "问题")).rejects.toThrow();
    expect(mocks.dispatchWebAgentRun).not.toHaveBeenCalled();
  });

  it("does not try to stop a run that already ended", async () => {
    await rerouteRun(run({ status: "succeeded" }), { kind: "open-domain" }, "问题");
    expect(mocks.cancelWebAgentRun).not.toHaveBeenCalled();
  });
});

// The route line (a capability's name, a duration and the control plane's sentence for why) had no screen and was deleted 2026-10-10:
// why the platform routed a request as it did is the back office's (owner ruling). Nothing of it is exported any more.
describe("the route line", () => {
  it("is not produced: no label, no duration and no reason for a run's route", async () => {
    const module = await import("./dispatch");
    for (const name of ["routeLineOf", "minutesText", "ANSWER_LINE_LABEL"]) expect(name in module, name).toBe(false);
  });
});

describe("conversation binding", () => {
  it("keeps the conversation when it has no tool yet, and starts a fresh one when it already has another", async () => {
    mocks.listWebResearchSessions.mockResolvedValue([
      { sessionId: "web-bound", mode: "specialist", agentId: "peer-review", agentVersion: "1.0.0" },
    ]);
    mocks.putWebResearchSession.mockImplementation(async (sessionId: string, selection: object) => ({ sessionId, ...selection }));

    // An unbound conversation takes the tool where it is.
    const kept = await bindConversationCapability("web-blank", { agentId: "adr-analysis", agentVersion: "1.0.0" });
    expect(kept).toEqual({ sessionId: "web-blank", rebound: false });
    expect(mocks.putWebResearchSession).toHaveBeenCalledWith("web-blank", { mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0" });

    // One that already runs another tool cannot be edited, so it is a new one.
    const moved = await bindConversationCapability("web-bound", { agentId: "adr-analysis", agentVersion: "1.0.0" });
    expect(moved.rebound).toBe(true);
    expect(moved.sessionId).not.toBe("web-bound");

    // Asking for the tool it already runs changes nothing.
    mocks.putWebResearchSession.mockClear();
    expect(await bindConversationCapability("web-bound", { agentId: "peer-review", agentVersion: "1.0.0" })).toEqual({ sessionId: "web-bound", rebound: false });
    expect(mocks.putWebResearchSession).not.toHaveBeenCalled();
  });

  it("starts a clean conversation when the control plane refuses the change", async () => {
    mocks.listWebResearchSessions.mockResolvedValue([]);
    mocks.putWebResearchSession
      .mockRejectedValueOnce(new WebApiError("conflict", { status: 409, code: "research_session_identity_conflict" }))
      .mockImplementation(async (sessionId: string, selection: object) => ({ sessionId, ...selection }));
    const result = await bindConversationCapability("web-old", { agentId: "adr-analysis", agentVersion: "1.0.0" });
    expect(result.rebound).toBe(true);
    expect(result.sessionId).not.toBe("web-old");
  });
});
