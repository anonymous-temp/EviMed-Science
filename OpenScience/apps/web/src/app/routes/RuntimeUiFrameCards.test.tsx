// The frame's own rows in a browser DOM: what a click on a subtask's 「查看」,
// a delivered file or a reply check's ⚠ line does. The bodies are the ones the
// socket's build serializes into the kernel's page; here they run against a
// recording slot registry.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameKit } from "../../../../../packages/harness-port/src/runtimeUiKit.mjs";
import { FRAME_VOCABULARY } from "../../../../../packages/harness-port/src/runtimeUiFrame.mjs";
import { apply as applyToolviews } from "../../../../../packages/harness-port/src/runtimeUiToolviews.mjs";
import { apply as applyPanels } from "../../../../../packages/harness-port/src/runtimeUiPanels.mjs";
import { apply as applyReplyChecks } from "../../../../../packages/harness-port/src/runtimeUiReplyChecks.mjs";
import { apply as applyShell } from "../../../../../packages/harness-port/src/runtimeUiShell.mjs";
import { apply as applyCommands } from "../../../../../packages/harness-port/src/runtimeUiCommands.mjs";

type Listener = () => void;
type Component = (props: Record<string, unknown>) => React.ReactElement | null;
type Registration = { options: { name: string; key?: string; id?: string; priority?: number }; component: Component };

function frame(entries: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const registrations: Registration[] = [];
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
      register: (options: Registration["options"], component: Component) => { registrations.push({ options, component }); return () => {}; },
      entries: (name: string) => registrations.filter((entry) => entry.options.name === name)
        .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)),
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
  applyReplyChecks(ctx, {}, target, undefined, kit);
  applyPanels(ctx, {}, target, undefined, kit);
  applyShell(ctx, {}, { ...target, document: undefined }, undefined, kit);
  kit.hub.deliver("session", { sessionId: "session-a" });
  const find = (name: string, key?: string) => registrations
    .filter((entry) => entry.options.name === name && (key === undefined || entry.options.key === key))
    .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]?.component;
  return {
    sessions, kit, registrations, find, card: find("tool.call.toolview", "evimed_delegate")!,
    publish(next: Array<Record<string, unknown>>) { snapshot = { ...snapshot, subagentsByParent: { "session-a": { entries: next } } }; act(() => { for (const fn of [...listeners]) fn(); }); },
  };
}

const started = {
  kind: "tool-result", seq: 3, time: Date.now(), callId: "c1", callTime: Date.now() - 1000,
  call: { name: "evimed_delegate", argsRaw: JSON.stringify({ deliverableId: "evidence" }) },
  content: [{ type: "text", text: `ok\n${JSON.stringify({ handle: "h-1", deliverableId: "evidence", childSessionId: "child-1", status: "started" }, null, 2)}` }],
  isError: false, subCalls: [],
};

describe("the subtask card's link to the child", () => {
  afterEach(() => { cleanup(); });

  it("opens the kernel's own subagent view at the address the parent's catalogue lists", () => {
    const f = frame([{ id: "child-1", kind: "child", mode: "one-shot" }]);
    const Card = f.card;
    render(<Card block={started} />);
    fireEvent.click(screen.getByRole("button", { name: /^查看/ }));
    expect(f.sessions.openSubagent).toHaveBeenCalledWith({ parentSessionId: "session-a", childSessionId: "child-1", mode: "one-shot" });
    expect(f.sessions.refreshSubagents).not.toHaveBeenCalled();
  });

  it("waits for the catalogue, asks for it once, and comes alive when the child is listed", () => {
    const f = frame([]);
    const Card = f.card;
    const view = render(<Card block={started} />);
    const button = screen.getByRole("button", { name: /^查看/ });
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

  it("follows the run state the shell sends with its title and state, and nothing else", () => {
    const f = frame([{ id: "child-1", kind: "child", mode: "one-shot" }]);
    const Card = f.card;
    const view = render(<Card block={started} />);
    expect(screen.getByText("已启动")).toBeInTheDocument();
    act(() => f.kit.hub.deliver("run-state", { runId: "run-1", sessionId: "session-a", progress: {
      deliverables: [{ id: "evidence", title: "老年房颤抗凝证据综述", status: "delegated", attempts: 0 }],
      children: [{ childSessionId: "child-1", deliverableId: "evidence", state: "running", lastActivityAt: null }],
      currentPhase: "search", sources: { searched: 40, included: 3, fullText: 0 },
    } }));
    expect(screen.getByText("老年房颤抗凝证据综述")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看「老年房颤抗凝证据综述」" })).toBeInTheDocument();
    // No clock, no phase, no source count, no submission tally.
    expect(view.container.textContent).toBe("老年房颤抗凝证据综述进行中查看");
  });
});

describe("the files after the answer that delivered them", () => {
  afterEach(() => { cleanup(); });
  const TURN_START = Date.parse("2026-09-22T10:00:00.000Z");
  const TURN_END = Date.parse("2026-09-22T10:25:00.000Z");
  const live = {
    runId: "run-1", sessionId: "session-a", state: "succeeded",
    artifacts: ["deliverables/evidence/clinical-evidence-report.md", "deliverables/evidence/clinical-evidence-matrix.json"],
    unverifiedArtifacts: [],
    progress: { deliverables: [{ id: "evidence", title: "老年房颤抗凝证据综述", status: "accepted", attempts: 2 }], children: [],
      startedAt: new Date(TURN_START + 1000).toISOString(), updatedAt: new Date(TURN_END + 5000).toISOString() },
  };
  const answerProps = {
    node: { kind: "assistant-step", data: { turn: 1, step: 3, finalNode: { seq: 40 } }, location: { kind: "step", turn: { turn: 1, start: { time: TURN_START } } } },
    useTurnData: (key: string) => (key === "turn-tail" ? { turn: 1, time: TURN_END, closing: { finalNode: { seq: 40 } } } : undefined),
    useChat: (selector: (snapshot: unknown) => unknown) => selector({ timeline: { turnOrder: [1] } }),
    useResource: (address: string) => (address.endsWith("clinical-evidence-report.md") ? { status: "live", value: { bytes: 24_576 } } : { status: "loading" }),
  };

  it("opens a file through the shell, and registers no card above the composer, tab or view of its own", () => {
    const registered: string[] = [];
    const f = frame([], { sidebarRightTabs: { register: (definition: { id: string }) => { registered.push(definition.id); return () => {}; } }, sidebarRight: { openTab: vi.fn() } });
    const sent: Array<[string, Record<string, unknown>]> = [];
    f.kit.hub.attach((type: string, fields: Record<string, unknown>) => { sent.push([type, fields]); });
    act(() => f.kit.hub.deliver("run-state", live));
    expect(registered).toEqual([]);
    expect(f.find("conversation.view")).toBeUndefined();
    expect(f.find("conversation.input.dock")).toBeUndefined();
    const Answer = f.find("conversation.chat.node", "assistant-step")!;
    render(<Answer {...answerProps} />);
    // The document's name, as the shell's reader titles it; the size the kernel reports.
    expect(screen.getByText("证据分析报告")).toBeInTheDocument();
    expect(screen.getByText("Markdown · 24 KB")).toBeInTheDocument();
    expect(screen.getByText("证据矩阵")).toBeInTheDocument();
    expect(screen.getByText("JSON")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开证据分析报告" }));
    expect(sent).toEqual([["open-artifact", { runId: "run-1", path: "deliverables/evidence/clinical-evidence-report.md" }]]);
    expect(document.body.textContent).not.toMatch(/已交付|已核对|用时|¥|结论/);
  });

  it("a reply check with a problem is one line that opens into each flagged sentence, its reason, the source's words and link", () => {
    const f = frame([]);
    act(() => f.kit.hub.deliver("reply-check", { sessionId: "session-a", checks: [{ turnSeq: 40, status: "done", cautions: [], verdicts: [
      { sentence: "二甲双胍可使 HbA1c 降低约 1% [1]。", verdict: "supported", reason: "一致", evidence: "fell by 1.1%", safety: "none", source: null },
      { sentence: "华法林与布洛芬合用无妨 [2]。", verdict: "unsupported", reason: "来源说增加出血", evidence: "NSAIDs increased the risk of major bleeding", safety: "none",
        source: { number: 2, title: "Warfarin and NSAIDs", url: "https://pubmed.ncbi.nlm.nih.gov/2/" } },
    ] }] }));
    const Answer = f.find("conversation.chat.node", "assistant-step")!;
    render(<Answer {...answerProps} />);
    const toggle = screen.getByRole("button", { name: /⚠ 1 处引用待核对/ });
    expect(screen.queryByText("华法林与布洛芬合用无妨 [2]。")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("华法林与布洛芬合用无妨 [2]。")).toBeInTheDocument();
    expect(screen.getByText("来源不支持：来源说增加出血")).toBeInTheDocument();
    expect(screen.getByText("原文：「NSAIDs increased the risk of major bleeding」")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "[2] Warfarin and NSAIDs" })).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/2/");
    expect(screen.queryByText(/二甲双胍/)).toBeNull();
  });

  it("tells the kernel its left column is collapsed whenever it says it is not, and never opens it", () => {
    const layout = { toggleSidebar: vi.fn() };
    const f = frame([], { layout });
    const LeftColumn = f.find("sidebar")!;
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
    // A starter goes into the composer of the open session.
    fireEvent.click(heroView.getByRole("button", { name: "≥70 岁人群阿司匹林一级预防的获益与出血风险。" }));
    heroView.unmount();
    act(() => kit.hub.deliver("session", { sessionId: "session-b" }));
    // In a session the chip alone sits under the composer; the starters stay on the hero.
    expect(components.has("evimed-tool-starters")).toBe(false);
    const Chip = components.get("evimed-tool") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Chip />);
    expect(view.container.textContent).toBe("");
    act(() => kit.hub.deliver("capability", { capabilityId: "clinical-evidence-synthesis", sessionId: "session-a" }));
    expect(screen.getByText("临床证据深度分析")).toBeInTheDocument();
    // The tool's name alone: how long it takes was said on 科研工具.
    expect(view.container.textContent).toBe("临床证据深度分析×");
    expect(screen.queryByRole("button", { name: "≥70 岁人群阿司匹林一级预防的获益与出血风险。" })).toBeNull();
    // Leaving the tool is the chip's ×: the shell is told, with the draft.
    const leave = screen.getByRole("button", { name: "移除「临床证据深度分析」" });
    expect(leave).toHaveAttribute("title", "移除");
    fireEvent.click(leave);
    expect(sent.at(-1)).toEqual(["bind-capability", { capabilityId: null, sessionId: "session-a", draft: "老年房颤该不该抗凝？" }]);
  });
});
