import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCheckReport, applySemanticsPatch, summarizeSemantics } from "@evimed/domain";
import type { DatasetMeaning } from "@/lib/dataSemanticsClient";
import { DatasetMeaningPanel } from "./DatasetMeaningPanel";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), confirm: vi.fn(), projectId: "project-one" }));
vi.mock("@/lib/dataSemanticsClient", () => ({ listDatasetMeanings: mocks.list, getDatasetMeaning: mocks.get, confirmDatasetMeaning: mocks.confirm }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getWebProjectId: () => mocks.projectId }));

const NOW = "2026-10-04T08:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** The asset the control plane would store, built by the domain: a model's reading, a researcher's correction, a dictionary. */
function meaning(): DatasetMeaning {
  const inferred = { basis: "model_inferred", inferredFrom: ["列名 creatinine", "取值 40–400"] };
  let { asset } = applySemanticsPatch(null, {
    datasetId: "visits", title: "脓毒症随访", ...inferred, population: "2023 年入院的成人脓毒症患者",
    tables: [{ name: "visits.csv", observationUnit: "每位患者每次就诊一行", observationKey: ["patient_id", "visit_no"] }],
    variables: [
      { table: "visits.csv", name: "creatinine", unit: "mg/dL", type: "number", role: "covariate" },
      { table: "visits.csv", name: "sex", allowedValues: [{ code: "M", label: "男" }, { code: "F", label: "女" }], missingness: { tokens: ["NA"], reason: "not_recorded" } },
    ],
    joins: [{ left: { table: "visits.csv", columns: ["patient_id"] }, right: { table: "patients.csv", columns: ["patient_id"] }, cardinality: "many_to_one" }],
    bindings: [{ table: "visits.csv", path: "knowledge-base/visits.csv", sha256: SHA_A, bytes: 1, rows: 180, columns: [] }],
  }, { now: NOW, via: "conversation" });
  asset = applySemanticsPatch(asset, { basis: "researcher_confirmed", statement: "这一列的单位是 mmol/L", variables: [{ table: "visits.csv", name: "creatinine", unit: "mmol/L" }] }, { now: NOW, via: "conversation" }).asset;
  asset = applySemanticsPatch(asset, { ...inferred, variables: [{ table: "visits.csv", name: "creatinine", unit: "mg/dL" }] }, { now: NOW, via: "conversation" }).asset;
  asset = applySemanticsPatch(asset, { basis: "dictionary_stated", statedIn: "data/dictionary.csv", variables: [{ table: "visits.csv", name: "sex", definition: "出生性别" }] }, { now: NOW, via: "conversation" }).asset;
  applyCheckReport(asset, {
    checkedAt: NOW, bindings: [], clean: [],
    findings: [{ outcome: "duplicate_exact", subject: { table: "visits.csv", column: "patient_id+visit_no" }, count: 3, rows: [4, 9, 12] }, { outcome: "distribution_shift", subject: { table: "visits.csv", column: "sbp" }, count: 1 }],
    notChecked: [{ family: "leakage", reason: "cutoff_undeclared", subject: {} }],
  }, {}, NOW);
  return { asset, revision: 4, interpretation: "0".repeat(64), summary: summarizeSemantics(asset) } as unknown as DatasetMeaning;
}
const listing = (datasetId = "visits", sha256 = SHA_A) => ({ datasetId, title: null, tables: [{ table: "visits.csv", path: "knowledge-base/visits.csv", sha256, rows: 180 }], summary: {}, lastCheck: null, updatedAt: NOW, revision: 4 });

describe("DatasetMeaningPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectId = "project-one";
    mocks.list.mockResolvedValue({ items: [listing()] });
    mocks.get.mockResolvedValue(meaning());
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows nothing for a file no analysis has recorded a meaning for", async () => {
    mocks.list.mockResolvedValue({ items: [listing("other", SHA_B)] });
    const { container } = render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/notes.csv" sha256={"c".repeat(64)} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("says whose words each fact is — the researcher's with the quote, a dictionary's with the file, the model's with what it read — and keeps a disagreeing inference visibly unused", async () => {
    render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/visits.csv" sha256={SHA_A} />);
    expect(await screen.findByRole("heading", { name: "数据含义 · 脓毒症随访" })).toBeInTheDocument();
    // The first line counts who vouches for the interpretation.
    expect(screen.getByText("你已确认 1")).toBeInTheDocument();
    expect(screen.getByText("数据字典所述 1")).toBeInTheDocument();
    expect(screen.getByText(/^模型推断 \d+$/)).toBeInTheDocument();
    expect(screen.getByText("2023 年入院的成人脓毒症患者")).toBeInTheDocument();
    // The confirmed unit is the researcher's own words, and the later inference was not applied.
    expect(screen.getByText("mmol/L")).toBeInTheDocument();
    expect(screen.getByText("你说：“这一列的单位是 mmol/L”")).toBeInTheDocument();
    expect(screen.getByText("模型推断另有判断：mg/dL，没有采用")).toBeInTheDocument();
    expect(screen.getByText("见 dictionary.csv")).toBeInTheDocument();
    expect(screen.getAllByText(/^依据：列名 creatinine；取值 40–400$/).length).toBeGreaterThan(0);
    // Codes and the join in the researcher's words, never an id. A code list is
    // a set, so the domain keeps it in one order whatever order it was written in.
    expect(screen.getByText("F（女）、M（男）")).toBeInTheDocument();
    expect(screen.getByText("visits.csv（patient_id）→ patients.csv（patient_id）")).toBeInTheDocument();
    expect(screen.getByText("多对一")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/model_inferred|researcher_confirmed|visits-|dsem_/);
  });

  it("says what the last check found and that a check which did not run is not a clean one", async () => {
    render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/visits.csv" sha256={SHA_A} />);
    expect(await screen.findByRole("heading", { name: /^最近一次检查/ })).toBeInTheDocument();
    expect(screen.getByText(/同一观察出现了完全相同的重复行 · visits\.csv · patient_id\+visit_no · 3/)).toBeInTheDocument();
    expect(screen.getByText(/取值分布超出了设定的变化范围 · visits\.csv · sbp · 1/)).toBeInTheDocument();
    expect(screen.getByText("需要决定")).toBeInTheDocument();
    expect(screen.getByText("1 项检查没有运行：没有给出截止时间列。没有运行不等于没有问题。")).toBeInTheDocument();
  });

  it("warns when the file is not the version the meaning was read from", async () => {
    mocks.list.mockResolvedValue({ items: [listing("visits", SHA_A)] });
    render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/visits.csv" sha256={SHA_B} />);
    expect(await screen.findByText(/这份文件不是记录含义时读的那一版/)).toBeInTheDocument();
  });

  it("confirms what the model only inferred, exactly as shown, and reloads", async () => {
    mocks.confirm.mockResolvedValue({ revision: 5, summary: {} });
    render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/visits.csv" sha256={SHA_A} />);
    await userEvent.click(await screen.findByRole("button", { name: "确认以上推断" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const [projectId, datasetId, targets] = mocks.confirm.mock.calls[0];
    expect([projectId, datasetId]).toEqual(["project-one", "visits"]);
    expect(targets).toContain("variable:visits.csv/creatinine:type");
    expect(targets).toContain("population");
    // What the researcher or a dictionary already vouched for is not re-confirmed.
    expect(targets).not.toContain("variable:visits.csv/creatinine:unit");
    expect(targets).not.toContain("variable:visits.csv/sex:definition");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });

  it("says when it cannot load, and tries again", async () => {
    mocks.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(meaning());
    render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/visits.csv" sha256={SHA_A} />);
    expect(await screen.findByText(/无法加载数据含义/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("heading", { name: /^数据含义/ })).toBeInTheDocument();
  });

  // The knowledge base lists any project of the account, and the panel names the project its document belongs to: the
  // tab being in another project is not a reason to drop the answer for that one.
  it("shows the document's own project's meaning whichever project the tab is in", async () => {
    mocks.projectId = "project-two";
    render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/visits.csv" sha256={SHA_A} />);
    expect(await screen.findByRole("heading", { name: /^数据含义/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith("project-one");
  });

  it("does not show a dataset after the panel has moved on to another document", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.list.mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValue({ items: [] });
    const { container, rerender } = render(<DatasetMeaningPanel projectId="project-one" path="knowledge-base/visits.csv" sha256={SHA_A} />);
    rerender(<DatasetMeaningPanel projectId="project-two" path="knowledge-base/other.csv" sha256={"f".repeat(64)} />);
    release({ items: [listing()] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
