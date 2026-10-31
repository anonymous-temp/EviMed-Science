import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YearRangeFilter } from "./YearRangeFilter";

afterEach(() => vi.useRealTimers());

describe("YearRangeFilter", () => {
  it("keeps custom years as a draft until Apply, including an open-ended range", async () => {
    const onChange = vi.fn();
    render(<YearRangeFilter onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("开始年份"), "2020");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(2020, undefined);
    expect(screen.queryByRole("group", { name: "按年份分布选择范围" })).not.toBeInTheDocument();
  });

  it("applies each relative preset once and uses the current calendar year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00+08:00"));
    const onChange = vi.fn();
    render(<YearRangeFilter onChange={onChange} />);
    for (const years of [1, 3, 5, 10]) {
      fireEvent.click(screen.getByRole("button", { name: `近 ${years} 年` }));
      expect(screen.getByLabelText("开始年份")).toHaveValue(String(2027 - years));
      expect(screen.getByLabelText("结束年份")).toHaveValue("2026");
      expect(onChange).toHaveBeenCalledTimes([1, 3, 5, 10].indexOf(years));
      fireEvent.click(screen.getByRole("button", { name: "应用年份" }));
      expect(onChange).toHaveBeenLastCalledWith(2027 - years, 2026);
    }
  });

  it("explains reversed and invalid ranges without requesting results", async () => {
    const onChange = vi.fn();
    render(<YearRangeFilter startYear={2025} endYear={2020} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(screen.getByRole("alert")).toHaveTextContent("开始年份不能晚于结束年份");
    expect(screen.getByLabelText("开始年份")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(screen.getByLabelText("开始年份"), { target: { value: "1799" } });
    await userEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请输入 1800");
    fireEvent.change(screen.getByLabelText("开始年份"), { target: { value: "20x0" } });
    await userEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts the shared minimum and next year, and submits numeric inputs with Enter", () => {
    const onChange = vi.fn(), max = new Date().getFullYear() + 1;
    render(<YearRangeFilter onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("开始年份"), { target: { value: "1800" } });
    fireEvent.change(screen.getByLabelText("结束年份"), { target: { value: String(max) } });
    fireEvent.keyDown(screen.getByLabelText("结束年份"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1800, max);
    fireEvent.change(screen.getByLabelText("结束年份"), { target: { value: String(max + 1) } });
    fireEvent.keyDown(screen.getByLabelText("结束年份"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps native keyboard and touch range controls draft-only and prevents crossed handles", () => {
    const onChange = vi.fn();
    render(<YearRangeFilter startYear={2020} endYear={2025} onChange={onChange} />);
    const start = screen.getByRole("slider", { name: "调整开始年份" });
    const end = screen.getByRole("slider", { name: "调整结束年份" });
    expect(start).toHaveAttribute("type", "range");
    expect(start).toHaveAttribute("step", "1");
    expect(start).toHaveAttribute("aria-valuetext", "2020 年");
    fireEvent.change(start, { target: { value: "2024" } });
    fireEvent.change(end, { target: { value: "2022" } });
    expect(screen.getByLabelText("结束年份")).toHaveValue("2024");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(2024, 2024);
  });

  it("shows only genuine distribution counts, merges duplicate years and applies a selected year", () => {
    const onChange = vi.fn();
    render(<YearRangeFilter distribution={[
      { year: 2020, count: 2 }, { year: 2020, count: 3 }, { year: 2022, count: 10 },
      { year: 2021, count: -10 }, { year: 0, count: 100 }, { year: 2023, count: NaN },
    ]} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "选择 2010—2014 年，共 0 条" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 2015—2019 年，共 0 条" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择 2020—2022 年，共 15 条" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(2020, 2022);
  });

  it("buckets a long distribution into accessible ranges without changing the totals", () => {
    const onChange = vi.fn();
    render(<YearRangeFilter distribution={Array.from({ length: 20 }, (_, index) => ({ year: 2000 + index, count: 2 }))} onChange={onChange} />);
    const buckets = screen.getAllByRole("button", { name: /^选择/ });
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toHaveAccessibleName("选择 1990—1999 年，共 0 条");
    expect(buckets[1]).toHaveAccessibleName("选择 2000—2009 年，共 20 条");
    expect(buckets[2]).toHaveAccessibleName("选择 2010—2019 年，共 20 条");
    fireEvent.click(buckets[1]);
    fireEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(2000, 2009);
  });

  it("anchors presets and range controls to the last available year, as in Vue", () => {
    const onChange = vi.fn();
    render(<YearRangeFilter distribution={[{ year: 2000, count: 2 }, { year: 2019, count: 10 }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "近 5 年" }));
    expect(screen.getByLabelText("开始年份")).toHaveValue("2015");
    expect(screen.getByLabelText("结束年份")).toHaveValue("2019");
    expect(screen.getByRole("slider", { name: "调整开始年份" })).toHaveAttribute("min", "1990");
    expect(screen.getByRole("slider", { name: "调整结束年份" })).toHaveAttribute("max", "2019");
    fireEvent.click(screen.getByRole("button", { name: "应用年份" }));
    expect(onChange).toHaveBeenCalledWith(2015, 2019);
  });

  it("keeps small nonzero shares visible while rounding all intervals to exactly 100 percent", () => {
    const { rerender } = render(<YearRangeFilter distribution={[
      { year: 1900, count: 1 }, { year: 1920, count: 1 }, { year: 1940, count: 1 }, { year: 1960, count: 997 },
    ]} onChange={vi.fn()} />);
    expect(screen.getAllByText("1%")).toHaveLength(2);
    expect(screen.getByText("98%")).toBeInTheDocument();
    rerender(<YearRangeFilter distribution={[{ year: 2020, count: 0 }]} onChange={vi.fn()} />);
    expect(screen.getAllByText("0%")).toHaveLength(3);
  });

  it("restores externally committed ranges and clears both the draft and active filter", () => {
    const onChange = vi.fn();
    const { rerender } = render(<YearRangeFilter startYear={2020} endYear={2025} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("开始年份"), { target: { value: "2022" } });
    rerender(<YearRangeFilter startYear={2010} endYear={2015} onChange={onChange} />);
    expect(screen.getByLabelText("开始年份")).toHaveValue("2010");
    expect(screen.getByLabelText("结束年份")).toHaveValue("2015");
    fireEvent.click(screen.getByRole("button", { name: "不限年份" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(undefined, undefined);
    expect(screen.getByLabelText("开始年份")).toHaveValue("");
    expect(screen.getByLabelText("结束年份")).toHaveValue("");
  });

  it("allows editing during loading but blocks duplicate application and clearing", () => {
    const onChange = vi.fn();
    render(<YearRangeFilter label="注册年份" startYear={2020} endYear={2025} busy onChange={onChange} />);
    expect(screen.getByRole("group", { name: "注册年份" })).toHaveAttribute("aria-busy", "true");
    fireEvent.change(screen.getByLabelText("开始年份"), { target: { value: "2021" } });
    fireEvent.keyDown(screen.getByLabelText("开始年份"), { key: "Enter" });
    expect(screen.getByLabelText("开始年份")).toHaveValue("2021");
    expect(screen.getByRole("button", { name: "应用年份" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "不限年份" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
