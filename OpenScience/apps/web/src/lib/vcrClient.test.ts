import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVcrStudy, queueVcrJob, saveVcrMethodConfiguration, getVcrMethodResult, getVcrMethodConfiguration, cancelVcrJob, confirmVcrBudget, contactVcrReferral, exportVcrStudy, getVcrComparator, getVcrData, getVcrHome, getVcrMatching, getVcrModels,
  getVcrPatients, getVcrPopulation, getVcrPrecedents, getVcrStudy, getVcrTrial, patchVcrStudy, readVcrCounts, readVcrValue, recordVcrDecision,
  saveVcrAssumption, signVcrReview, getVcrMembers, readVcrMembers, removeVcrMember, setVcrMembers, transitionVcrReferral,
  adoptVcrModel, getVcrReferrals, overrideVcrJudgment, readVcrReferrals, reviewVcrAssessment,
  readVcrComparator, readVcrData, readVcrHome, readVcrMatching, readVcrModels, readVcrPatients, readVcrPopulation, readVcrStudy, readVcrTrial,
  runVcrTrialSearch,
} from "./vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("./productClient", () => network);

beforeEach(() => {
  installVcrServer(network.productRequest);
});

// The readers are what stand between the server's answer and a component. They
// are total: whatever the server sends, a list is a list and a value is a value.
describe("the readers over the server's own pages", () => {
  it("read the study page without losing what the server sent", async () => {
    const study = await getVcrStudy(STUDY_ID);
    const sent = fixture("ev201/study.json");
    expect(study.tier).toBe("T0");
    expect(study.name).toBe(sent.name);
    expect(study.overview.designs).toHaveLength(sent.overview.designs.length);
    expect(study.overview.metrics.map((metric) => metric.label)).toEqual(sent.overview.metrics.map((metric: { label: string }) => metric.label));
    expect(study.budget?.limitSeconds).toBe(7200);
    expect(study.jobs.some((job) => job.state === "awaiting_budget")).toBe(true);
    expect(study.ceiling?.withinCeiling).toBe(true);
  });

  it("read every tab of the seeded study and keep every list the server sent", async () => {
    const population = await getVcrPopulation(STUDY_ID);
    expect(population.criteria).toHaveLength(fixture("ev201/population.json").criteria.length);
    expect(population.attrition.length).toBeGreaterThan(0);
    expect(population.stale?.queued).toBe(true);
    expect(population.quality).toBeNull();

    const patients = await getVcrPatients(STUDY_ID);
    expect(patients.model?.twin).toBe("scenario_simulation");
    expect(patients.model?.twinLabel).toBe("情景仿真");
    expect(patients.partial?.sentence).toMatch(/1,200/);
    expect(patients.sensitivity?.base?.value).toBe(0.41);

    const comparator = await getVcrComparator(STUDY_ID);
    expect(comparator.routes).toHaveLength(4);
    expect(comparator.dimensions).toHaveLength(10);
    expect(comparator.gaps?.items).toHaveLength(3);
    expect(comparator.curves.every((curve) => curve.points.length > 0)).toBe(true);

    const trial = await getVcrTrial(STUDY_ID);
    expect(trial.designs.map((design) => design.code)).toEqual(["A", "B", "C", "D"]);
    expect(trial.designs.find((design) => design.code === "D")?.dominated).toBe(true);
    expect(trial.designs.filter((design) => design.chosen).map((design) => design.code)).toEqual(["B"]);
    expect(trial.forecasts).toHaveLength(1);

    const matching = await getVcrMatching(STUDY_ID);
    expect(matching.candidates.length).toBeGreaterThan(0);
    expect(matching.selected?.criteria.length).toBe(6);
    expect(matching.ledger?.length).toBe(11);

    const data = await getVcrData(STUDY_ID);
    expect(data.assumptions.map((card) => card.key)).toContain("control_median_pfs");
    expect(data.assumptions[0].value.source).toBe("aggregate");

    const models = await getVcrModels();
    expect(models.models.length).toBeGreaterThan(3);
    expect(models.ladder).toHaveLength(4);
  });

  it("read the home list as the browser's rows", async () => {
    const home = await getVcrHome();
    expect(home.studies).toHaveLength(2);
    expect(home.studies.every((study) => typeof study.tier === "string" && typeof study.updatedAt === "string")).toBe(true);
    expect(home.todos?.length).toBeGreaterThan(0);
  });
});

// A key the server sends and a reader drops is a field no component can ever
// show: the type would say it exists and the page would never have it.
describe("the readers drop nothing the server sends", () => {
  const cases: Array<[string, (raw: unknown) => object, string]> = [
    ["study", readVcrStudy, "ev201/study.json"],
    ["population", readVcrPopulation, "ev201/population.json"],
    ["patients", readVcrPatients, "ev201/patients.json"],
    ["comparator", readVcrComparator, "ev201/comparator.json"],
    ["trial", readVcrTrial, "ev201/trial.json"],
    ["matching", readVcrMatching, "ev201/matching.json"],
    ["matching for one candidate", readVcrMatching, "ev201/matching-p0192.json"],
    ["matching of a patient's trials", readVcrMatching, "ev201/matching-patient-trials.json"],
    ["matching of a patient with no trial found", readVcrMatching, "ev201/matching-patient-trials-none.json"],
    ["data", readVcrData, "ev201/data.json"],
    ["models", readVcrModels, "ev201/models.json"],
    ["home", readVcrHome, "ev201/home.json"],
  ];
  for (const [name, read, file] of cases) {
    it(`keeps every key of the ${name} page`, () => {
      const sent = fixture(file);
      expect(Object.keys(read(sent))).toEqual(expect.arrayContaining(Object.keys(sent)));
    });
  }

  it("keeps every design's numbers, the drill-down and the dominated design's words", () => {
    const sent = fixture("ev201/trial.json");
    const read = readVcrTrial(sent);
    for (const [index, design] of sent.designs.entries()) {
      expect(Object.keys(read.designs[index].measures)).toEqual(Object.keys(design.measures));
      expect(read.designs[index].note).toBe(design.note);
    }
    expect(read.designs[0].measures.assurance.detail?.fields?.length).toBeGreaterThan(0);
  });
});

describe("a payload the server never sends is still survivable", () => {
  it("turns every missing list into an empty one, on every tab", () => {
    for (const junk of [{}, null, "text", 5, []]) {
      expect(readVcrPopulation(junk).criteria).toEqual([]);
      expect(readVcrPatients(junk).panels).toEqual([]);
      expect(readVcrComparator(junk).dimensions).toEqual([]);
      expect(readVcrTrial(junk).designs).toEqual([]);
      expect(readVcrTrial(junk).forecasts).toEqual([]);
      expect(readVcrMatching(junk).candidates).toEqual([]);
      expect(readVcrMatching(junk).view).toBe("matching");
      // A page with no patient's trials in it is the other direction's page, not an empty list of trials.
      expect(readVcrMatching(junk).patientTrials).toBeUndefined();
      expect(readVcrData(junk).assumptions).toEqual([]);
      expect(readVcrModels(junk).models).toEqual([]);
      expect(readVcrStudy(junk).overview.designs).toEqual([]);
      expect(readVcrHome(junk).studies).toEqual([]);
    }
  });

  it("reads the tier offer as the server sent it, and as nothing when it is not one", () => {
    const sent = { tier: "T2", label: "T2 完整治疗与纵向结局", unlocks: ["a", "b"], basis: { subjects: 240, treatment: true, outcomes: true } };
    expect(readVcrStudy({ tierOffer: sent }).tierOffer).toEqual(sent);
    expect(readVcrStudy({ tierOffer: { tier: "T1" } }).tierOffer).toEqual({ tier: "T1", label: "T1", unlocks: [], basis: { subjects: 0, treatment: false, outcomes: false } });
    // An offer to stay at T0, to go somewhere that is not a tier, or that is not an object is no offer: the page draws nothing.
    for (const junk of [undefined, null, "T1", 7, [], {}, { tier: "T0" }, { tier: "T9" }, { tier: 1 }]) expect(readVcrStudy({ tierOffer: junk }).tierOffer, JSON.stringify(junk)).toBeNull();
    expect(readVcrStudy({}).tierOffer).toBeNull();
  });

  it("never turns a missing value into a zero, and never lets an unlabelled one pass for an observation", () => {
    for (const junk of [undefined, null, {}, { value: "4" }, { value: Number.NaN }]) {
      const value = readVcrValue(junk);
      expect(value.value).toBeNull();
      expect(value.source).toBe("assumed");
    }
    expect(readVcrValue({ value: 0, source: "predicted" }).value).toBe(0);
    expect(readVcrValue({ value: 1, source: "made_up" }).source).toBe("assumed");
    expect(readVcrValue({ value: 1, source: "observed", interval: { low: 1, high: 2 } }).interval).toBeNull();
  });

  it("keeps the four counts, with nulls where nothing was counted", () => {
    expect(readVcrCounts(null)).toBeNull();
    expect(readVcrCounts({ realPatients: 0 })).toMatchObject({ realPatients: 0, events: null, effectiveSampleSize: null, generatedRecords: null });
  });
});

describe("the patient's trials", () => {
  it("reads the ranked list with each trial's registry address, phase, status, counts, and the chosen trial's criteria", () => {
    const sent = fixture("ev201/matching-patient-trials.json");
    const page = readVcrMatching(sent);
    expect(page.directions).toEqual(["trial_to_patient", "patient_to_trial"]);
    expect(page.direction).toBe("patient_to_trial");
    const trials = page.patientTrials;
    expect(trials?.available).toBe(true);
    expect(trials?.subject).toBe("P-0192");
    expect(trials?.trials.map((trial) => [trial.rank, trial.kind, trial.id])).toEqual([[1, "registry", "ctr_1"], [2, "protocol", "prt_2"], [3, "registry", "ctr_2"], [4, "registry", "ctr_3"]]);
    expect(trials?.trials[0]).toMatchObject({
      registry: "clinicaltrials.gov", registryId: "NCT05000001", url: "https://clinicaltrials.gov/study/NCT05000001", phase: "III 期", status: "招募中",
      eligibility: "eligible", counts: { satisfied: 3, unknown: 0, notSatisfied: 0, pending: 0 }, conditions: ["Non-small Cell Lung Cancer"],
      sites: { total: 14, countries: ["China"] },
    });
    expect(trials?.trials[1].sites).toBeNull();
    expect(trials?.selected?.id).toBe("ctr_1");
    expect(trials?.selected?.criteria.map((row) => row.code)).toEqual(["I1", "I2", "E1"]);
    expect(trials?.selected?.verdict?.text).toBe("符合：全部适用的入排条件都满足");
  });

  it("reads a patient the study holds no trial for as an empty list and no chosen trial, and a payload that is not a page as nothing", () => {
    const none = readVcrMatching(fixture("ev201/matching-patient-trials-none.json")).patientTrials;
    expect(none).toMatchObject({ available: true, subject: "P-0201", trials: [], selected: null });
    for (const junk of [{}, []]) {
      expect(readVcrMatching({ patientTrials: junk }).patientTrials).toMatchObject({ available: true, subject: null, trials: [], selected: null });
    }
    // What is not an object is no page of trials: the tab reads as the other direction's.
    for (const junk of ["text", 5, null, true]) expect(readVcrMatching({ patientTrials: junk }).patientTrials).toBeUndefined();
    expect(readVcrMatching({ patientTrials: { available: false } }).patientTrials?.available).toBe(false);
    expect(readVcrMatching({ patientTrials: { trials: [{ id: "ctr_9" }] } }).patientTrials?.trials[0]).toMatchObject({
      id: "ctr_9", conditions: [], sites: null, counts: { satisfied: 0, unknown: 0, notSatisfied: 0, pending: 0 },
    });
  });

  it("asks for the patient's page by direction, patient and trial, and posts the search with the patient's key and nothing else", async () => {
    await getVcrMatching(STUDY_ID, { view: "matching", direction: "patient_to_trial", candidate: "P-0192", trial: "ctr_2" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/matching?view=matching&direction=patient_to_trial&candidate=P-0192&trial=ctr_2`);
    const answer = await runVcrTrialSearch(STUDY_ID, "P-0192");
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/trial-search`, "POST", { subjectKey: "P-0192" });
    expect(answer.runId).toBe("run_3");
  });
});

describe("the routes the client calls, and the bodies it posts", () => {
  it("reads a tab with its view and candidate, and the precedents with the server's own query word", async () => {
    await getVcrMatching(STUDY_ID, { view: "referral", candidate: "P-0192" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/matching?view=referral&candidate=P-0192`);
    await getVcrPrecedents({ q: "NCT" });
    expect(network.productRequest).toHaveBeenCalledWith("/vcr/precedents?q=NCT");
    await getVcrPrecedents();
    expect(network.productRequest).toHaveBeenCalledWith("/vcr/precedents");
  });

  it("posts the budget confirmation as a job id or as CPU time — never the old ¥ limit", async () => {
    await confirmVcrBudget(STUDY_ID, { jobId: "job_seed_17" });
    await confirmVcrBudget(STUDY_ID, { cpuSeconds: 1800 });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/budget`, "POST", { jobId: "job_seed_17" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/budget`, "POST", { cpuSeconds: 1800 });
  });

  it("posts a decision with the goal as its question, a review on named versions, an assumption under its key", async () => {
    await recordVcrDecision(STUDY_ID, { question: "目标", chosen: { id: "scn_2", code: "B", label: "方案 B" }, rationale: "折中" });
    await signVcrReview(STUDY_ID, { kind: "statistical", nodes: ["assumption:control_median_pfs@1"] });
    await saveVcrAssumption(STUDY_ID, { key: "control_median_pfs", pointValue: 4.2 });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/decisions`, "POST", { question: "目标", chosen: { id: "scn_2", code: "B", label: "方案 B" }, rationale: "折中" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/reviews`, "POST", { kind: "statistical", nodes: ["assumption:control_median_pfs@1"] });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/assumptions`, "POST", { key: "control_median_pfs", pointValue: 4.2 });
  });

  it("confirms a contact on the person's referral, cancels a job, exports, and cannot put a budget in the settings", async () => {
    await contactVcrReferral(STUDY_ID, "ref_seed_1", { note: "已确认" });
    network.productRequest.mockResolvedValueOnce({ job: { id: "job_seed_16", kind: "generate_patients_binary", state: "canceled" }, canceled: true });
    expect((await cancelVcrJob(STUDY_ID, "job_seed_16")).state).toBe("canceled");
    const answer = await exportVcrStudy(STUDY_ID, "study_package");
    await patchVcrStudy(STUDY_ID, { status: "paused", budget: { limitSeconds: 1 } } as never);
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/referrals/ref_seed_1/contact`, "POST", { note: "已确认" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/jobs/job_seed_16/cancel`, "POST", {});
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/export`, "POST", { kind: "study_package" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}`, "PATCH", { status: "paused" });
    expect(answer.runId).toBe("run_2");
  });
});

describe("members and the referral ledger", () => {
  it("reads the members as the route lists them, and drops a row with no account", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}/members`]: { members: [
        { userId: "owner_1", owner: true, roles: ["lead"], roleLabels: ["研究负责人"], abilities: ["read"] },
        { userId: "u_stat", owner: false, roles: ["statistical_reviewer"], roleLabels: ["统计复核"], invitedBy: "owner_1", createdAt: "2026-09-20T00:00:00Z" },
        { owner: false, roles: [] },
      ] },
    });
    const members = await getVcrMembers(STUDY_ID);
    expect(members.map((member) => [member.userId, member.owner, member.roles])).toEqual([["owner_1", true, ["lead"]], ["u_stat", false, ["statistical_reviewer"]]]);
    // A person is read by name; a name the server did not send is null, and the reader never fills it with the id.
    expect(members.map((member) => member.name)).toEqual([null, null]);
    expect(readVcrMembers({ members: [{ userId: "u_stat", name: "陈统计", roles: [] }] })[0].name).toBe("陈统计");
    expect(readVcrMembers(null)).toEqual([]);
    expect(readVcrMembers({ members: "nope" })).toEqual([]);
  });

  it("adds a role with { userId, role } and removes one through ?role=, encoding what it puts in the path", async () => {
    await setVcrMembers(STUDY_ID, { userId: "u_site", role: "site", detail: { siteId: "ste_01" } });
    await removeVcrMember(STUDY_ID, "u_stat", "statistical_reviewer");
    await removeVcrMember(STUDY_ID, "u_stat");
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/members`, "POST", { userId: "u_site", role: "site", detail: { siteId: "ste_01" } });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/members/u_stat?role=statistical_reviewer`, "DELETE");
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/members/u_stat`, "DELETE");
  });

  it("moves a referral through its own route, with only the keys the route lists", async () => {
    await transitionVcrReferral(STUDY_ID, "ref_seed_1", { to: "needs_evidence", note: "E1 申请近 4 周头颅 MRI" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/referrals/ref_seed_1/transition`, "POST",
      { to: "needs_evidence", note: "E1 申请近 4 周头颅 MRI" });
  });

  it("reads the ledger's rows as the route answers them, and drops a row with no id", async () => {
    const referrals = await getVcrReferrals(STUDY_ID);
    expect(referrals.map((row) => [row.id, row.subjectKey, row.state, row.assessmentId])).toEqual([
      ["ref_seed_1", "P-0192", "contactable", "asm_P-0192"], ["ref_seed_2", "P-0201", "contacted", "asm_P-0201"],
      ["ref_seed_3", "P-0177", "needs_evidence", "asm_P-0177"], ["ref_seed_4", "P-0150", "enrolled", "asm_P-0150"],
    ]);
    expect(referrals[1].contactApprovedBy).toBe("coordinator-1");
    expect(referrals[1].contactApprovedByName).toBe("周协调员");
    expect(referrals[0].contactApprovedByName).toBeNull();
    expect(readVcrReferrals(null)).toEqual([]);
    expect(readVcrReferrals({ referrals: [{ subjectKey: "x" }, "no", { id: "r", subjectKey: "y" }] }).map((row) => row.id)).toEqual(["r"]);
    await getVcrReferrals(STUDY_ID, { state: "contactable" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/referrals?state=contactable`);
  });

  it("re-judges one rule and countersigns one assessment by the ids in the path, and adopts a model through the library route", async () => {
    await overrideVcrJudgment(STUDY_ID, "asm_1", "crt/2", { state: "not_satisfied", note: " 依据 " });
    await reviewVcrAssessment(STUDY_ID, "asm_1");
    await adoptVcrModel({ name: "m", sources: ["NCT02296125"] });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/assessments/asm_1/judgments/crt%2F2/override`, "POST", { state: "not_satisfied", note: "依据" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/assessments/asm_1/review`, "POST", {});
    expect(network.productRequest).toHaveBeenCalledWith("/vcr/models", "POST", { name: "m", sources: ["NCT02296125"] });
  });

  it("puts the composer's 起点 in the settings body, and still no budget", async () => {
    await patchVcrStudy(STUDY_ID, { action: "trial" });
    expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}`, "PATCH", { action: "trial" });
  });
});


describe("method workbench requests", () => {
  it("sends calculation purpose and queue subject through the actual body builders", async () => {
    network.productRequest.mockResolvedValue({ id: "calculation_1" });
    await createVcrStudy({ name: "Independent", purpose: "calculation" });
    expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", { name: "Independent", purpose: "calculation" });
    await queueVcrJob("calculation_1", { kind: "generate_patients_binary", subjectId: "patient_set_1", modelId: "source_model", scenario: { n: 40 }, seed: 42, inputs: [] });
    expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/calculation_1/jobs", "POST", { kind: "generate_patients_binary", subjectId: "patient_set_1", modelId: "source_model", scenario: { n: 40 }, seed: 42, inputs: [] });
  });
  it("prepares exact method versions and addresses the original job configuration and result", async () => {
    network.productRequest.mockResolvedValue({ subjectId: "comparator_2", objectKind: "comparator", version: 2 });
    await saveVcrMethodConfiguration("calculation_1", { method: "comparator.evalue", name: "Sensitivity", scenario: { riskRatio: 2 }, subjectId: "comparator_1" });
    expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/calculation_1/method-configurations", "POST", { method: "comparator.evalue", name: "Sensitivity", scenario: { riskRatio: 2 }, subjectId: "comparator_1" });
    await getVcrMethodConfiguration("calculation_1", "old_job");
    expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/calculation_1/jobs/old_job/configuration");
    network.productRequest.mockResolvedValue({ jobId: "old_job", result: { id: "old_result", kind: "patient_set" }, execution: { method: "patients.binary", sourceModel: { id: "old_source", version: "1.0.0" } }, records: { available: true, profile: [{ variable: "response", kind: "binary", levels: [{ level: "1", n: 20, p: 0.4 }] }] } });
    const historical = await getVcrMethodResult("calculation_1", "old_job");
    expect(network.productRequest).toHaveBeenLastCalledWith("/vcr/studies/calculation_1/jobs/old_job/result");
    expect(historical.result?.id).toBe("old_result");
    expect(historical.execution?.sourceModel?.version).toBe("1.0.0");
    expect(historical.records.profile?.[0].levels?.[0].percent).toBe(40);
  });
  it("includes the four domain forecast protocols omitted by older catalogues", async () => {
    network.productRequest.mockResolvedValue({ models: [], methods: [{ id: "binary", method: "patients.binary", name: "Binary" }] });
    const catalogue = await getVcrModels();
    expect(catalogue.methods.filter(method => method.method?.startsWith("forecast.")).map(method => method.method)).toEqual(["forecast.trajectories", "forecast.evaluate", "forecast.compare", "forecast.trial_benchmark"]);
  });
});


it("unwraps only the documented cancellation envelope while queue and get retain flat jobs", async () => {
  const job = { id: "job_1", kind: "generate_patients_binary", method: "patients.binary", state: "canceled" };
  network.productRequest.mockResolvedValue({ job, canceled: false });
  expect(await cancelVcrJob("calculation_1", "job_1")).toEqual(job);
  expect(network.productRequest).toHaveBeenLastCalledWith("/vcr/studies/calculation_1/jobs/job_1/cancel", "POST", {});
});
it("sends only the six public quality basis fields through the actual job body builder", async () => {
  const basis = { populationId: "population_1", populationVersion: 2, resultId: "generation_1", table: "population" as const, inputId: "server_generation_ref", sha256: "a".repeat(64) };
  network.productRequest.mockResolvedValue({ id: "quality_job", kind: "population_quality", state: "queued" });
  await queueVcrJob("calculation_1", { kind: "population_quality", subjectId: "population_1", scenario: { trainingInputId: "server_training_ref", syntheticInputId: basis.inputId }, inputs: [{ kind: "snapshot", id: "training_1" }], qualityBasis: { ...basis, location: "must-not-be-sent" } as typeof basis });
  expect(network.productRequest).toHaveBeenLastCalledWith("/vcr/studies/calculation_1/jobs", "POST", { kind: "population_quality", subjectId: "population_1", scenario: { trainingInputId: "server_training_ref", syntheticInputId: basis.inputId }, inputs: [{ kind: "snapshot", id: "training_1" }], qualityBasis: basis });
});

it("uses the public reconstruction selection in prepare and the real queue body, retaining historical availability", async () => {
  const scenario = { covariates: ["age"], targets: { age: 60 } };
  network.productRequest.mockResolvedValue({ subjectId: "maic_1", objectKind: "comparator", version: 1, reconstructionResultId: "reconstruction_1", scenario });
  expect(await saveVcrMethodConfiguration("study_1", { method: "comparator.maic_time_to_event", name: "MAIC", scenario, reconstructionResultId: "reconstruction_1" })).toEqual({ subjectId: "maic_1", objectKind: "comparator", version: 1, reconstructionResultId: "reconstruction_1", scenario });
  expect(network.productRequest).toHaveBeenLastCalledWith("/vcr/studies/study_1/method-configurations", "POST", { method: "comparator.maic_time_to_event", name: "MAIC", scenario, reconstructionResultId: "reconstruction_1" });
  await queueVcrJob("study_1", { kind: "maic_time_to_event_comparator", subjectId: "maic_1", scenario, inputs: [{ kind: "snapshot", id: "snapshot_1" }], reconstructionResultId: "reconstruction_1" });
  expect(network.productRequest).toHaveBeenLastCalledWith("/vcr/studies/study_1/jobs", "POST", { kind: "maic_time_to_event_comparator", subjectId: "maic_1", scenario, inputs: [{ kind: "snapshot", id: "snapshot_1" }], reconstructionResultId: "reconstruction_1" });
  network.productRequest.mockResolvedValue({ reconstructionResultId: "original_reconstruction", reconstructionResultAvailable: false, scenario });
  expect(await getVcrMethodConfiguration("study_1", "old_maic")).toMatchObject({ reconstructionResultId: "original_reconstruction", reconstructionResultAvailable: false, scenario });
});
