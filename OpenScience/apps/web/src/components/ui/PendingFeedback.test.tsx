import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announce } from "@/lib/announce";
import { PendingFeedback, PendingFeedbackBoundary } from "./PendingFeedback";

vi.mock("@/lib/announce", () => ({ announce: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); cleanup(); vi.useRealTimers(); });

describe("read feedback latency", () => {
  it("keeps passive gallery skeletons visible after a minute without inventing a read", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    render(<PendingFeedbackBoundary mode="passive"><PendingFeedback><div data-testid="demo-skeleton" /></PendingFeedback></PendingFeedbackBoundary>);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTestId("demo-skeleton")).toBeInTheDocument();
    expect(document.querySelector("[data-pending-feedback]")).toBeNull();
    expect(announce).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces the visible placeholder once while suppressing hidden tab reads, then activates on reveal", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const body = (hidden: boolean) => <>
      {hidden && <PendingFeedback stage="正在读取所选范围"><div /></PendingFeedback>}
      <div hidden={hidden}><PendingFeedbackBoundary mode={hidden ? "inactive" : "active"}>
        <PendingFeedback stage="正在读取页签"><div /></PendingFeedback>
      </PendingFeedbackBoundary></div>
    </>;
    const view = render(body(true));
    act(() => vi.advanceTimersByTime(10_000));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("正在读取所选范围", expect.any(Object));
    view.rerender(body(false));
    act(() => vi.advanceTimersByTime(10_000));
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith("正在读取页签", expect.any(Object));
  });

  it("does not flash a fast read; exposes the relevant skeleton at 300ms", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const view = render(<PendingFeedback><div data-testid="skeleton" /></PendingFeedback>);
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never reveals feedback when the real read settles before 300ms", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const view = render(<PendingFeedback><div data-testid="skeleton" /></PendingFeedback>);
    act(() => vi.advanceTimersByTime(100));
    view.rerender(<p>读取结果</p>);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("读取结果")).toBeInTheDocument();
    expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports real elapsed and stage at 10s and truthful non-durable limits at 60s", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    render(<PendingFeedback stage="正在读取账户信息"><div /></PendingFeedback>);
    act(() => vi.advanceTimersByTime(10_000));
    expect(document.querySelector("[data-pending-feedback]")).toHaveTextContent("正在读取账户信息 · 已等待 10 秒");
    expect(announce).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/不会保留/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(50_000));
    expect(document.querySelector("[data-pending-feedback]")).toHaveTextContent("已等待 1 分");
    expect(document.querySelector("[data-pending-feedback]")).toHaveTextContent("离开页面后不会保留本次请求");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(announce).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(5000));
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("resets timing for a new request and clears old request timers", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const view = render(<PendingFeedback key="first"><div data-testid="skeleton" /></PendingFeedback>);
    act(() => vi.advanceTimersByTime(60_000));
    view.rerender(<PendingFeedback key="second"><div data-testid="skeleton" /></PendingFeedback>);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
