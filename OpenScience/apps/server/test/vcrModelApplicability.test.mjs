// Execution issues refuse one calculation; premises are said and never refuse (in silico plan T03/T04). Pure: no database.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_MECHANISTIC_REQUIRED } from "@evimed/domain";
import { vcrModelApplicabilityAssessment, vcrModelApplicabilityIssues, vcrModelExecutionIssues, vcrModelPackOf, vcrPopulationVariables } from "../src/vcrModelApplicability.mjs";

const variables = vcrPopulationVariables({ definition: { population: { variables: [{ name: "age", min: 30, max: 92 }] } } });
const fitted = { id: "m", name: "fitted", version: "1.0.0", endpointType: "binary", card: {},
  applicability: { endpoints: ["binary"], inputRanges: { age: [40, 80] } } };

test("a range the model was fitted on is a premise: the calculation is not refused, the legacy list still shows it", () => {
  const study = { endpointType: "binary", variables };
  assert.deepEqual(vcrModelApplicabilityIssues(fitted, study).map((i) => i.code), ["input_out_of_range"]);
  const { executionIssues, premises } = vcrModelApplicabilityAssessment(fitted, study);
  assert.deepEqual(executionIssues, []);
  assert.deepEqual(premises.map((i) => i.code), ["input_out_of_range"]);
  assert.deepEqual(vcrModelExecutionIssues(fitted, study), []);
});

test("a field the population lacks and an endpoint the model does not produce refuse that calculation, field by field", () => {
  const model = { ...fitted, applicability: { endpoints: ["binary"], requiredFields: ["creatinine"] } };
  assert.deepEqual(vcrModelExecutionIssues(model, { endpointType: "binary", variables }).map((i) => i.field), ["creatinine"]);
  assert.deepEqual(vcrModelExecutionIssues(fitted, { endpointType: "time_to_event", variables }).map((i) => i.code), ["endpoint_not_covered"]);
});

test("a card short of its own contract cannot be checked: reported field by field as execution issues", () => {
  const bare = { ...fitted, endpointType: "time_to_event", card: { interfaceShape: "event_history_to_trajectories" }, applicability: { endpoints: ["time_to_event"] }, validation: {} };
  const { executionIssues } = vcrModelApplicabilityAssessment(bare, { endpointType: "time_to_event", variables });
  assert.ok(executionIssues.length >= 10 && executionIssues.every((i) => i.code === "interface_field_missing"));
});

test("use evidence on the card becomes premises, a revoked source an execution issue, a legacy card is asked for nothing", () => {
  const card = { executable: true, executableModes: ["conditional_forecast"], useEvidence: [{ mode: "factual_forecast", population: "p", endpoint: "binary", evidenceRef: "r" }] };
  const model = { ...fitted, applicability: { endpoints: ["binary"] }, card };
  const asked = { endpointType: "binary", variables, mode: "conditional_forecast", population: "p" };
  const ok = vcrModelApplicabilityAssessment(model, asked);
  assert.deepEqual(ok.executionIssues, []);
  assert.ok(ok.premises.some((i) => i.code === "use_not_validated" && /没有为这种用途验证过/.test(String(i.text))));
  const revoked = vcrModelApplicabilityAssessment(model, { ...asked, authorized: false });
  assert.deepEqual(revoked.executionIssues.map((i) => i.code), ["authorization_lost"]);
  assert.ok(revoked.premises.length > 0, "every other finding is kept");
  assert.deepEqual(vcrModelPackOf({ card: {} }), {});
  assert.deepEqual(vcrModelApplicabilityAssessment({ ...fitted, applicability: { endpoints: ["binary"] } }, { endpointType: "binary", variables }), { executionIssues: [], premises: [] });
});

test("a mechanism package whose solver the runtime lock lacks is an execution issue, not a premise", () => {
  const model = { ...fitted, applicability: { endpoints: ["binary"] }, card: { mechanism: { engine: "ospsuite" } } };
  const result = vcrModelApplicabilityAssessment(model, { endpointType: "binary", variables, installedPackages: ["deSolve"] });
  assert.deepEqual(result.executionIssues.map((i) => i.code), ["runtime_unavailable"]);
  assert.equal(result.premises.some((i) => i.code === "runtime_unavailable"), false);
  assert.equal(VCR_MECHANISTIC_REQUIRED.length, 13);
});
