// The 虚拟临研 chip in a browser DOM: what the two selects and the starters do
// when the reader uses them. The body is the one the socket's build serializes
// into the kernel's page; here it runs against a recording slot registry, the
// same arrangement `RuntimeUiFrameCards.test.tsx` uses for the GEO chip.
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
  };
  const kit = createFrameKit(ctx, target, (id: string) => (id === "react" ? React : undefined), FRAME_VOCABULARY);
  const sent: Array<[string, Record<string, unknown>]> = [];
  kit.hub.attach((type: string, fields: Record<string, unknown>) => { sent.push([type, fields]); });
  applyCommands(ctx, {}, target, undefined, kit);
  return { components, drafts, kit, sent };
}

describe("the 虚拟临研 chip", () => {
  afterEach(() => { cleanup(); });

  it("says 「虚拟临研」, changes where the study starts and what it is for through the shell, and never sends the composer", () => {
    const f = vcrFrame();
    const Hero = f.components.get("conversation.hero.agentPreset") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Hero />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-protocol", sessionId: "session-a" }));
    expect(view.getByText("虚拟临研")).toBeInTheDocument();
    expect(view.queryByRole("combobox", { name: "起点" })).toBeNull();
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write", "manage_study"]))));

    const start = view.getByRole("combobox", { name: "起点" });
    expect(start).toHaveValue("auto");
    expect(Array.from((start as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(["起点：自动", "起点：队列", "起点：患者", "起点：对照", "起点：试验"]);
    fireEvent.change(start, { target: { value: "trial" } });
    expect(f.sent.at(-1)).toEqual(["vcr-options", { sessionId: "session-a", start: "trial" }]);
    expect(start).toHaveValue("trial");

    const use = view.getByRole("combobox", { name: "预期用途" });
    expect(use).toHaveValue("exploratory");
    expect(use).toHaveDisplayValue("预期用途：探索");
    fireEvent.change(use, { target: { value: "design_support" } });
    expect(f.sent.at(-1)).toEqual(["vcr-options", { sessionId: "session-a", intendedUse: "design_support" }]);
    expect(use).toHaveValue("design_support");

    // A starter fills the composer; nothing is sent.
    fireEvent.click(view.getByRole("button", { name: "估算样本量" }));
    expect(f.drafts).toEqual(["帮我估算这项研究的样本量和成功把握，研究是："]);
    expect(f.sent.filter(([type]) => type !== "vcr-options")).toEqual([]);
  });

  it("puts the study's own value back when the shell says the write did not land", () => {
    const f = vcrFrame();
    const Chip = f.components.get("evimed-tool") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Chip />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-package", sessionId: "session-a" }));
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write", "manage_study"]))));
    const use = view.getByRole("combobox", { name: "预期用途" });
    fireEvent.change(use, { target: { value: "submission_preparation" } });
    expect(use).toHaveValue("submission_preparation");
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write", "manage_study"]))));
    expect(view.getByRole("combobox", { name: "预期用途" })).toHaveValue("exploratory");
    // The starters are the blank conversation's: not under the composer.
    expect(view.queryByRole("button", { name: "完整研究" })).toBeNull();
  });

  it("offers a reader without the lead's role the start and not the intended use", () => {
    const f = vcrFrame();
    const Chip = f.components.get("evimed-tool") as (props: Record<string, unknown>) => React.ReactElement;
    const view = render(<Chip />);
    act(() => f.kit.hub.deliver("capability", { capabilityId: "vcr-matching", sessionId: "session-a" }));
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read", "write"]))));
    expect(view.getByRole("combobox", { name: "起点" })).toBeInTheDocument();
    expect(view.queryByRole("combobox", { name: "预期用途" })).toBeNull();
    act(() => f.kit.hub.deliver("vcr", frameVcrOptions("session-a", study(["read"]))));
    expect(view.queryByRole("combobox", { name: "起点" })).toBeNull();
    expect(view.queryByRole("combobox", { name: "预期用途" })).toBeNull();
    expect(view.getByText("虚拟临研")).toBeInTheDocument();
  });
});
