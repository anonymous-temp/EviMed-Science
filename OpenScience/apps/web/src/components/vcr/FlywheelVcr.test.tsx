import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { VCR_SIMULATION_NOT_EVIDENCE_ZH } from "@evimed/domain";
import { DataTab } from "./tabs/DataTab";
import { TrialTab } from "./tabs/TrialTab";
import { VcrPackageReader } from "./VcrPackageReader";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";

// The evidence flywheel's edges of 虚拟临床研究 (F23, F24, the 模拟研究 column, F25): each renders from a copy of the server's own fixture
// with the one field the feature adds, and the browser is held to what it sends.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
const ev201 = (patch: Partial<VcrStudy> = {}): VcrStudy => ({ ...readVcrStudy(fixture("ev201/study.json")), ...patch });
const sent = (method: string, path: string) => network.productRequest.mock.calls.filter((call) => call[0] === path && (call[1] ?? "GET") === method);

beforeEach(() => {
  installVcrServer(network.productRequest);
  toasts.success.mockReset();
  toasts.error.mockReset();
});

describe("the data tab (F23, F24)", () => {
  it("labels a card 有新证据 with what bears on it, and says where the new version is when the plan has frozen", async () => {
    const payload = fixture("ev201/data.json");
    const card = payload.assumptions[0];
    card.newEvidence = { label: "有新证据", afterFreezeVersion: 2, open: [
      { id: "sig_1", cause: "new_results", identifier: "reg:NCT09900001", itemId: "17", title: "Final overall survival of NCT09900001", at: null }] };
    card.detail.versions = [{ version: 2, at: "今天 09:07", text: "7 项随机效应汇总", note: "冻结后新增，不影响已冻结的计划", afterFreeze: true }, ...card.detail.versions];
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: payload });
    const { container } = draw(<DataTab studyId={STUDY_ID} study={ev201()} />);
    const news = await waitFor(() => {
      const node = container.querySelector("[data-vcr-new-evidence]");
      if (!node) throw new Error("no label");
      return node as HTMLElement;
    });
    expect(news).toHaveTextContent("有新证据");
    expect(news).toHaveTextContent("新的结果");
    expect(news).toHaveTextContent("Final overall survival of NCT09900001");
    expect(news).toHaveTextContent("分析计划已经冻结：新版本放在冻结的版本旁边，研究仍按冻结的版本计算。");
    expect(container.querySelector(`[data-vcr-assumption='${card.id}']`)).toHaveTextContent("有新证据");
    expect(screen.getByText("冻结后新增，不影响已冻结的计划")).toBeInTheDocument();
  });

  it("marks an evidence item found through a card, and lists trial events as candidates that are not precedents", async () => {
    const payload = fixture("ev201/data.json");
    payload.assumptions[0].detail.forest[0].candidateFrom = { cardId: "card_abc123", claimId: "CLM-1" };
    payload.precedentCandidates = [
      { id: "pcn_1", candidate: true, event: "results", frontierItemId: "17", registry: "clinicaltrials.gov", registryId: "NCT05550002", doi: null, pmid: null, title: "Results of NCT05550002", noticedAt: null },
      { id: "pcn_2", candidate: true, event: "label_change", frontierItemId: "18", registry: null, registryId: null, doi: "10.1000/x", pmid: null, title: "Label change for candidatumab", noticedAt: null },
    ];
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: payload });
    const { container } = draw(<DataTab studyId={STUDY_ID} study={ev201()} />);
    const row = await waitFor(() => {
      const node = container.querySelector("[data-vcr-candidate-from='card_abc123']");
      if (!node) throw new Error("no provenance");
      return node as HTMLElement;
    });
    expect(row).toHaveTextContent("线索 · 来自证据卡");
    const candidates = container.querySelectorAll("[data-vcr-precedent-candidate]");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toHaveTextContent("待核对");
    expect(candidates[0]).toHaveTextContent("结果发布 · NCT05550002");
    expect(candidates[1]).toHaveTextContent("说明书变更 · DOI 10.1000/x");
    expect(screen.getByText(/只是线索，不是先例/)).toBeInTheDocument();
  });
});

describe("发布到模拟研究", () => {
  const withPublication = (publication: Record<string, unknown> | null) => {
    const payload = fixture("ev201/export.json");
    payload.kind = "simulation_report";
    payload.publication = publication;
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/export/exp_2`]: payload });
  };

  it("says the fixed sentence, sends words only, and lets the lead withdraw", async () => {
    withPublication({ canPublish: true, live: null });
    draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    const publish = await screen.findByRole("button", { name: "发布到模拟研究" });
    expect(screen.getAllByText(VCR_SIMULATION_NOT_EVIDENCE_ZH).length).toBeGreaterThan(0);
    await userEvent.click(publish);
    const dialog = await screen.findByRole("dialog", { name: "发布到模拟研究" });
    expect(within(dialog).getByText(new RegExp(VCR_SIMULATION_NOT_EVIDENCE_ZH))).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("一句话说明"), "两臂随机试验的把握度模拟。");
    await userEvent.click(within(dialog).getByRole("button", { name: "发布" }));
    await waitFor(() => expect(sent("POST", `/vcr/studies/${STUDY_ID}/publications`)).toHaveLength(1));
    expect(sent("POST", `/vcr/studies/${STUDY_ID}/publications`)[0][2]).toEqual({ exportId: "exp_2", title: "研究包 v1", summary: "两臂随机试验的把握度模拟。" });
  });

  it("offers the withdrawal for a live publication and nothing at all to anyone who may not publish", async () => {
    withPublication({ canPublish: true, live: { id: "sim_1", publishedAt: "2026-10-06T00:00:00Z" } });
    const { unmount } = draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    expect(await screen.findByText("已发布到模拟研究")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤回" }));
    await waitFor(() => expect(sent("DELETE", `/vcr/studies/${STUDY_ID}/publications/sim_1`)).toHaveLength(1));
    unmount();
    withPublication({ canPublish: false, live: null });
    draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    await screen.findByRole("heading", { name: "研究包 v1" });
    expect(document.querySelector("[data-vcr-publish]")).toBeNull();
  });

  it("is absent where the column is off: no publication block in the payload, no act on the page", async () => {
    withPublication(null);
    draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    await screen.findByRole("heading", { name: "研究包 v1" });
    expect(screen.queryByRole("button", { name: "发布到模拟研究" })).toBeNull();
  });
});

describe("登记预测", () => {
  it("files a scenario's prediction with a design, a measure, a trial and an endpoint — never a number — and only for the lead on a deployment that has the registry", async () => {
    const lead = ev201({ features: { simulations: false, predictions: true, platformPacks: false } });
    draw(<TrialTab studyId={STUDY_ID} study={lead} />);
    const card = await waitFor(() => {
      const node = document.querySelector("[data-vcr-file-prediction]");
      if (!node) throw new Error("no card");
      return node as HTMLElement;
    });
    await userEvent.type(within(card).getByLabelText("试验登记号"), "NCT02296125");
    await userEvent.type(within(card).getByLabelText("主要终点"), "PFS");
    await userEvent.selectOptions(within(card).getByLabelText("预测的指标"), "assurance");
    await userEvent.click(within(card).getByRole("button", { name: "登记预测" }));
    await waitFor(() => expect(sent("POST", `/vcr/studies/${STUDY_ID}/predictions`)).toHaveLength(1));
    const body = sent("POST", `/vcr/studies/${STUDY_ID}/predictions`)[0][2] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["endpoint", "registryId", "resultPath", "scenarioId"]);
    expect(body).toMatchObject({ registryId: "NCT02296125", endpoint: "PFS", resultPath: "measure(assurance)" });
  });

  it("is not on the page without the registry, or for a reader who is not the lead", async () => {
    const off = ev201({ features: { simulations: false, predictions: false, platformPacks: false } });
    const { unmount } = draw(<TrialTab studyId={STUDY_ID} study={off} />);
    await screen.findByRole("table", { name: "方案的对比" });
    expect(document.querySelector("[data-vcr-file-prediction]")).toBeNull();
    unmount();
    const member = ev201({ features: { simulations: false, predictions: true, platformPacks: false }, abilities: ["read", "write"] });
    draw(<TrialTab studyId={STUDY_ID} study={member} />);
    await screen.findByRole("table", { name: "方案的对比" });
    expect(document.querySelector("[data-vcr-file-prediction]")).toBeNull();
  });
});
