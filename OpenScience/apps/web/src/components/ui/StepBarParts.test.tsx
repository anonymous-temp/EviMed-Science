import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ActivityStrip } from "./ActivityStrip";
import { Tabs } from "./Tabs";

/**
 * What a module's step bar needs of the framework's two parts beyond what they did (R19, 虚拟临床研究's study page): a tab that says
 * what its stage found and what its dot means, a row that stays reachable from the keyboard when none of its tabs is the open view
 * (the study's conversation is a view of the page and not a tab), and a strip that can say a step is in line and for what.
 */

const ITEMS = [
  { value: "overview", label: "总览" },
  { value: "population", label: "人群", dot: "done" as const, note: "3,412 名", hint: "已完成" },
  { value: "patients", label: "虚拟患者", dot: "attention" as const, note: "2,000 名", hint: "需要留意：上次没有做完" },
];

describe("Tabs — what a stage found, and what its dot means", () => {
  it("prints the note after the name, reads it with the label, and gives the dot's meaning as the tab's tooltip", () => {
    render(<Tabs label="研究视图" items={ITEMS} value="overview" onChange={() => undefined} />);
    const tab = screen.getByRole("tab", { name: /^虚拟患者/ });
    expect(tab).toHaveTextContent("虚拟患者2,000 名需要留意");
    expect(tab.querySelector("[data-tab-note]")).toHaveTextContent("2,000 名");
    expect(document.getElementById(tab.getAttribute("aria-describedby") ?? "")).toHaveTextContent("需要留意：上次没有做完");
    // A tab with no hint carries none.
    expect(screen.getByRole("tab", { name: "总览" })).not.toHaveAttribute("aria-describedby");
  });

  it("keeps the row in the tab order when no tab is the open view, by its first tab, and still moves with the arrows", async () => {
    const onChange = vi.fn();
    render(<Tabs label="研究视图" items={ITEMS} value="chat" onChange={onChange} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(screen.queryByRole("tab", { selected: true })).toBeNull();
    tabs[0].focus();
    // From no open tab the arrow goes to the first one.
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("overview");
  });

  it("leaves a row with an open tab as it was: only the open one is in the tab order", () => {
    render(<Tabs label="研究视图" items={ITEMS} value="population" onChange={() => undefined} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });
});

describe("ActivityStrip — a step in line", () => {
  const draw = (props: Parameters<typeof ActivityStrip>[0]) => render(<MemoryRouter><ActivityStrip {...props} /></MemoryRouter>);

  it("says 排队中 and what it waits for, with a still dot and no clock — nothing has started to be counted", () => {
    draw({ label: "生成虚拟患者", waiting: "等“证据”做完", startedAt: new Date(Date.now() - 600_000).toISOString(), queued: 1 });
    const strip = document.querySelector("[data-activity='strip']") as HTMLElement;
    expect(strip).toHaveAttribute("data-activity-state", "queued");
    expect(strip).toHaveTextContent("生成虚拟患者 · 排队中");
    expect(strip).toHaveTextContent("等“证据”做完");
    expect(strip).toHaveTextContent("另有 1 项排队");
    expect(strip).not.toHaveTextContent(/正在|分钟/);
    expect(strip.querySelector(".animate-pulse")).toBeNull();
  });

  it("is what it was while it runs: 正在, the phase and its count, the clock, and 取消", async () => {
    const onCancel = vi.fn();
    draw({ label: "生成虚拟患者", phase: "计算", counts: { done: 3, total: 10 }, startedAt: new Date(Date.now() - 125_000).toISOString(), onCancel });
    const strip = document.querySelector("[data-activity='strip']") as HTMLElement;
    expect(strip).toHaveAttribute("data-activity-state", "running");
    expect(strip).toHaveTextContent("正在生成虚拟患者");
    expect(strip).toHaveTextContent("计算 3 / 10");
    expect(strip).toHaveTextContent("2 分");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalled();
    expect(strip.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("says it in the header's small form too", () => {
    draw({ label: "生成虚拟患者", waiting: "等“证据”做完", variant: "chip" });
    expect(document.querySelector("[data-activity='chip']")).toHaveTextContent("生成虚拟患者，排队中");
  });
});
