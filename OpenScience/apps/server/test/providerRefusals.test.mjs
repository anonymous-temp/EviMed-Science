// Refusals by model provider (providerRefusals.mjs): what is counted, what is
// not, and the series the balance alert reads existing before its first event.
import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_PROVIDERS, PAYMENT_REQUIRED, providerRefusalCount, providerRefusalMetricFamily, recordProviderRefusal } from "../src/providerRefusals.mjs";

test("every provider's 402 series exists from the start, so the first exhausted balance shows as an increase", () => {
  const family = providerRefusalMetricFamily();
  assert.equal(family.name, "open_science_model_provider_refusals_total");
  assert.equal(family.type, "counter");
  assert.match(family.help, /Arrearage/, "the help line says DashScope's arrears answer is counted as 402");
  for (const provider of MODEL_PROVIDERS) {
    assert.ok(family.series.some((series) => series.labels.provider === provider && series.labels.status === "402"), `${provider} has no 402 series`);
  }
});

test("a refusal before output is counted by provider and status; a 5xx, a 408 or an unknown provider is not", () => {
  const before = providerRefusalCount("deepseek", PAYMENT_REQUIRED);
  assert.equal(recordProviderRefusal("deepseek", 402), true);
  assert.equal(providerRefusalCount("deepseek", 402), before + 1);
  const rateLimited = providerRefusalCount("typesafe", 429);
  assert.equal(recordProviderRefusal("typesafe", 429), true);
  assert.equal(providerRefusalCount("typesafe", 429), rateLimited + 1);
  assert.ok(providerRefusalMetricFamily().series.some((series) => series.labels.provider === "typesafe" && series.labels.status === "429" && series.value === rateLimited + 1));
  for (const [provider, status] of [["deepseek", 500], ["deepseek", 503], ["dashscope", 408], ["somebody", 402]]) {
    assert.equal(recordProviderRefusal(provider, status), false, `${provider} ${status}`);
  }
  assert.equal(providerRefusalMetricFamily().series.some((series) => series.labels.provider === "somebody" || series.labels.status === "503"), false, "the label set stays closed");
});
