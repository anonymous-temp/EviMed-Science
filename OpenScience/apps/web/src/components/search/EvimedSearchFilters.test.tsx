import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvimedSearchFilters, type EvimedSearchFiltersProps } from "./EvimedSearchFilters";

afterEach(cleanup);

function setup(overrides: Partial<EvimedSearchFiltersProps> = {}) {
  const props: EvimedSearchFiltersProps = { category: "literature", query: "diabetes", filters: {}, loading: false,
    facets: { timeline: [], groups: [], unavailable: [] }, onChange: vi.fn(), onReset: vi.fn(), onRetry: vi.fn(), ...overrides };
  render(<EvimedSearchFilters {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe("catalogue filter panel", () => {
  it("expands long options inside one keyboard scroll window and keeps selection and loading from collapsing it", async () => {
    const group = { key: "articleType" as const, label: "研究类型", options: Array.from({ length: 20 }, (_, index) => ({ value: String(index), label: `类型 ${index + 1}` })) };
    const props: EvimedSearchFiltersProps = { category: "literature", query: "diabetes", filters: {}, loading: false,
      facets: { timeline: [], groups: [group], unavailable: [] }, onChange: vi.fn(), onReset: vi.fn(), onRetry: vi.fn() };
    const user = userEvent.setup();
    const { rerender } = render(<EvimedSearchFilters {...props} />);
    expect(within(screen.getByRole("group", { name: "研究类型" })).getAllByRole("checkbox")).toHaveLength(6);
    const more = screen.getByRole("button", { name: "显示更多 · 还有 14 项" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    const options = screen.getByRole("group", { name: "研究类型" });
    expect(options).toHaveAttribute("tabindex", "0");
    expect(within(options).getAllByRole("checkbox")).toHaveLength(20);
    expect(screen.getByRole("button", { name: "收起选项" })).toHaveAttribute("aria-controls", options.id);
    options.scrollTop = 170; fireEvent.scroll(options);
    await user.click(screen.getByRole("checkbox", { name: "类型 20" }));
    expect(props.onChange).toHaveBeenCalledWith({ articleType: '["19"]', page: null });
    rerender(<EvimedSearchFilters {...props} loading facets={undefined} filters={{ articleType: ["19"] }} />);
    rerender(<EvimedSearchFilters {...props} filters={{ articleType: ["19"] }} />);
    const restored = screen.getByRole("group", { name: "研究类型 1" });
    expect(within(restored).getAllByRole("checkbox")).toHaveLength(20);
    expect(restored.scrollTop).toBe(170);
    await user.click(screen.getByRole("button", { name: "收起选项" }));
    expect(within(restored).getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getByRole("checkbox", { name: "类型 20" })).toHaveAttribute("aria-checked", "true");
    expect(restored.scrollTop).toBe(0);
    expect(restored).not.toHaveAttribute("tabindex");
    rerender(<EvimedSearchFilters key="new-query" {...props} query="asthma" />);
    expect(screen.queryByRole("checkbox", { name: "类型 20" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示更多 · 还有 14 项" })).toHaveAttribute("aria-expanded", "false");
  });

  it("commits result words only on submission and preserves IME composition", async () => {
    const { onChange, user } = setup();
    const input = screen.getByRole("textbox", { name: "结果中搜索" });
    await user.type(input, "insulin");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "在结果中搜索" }));
    expect(onChange).toHaveBeenLastCalledWith({ words: "insulin", page: null });
  });

  it("retains selected facets absent from the narrowed options and pairs department parents", async () => {
    const { onChange, user } = setup({ category: "guidelines", filters: { secondLevelDepartment: ["旧科室"] },
      facets: { timeline: [], unavailable: [], groups: [{ key: "secondLevelDepartment", label: "科室", options: [{ value: "心内科", label: "心内科", parent: "内科", count: 10 }] }] } });
    expect(screen.getByRole("checkbox", { name: "旧科室" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("checkbox", { name: "心内科" }));
    expect(onChange).toHaveBeenLastCalledWith({ secondLevelDepartment: '["旧科室","心内科"]', firstLevelDepartment: '["内科"]', page: null });
  });

  it("clears incompatible registry filters in one update while leaving the chosen years alone", async () => {
    const { onChange, user } = setup({ category: "trials", filters: { source: "1", startYear: 2020, minSampleSize: 10, testPhase: ["Phase 1"] },
      facets: { timeline: [], unavailable: [], groups: [{ key: "source", label: "试验来源", options: [{ value: "0", label: "ChiCTR" }, { value: "1", label: "ClinicalTrials.gov" }, { value: "2", label: "CENTRAL" }] }] } });
    await user.click(screen.getByRole("button", { name: "试验来源：ClinicalTrials.gov" }));
    await user.click(screen.getByRole("menuitemradio", { name: "CENTRAL" }));
    expect(onChange).toHaveBeenLastCalledWith({ source: "2", page: null, minSampleSize: null, maxSampleSize: null, studyType: null,
      testPhase: null, recruitmentStatus: null, associatedArticles: null, clinicalSourceDb: null });
  });

  it("validates numeric ranges before applying and keeps year input usable while facets load", async () => {
    const { onChange, user } = setup({ loading: true });
    await user.type(screen.getByRole("spinbutton", { name: "最小影响因子" }), "10");
    await user.type(screen.getByRole("spinbutton", { name: "最大影响因子" }), "5");
    await user.click(screen.getByRole("button", { name: "应用影响因子" }));
    expect(screen.getByRole("alert")).toHaveTextContent("最大值不能小于最小值");
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("spinbutton", { name: "最大影响因子" }));
    await user.type(screen.getByRole("spinbutton", { name: "最大影响因子" }), "15");
    await user.click(screen.getByRole("button", { name: "应用影响因子" }));
    expect(onChange).toHaveBeenLastCalledWith({ smallJcr: "10", bidJcr: "15", page: null });
    expect(screen.getByRole("button", { name: "应用年份" })).not.toBeDisabled();
  });

  it("retries incomplete facets and keeps CENTRAL database selection single-valued", async () => {
    const { onChange, onRetry, user } = setup({ category: "trials", filters: { source: "2", clinicalSourceDb: "A" },
      facets: { timeline: [], unavailable: ["timeline"], groups: [{ key: "clinicalSourceDb", label: "来源", options: [{ value: "A", label: "Source A" }, { value: "B", label: "Source B" }] }] } });
    await user.click(screen.getByRole("checkbox", { name: "Source B" }));
    expect(onChange).toHaveBeenLastCalledWith({ clinicalSourceDb: "B", page: null });
    await user.click(screen.getByRole("button", { name: "重新加载筛选" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("spinbutton", { name: "最小样本量" })).not.toBeInTheDocument();
  });
});
