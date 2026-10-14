import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterDetail } from "./MasterDetail";

/** The page's own width as the layout measures it (jsdom has no layout). */
let width = 0;
beforeEach(() => {
  width = 1000;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.hasAttribute("data-master-detail") ? width : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
});
afterEach(() => vi.restoreAllMocks());

const list = <ul><li>假设 A</li><li>假设 B</li></ul>;
const detail = <p>假设 A 的详情</p>;

describe("MasterDetail", () => {
  it("puts the list beside the record when the page has room for both, and the record is the right-hand column, not a drawer", () => {
    const { container } = render(<MasterDetail list={list} detail={detail} selected listLabel="假设列表" detailLabel="假设" detailTitle="假设" onCloseDetail={() => {}} />);
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    expect(screen.getByRole("region", { name: "假设列表" })).toHaveStyle({ width: "340px" });
    expect(screen.getByRole("region", { name: "假设" })).toHaveTextContent("假设 A 的详情");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the record in a drawer over the list when there is not room, and closing it is the page's", async () => {
    width = 700;
    const close = vi.fn();
    const { rerender } = render(<MasterDetail list={list} detail={detail} selected={false} listLabel="假设列表" detailLabel="假设" detailTitle="假设" onCloseDetail={close} />);
    expect(screen.getByRole("region", { name: "假设列表" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<MasterDetail list={list} detail={detail} selected listLabel="假设列表" detailLabel="假设" detailTitle="假设" onCloseDetail={close} />);
    const drawer = screen.getByRole("dialog", { name: "假设" });
    expect(drawer).toHaveTextContent("假设 A 的详情");
    // The list stays the page behind the drawer.
    expect(screen.getByRole("region", { name: "假设列表" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swaps the record for the list instead where the record needs the whole width (a conversation)", () => {
    width = 700;
    const { container, rerender } = render(<MasterDetail narrow="swap" list={list} detail={detail} selected={false} listLabel="任务列表" detailLabel="任务" modeAttribute="data-autopilot-layout" />);
    expect(container.querySelector("[data-autopilot-layout]")).toHaveAttribute("data-autopilot-layout", "single");
    expect(screen.getByRole("region", { name: "任务列表" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "任务" })).toBeNull();
    rerender(<MasterDetail narrow="swap" list={list} detail={detail} selected listLabel="任务列表" detailLabel="任务" modeAttribute="data-autopilot-layout" />);
    expect(screen.queryByRole("region", { name: "任务列表" })).toBeNull();
    expect(screen.getByRole("region", { name: "任务" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hands each region whether the two are side by side", () => {
    width = 1000;
    render(<MasterDetail narrow="swap" list={({ split }) => <p>{split ? "并排" : "单列"}</p>} detail={({ split }) => <p>{split ? "详情并排" : "详情单列"}</p>} selected listLabel="列表" detailLabel="详情" />);
    expect(screen.getByText("并排")).toBeInTheDocument();
    expect(screen.getByText("详情并排")).toBeInTheDocument();
  });

  it("does not compile a drawer without a title and a way to close it", () => {
    // @ts-expect-error `narrow="drawer"` (the default) needs `detailTitle` and `onCloseDetail`
    const missing = <MasterDetail list={list} detail={detail} selected listLabel="列表" detailLabel="详情" />;
    expect(missing).toBeTruthy();
  });
});
