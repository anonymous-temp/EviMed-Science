import { describe, expect, it } from "vitest";
import { VCR_SCENARIO_SCHEMAS, vcrScenarioRows } from "@evimed/domain";
import { methodFieldText } from "./vcrMethodFieldText";
const text = (method: string, path: string, root: Record<string, unknown> = {}, unit?: string) => methodFieldText(method, path, { unit }, root, "原标签");
describe("method-context scientific field meanings", () => {
  it.each([
    ["accrual.poisson_gamma", "sites[0].alpha", "招募强度 Gamma 形状 α"],
    ["accrual.poisson_gamma", "sites[0].beta", "招募强度 Gamma 速率 β"],
    ["accrual.poisson_gamma", "screenFailure.alpha", "筛选失败率 Beta 先验形状 α"],
    ["accrual.poisson_gamma", "screenFailure.beta", "筛选失败率 Beta 先验形状 β"],
    ["design.analytic", "analysis.alpha", "检验显著性水平 α"],
    ["design.simulate", "analysis.alpha", "检验显著性水平 α"],
    ["comparator.map_prior", "operatingCharacteristics.alpha", "检验显著性水平 α"],
    ["population.scenario", "population.missing[0].beta", "缺失机制回归系数 β"],
    ["population.synthpop", "analyses[0].target", "待评估回归系数的变量列"],
    ["accrual.poisson_gamma", "target", "累计目标入组人数"],
    ["design.procova", "prognostic.lambda", "相关性折减因子 λ"],
    ["design.procova", "prognostic.gamma", "对照组标准差膨胀因子 γ"],
    ["comparator.tipping_point", "deltas", "删失后危险率倍数 δ"],
  ])("labels %s / %s from its own parameterization", (method, path, expected) => {
    expect(text(method, path).label).toBe(expected);
  });
  it("uses Beta shape parameters for population variables and leaves user-defined column labels intact", () => {
    const root = { population: { variables: [{ family: "beta" }] } };
    expect(text("population.scenario", "population.variables[0].alpha", root)).toMatchObject({ label: "Beta 分布形状参数 α", unit: "无量纲" });
    expect(text("population.scenario", "population.variables[0].beta", root).label).toBe("Beta 分布形状参数 β");
    expect(methodFieldText("comparator.maic", "targets.alpha", {}, {}, "alpha", true).label).toBe("alpha");
  });
  it("keeps assurance prior scales distinct from observed outcome SD and from a time cutoff", () => {
    expect(text("design.assurance", "designPrior.mean", { endpoint: { type: "time_to_event" } })).toMatchObject({ label: "对数风险比先验均值", unit: "对数 HR" });
    expect(text("design.assurance", "designPrior.sd", { endpoint: { type: "binary" } })).toMatchObject({ label: "风险差先验标准差", unit: "发生率差" });
    expect(text("design.assurance", "designPrior.mean", { endpoint: { type: "continuous" } }).label).toBe("均值差先验均值");
    expect(text("comparator.map_prior", "tauPrior.scale", { tauPrior: { kind: "uniform" }, historical: { events: [1, 2] } })).toMatchObject({ label: "异质性 τ 均匀先验上限", unit: "logit 尺度" });
    expect(text("comparator.map_prior", "tauPrior.scale", { tauPrior: { kind: "half_normal" }, historical: { estimate: [1, 2] } }).unit).toBe("历史估计的分析尺度");
    expect(text("comparator.rmst", "tau", { timeUnit: "weeks" })).toMatchObject({ label: "RMST 截断时间 τ", unit: "周" });
  });
  it("uses canonical schema units, retaining declared custom units and the actual default boundary", () => {
    expect(text("accrual.poisson_gamma", "sites[0].beta")).toMatchObject({ unit: "月", hint: expect.stringContaining("β 不是尺度参数") });
    expect(text("accrual.poisson_gamma", "eventHazard")).toMatchObject({ label: "每位受试者事件危险率", unit: "每月" });
    expect(text("patients.time_to_event", "truth.controlDistribution.rate", { endpoint: { type: "time_to_event" }, timeUnit: "days" }).unit).toBe("每天");
    expect(text("comparator.rmst", "tau").unit).toBe("月（方法默认）");
    expect(text("comparator.rmst", "tau", { timeUnit: "cycles" }).unit).toBe("cycles（自定义单位，未换算）");
    expect(text("patients.longitudinal", "truth.effect", {}, "outcome units per time unit")).toMatchObject({ label: "干预对结局变化速率的效应", unit: "结局原单位／所设时间单位" });
  });
  it("audits every supported schema: significance labels occur only at test-alpha paths and canonical units remain visible", () => {
    for (const method of Object.keys(VCR_SCENARIO_SCHEMAS)) {
      for (const row of vcrScenarioRows(method).rows) {
        const shown = text(method, row.path, {}, row.unit);
        if (shown.label.includes("显著性水平")) expect(row.path).toMatch(/^(analysis|operatingCharacteristics)\.alpha$/);
        if (row.unit) expect(shown.unit, `${method}:${row.path}`).toBeTruthy();
      }
    }
    expect(text("future.method", "unknown.alpha").label).toBe("参数 α");
    expect(text("future.method", "unknown.sigma").label).toBe("参数 σ");
  });
});
