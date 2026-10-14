import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Library, UsersRound } from "lucide-react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartCard } from "./ChartCard";
import { ChartGrid } from "./ChartGrid";
import { FactList } from "./FactList";
import { ScopeMenu } from "./ScopeMenu";
import { Section } from "./Section";
import { StateScreen } from "./StateScreen";
import { Compass } from "lucide-react";

afterEach(() => vi.restoreAllMocks());

describe("ChartGrid", () => {
  const card = (key: string) => ({ key, node: <ChartCard title={`图 ${key}`}>内容</ChartCard> });

  it("lays cards out in rows that share a height, and a span-2 card takes its whole row", () => {
    const { container } = render(<ChartGrid rows={[[{ ...card("trend"), span: 2 }], [card("engine"), card("pool")]]} />);
    const grid = container.querySelector("[data-chart-grid]") as HTMLElement;
    const rows = grid.querySelectorAll("[data-chart-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0].children[0]).toHaveClass("md:col-span-2");
    expect(rows[1].children).toHaveLength(2);
    expect(rows[1]).toHaveClass("items-stretch", "md:grid-cols-2");
    // The cell's child fills it, so a card with less in it is as tall as its neighbour.
    expect(rows[1].children[0]).toHaveClass("[&>*]:h-full");
  });

  it("names a row that is not full, in development, so a grid cannot be left with a hole", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<ChartGrid rows={[[card("a")], [card("b"), card("c")]]} />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("row 1 (a) spans 1 of 2 columns");
  });

  it("does not warn for full rows, and has a three-column form", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<ChartGrid columns={3} rows={[[card("a"), card("b"), card("c")], [{ ...card("d"), span: 3 }]]} />);
    expect(warn).not.toHaveBeenCalled();
    expect(container.querySelector("[data-chart-row]")).toHaveClass("md:grid-cols-3");
  });
});

describe("FactList", () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ label: `项 ${index + 1}`, value: `值 ${index + 1}` }));

  it("is the one key and value list, label then value, in a definition list", () => {
    const { container } = render(<FactList rows={rows.slice(0, 3)} />);
    expect(container.querySelector("dl")).not.toBeNull();
    expect(screen.getByText("项 2").tagName).toBe("DT");
    expect(screen.getByText("值 2").tagName).toBe("DD");
    expect(screen.queryByText(/全部 \d+ 项/)).toBeNull();
  });

  it("shows at most eight rows and keeps the rest behind 「全部 N 项」", () => {
    const { container } = render(<FactList rows={rows} />);
    expect(container.querySelectorAll("dl")[0].querySelectorAll("dt")).toHaveLength(8);
    const more = screen.getByText("全部 11 项");
    expect(more.closest("details")).not.toBeNull();
    expect(within(more.closest("details") as HTMLElement).getAllByRole("definition")).toHaveLength(3);
  });
});

describe("Section", () => {
  it("is a heading at the section rung with its count and the controls of that block alone", () => {
    render(<Section title="试验先例" count={12} toolbar={<button type="button">下载</button>}><p>表</p></Section>);
    const heading = screen.getByRole("heading", { level: 2, name: "试验先例" });
    expect(heading).toHaveClass("text-section", "font-semibold");
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "试验先例" })).toContainElement(screen.getByRole("button", { name: "下载" }));
  });

  it("takes the next heading level and the 14 px rung when it is nested", () => {
    render(<Section title="分部" level="sub"><p>内容</p></Section>);
    expect(screen.getByRole("heading", { level: 3, name: "分部" })).toHaveClass("text-ui");
  });
});

describe("ScopeMenu", () => {
  const groups = [
    { heading: "我的项目", choices: [{ id: "p1", label: "高血压随访" }, { id: "p2", label: "糖尿病管理" }] },
    { heading: "虚拟临床研究", choices: [{ id: "s1", label: "阿司匹林虚拟研究", icon: UsersRound }] },
    { choices: [{ id: "shared", label: "所有项目共享", icon: Library }] },
  ];

  it("is a header button that names the choice and its icon, grouped as the sidebar groups them", async () => {
    const change = vi.fn();
    render(<ScopeMenu label="范围" groups={groups} value="s1" onChange={change} />);
    const trigger = screen.getByRole("button", { name: "范围：阿司匹林虚拟研究" });
    await userEvent.click(trigger);
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["高血压随访", "糖尿病管理", "阿司匹林虚拟研究", "所有项目共享"]);
    expect(screen.getByText("虚拟临床研究")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "阿司匹林虚拟研究" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "所有项目共享" }));
    expect(change).toHaveBeenCalledWith("shared");
  });

  it("is a chip among filters that can be cleared to 「全部项目」", async () => {
    const change = vi.fn();
    render(<ScopeMenu variant="chip" label="项目" allLabel="全部项目" groups={groups.slice(0, 1)} value={null} onChange={change} />);
    const chip = screen.getByRole("button", { name: "项目" });
    expect(chip).toHaveAttribute("aria-haspopup", "menu");
    expect(chip).not.toHaveAttribute("aria-pressed");
    await userEvent.click(chip);
    expect(await screen.findByRole("menuitemradio", { name: "全部项目" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "糖尿病管理" }));
    expect(change).toHaveBeenCalledWith("p2");
  });
});

describe("StateScreen", () => {
  it("is an icon, one sentence and one action, and says where the address used to lead", () => {
    const { container } = render(
      <MemoryRouter>
        <StateScreen icon={Compass} title="页面不存在" titleAs="h1" action={<a href="/">返回首页</a>} back={{ to: "/app/account?tab=usage" }} />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-state-screen]")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "页面不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回到原处" })).toHaveAttribute("href", "/app/account?tab=usage");
  });

  it("says nothing more than its sentence and its action by default", () => {
    const { container } = render(<MemoryRouter><StateScreen icon={Compass} title="出了点问题" role="alert" action={<button type="button">重新载入</button>} /></MemoryRouter>);
    expect(container.textContent).toBe("出了点问题重新载入");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
