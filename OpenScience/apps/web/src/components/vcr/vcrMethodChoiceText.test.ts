import { expect, it } from "vitest";
import { VCR_JOB_METHODS, VCR_SCENARIO_EXAMPLES, VCR_SCENARIO_SCHEMAS, VCR_ROW_RULE_OPS, VCR_ROW_RULE_COMPARATORS, VCR_LONGITUDINAL_METHODS } from "@evimed/domain";
import { methodChoiceLabel, methodExampleLabel, ruleChoiceLabel } from "./vcrMethodChoiceText";
import type { Schema } from "./VcrScenarioEditor";
type Choice = { path: string; values: string[] };
function choices(node: Schema, path = ""): Choice[] {
  const rows: Choice[] = [];
  if (node.t === "variant") rows.push({ path: path ? `${path}.${node.on ?? "type"}` : node.on ?? "type", values: Object.keys(node.variants ?? {}) });
  if (Array.isArray(node.values)) rows.push({ path, values: node.values });
  if (node.t === "boolean") rows.push({ path, values: ["true", "false"] });
  const dynamic = (node as Schema & { valuesBy?: { map: Record<string, string[]> } }).valuesBy;
  if (dynamic) rows.push({ path, values: [...new Set(Object.values(dynamic.map).flat())] });
  for (const [key, child] of Object.entries(node.fields ?? {})) rows.push(...choices(child, path ? `${path}.${key}` : key));
  for (const fields of Object.values(node.variants ?? {})) for (const [key, child] of Object.entries(fields)) rows.push(...choices(child, path ? `${path}.${key}` : key));
  if (node.items) rows.push(...choices(node.items, `${path}[]`));
  if (node.values && !Array.isArray(node.values)) rows.push(...choices(node.values, `${path}.{key}`));
  return rows;
}
it("covers all declared choices and authored examples of all32R methods", () => {
  const methods = Object.values(VCR_JOB_METHODS).filter(method => !method.startsWith("forecast."));
  expect(methods).toHaveLength(32);
  let count = 0; const values = new Set<string>();
  for (const method of methods) {
    for (const row of choices((VCR_SCENARIO_SCHEMAS as Record<string, unknown>)[method] as Schema)) {
      count += 1;
      for (const value of row.values) {
        values.add(value); const label = methodChoiceLabel(method, row.path, value);
        expect(label, `${method}:${row.path}:${value}`).toMatch(/[\u3400-\u9fff]|O'Brien-Fleming|Pocock/);
        if (!["obrien_fleming", "pocock"].includes(value)) expect(label).not.toBe(value);
      }
    }
    for (const example of VCR_SCENARIO_EXAMPLES[method]) expect(methodExampleLabel(method, example.label), `${method}:${example.label}`).toMatch(/[\u3400-\u9fff]/);
  }
  expect(count).toBe(123); expect(values.size).toBe(127); expect(Object.values(VCR_SCENARIO_EXAMPLES).flat()).toHaveLength(38);
  for (const value of [...VCR_ROW_RULE_OPS, ...VCR_ROW_RULE_COMPARATORS]) expect(ruleChoiceLabel(value)).not.toBe(value);
  expect(Object.keys(VCR_LONGITUDINAL_METHODS)).toHaveLength(4);
});
it("uses field context, preserves acronyms and leaves user/source values unchanged", () => {
  expect(methodChoiceLabel("patients.time_to_event", "accrual.kind", "uniform")).toBe("匀速入组");
  expect(methodChoiceLabel("population.scenario", "population.variables[2].family", "uniform")).toBe("均匀分布");
  expect(methodChoiceLabel("evidence.pool", "scale", "identity")).toBe("原始尺度");
  expect(methodChoiceLabel("comparator.weighted_cox", "phTransform", "identity")).toBe("原始时间");
  expect(methodChoiceLabel("comparator.maic", "link", "identity")).toBe("恒等链接");
  expect(methodChoiceLabel("comparator.propensity_weight", "estimand", "ATT")).toContain("ATT");
  expect(methodChoiceLabel("comparator.evalue", "scale", "hazard_ratio")).toContain("HR");
  expect(methodChoiceLabel("future.method", "endpoint.type", "binary")).toBe("binary");
  expect(methodChoiceLabel("population.scenario", "population.variables[0].levels[0]", "normal")).toBe("normal");
  expect(methodChoiceLabel("population.scenario", "population.variables[0].name", "alpha")).toBe("alpha");
  expect(methodChoiceLabel("comparator.rmst", "timeUnit", "cycles")).toBe("cycles");
  expect(methodExampleLabel("design.analytic", "My source example")).toBe("My source example");
});
