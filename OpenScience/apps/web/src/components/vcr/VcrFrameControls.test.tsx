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
    steps: {}, sessionId: "session-a", definition: null, abilities, budget: null, jobs: [], ceiling: null,
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

  it("says 「虚拟临床研究」, changes where the study starts and what it is for from the chip's menu through the shell, and never sends the composer", () => {
    const f = vcrFrame();
    const Hero = f.components.get("conversation.hero.agentPreset") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Hero />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-protocol", sessionId: "session-a" }));
    expect(view.getByText("虚拟临床研究")).toBeInTheDocument();
    // Without the study's options there is nothing to set: the chip is a name and a way out.
    expect(view.container.querySelector("[aria-haspopup]")).toBeNull();
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write", "manage_study"]))));

    // At the defaults the chip says nothing more; the settings are one click away, in a menu that opens above it.
    const trigger = view.getByRole("button", { name: "虚拟临床研究，设置" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(view.queryByRole("radiogroup", { name: "起点" })).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = view.getByRole("dialog", { name: "虚拟临床研究设置" });
    const start = within(menu).getByRole("radiogroup", { name: "起点" });
    expect(within(start).getAllByRole("radio").map((option) => option.textContent)).toEqual(["自动", "队列", "患者", "对照", "试验"]);
    expect(within(start).getByRole("radio", { name: "自动" })).toBeChecked();
    fireEvent.click(within(start).getByRole("radio", { name: "试验" }));
    expect(f.sent.at(-1)).toEqual(["vcr-options", { sessionId: "session-a", start: "trial" }]);
    expect(within(start).getByRole("radio", { name: "试验" })).toBeChecked();
    // One setting off its default is named on the chip.
    expect(view.getByRole("button", { name: "虚拟临床研究 · 试验，设置" })).toBeInTheDocument();

    const use = within(menu).getByRole("radiogroup", { name: "预期用途" });
    expect(within(use).getByRole("radio", { name: "探索" })).toBeChecked();
    fireEvent.click(within(use).getByRole("radio", { name: "研究设计支持" }));
    expect(f.sent.at(-1)).toEqual(["vcr-options", { sessionId: "session-a", intendedUse: "design_support" }]);
    expect(within(use).getByRole("radio", { name: "研究设计支持" })).toBeChecked();
    // Both settings off their defaults: a count, not a sentence.
    expect(view.getByRole("button", { name: "虚拟临床研究 · 2 项设置，设置" })).toBeInTheDocument();

    // Escape closes the menu and puts focus back on the chip.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "虚拟临床研究 · 2 项设置，设置" }));

    // A starter fills the composer; nothing is sent.
    fireEvent.click(view.getByRole("button", { name: "估算样本量" }));
    expect(f.drafts).toEqual(["帮我估算这项研究的样本量和成功把握，研究是："]);
    expect(f.sent.filter(([type]) => type !== "vcr-options")).toEqual([]);
  });

  it("draws the six starting points of a new study on the blank conversation — with the chip's menu or, with no study found, without it — and a pill only fills the composer", () => {
    const f = vcrFrame();
    const Hero = f.components.get("conversation.hero.agentPreset") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Hero />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-protocol", sessionId: "session-a" }));
    const labels = ["估算样本量", "生成合成人群", "外部对照可行性", "模拟试验方案", "找先例与参数", "匹配患者"];
    // No study yet (the shell could not read one): the pills are still there, and the chip has no menu to offer.
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", null)));
    expect(labels.every((label) => view.queryByRole("button", { name: label }))).toBe(true);
    expect(view.container.querySelector("[aria-haspopup]")).toBeNull();
    // The study the shell found by its project — a draft nobody has spoken in — gives the chip its menu, and the pills stay.
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", { ...study(["read", "write", "manage_study"]), status: "draft" } as VcrStudy)));
    fireEvent.click(view.getByRole("button", { name: "虚拟临床研究，设置" }));
    expect(within(view.getByRole("radiogroup", { name: "起点" })).getByRole("radio", { name: "自动" })).toBeChecked();
    expect(labels.every((label) => view.queryByRole("button", { name: label }))).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "模拟试验方案" }));
    expect(f.drafts).toEqual(["帮我模拟几个试验方案：比较样本量、功效、成功把握、周期和成本，研究是："]);
    expect(f.sent.filter(([type]) => type !== "vcr-options")).toEqual([]);
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

  it("offers a reader without the lead's role the start and not the intended use", () => {
    const f = vcrFrame();
    const Chip = f.components.get("evimed-tool") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Chip />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-matching", sessionId: "session-a" }));
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write"]))));
    fireEvent.click(view.getByRole("button", { name: "虚拟临床研究，设置" }));
    const menu = view.getByRole("dialog", { name: "虚拟临床研究设置" });
    expect(within(menu).getByRole("radiogroup", { name: "起点" })).toBeInTheDocument();
    expect(within(menu).queryByRole("radiogroup", { name: "预期用途" })).toBeNull();
    // A reader who can change nothing has no menu at all: the chip is a name and a way out.
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read"]))));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.container.querySelector("[aria-haspopup]")).toBeNull();
    expect(view.getByText("虚拟临床研究")).toBeInTheDocument();
  });
});
