import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultLineagePanel } from "./ResultLineagePanel";
import type { ProducerSnapshot, ResultLineage, ResultVersion, ValueBindings } from "@/lib/resultProvenance";

const api = vi.hoisted(() => ({ lineage: vi.fn() }));
vi.mock("@/lib/resultProvenance", async (original) => ({ ...await original<typeof import("@/lib/resultProvenance")>(), getResultLineage: api.lineage }));

const CALC = `rv_${"a".repeat(64)}`;
const NEXT = `rv_${"b".repeat(64)}`;
const base: ResultVersion = { artifactId: "ra_1", versionId: `rv_${"c".repeat(64)}`, projectId: "p", path: "report.md", digest: "c".repeat(64), size: 10, mimeType: "text/markdown",
  capturedAt: "2026-10-04T00:00:00Z", producer: { kind: "tool", sessionId: "ses_1", runId: "run_1" }, inputs: [], code: null, environment: null, findings: [], machineValues: [],
  coverage: { snapshot: "complete", producer: "bound", inputs: "unknown", code: "unknown", environment: "unknown", gaps: [] }, supersedesVersionId: null };
const engine: ProducerSnapshot = { kind: "engine_job", origin: "platform_measured", method: { id: "meta.dl", version: "1", engineVersion: null, executed: { tau_estimator: "DL" }, seed: null, parameters: null },
  script: { path: null, digest: "f".repeat(64), bytes: null, files: null, executed: true, verified: true }, inputs: [{ kind: "data", id: "input.json", digest: "d".repeat(64), versionId: `rv_${"d".repeat(64)}`, path: "input.json", availability: "captured" }],
  transformations: [{ datasetId: "trial-a", name: "derive-outcome", version: 2, codeDigest: null }],
  environment: { status: "reported", digest: "e".repeat(64), facts: { interpreter: "Python 3.12.3", imageId: `sha256:${"7".repeat(64)}`, packages: { numpy: "1.26.4", scipy: "1.13.0" } } }, process: null,
  reproduction: "observed_execution", unknown: [], recorded: true };
const unobserved: ProducerSnapshot = { kind: "unobserved", origin: "unknown", method: null, script: null, inputs: [], transformations: [], environment: { status: "unknown", digest: null, facts: null }, process: null,
  reproduction: "not_applicable", unknown: ["script", "inputs", "environment", "undeclared_dependencies"], recorded: true };
const bindings: ValueBindings = { status: "partly_bound", calculations: [{ versionId: CALC, digest: "a".repeat(64), path: "analysis/pooled.json", alias: null }],
  items: [{ basis: "matched", locator: { kind: "text", line: 3, column: 8 }, printed: "0.71", calculation: { versionId: CALC, digest: "a".repeat(64), key: "values.pooled_effect", value: 0.7134, unit: "odds_ratio" }, format: { id: "round", places: 2 } },
    { basis: "rendered", locator: { kind: "text", line: 3, column: 30 }, printed: "41.2%", calculation: { versionId: CALC, digest: "a".repeat(64), key: "values.i_squared", value: 41.234, unit: "percent" }, format: { id: "pct1" } }],
  unbound: [{ locator: { kind: "text", line: 4, column: 2 }, printed: "0.73", reason: "differs_from_value", candidates: [{ versionId: CALC, key: "values.pooled_effect", value: 0.7134 }] },
    { locator: { kind: "cell", row: 2, column: 3 }, printed: "3.14", reason: "no_matching_value", candidates: [] }],
  unresolved: [{ path: "pool.nothing", reason: "no_such_value" }], counts: { bound: 2, rendered: 1, unbound: 2, ambiguous: 0, unresolved: 1 }, truncated: false };
const lineage = (extra: Partial<ResultLineage> = {}): ResultLineage => ({ versionId: base.versionId, role: "report", dependents: [], changes: [],
  calculations: [{ versionId: CALC, path: "analysis/pooled.json", digest: "a".repeat(64), capturedAt: "2026-10-03T00:00:00Z", runId: "run_0", method: "meta.dl", producer: "engine_job" }], ...extra });
const onOpen = vi.fn();
const mount = (version: ResultVersion, selectedText: string | null = null) => render(<ResultLineagePanel key={version.versionId} version={version} selectedText={selectedText} onOpen={onOpen} />);
beforeEach(() => { vi.clearAllMocks(); api.lineage.mockImplementation(async () => lineage()); });

describe("the numerical chain of a version", () => {
  it("says how an engine result was produced, with its inputs, environment and the transformation it was run on", async () => {
    mount({ ...base, snapshot: engine, bindings: { ...bindings, status: "not_checked", items: [], unbound: [], unresolved: [], counts: { bound: 0, rendered: 0, unbound: 0, ambiguous: 0, unresolved: 0 } } });
    const section = await screen.findByRole("region", { name: "生成方式" });
    expect(section).toHaveTextContent("确定性计算引擎 · meta.dl 第 1 版");
    expect(section).toHaveTextContent("实际执行：tau_estimator=DL");
    expect(section).toHaveTextContent("摘要 ffffffffffff · 已核对");
    expect(section).toHaveTextContent("输入：input.json · 摘要 dddddddddddd · 已保存此版本");
    expect(section).toHaveTextContent("数据变换：derive-outcome 第 2 版（数据集 trial-a）");
    expect(section).toHaveTextContent("Python 3.12.3 · 2 个软件包的版本 · 运行镜像 777777777777");
    expect(section).toHaveTextContent("运行已记录，所用代码已核对");
    expect(within(section).queryByRole("list", { name: "未被观察的部分" })).toBeNull();
  });

  it("names what was not observed for a version of unknown origin, and for code that was only generated", async () => {
    mount({ ...base, snapshot: unobserved });
    const section = await screen.findByRole("region", { name: "生成方式" });
    expect(section).toHaveTextContent("生成过程未被观察");
    const unknown = within(section).getByRole("list", { name: "未被观察的部分" });
    expect(unknown).toHaveTextContent("所用代码未记录");
    expect(unknown).toHaveTextContent("运行中读取的其他文件和网络访问未被记录");
    mount({ ...base, versionId: `rv_${"9".repeat(64)}`, snapshot: { ...unobserved, kind: "authored", unknown: [], reproduction: "generated_not_executed" } });
    expect(await screen.findByText("这是对话中生成的代码，没有它运行过的记录")).toBeInTheDocument();
    mount({ ...base, versionId: `rv_${"8".repeat(64)}`, snapshot: { ...unobserved, recorded: false } });
    expect(await screen.findByText("此版本保存时没有记录生成过程。")).toBeInTheDocument();
  });

  it("lists each printed number with the calculation, key, unit and formatting it came from, and each one that came from nothing", async () => {
    mount({ ...base, snapshot: engine, bindings });
    const section = await screen.findByRole("region", { name: "数值核对" });
    expect(section).toHaveTextContent("2 个数值已对应到计算值，2 个没有对应的计算值");
    const table = within(section).getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("0.71values.pooled_effect = 0.7134 odds_ratio保留 2 位小数第 3 行");
    expect(rows[1]).toHaveTextContent("41.2%values.i_squared = 41.234 percent平台渲染，百分数，保留 1 位小数");
    const unbound = within(section).getByRole("list", { name: "没有对应计算值的数值" });
    expect(unbound).toHaveTextContent("“0.73”（第 4 行）：与计算值 values.pooled_effect（0.7134）接近但不相等，可能已过时或录入有误");
    expect(unbound).toHaveTextContent("“3.14”（第 2 行第 3 列）：没有对应的计算值");
    expect(section).toHaveTextContent("渲染时有 1 处引用没有找到对应的计算值，报告里写的是“未计算”。");
    await userEvent.click(within(rows[0]).getByRole("button", { name: "查看计算" }));
    expect(onOpen).toHaveBeenCalledWith({ versionId: CALC, path: "analysis/pooled.json", runId: "run_0" });
  });

  it("answers, for a selected number, which calculation it is and how it was formatted", async () => {
    mount({ ...base, snapshot: engine, bindings }, "0.71");
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("“0.71”与 analysis/pooled.json 的 values.pooled_effect（0.7134 odds_ratio）一致，保留 2 位小数。");
  });

  it("says a calculation's printed dependents and what its successor would move, and what the rounding leaves alone", async () => {
    const calculation: ResultVersion = { ...base, versionId: CALC, path: "analysis/pooled.json", snapshot: engine, machineValues: [{ key: "values.pooled_effect", value: 0.7134 }],
      bindings: { ...bindings, status: "not_checked", items: [], unbound: [], unresolved: [], counts: { bound: 0, rendered: 0, unbound: 0, ambiguous: 0, unresolved: 0 } } };
    api.lineage.mockResolvedValue({ versionId: CALC, role: "calculation", calculations: [], dependents: [{ versionId: base.versionId, path: "report.md", capturedAt: "x", digest: "c".repeat(64), runId: "run_1", boundValues: 4, keys: [] }],
      changes: [{ calculationVersionId: CALC, successorVersionId: NEXT, successorCapturedAt: "2026-10-05T00:00:00Z", successorPath: "analysis/pooled.json", successorRunId: "run_3",
        summary: { dependents: 1, affectedValues: 1, unaffectedValues: 3, needSuccessor: 1 },
        dependents: [{ versionId: base.versionId, path: "report.md", bound: 4, unchanged: 3, needsSuccessor: true,
          affected: [{ locator: { kind: "text", line: 3, column: 20 }, printed: "0.52", key: "values.ci_lower", unit: "odds_ratio", before: 0.5201, after: 0.4811, printedNow: "0.48", status: "changed" }] }] }] });
    mount(calculation);
    expect(await screen.findByText("依赖这次计算的数值")).toBeInTheDocument();
    expect(screen.getByText(/report\.md · 4 个数值/)).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "计算与依赖" });
    expect(section).toHaveTextContent("这次计算已有新版本");
    expect(section).toHaveTextContent("1 处数值会变化，3 处保持不变");
    expect(section).toHaveTextContent("第 3 行：0.52 → 0.48");
    await userEvent.click(within(section).getByRole("button", { name: "查看新版本" }));
    expect(onOpen).toHaveBeenCalledWith({ versionId: NEXT, path: "analysis/pooled.json", runId: "run_3" });
  });

  it("shows a failed read of the chain as a quiet status with a retry, never as a verdict on the result", async () => {
    api.lineage.mockRejectedValueOnce(new Error("数值来源暂时无法读取"));
    mount({ ...base, snapshot: engine, bindings });
    expect(await screen.findByText(/数值来源暂时无法读取/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "数值核对" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试读取数值来源" }));
    expect(await screen.findByText("analysis/pooled.json · meta.dl")).toBeInTheDocument();
  });

  it("refuses a lineage that answers for another version", async () => {
    api.lineage.mockResolvedValue({ ...lineage(), versionId: NEXT });
    mount({ ...base, snapshot: engine, bindings });
    expect(await screen.findByText(/返回的数值来源与所选版本不一致/)).toBeInTheDocument();
  });
});
