import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { VcrProfileRow } from "@/lib/vcrClient";
import { BalancePlot } from "./BalancePlot";

afterEach(cleanup);

const value = (n: number | null) => ({ value: n, text: n === null ? "—" : null, unit: null, source: "observed" as const, interval: null, mcse: null, review: null, precision: 1, reason: null, stale: false, detail: null });

const covariate: VcrProfileRow = { key: "年龄", label: "年龄", ours: value(null), theirs: value(null), smd: 0.04, smdBefore: 0.31, flagged: false, note: null };
const year: VcrProfileRow = {
  key: "enrolment_year", label: "入组年份", ours: value(null), theirs: value(null), smd: 5.43, smdBefore: 5.44, flagged: true,
  note: "平均入组年份：本研究 2020.1，外部对照 2015.6。没有按它加权；外部对照有 73% 的人入组年份不在本研究的 2019–2021 年之内。",
};

describe("the balance plot", () => {
  it("draws the enrolment-year row beside the covariates, with both arms' mean year and the sentence that it was not weighted on", () => {
    const { container } = render(<BalancePlot rows={[covariate, year]} />);
    const row = container.querySelector("[data-vcr-balance-row='enrolment_year']") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("入组年份");
    expect(row).toHaveTextContent("平均入组年份：本研究 2020.1，外部对照 2015.6。没有按它加权；外部对照有 73% 的人入组年份不在本研究的 2019–2021 年之内。");
    expect(row.querySelector("[data-vcr-smd]")).toHaveAttribute("data-vcr-smd", "over");
    expect(within(row).getByRole("img", { name: /入组年份 标准化差异，加权前 5.44，加权后 5.43，超过界值/ })).toBeInTheDocument();
  });

  it("draws no note for a covariate that carries none", () => {
    const { container } = render(<BalancePlot rows={[covariate]} />);
    const row = container.querySelector("[data-vcr-balance-row='年龄']") as HTMLElement;
    expect(row).not.toHaveTextContent("没有按它加权");
    expect(container.querySelector("[data-vcr-balance-row='enrolment_year']")).toBeNull();
  });
});
