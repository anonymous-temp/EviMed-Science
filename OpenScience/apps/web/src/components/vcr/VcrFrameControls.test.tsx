// The 虚拟临床研究 chip in a browser DOM: what the chip's menu (起点 and 预期用途, as
// radio groups that open above the composer) and the starters do when the reader uses them. The body is the one the socket's build serializes
// into the kernel's page; here it runs against a recording slot registry, the
// same arrangement `RuntimeUiFrameCards.test.tsx` uses for the GEO chip.
import * as React from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFrameKit } from "../../../../../packages/harness-port/src/runtimeUiKit.mjs";
import { FRAME_VOCABULARY } from "../../../../../packages/harness-port/src/runtimeUiFrame.mjs";
import { apply as applyCommands } from "../../../../../packages/harness-port/src/runtimeUiCommands.mjs";
import { frameVcrOptions } from "./frameVcrOptions";
import type { VcrStudy } from "@/lib/vcrClient";

type Component = (props: Record<string, unknown>) => unknown;

function mainView(sessionId: string) {
  return { ids: [sessionId], phase: "ready", byId: { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } }, projectionsBySession: {} };
}

/** A study as the shell reads it, with the roles it holds. */
function study(abilities: string[]): VcrStudy {
  return {
    id: "std_1", projectId: "p", name: "EV-201", question: null, tier: "T0", intendedUse: "exploratory", status: "active",
    steps: {}, sessionId: "session-a", conversation: { sessionId: "session-a", exists: true }, activity: null, stepSummaries: {},
    definition: null, abilities, budget: null, jobs: [], ceiling: null,
    overview: { headline: null, metrics: [], counts: null, designs: [], attention: [], changes: [], reviews: [], deliverables: [] },
  };
}

function vcrFrame() {
  const components = new Map<string, Component>();
  const drafts: string[] = [];
  const ctx: Record<string, unknown> = {
    slots: {
      inject: (_name: string, setup: () => unknown) => setup(),
      register: (options: { name: string; id?: string }, component: Component) => { components.set(options.id ?? options.name, component); return () => {}; },
    },
    sessions: { list: { getSnapshot: () => mainView("session-a"), subscribe: () => () => {} }, scope: (id: string) => ({ id }) },
    conversation: { input: { for: () => ({ setDraft: (text: string) => { drafts.push(text); }, state: { getSnapshot: () => ({ draft: "" }) } }) } },
    effect: (setup: () => unknown) => setup(),
    on: () => () => {},
  };
  // The module's capabilities are hidden from the tool list: the catalogue has none.
  const target = {
    __EVIMED_FRAME__: { version: 1, frameId: "f", projectId: "p", shellOrigin: "https://app.example", cwd: "/workspace", capabilities: [] },
    parent: { postMessage() {} }, addEventListener() {}, removeEventListener() {}, console,
    // The menu closes on Escape and on a press outside it: it listens on the page.
    document,
  };
  const kit = createFrameKit(ctx, target, (id: string) => (id === "react" ? React : undefined), FRAME_VOCABULARY);
  const sent: Array<[string, Record<string, unknown>]> = [];
  kit.hub.attach((type: string, fields: Record<string, unknown>) => { sent.push([type, fields]); });
  applyCommands(ctx, {}, target, undefined, kit);
  return { components, drafts, kit, sent };
}

describe("the 虚拟临床研究 chip", () => {
  afterEach(() => { cleanup(); });

  it("fills the native composer from four task intents without sending or changing the study start", () => {
    const f = vcrFrame();
    const Hero = f.components.get("conversation.hero.agentPreset") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Hero />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-protocol", sessionId: "session-a" }));
    const labels = ["患者匹配", "人群与患者", "合成对照", "虚拟试验"];
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", null)));
    expect(labels.every(label => view.queryByRole("button", { name: label }))).toBe(true);
    expect(view.container.querySelector("[aria-haspopup]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "虚拟试验" }));
    expect(f.drafts).toEqual([expect.stringContaining("先查找参数证据")]);
    expect(f.sent).toEqual([]);
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write", "manage_study"]))));
    fireEvent.click(view.getByRole("button", { name: "虚拟临床研究，设置" }));
    const menu = view.getByRole("dialog", { name: "虚拟临床研究设置" });
    expect(within(menu).queryByRole("radiogroup", { name: "起点" })).toBeNull();
    const use = within(menu).getByRole("radiogroup", { name: "预期用途" });
    fireEvent.click(within(use).getByRole("radio", { name: "研究设计支持" }));
    expect(f.sent.at(-1)).toEqual(["vcr-options", { sessionId: "session-a", intendedUse: "design_support" }]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "虚拟临床研究 · 研究设计支持，设置" }));
  });

  it("puts the study's own value back when the shell says the write did not land", () => {
    const f = vcrFrame();
    const Chip = f.components.get("evimed-tool") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Chip />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-package", sessionId: "session-a" }));
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write", "manage_study"]))));
    fireEvent.click(view.getByRole("button", { name: "虚拟临床研究，设置" }));
    const use = () => within(view.getByRole("dialog", { name: "虚拟临床研究设置" })).getByRole("radiogroup", { name: "预期用途" });
    fireEvent.click(within(use()).getByRole("radio", { name: "申报准备" }));
    expect(within(use()).getByRole("radio", { name: "申报准备" })).toBeChecked();
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write", "manage_study"]))));
    expect(within(use()).getByRole("radio", { name: "探索" })).toBeChecked();
    expect(within(use()).getByRole("radio", { name: "申报准备" })).not.toBeChecked();
    expect(view.getByRole("button", { name: "虚拟临床研究，设置" })).toBeInTheDocument();
    // The starters are the blank conversation's: not under the composer.
    expect(view.queryByRole("button", { name: "完整研究" })).toBeNull();
  });

  it("offers no settings to readers who cannot manage the study, while keeping task starters", () => {
    const f = vcrFrame();
    const Hero = f.components.get("conversation.hero.agentPreset") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Hero />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-matching", sessionId: "session-a" }));
    for (const abilities of [["read", "write"], ["read"]]) {
      act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(abilities))));
      expect(view.queryByRole("dialog")).toBeNull();
      expect(view.container.querySelector("[aria-haspopup]")).toBeNull();
      expect(view.getByText("虚拟临床研究")).toBeInTheDocument();
      expect(view.getByRole("button", { name: "患者匹配" })).toBeInTheDocument();
    }
    expect(f.sent).toEqual([]);
  });
});
