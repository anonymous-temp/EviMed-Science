import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ChartCard, LegendMark } from "./ChartCard";
import { DataTable, InlineBar, drawnColumns } from "./DataTable";
import { Delta, deltaSense } from "./Delta";
import { ProgressRail } from "./ProgressRail";
import { SeverityBadge } from "./SeverityBadge";
import { BulletBar, StatBand, StatTile } from "./StatTile";

/**
 * The data-page primitives. They are the reference implementation the Vue side
 * copies, so what is asserted here is their contract: the states each one
 * carries, and the three honesty rules a dashboard can most easily break —
 * a change inside the noise is 「持平」, a rival is never the brand colour, and
 * a column nothing fills is not drawn.
 */

describe("Delta", () => {
  it("reads a change inside the fluctuation band as 持平, with no arrow", () => {
    expect(deltaSense(2, { noise: 3 })).toBe("flat");
    render(<Delta value={2} noise={3} />);
    expect(screen.getByText("持平")).toBeInTheDocument();
    expect(screen.queryByText("▲")).not.toBeInTheDocument();
  });

  it("says the direction three ways: a shape, a colour and a word", () => {
    const { container } = render(<Delta value={8} unit="point" />);
    expect(screen.getByText("▲")).toBeInTheDocument();
    expect(screen.getByText("上升个百分点")).toHaveClass("sr-only");
    expect(container.querySelector("[data-delta='up']")).toHaveClass("text-accent");
  });

  it("follows the metric's own direction: a fall in a 「越低越好」 metric is an improvement", () => {
    expect(deltaSense(-2, { polarity: "down" })).toBe("up");
    const { container } = render(<Delta value={-2} polarity="down" />);
    expect(container.querySelector("[data-delta='up']")).toHaveClass("text-accent");
    expect(screen.getByText("▼")).toBeInTheDocument();
  });

  it("renders nothing when there is no second reading to compare", () => {
    const { container } = render(<Delta value={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("spends red only where the worsening is a clinical one", () => {
    const plain = render(<Delta value={-5} />);
    expect(plain.container.querySelector("[data-delta='down']")).toHaveClass("text-text-2");
    plain.unmount();
    const safety = render(<Delta value={-5} tone="safety" />);
    expect(safety.container.querySelector("[data-delta='down']")).toHaveClass("text-danger");
  });
});

describe("StatTile", () => {
  it("carries the number, its unit, its rank, its change and its target", () => {
    render(
      <StatTile
        label="综合可见度"
        value="61"
        unit="/ 100"
        rank="第 3 / 6"
        delta={<Delta value={17} unit="index" />}
        note="较基线 · 目标 65"
        hint="61，264 次回答"
        lead
      />,
    );
    const tile = screen.getByRole("region", { name: "综合可见度" });
    expect(tile).toHaveTextContent("61");
    expect(tile).toHaveTextContent("第 3 / 6");
    expect(tile).toHaveTextContent("较基线 · 目标 65");
    // The sample is a tooltip, never a printed line in the tile.
    expect(tile).toHaveAttribute("title", "61，264 次回答");
    expect(tile).not.toHaveTextContent("264 次回答");
    expect(within(tile).getByText("61")).toHaveClass("text-metric-lg");
  });

  it("has a skeleton of its own, and says a missing number in words", () => {
    const { container, rerender } = render(<StatTile label="引用命中率" value="样本不足" loading />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    rerender(<StatTile label="引用命中率" value="样本不足" />);
    expect(screen.getByRole("region", { name: "引用命中率" })).toHaveTextContent("样本不足");
  });

  it("declares the band's denominator once, under the band", () => {
    render(
      <StatBand label="本轮指标" columns={4} footnote="按 4 个引擎、264 次有效回答计算">
        <StatTile label="A" value="1" />
        <StatTile label="B" value="2" />
      </StatBand>,
    );
    expect(within(screen.getByRole("region", { name: "本轮指标" })).getAllByText(/次有效回答计算/)).toHaveLength(1);
  });

  it("puts the target and the leading rival on the same measure as the value", () => {
    const { container } = render(<BulletBar label="综合可见度" value={61} target={65} targetLabel="目标 65" rival={72} rivalLabel="诺和盈 72" />);
    expect(screen.getByRole("img", { name: "综合可见度 61，目标 65，诺和盈 72" })).toBeInTheDocument();
    expect((container.querySelector("[data-bullet-target]") as HTMLElement).style.left).toBe("65%");
    expect((container.querySelector("[data-bullet-rival]") as HTMLElement).style.left).toBe("72%");
  });
});

describe("SeverityBadge", () => {
  it("says the grade, its colour and its consequence", () => {
    render(<SeverityBadge level="S3" />);
    const badge = screen.getByText(/S3/);
    expect(badge).toHaveAttribute("title", "可致暂时伤害");
    expect(badge).toHaveClass("bg-severity-s3");
    expect(badge).toHaveTextContent("可致暂时伤害");
  });

  it("keeps the deep red for the grades that would reach a patient", () => {
    const { container } = render(<><SeverityBadge level="S2" /><SeverityBadge level="S1" /></>);
    expect(container.querySelector("[data-severity='S2']")).toHaveClass("bg-severity-s2");
    expect(container.querySelector("[data-severity='S1']")).toHaveClass("bg-severity-s1");
  });
});

describe("ChartCard", () => {
  it("has the four states, and an empty chart is a sentence rather than a frame", () => {
    const retry = vi.fn();
    const { rerender, container } = render(<ChartCard title="可见度升到 61" state="loading" height={200}>x</ChartCard>);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();

    rerender(<ChartCard title="可见度升到 61" state="empty" emptyText="还没有开始持续监测。">x</ChartCard>);
    expect(screen.getByText("还没有开始持续监测。")).toBeInTheDocument();
    expect(screen.queryByText("x")).not.toBeInTheDocument();

    rerender(<ChartCard title="可见度升到 61" state="error" errorMessage="读不到" onRetry={retry}>x</ChartCard>);
    expect(screen.getByRole("alert")).toHaveTextContent("读不到");

    rerender(<ChartCard title="可见度升到 61" footnote="按 4 个引擎计算">x</ChartCard>);
    expect(screen.getByRole("heading", { name: "可见度升到 61" })).toBeInTheDocument();
    expect(screen.getByText("按 4 个引擎计算")).toBeInTheDocument();
  });

  it("retries from the card", async () => {
    const retry = vi.fn();
    render(<ChartCard title="t" state="error" errorMessage="读不到" onRetry={retry}>x</ChartCard>);
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(retry).toHaveBeenCalled();
  });

  it("marks a legend entry with the series it stands for", () => {
    const { container } = render(<LegendMark series="rival-1" color="var(--chart-rival-1)">诺和盈</LegendMark>);
    expect((container.querySelector("[data-legend-mark='rival-1']") as HTMLElement).style.background).toBe("var(--chart-rival-1)");
  });
});

describe("DataTable", () => {
  interface Row { id: string; name: string; rival: string | null; value: number; ours: boolean }
  const rows: Row[] = [
    { id: "a", name: "诺和盈", rival: null, value: 31, ours: false },
    { id: "b", name: "信尔美", rival: null, value: 15, ours: true },
  ];
  const columns = [
    { key: "name", header: "同类药", rowHeader: true, cell: (row: Row) => row.name },
    { key: "rival", header: "头部竞品", cell: (row: Row) => row.rival ?? "—", isEmpty: (row: Row) => !row.rival },
    { key: "value", header: "提及率", align: "right" as const, cell: (row: Row) => `${row.value}%` },
  ];

  it("does not draw a column that would be 「—」 in every row", () => {
    expect(drawnColumns(columns, rows).map((column) => column.key)).toEqual(["name", "value"]);
    render(<DataTable label="同类药" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const table = screen.getByRole("table", { name: "同类药" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["同类药", "提及率"]);
    expect(within(table).queryByText("—")).not.toBeInTheDocument();
  });

  it("draws a column as soon as one row fills it", () => {
    const filled = [rows[0], { ...rows[1], rival: "穆峰达 18%" }];
    expect(drawnColumns(columns, filled).map((column) => column.key)).toEqual(["name", "rival", "value"]);
  });

  it("marks our own row and gives every row a handle", () => {
    render(
      <DataTable
        label="同类药"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        highlight={(row) => row.ours}
        rowAttrs={(row) => ({ "data-rank-row": row.id })}
      />,
    );
    const ours = document.querySelector("[data-rank-row='b']") as HTMLElement;
    expect(ours).toHaveAttribute("data-row-ours");
    expect(ours).toHaveClass("bg-accent-soft");
    expect(document.querySelector("[data-rank-row='a']")).not.toHaveAttribute("data-row-ours");
  });

  it("has the four states", async () => {
    const retry = vi.fn();
    const { rerender, container } = render(<DataTable label="t" columns={columns} rows={rows} rowKey={(row) => row.id} state="loading" />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    rerender(<DataTable label="t" columns={columns} rows={[]} rowKey={(row) => row.id} emptyText="还没有数据。" />);
    expect(screen.getByText("还没有数据。")).toBeInTheDocument();
    rerender(<DataTable label="t" columns={columns} rows={rows} rowKey={(row) => row.id} state="error" errorMessage="读不到" onRetry={retry} />);
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /重试/ }));
    expect(retry).toHaveBeenCalled();
  });

  it("paints an inline bar in the brand only when the row is ours", () => {
    const { container } = render(
      <>
        <InlineBar value={15} max={31} tone="own" label="信尔美 提及率" />
        <InlineBar value={31} max={31} tone="rival" label="诺和盈 提及率" />
      </>,
    );
    const [ours, rival] = [...container.querySelectorAll("[data-bar-tone]")];
    expect(ours.firstElementChild).toHaveClass("bg-accent");
    expect(rival.firstElementChild).not.toHaveClass("bg-accent");
  });
});

describe("ProgressRail", () => {
  const steps = [
    { key: "evidence", name: "证据", note: "86 条事实", state: "done" as const, to: "/app/geo/g/plan" },
    { key: "content", name: "内容", note: "14/20", state: "active" as const },
    { key: "distribution", name: "投放", note: "待你确认预算", state: "waiting" as const },
    { key: "monitoring", name: "监测", state: "todo" as const },
  ];

  it("shows each step's state as a shape, a colour and a word, and what it produced", () => {
    render(<MemoryRouter><ProgressRail label="进度" steps={steps} /></MemoryRouter>);
    const rail = screen.getByRole("list", { name: "进度" });
    expect([...rail.querySelectorAll("[data-rail-step]")].map((step) => step.getAttribute("data-rail-state")))
      .toEqual(["done", "active", "waiting", "todo"]);
    expect(within(rail).getByText("86 条事实")).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: /证据/ })).toHaveAttribute("href", "/app/geo/g/plan");
    expect(within(rail).getByText("，等你")).toHaveClass("sr-only");
  });

  it("is not a progress bar, and never a second one", () => {
    render(<MemoryRouter><ProgressRail label="进度" steps={steps} /></MemoryRouter>);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("sets a word that stands in for a number smaller than a number", () => {
    // 「未测」 and 「样本不足」 are words, and a word at the 40 px metric rung
    // shouts a non-measurement louder than every measurement beside it.
    const { container, rerender } = render(<StatTile label="豆包" value="未测" placeholder />);
    const word = container.querySelector("[data-stat-value]");
    expect(word).toHaveClass("text-heading");
    expect(word).not.toHaveClass("text-metric");
    expect(word).not.toHaveClass("text-metric-lg");
    rerender(<StatTile label="品牌提及率" value="21" unit="%" lead />);
    expect(container.querySelector("[data-stat-value]")).toHaveClass("text-metric-lg");
  });

});
