import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NeedsBar } from "./NeedsBar";

describe("NeedsBar", () => {
  it("draws nothing when nothing waits", () => {
    const { container } = render(<NeedsBar needs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the first need with its kind and counts the rest, whose way is `more`", () => {
    render(<NeedsBar needs={[{ key: "a", kind: "confirm", text: "设置投放预算", action: <a href="/x">去处理</a> }, { key: "b", kind: "resolve", text: "诊断未完成" }]} more={<a href="/all">全部</a>} />);
    expect(screen.getByText(/等你 · 待确认/)).toBeInTheDocument();
    expect(screen.getByText(/设置投放预算（共 2 项）/)).toBeInTheDocument();
    expect(screen.queryByText(/诊断未完成/)).toBeNull();
    expect(screen.getByRole("link", { name: "全部" })).toBeInTheDocument();
  });

  it("has no count and no `more` for one need", () => {
    render(<NeedsBar needs={[{ key: "a", kind: "provide", text: "还缺一份说明书", action: <a href="/x">去处理</a> }]} more={<a href="/all">全部</a>} />);
    expect(screen.queryByRole("link", { name: "全部" })).toBeNull();
    expect(screen.queryByText(/共 1 项/)).toBeNull();
  });
});
