import { describe, expect, it } from "vitest";
import { assignResultAnchors, resultGapLabel, resultTextDifference, resultValueDifference, selectionResultAnchor } from "./resultProvenance";

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
  });
});
