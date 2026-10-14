import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStrip } from "./ActivityStrip";
import { StepState } from "./StepState";

const inRouter = (node: React.ReactNode) => <MemoryRouter>{node}</MemoryRouter>;

describe("StepState", () => {
  it("writes an empty step as a recipe: what it uses (each a way to the thing), what it gives, and the one verb-and-object button", async () => {
    const start = vi.fn();
    const open = vi.fn();
    const { container } = render(inRouter(
      <StepState
        phase="empty"
        step="生成虚拟患者"
        noun="虚拟患者"
        uses={[{ label: "人群", to: "/app/virtual-research/s1/population" }, { label: "证据", onOpen: open }]}
        gives="2,000 名虚拟患者的基线与随访轨迹"
        onStart={start}
      />,
    ));
    expect(container.querySelector("[data-step-state='empty']")).not.toBeNull();
    expect(container.querySelector("[data-empty]")).not.toBeNull();
    expect(screen.getByText("还没有虚拟患者")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "人群" })).toHaveAttribute("href", "/app/virtual-research/s1/population");
    await userEvent.click(screen.getByRole("button", { name: "证据" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByText("得到 2,000 名虚拟患者的基线与随访轨迹")).toBeInTheDocument();
    // The button names the work. It is not 「让 AI 做」.
    await userEvent.click(screen.getByRole("button", { name: "生成虚拟患者" }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("让 AI 做")).toBeNull();
  });

  it("says why there is no button where the person may not start the step, and never stops at a bare title", () => {
    const { container } = render(inRouter(<StepState phase="empty" step="生成虚拟患者" noun="虚拟患者" reason="只有研究的负责人可以开始这一步。" />));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("只有研究的负责人可以开始这一步。")).toBeInTheDocument();
    expect(container.querySelector("[data-empty][data-reason]")).not.toBeNull();
  });

  it("says what a queued step waits for, and lets it be cancelled", async () => {
    const stop = vi.fn();
    render(inRouter(<StepState phase="queued" step="设计试验" after="对照" onStop={stop} to="/app/runs?run=r1" />));
    expect(screen.getByText("设计试验，排队中")).toBeInTheDocument();
    expect(screen.getByText("“对照”做完后自动开始。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看对话" })).toHaveAttribute("href", "/app/runs?run=r1");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  describe("a running step", () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T08:03:00Z")); });
    afterEach(() => vi.useRealTimers());

    it("is never a lone 「正在进行」: what, how far, for how long, where the conversation is, and 停止", () => {
      const stop = vi.fn();
      const { container } = render(inRouter(
        <StepState phase="running" step="生成虚拟患者" phaseName="计算" counts={{ done: 1200, total: 2000 }} startedAt="2026-10-14T08:00:30Z" onStop={stop} to="/app/runs?run=r1" />,
      ));
      expect(screen.getByText("正在生成虚拟患者")).toBeInTheDocument();
      expect(screen.getByText("计算 1,200 / 2,000 · 已进行 2 分 30 秒")).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/%|正在进行/);
      expect(screen.getByRole("link", { name: "查看对话" })).toBeInTheDocument();
      screen.getByRole("button", { name: "停止" }).click();
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps what a failed step kept, and offers to go on from there", async () => {
    const resume = vi.fn();
    render(inRouter(<StepState phase="failed" step="生成虚拟患者" failure="计算在第 1,200 名时中断。" kept="已算出的 1,200 名保留。" onResume={resume} to="/app/runs?run=r1" />));
    expect(screen.getByText("生成虚拟患者没有完成")).toBeInTheDocument();
    expect(screen.getByText("已算出的 1,200 名保留。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "接着做" }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("says a step that waits for the allowance is waiting for it, with the control that puts it right", () => {
    render(inRouter(<StepState phase="credits" step="定义" waiting="allowance" topUp={<a href="/app/account?tab=usage">去充值</a>} />));
    expect(screen.getByText(/这一步在等额度/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去充值" })).toBeInTheDocument();
  });
});

describe("ActivityStrip", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T08:03:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("says what is happening, how far and for how long, under the rail, with the way to cancel it and to the conversation", async () => {
    const cancel = vi.fn();
    const { container } = render(inRouter(
      <ActivityStrip label="生成虚拟患者" phase="计算" counts={{ done: 1200, total: 2000 }} startedAt="2026-10-14T08:00:00Z" queued={2} to="/app/runs?run=r1" onCancel={cancel} />,
    ));
    const strip = container.querySelector("[data-activity='strip']") as HTMLElement;
    expect(strip).toHaveTextContent("正在生成虚拟患者");
    expect(strip).toHaveTextContent("计算 1,200 / 2,000");
    expect(strip).toHaveTextContent("3 分钟");
    expect(strip).toHaveTextContent("另有 2 项排队");
    // Never a percentage: a share of an agent's work is a number nobody can honour.
    expect(strip.textContent).not.toContain("%");
    expect(screen.getByRole("link", { name: "查看进度" })).toHaveAttribute("href", "/app/runs?run=r1");
    screen.getByRole("button", { name: "取消" }).click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("is a small chip for the header: the step, the elapsed time and one link to the progress", () => {
    const { container } = render(inRouter(<ActivityStrip variant="chip" label="证据" startedAt="2026-10-14T08:00:00Z" to="/app/runs?run=r1" />));
    const chip = container.querySelector("[data-activity='chip']") as HTMLElement;
    expect(chip.tagName).toBe("A");
    expect(chip).toHaveAttribute("href", "/app/runs?run=r1");
    expect(chip).toHaveTextContent("正在证据3 分钟查看进度");
  });
});
