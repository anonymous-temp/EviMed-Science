import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError, type WebAgentRun, type WebResearchAgent } from "@/lib/apiClient";

const mocks = vi.hoisted(() => ({
  putWebResearchSession: vi.fn(),
  dispatchWebAgentRun: vi.fn(),
  cancelWebAgentRun: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  putWebResearchSession: mocks.putWebResearchSession,
  dispatchWebAgentRun: mocks.dispatchWebAgentRun,
  cancelWebAgentRun: mocks.cancelWebAgentRun,
}));

import { dispatchResearch, minutesText, newResearchSessionId, rerouteRun, routeLineOf } from "./dispatch";

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

const catalog = [
  { id: "clinical-evidence-synthesis", version: "2.13.0", title: "Clinical evidence", estimatedMinutes: [15, 30] },
  { id: "meta-analysis", version: "1.0.0", title: "Meta", estimatedMinutes: [30, 180] },
] as unknown as WebResearchAgent[];

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

describe("routeLineOf", () => {
  it("names the capability in the product's words, with the run's own duration and reason", () => {
    const line = routeLineOf(run({ routeReason: "题面是一个需要逐条核验文献的临床问题", estimatedMinutes: { min: 15, max: 30 } }));
    expect(line).toEqual({
      agentId: "clinical-evidence-synthesis",
      label: "临床证据深度分析",
      answerLine: false,
      minutes: "通常 15–30 分钟",
      reason: "题面是一个需要逐条核验文献的临床问题",
    });
  });

  it("falls back to the capability's display figure, then the catalogue's, and says nothing without one", () => {
    // clinical-evidence-synthesis's display block says 30–70.
    expect(routeLineOf(run()).minutes).toBe("通常 30–70 分钟");
    const unknown = { effectiveAgentId: "not-in-the-table", agentId: "not-in-the-table" };
    expect(routeLineOf(run(unknown), [{ ...catalog[0], id: "not-in-the-table" }]).minutes).toBe("通常 15–30 分钟");
    expect(routeLineOf(run(unknown)).minutes).toBeNull();
  });

  it("calls the answer line 普通问答", () => {
    const line = routeLineOf(run({ mode: "open-domain", agentId: null, effectiveAgentId: "open-domain-answer" }));
    expect(line).toMatchObject({ agentId: null, label: "普通问答", answerLine: true });
  });

  // The ledger's own routing code is for the ledger; a reader gets the
  // control plane's Chinese sentence or nothing.
  it("never shows the internal routing code as the reason", () => {
    const line = routeLineOf(run({ effectiveRouteReason: "session-binding" } as Partial<WebAgentRun>));
    expect(line.reason).toBeNull();
  });
});

describe("minutesText", () => {
  it("renders a range, a single figure, and nothing for a missing or empty one", () => {
    expect(minutesText({ min: 15, max: 30 })).toBe("通常 15–30 分钟");
    expect(minutesText({ min: 5, max: 5 })).toBe("通常约 5 分钟");
    expect(minutesText(null)).toBeNull();
    expect(minutesText({ min: 0, max: 0 })).toBeNull();
    expect(minutesText({ min: Number.NaN, max: 3 })).toBeNull();
  });
});
