import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelVcrJob, confirmVcrBudget, contactVcrReferral, exportVcrStudy, getVcrComparator, getVcrData, getVcrHome, getVcrMatching, getVcrModels,
  getVcrPatients, getVcrPopulation, getVcrPrecedents, getVcrStudy, getVcrTrial, patchVcrStudy, readVcrCounts, readVcrValue, recordVcrDecision,
  saveVcrAssumption, signVcrReview, getVcrMembers, readVcrMembers, removeVcrMember, setVcrMembers, transitionVcrReferral,
  adoptVcrModel, getVcrReferrals, overrideVcrJudgment, readVcrReferrals, reviewVcrAssessment,
  readVcrComparator, readVcrData, readVcrHome, readVcrMatching, readVcrModels, readVcrPatients, readVcrPopulation, readVcrStudy, readVcrTrial,
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
    expect(population.quality?.tag).toBe("合成 · 探索性");

    const patients = await getVcrPatients(STUDY_ID);
    expect(patients.model?.twinLabel).toBe("基线条件化预测");
    expect(patients.partial?.done).toMatch(/1,200/);
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
    await cancelVcrJob(STUDY_ID, "job_seed_16");
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
