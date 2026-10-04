import test from "node:test";
import assert from "node:assert/strict";
import {
  NUMBER_FORMATS, NUMBER_UNCOMPUTED, formatNumberValue, readNumberPath, renderNumberTemplate, resolveNumberPath, typedNumberSpans, typedNumbersOf,
} from "../index.mjs";

const document = {
  pooled: { value: 0.7134, unit: "odds_ratio", interval: { low: 0.52, high: 0.91, kind: "confidence" } },
  heterogeneity: { value: 41.234, unit: "percent" },
  studies: [{ id: "s1", yi: 0.12 }, { id: "s2", yi: 0.3 }],
};
const resolve = (path) => resolveNumberPath(document, path);

test("the mechanism lifted out of the study renderer reads paths, units and formats the same way", () => {
  assert.equal(readNumberPath(document, "studies[1].yi"), 0.3);
  assert.deepEqual(resolveNumberPath(document, "pooled.value"), { value: 0.7134, unit: "odds_ratio" });
  assert.deepEqual(resolveNumberPath(document, "pooled.interval.low"), { value: 0.52, unit: "odds_ratio" });
  assert.equal(formatNumberValue(0.7134, "f2").text, "0.71");
  assert.equal(formatNumberValue(41.234, "pct1", "percent").text, "41.2%", "a value recorded as a percentage is printed as it stands");
  assert.deepEqual(formatNumberValue(0.7134, "pct1", "odds_ratio"), { ok: false, text: NUMBER_UNCOMPUTED, reason: "unit_mismatch" });
  assert.ok(NUMBER_FORMATS.includes("f2") && NUMBER_FORMATS.includes("ci"));
});

test("a template renders its references against any resolver and reports what it could not", () => {
  const { text, bindings, unparsed, typed } = renderNumberTemplate(
    "合并 OR {{n:pooled.value|f2}}，I² {{n:heterogeneity.value|pct1}}，缺 {{n:nothing.here|f2}}，手写 71.2，坏 {{n:pooled.value|F2}}。", resolve);
  assert.equal(text, `合并 OR 0.71，I² 41.2%，缺 ${NUMBER_UNCOMPUTED}，手写 ${NUMBER_UNCOMPUTED}，坏 ${NUMBER_UNCOMPUTED}。`);
  assert.deepEqual(bindings.map((binding) => [binding.path, binding.format, binding.ok, binding.reason ?? null]),
    [["pooled.value", "f2", true, null], ["heterogeneity.value", "pct1", true, null], ["nothing.here", "f2", false, "unbound"]]);
  assert.equal(bindings[0].value, 0.7134, "the machine value, not the rounded words, is what the binding holds");
  assert.deepEqual(typed, ["71.2"]);
  assert.equal(unparsed.length, 1);
  const unknown = renderNumberTemplate("{{n:pooled.value|percent}}", resolve);
  assert.equal(unknown.bindings[0].unknownFormat, "percent");
  assert.equal(unknown.text, "0.7134", "an unknown format still prints the raw value");
});

test("a finished report's own citations, code spans and addresses are not typed numbers, a template's behaviour is untouched", () => {
  const prose = "合并 OR 为 0.71 [12]，见 `n = 345` 与 https://example.org/a/345.5，样本 1,284 人。";
  assert.deepEqual(typedNumberSpans(prose).map((span) => span.raw), ["0.71", "345", "345.5", "1,284"], "a template reads every digit it was not allowed");
  assert.deepEqual(typedNumberSpans(prose, { report: true }).map((span) => span.raw), ["0.71", "1,284"]);
  assert.deepEqual(typedNumbersOf("功效为 {{n:pooled.value|f2}}，2026 年第 3 页。"), []);
});
