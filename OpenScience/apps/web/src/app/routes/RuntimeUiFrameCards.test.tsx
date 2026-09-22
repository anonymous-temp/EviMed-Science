// The frame's tool-call cards in a browser DOM: what a click on 「查看子任务」
// asks the kernel for. The body is the one the socket's build serializes into
// the kernel's page; here it runs against a recording slot registry.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameKit } from "../../../../../packages/harness-port/src/runtimeUiKit.mjs";
import { FRAME_VOCABULARY } from "../../../../../packages/harness-port/src/runtimeUiFrame.mjs";
import { apply as applyToolviews } from "../../../../../packages/harness-port/src/runtimeUiToolviews.mjs";
import { apply as applyPanels } from "../../../../../packages/harness-port/src/runtimeUiPanels.mjs";
import { apply as applyShell } from "../../../../../packages/harness-port/src/runtimeUiShell.mjs";
import { apply as applyCommands } from "../../../../../packages/harness-port/src/runtimeUiCommands.mjs";

type Listener = () => void;

function frame(entries: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const components = new Map<string, (props: Record<string, unknown>) => unknown>();
  const listeners = new Set<Listener>();
  let snapshot = { current: "session-a", subagentsByParent: { "session-a": { entries } } };
  const sessions = {
    list: { getSnapshot: () => snapshot, subscribe: (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn); } },
    refreshSubagents: vi.fn(),
    openSubagent: vi.fn(),
  };
  const ctx: Record<string, unknown> = {
    sessions,
    slots: {
      inject: (_name: string, setup: () => unknown) => setup(),
      register: (options: { key?: string; name: string }, component: (props: Record<string, unknown>) => unknown) => { components.set(options.key ?? options.name, component); return () => {}; },
    },
    effect: (setup: () => unknown) => setup(),
    on: () => () => {},
    ...extra,
  };
  const target = {
    __EVIMED_FRAME__: { version: 1, frameId: "f", projectId: "p", shellOrigin: "https://app.example", cwd: "/workspace", capabilities: [] },
    parent: { postMessage() {} }, addEventListener() {}, removeEventListener() {}, console, setTimeout, clearTimeout,
    setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  const kit = createFrameKit(ctx, target, (id: string) => (id === "react" ? React : undefined), FRAME_VOCABULARY);
  applyToolviews(ctx, {}, target, undefined, kit);
  applyPanels(ctx, {}, target, undefined, kit);
  applyShell(ctx, {}, { ...target, document: undefined }, undefined, kit);
  kit.hub.deliver("session", { sessionId: "session-a" });
  return {
    sessions, kit, components, card: components.get("evimed_delegate")!,
    publish(next: Array<Record<string, unknown>>) { snapshot = { ...snapshot, subagentsByParent: { "session-a": { entries: next } } }; act(() => { for (const fn of [...listeners]) fn(); }); },
  };
}

const started = {
  kind: "tool-result", seq: 3, time: Date.now(), callId: "c1", callTime: Date.now() - 1000,
  call: { name: "evimed_delegate", argsRaw: JSON.stringify({ deliverableId: "evidence" }) },
  content: [{ type: "text", text: `ok\n${JSON.stringify({ handle: "h-1", deliverableId: "evidence", childSessionId: "child-1", status: "started" }, null, 2)}` }],
  isError: false, subCalls: [],
};

describe("the delegation card's link to the child", () => {
  afterEach(() => { cleanup(); });

  it("opens the kernel's own subagent view at the address the parent's catalogue lists", () => {
    const f = frame([{ id: "child-1", kind: "child", mode: "one-shot" }]);
    const Card = f.card as (props: Record<string, unknown>) => React.ReactElement;
    render(<Card block={started} />);
    fireEvent.click(screen.getByRole("button", { name: "查看子任务" }));
    expect(f.sessions.openSubagent).toHaveBeenCalledWith({ parentSessionId: "session-a", childSessionId: "child-1", mode: "one-shot" });
    expect(f.sessions.refreshSubagents).not.toHaveBeenCalled();
  });

  it("waits for the catalogue, asks for it once, and comes alive when the child is listed", () => {
    const f = frame([]);
    const Card = f.card as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Card block={started} />);
    const button = screen.getByRole("button", { name: "查看子任务" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(f.sessions.openSubagent).not.toHaveBeenCalled();
    view.rerender(<Card block={{ ...started }} />);
    expect(f.sessions.refreshSubagents).toHaveBeenCalledTimes(1);
    expect(f.sessions.refreshSubagents).toHaveBeenCalledWith("session-a");
    f.publish([{ id: "child-1", kind: "child", mode: "continuable" }]);
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(f.sessions.openSubagent).toHaveBeenCalledWith({ parentSessionId: "session-a", childSessionId: "child-1", mode: "continuable" });
  });

  it("ticks while the child works and follows the run state the shell sends", () => {
    vi.useFakeTimers();
    try {
      const f = frame([{ id: "child-1", kind: "child", mode: "one-shot" }]);
      const Card = f.card as (props: Record<string, unknown>) => React.ReactElement;
      const begun = Date.now();
      const block = { ...started, callTime: begun, time: begun + 500 };
      render(<Card block={block} />);
      expect(screen.getByText("已启动")).toBeInTheDocument();
      act(() => f.kit.hub.deliver("run-state", { runId: "run-1", sessionId: "session-a", progress: {
        deliverables: [{ id: "evidence", title: "老年房颤抗凝证据综述", status: "delegated", attempts: 0 }],
        children: [{ childSessionId: "child-1", deliverableId: "evidence", state: "running", lastActivityAt: null }],
        currentPhase: "search", sources: { searched: 40, included: 3, fullText: 0 },
      } }));
      expect(screen.getByText("老年房颤抗凝证据综述")).toBeInTheDocument();
      expect(screen.getByText("进行中")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(65_000); });
      expect(screen.getByText(/已用时 1 分 0\d 秒 · 当前：检索 · 纳入 3 篇/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});

describe("the delivery card", () => {
  afterEach(() => { cleanup(); });
  const live = {
    runId: "run-1", sessionId: "session-a", state: "succeeded",
    artifacts: ["deliverables/evidence/clinical-evidence-report.md", "deliverables/evidence/clinical-evidence-matrix.json"],
    unverifiedArtifacts: [],
    progress: { deliverables: [{ id: "evidence", title: "老年房颤抗凝证据综述", status: "accepted", attempts: 2 }], children: [] },
  };

  it("opens the report through the shell, and registers no tab or view of its own", () => {
    const registered: string[] = [];
    const f = frame([], { sidebarRightTabs: { register: (definition: { id: string }) => { registered.push(definition.id); return () => {}; } }, sidebarRight: { openTab: vi.fn() } });
    const sent: Array<[string, Record<string, unknown>]> = [];
    f.kit.hub.attach((type: string, fields: Record<string, unknown>) => { sent.push([type, fields]); });
    act(() => f.kit.hub.deliver("run-state", live));
    act(() => f.kit.hub.deliver("evidence", { runId: "run-1", reportPath: live.artifacts[0], claims: [
      { claimId: "CLM-002", claim: "老年患者大出血风险相近。", claimType: "direct", status: "quote_not_found", sourceTitle: "ARISTOTLE" },
    ], sources: [] }));
    // The right column and the view ring are the kernel's (its file tree and
    // its trajectory view); the product registers nothing there.
    expect(registered).toEqual([]);
    expect(f.components.has("conversation.view")).toBe(false);
    expect(f.components.has("evimed-files")).toBe(false);
    const Card = f.components.get("conversation.input.dock") as (props: Record<string, unknown>) => React.ReactElement;
    render(<Card />);
    fireEvent.click(screen.getByRole("button", { name: "打开报告" }));
    expect(sent).toEqual([["open-artifact", { runId: "run-1", path: "deliverables/evidence/clinical-evidence-report.md" }]]);
    expect(screen.getByText(/引用前请在报告里核对带 ⚠ 的结论/)).toBeInTheDocument();
  });

  it("tells the kernel its left column is collapsed whenever it says it is not, and never opens it", () => {
    const layout = { toggleSidebar: vi.fn() };
    const f = frame([], { layout });
    const LeftColumn = f.components.get("sidebar") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<LeftColumn collapsed={false} />);
    expect(layout.toggleSidebar).toHaveBeenCalledTimes(1);
    view.rerender(<LeftColumn collapsed />);
    view.rerender(<LeftColumn collapsed />);
    expect(layout.toggleSidebar).toHaveBeenCalledTimes(1);
  });
});

describe("the tools on a blank conversation", () => {
  afterEach(() => { cleanup(); });

  it("show nothing but the composer until a tool is chosen, then a chip and its starters under the composer, which can be left", () => {
    const components = new Map<string, (props: Record<string, unknown>) => unknown>();
    const ctx: Record<string, unknown> = {
      slots: { inject: (_name: string, setup: () => unknown) => setup(),
        register: (options: { name: string; id?: string }, component: (props: Record<string, unknown>) => unknown) => { components.set(options.id ?? options.name, component); return () => {}; } },
      sessions: { list: { getSnapshot: () => ({ current: "session-a" }), subscribe: () => () => {} }, scope: (id: string) => ({ id }) },
      conversation: { input: { for: () => ({ setDraft: () => {}, state: { getSnapshot: () => ({ draft: "老年房颤该不该抗凝？" }) } }) } },
      effect: (setup: () => unknown) => setup(),
      on: () => () => {},
    };
    const target = {
      __EVIMED_FRAME__: { version: 1, frameId: "f", projectId: "p", shellOrigin: "https://app.example", cwd: "/workspace", capabilities: [
        { id: "clinical-evidence-synthesis", title: "临床证据深度分析", category: "临床证据", brief: "b", summary: "围绕一个临床问题检索并综合证据。", minutes: [30, 70], starters: ["≥70 岁人群阿司匹林一级预防的获益与出血风险。"], outputs: ["证据综述报告"], limits: [], materials: "" },
      ] },
      parent: { postMessage() {} }, addEventListener() {}, removeEventListener() {}, console,
    };
    const kit = createFrameKit(ctx, target, (id: string) => (id === "react" ? React : undefined), FRAME_VOCABULARY);
    const sent: Array<[string, Record<string, unknown>]> = [];
    kit.hub.attach((type: string, fields: Record<string, unknown>) => { sent.push([type, fields]); });
    applyCommands(ctx, {}, target, undefined, kit);
    // The hero seat carries the chip and the starters within the composer's
    // width; no page of the tool above the composer.
    const Hero = components.get("conversation.hero.agentPreset") as (props: Record<string, unknown>) => React.ReactElement;
    const heroView = render(<Hero />);
    expect(heroView.container.textContent).toBe("");
    act(() => kit.hub.deliver("capability", { capabilityId: "clinical-evidence-synthesis", sessionId: "session-a" }));
    expect(heroView.container.querySelector("[data-evimed-hero-tools]")).not.toBeNull();
    expect(heroView.container.querySelector("[data-evimed-tool-page]")).toBeNull();
    expect(heroView.getByText("临床证据深度分析")).toBeInTheDocument();
    heroView.unmount();
    act(() => kit.hub.deliver("session", { sessionId: "session-b" }));
    const Chip = components.get("evimed-tool") as (props: Record<string, unknown>) => React.ReactElement;
    const Starters = components.get("evimed-tool-starters") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<><Chip /><Starters /></>);
    expect(view.container.textContent).toBe("");
    act(() => kit.hub.deliver("capability", { capabilityId: "clinical-evidence-synthesis", sessionId: "session-a" }));
    expect(screen.getByText("临床证据深度分析")).toBeInTheDocument();
    expect(screen.getByText("约 30–70 分钟")).toBeInTheDocument();
    expect(screen.queryByText(/你会拿到/)).toBeNull();
    // A starter goes into the composer of the open session.
    fireEvent.click(screen.getByRole("button", { name: "≥70 岁人群阿司匹林一级预防的获益与出血风险。" }));
    // Leaving the tool is the chip's ×: the shell is told, with the draft.
    fireEvent.click(screen.getByRole("button", { name: "不再用「临床证据深度分析」" }));
    expect(sent.at(-1)).toEqual(["bind-capability", { capabilityId: null, sessionId: "session-a", draft: "老年房颤该不该抗凝？" }]);
  });
});
