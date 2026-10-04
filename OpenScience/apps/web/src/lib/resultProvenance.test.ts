import { describe, expect, it } from "vitest";
import { assignResultAnchors, bindingFormatLabel, bindingsForSelection, bindingStatusLabel, replayEnvironmentLabel, reproductionLabel, resultEnvironmentDifference, resultGapLabel, resultTextDifference, resultValueDifference, selectionResultAnchor, snapshotKindLabel, snapshotUnknownLabel, type ResultVersion, type ValueBindings } from "./resultProvenance";

describe("result anchors and differences", () => {
  it("anchors a selected table cell to its immutable row and column", () => {
    const root = document.createElement("div"); root.innerHTML = "<table><tbody><tr><td>alpha</td><td>beta</td></tr></tbody></table>";
    document.body.append(root); assignResultAnchors(root);
    const range = document.createRange(); range.selectNodeContents(root.querySelectorAll("td")[1]);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    expect(selectionResultAnchor(root, selection)).toMatchObject({ kind: "table-cell", selectedText: "beta", row: 0, column: 1 });
    selection.removeAllRanges(); root.remove();
  });
  it("refuses selections outside the result and across separate elements", () => {
    const root = document.createElement("div"); root.innerHTML = "<p>first</p><p>second</p>"; document.body.append(root); assignResultAnchors(root);
    const range = document.createRange(); range.setStart(root.children[0].firstChild!, 0); range.setEnd(root.children[1].firstChild!, 2);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    expect(selectionResultAnchor(root, selection)).toBeNull(); root.remove(); selection.removeAllRanges();
  });
  it("compares complete changed lines while preserving prefix and suffix line numbers", () => {
    expect(resultTextDifference("head\nold\ntail", "head\nnew\ntail")).toEqual([{ kind: "removed", line: 2, text: "old" }, { kind: "added", line: 2, text: "new" }]);
    expect(resultTextDifference("same", "same")).toEqual([]);
  });
});

describe("declared numerical comparison", () => {
  it("distinguishes exact, tolerated, changed, missing and incompatible units", () => {
    const old = { key: "ratio", value: 1, unit: "ratio" };
    expect(resultValueDifference(old, old)).toBe("完全一致");
    expect(resultValueDifference(old, { ...old, value: 1.001, absoluteTolerance: 0.002 })).toBe("在允许误差内");
    expect(resultValueDifference(old, { ...old, value: 1.01, relativeTolerance: 0.02 })).toBe("在允许误差内");
    expect(resultValueDifference(old, { ...old, value: 1.03, relativeTolerance: 0.02 })).toBe("有变化");
    expect(resultValueDifference(old, undefined)).toBe("缺少旧值或新值");
    expect(resultValueDifference(old, { ...old, unit: "mg" })).toBe("无法比较单位");
    expect(resultValueDifference({ ...old, value: Infinity }, { ...old, value: NaN })).toBe("无法比较数值");
    expect(resultValueDifference({ ...old, value: "1" }, { ...old, value: "1" })).toBe("无法比较数值");
    expect(resultValueDifference(old, { ...old, value: 2, absoluteTolerance: Infinity })).toBe("无法比较数值");
  });
});

describe("what a result version says about its record", () => {
  it("reads a file captured with no delivery receipt behind it as not verified, not as a generic gap", () => {
    // An unverified delivery's files keep their versions as observed bytes
    // (`producer: observed`, the gap `producer_bytes_not_bound`): the file is
    // theirs to open, and the page says it has not been verified.
    expect(resultGapLabel("producer_bytes_not_bound")).toBe("文件内容未经核验");
    expect(resultGapLabel("code_not_captured")).toBe("部分来源、代码或环境未完整保存");
    // Two different things can be missing from a result that cannot be recalculated, and each is named.
    expect(resultGapLabel("no_owned_deterministic_recipe")).toBe("未保存受支持的计算配方");
    expect(resultGapLabel("engine_unavailable")).toBe("这个部署没有用于重算的计算引擎");
  });
});

describe("which parts of two results ran differently", () => {
  const input = (digest: string | null) => ({ kind: "code", id: "meta.dl", digest, versionId: null, path: null, availability: "reference" });
  const version = (method: ResultVersion["method"], code = "a".repeat(64), environment = "b".repeat(64)) =>
    ({ code: input(code), environment: input(environment), method } as unknown as ResultVersion);
  const method = { id: "meta.dl", version: "2.0.0", digest: "c".repeat(64), seeded: false, seed: null };

  it("names the method record when two results that both have one ran different ones", () => {
    const difference = resultEnvironmentDifference(version({ ...method, version: "2.1.0", digest: "d".repeat(64) }), version(method));
    expect(difference).toEqual({ status: "differs", changed: ["method"] });
    expect(replayEnvironmentLabel(difference, "所比较的版本")).toBe("运行环境与所比较的版本不同（方法记录已变化），数值比较不是在同一环境下得到的");
    expect(resultEnvironmentDifference(version(method, "e".repeat(64)), version({ ...method, version: "2.1.0" }))?.changed).toEqual(["code", "method"]);
  });

  it("says nothing about the method when a result names none, and calls identical records the same", () => {
    expect(resultEnvironmentDifference(version(null), version(method))).toEqual({ status: "same", changed: [] });
    expect(resultEnvironmentDifference(version(undefined), version(undefined))).toEqual({ status: "same", changed: [] });
    expect(resultEnvironmentDifference(version(method), version({ ...method }))).toEqual({ status: "same", changed: [] });
    const noRecordAtAll = { code: null, environment: null } as unknown as ResultVersion;
    expect(resultEnvironmentDifference(noRecordAtAll, noRecordAtAll)).toBeNull();
  });
});

describe("the numerical chain in words", () => {
  const counts = { bound: 3, rendered: 1, unbound: 2, ambiguous: 0, unresolved: 0 };
  const bindings = (status: ValueBindings["status"]): ValueBindings => ({ status, calculations: [], items: [], unbound: [], unresolved: [], counts, truncated: false });
  it("says what a state of a report's numbers is, and never reads a missing check as clean", () => {
    expect(bindingStatusLabel(bindings("bound"))).toBe("文中数值都已对应到计算值");
    expect(bindingStatusLabel(bindings("partly_bound"))).toBe("3 个数值已对应到计算值，2 个没有对应的计算值");
    expect(bindingStatusLabel(bindings("unbound"))).toBe("文中 2 个数值没有对应的计算值");
    expect(bindingStatusLabel(bindings("no_calculation"))).toMatch(/数值未核对/);
    expect(bindingStatusLabel(bindings("not_checkable"))).toMatch(/无法核对/);
    expect(bindingStatusLabel(bindings("not_checked"))).toBe("数值尚未核对");
  });
  it("names the formatting between a machine value and what was printed", () => {
    expect(bindingFormatLabel({ id: "f2" })).toBe("保留 2 位小数");
    expect(bindingFormatLabel({ id: "pct1" })).toBe("百分数，保留 1 位小数");
    expect(bindingFormatLabel({ id: "round", places: 1, scale: 100 })).toBe("小数乘 100 显示为百分数，保留 1 位小数");
    expect(bindingFormatLabel({ id: "round", places: 0, grouped: true })).toBe("保留 0 位小数，千分位");
    expect(bindingFormatLabel({ id: "round", places: 2, magnitude: true })).toBe("保留 2 位小数，省略负号");
  });
  it("labels how bytes came about, whether code ran and what was not observed", () => {
    expect(snapshotKindLabel("unobserved")).toBe("生成过程未被观察");
    expect(reproductionLabel("generated_not_executed")).toMatch(/没有它运行过的记录/);
    expect(reproductionLabel("declared_execution")).toMatch(/未能核对/);
    expect(reproductionLabel("not_applicable")).toBeNull();
    expect(snapshotUnknownLabel("undeclared_dependencies")).toMatch(/其他文件和网络/);
    expect(resultGapLabel("dependencies_not_observed")).toMatch(/其他文件和网络/);
    expect(resultGapLabel("values_unbound")).toBe("文中有数值没有对应的计算值");
  });
  it("finds the bindings of exactly the words a researcher selected, and lists several rather than guessing", () => {
    const item = (key: string) => ({ basis: "matched" as const, locator: { kind: "text" as const, line: 1, column: 0 }, printed: "0.71", format: { id: "round", places: 2 },
      calculation: { versionId: "rv_1", digest: null, key, value: 0.7134, unit: null } });
    const version = { bindings: { ...bindings("partly_bound"), items: [item("a"), item("b")], unbound: [{ locator: { kind: "text" as const, line: 2, column: 0 }, printed: "9.9", reason: "no_matching_value" as const, candidates: [] }] } } as unknown as ResultVersion;
    expect(bindingsForSelection(version, " 0.71 ").bound.map((entry) => entry.calculation.key)).toEqual(["a", "b"]);
    expect(bindingsForSelection(version, "9.9").unbound).toHaveLength(1);
    expect(bindingsForSelection(version, "OR 0.71（95% CI）").bound.map((entry) => entry.calculation.key)).toEqual(["a", "b"]);
    expect(bindingsForSelection(version, "unrelated")).toEqual({ bound: [], unbound: [] });
    expect(bindingsForSelection({} as ResultVersion, "0.71")).toEqual({ bound: [], unbound: [] });
  });
});
