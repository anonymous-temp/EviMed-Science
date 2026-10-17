import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { PatientsTab } from "./tabs/PatientsTab";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";
import { renderTab } from "./__fixtures__/tabFrame";

/**
 * 模型评估, rendered from what the server sends (the seeded EV-201 study's record, written by a run): the nine elements in the
 * guideline's order, the risk the platform worked out and the rule that settled it, who wrote this version, and the lead's edit —
 * which has no field for the risk and saves the next version of the record. The assessment is about the model the study uses, so it
 * lives in the model's record, the drawer the patients tab's 「模型 ›」 opens (R19); it is no longer a folded table under the charts.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const study = (abilities?: string[], patients?: Record<string, unknown>): VcrStudy => {
  const raw = fixture("ev201/study.json");
  if (abilities) raw.abilities = abilities;
  if (patients) raw.steps.patients = patients;
  return readVcrStudy(raw);
};
const draw = (node: React.ReactElement) => renderTab(node);
const TITLE = "二线 NSCLC 多西他赛组 PFS · Weibull";
const band = (container: HTMLElement) => container.querySelector("[data-page-chrome]") as HTMLElement;
/** The model's record, opened from the band's chip: the card, and under it the assessment of the model. */
const openRecord = async (container: HTMLElement, name: RegExp | string = /^模型/, title: string = TITLE) => {
  const bandNow = await waitFor(() => { const node = band(container); if (!node) throw new Error("no band"); return node; });
  await userEvent.click(within(bandNow).getByRole("button", { name }));
  return screen.findByRole("dialog", { name: title });
};

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
});

describe("模型评估", () => {
  it("reads the record as the guideline's table: each element, the derived risk with the rule that settled it, and who wrote it", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    const drawer = await openRecord(container);
    const section = within(drawer);
    // The model is named by the library's Chinese title, never by the id the engine files it under, and with no version number.
    expect(section.getAllByRole("heading", { name: TITLE }).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/nsclc-docetaxel-pfs-weibull/);
    for (const label of ["关注的问题", "使用情境", "模型影响力", "错误决策的后果", "模型风险", "模型冲击", "技术标准", "所拟用法的适当性", "模型与模型结果的评价", "证据评估的结论"]) {
      expect(section.getByText(label)).toBeInTheDocument();
    }
    const risk = section.getByText("模型风险", { selector: "dt, span, div, th" }).closest("[data-vcr-assessment-row]") as HTMLElement;
    expect(within(risk).getByText("高")).toBeInTheDocument();
    expect(within(risk).getByText("两项评级不同，模型风险随影响更大的一项——错误决策的后果。")).toBeInTheDocument();
    expect(within(risk).getByText("后果为高而影响力为中，风险随后果")).toBeInTheDocument();
    // Who wrote a record is not said when it was the run; a person's edit is (owner ruling 2026-10-10).
    expect(section.queryByText(/AI 写入/)).not.toBeInTheDocument();
    // What nobody has written yet says so; it is never a blank that reads as a finding.
    expect(within(section.getByText("模型与模型结果的评价").closest("[data-vcr-assessment-row]") as HTMLElement).getByText("未填写")).toBeInTheDocument();
  });

  it("is behind the model chip in the band — not folded under the charts — and the chip names the model", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("table", { name: "患者" });
    // Nothing of the assessment stands on the page.
    expect(container.querySelector("[data-vcr-assessments]")).toBeNull();
    expect(screen.queryByText(/模型评估 · 1 个模型/)).toBeNull();
    expect(within(band(container)).getByRole("button", { name: `模型：${TITLE.length > 14 ? `${TITLE.slice(0, 13)}…` : TITLE}` })).toBeInTheDocument();
    const drawer = await openRecord(container);
    expect(drawer.querySelector("[data-vcr-assessments]")).not.toBeNull();
    // And no sentence says whose models these are or that no patients exist: the assessment is of the model the study uses.
    expect(drawer.textContent).not.toContain("这些评估写的是本研究已经用到的模型");
  });

  it("with an assessment and no patient set is the step's recipe, with the assessment behind the band's 模型评估 — and never 「还没有选定模型」 over an assessment of another model", async () => {
    const raw = fixture("ev201/patients.json");
    Object.assign(raw, { model: null, trajectories: null, example: null, panels: [], sensitivity: null, headline: null, twin: null, sets: [], counts: null, partial: null, stale: null, records: null, calibration: null, profile: [], profileKind: null });
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/patients`]: raw });
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={study(undefined, { status: "none", requested: false })} />);
    const recipe = await waitFor(() => { const node = container.querySelector("[data-vcr-step-empty='patients']"); if (!node) throw new Error("no recipe"); return node as HTMLElement; });
    expect(within(recipe).getByRole("button", { name: "生成虚拟患者" })).toBeInTheDocument();
    expect(screen.queryByText("还没有选定模型")).toBeNull();
    expect(container.querySelector("[data-vcr-not-applicable]")).toBeNull();
    // The assessment is of the model the study already uses, and it is one press from the band.
    const drawer = await openRecord(container, "模型评估", "模型评估");
    expect(drawer.querySelector("[data-vcr-assessments]")).not.toBeNull();
    expect(within(drawer).getAllByRole("heading", { name: TITLE }).length).toBeGreaterThan(0);
    expect(drawer.textContent).not.toContain("这些评估写的是本研究已经用到的模型；虚拟患者还没有生成。");
  });

  it("with a result but no model says so once, with the way to change it — and keeps the assessment behind the chip", async () => {
    const raw = fixture("ev201/patients.json");
    raw.model = null;
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/patients`]: raw });
    const { container, spies } = draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    const note = await waitFor(() => { const node = container.querySelector("[data-note]"); if (!node) throw new Error("no note"); return node as HTMLElement; });
    expect(note).toHaveTextContent("这些结果没有选定的模型");
    await userEvent.click(within(note).getByRole("button", { name: "换一个模型" }));
    expect(spies.openChat).toHaveBeenCalled();
    const drawer = await openRecord(container, "模型评估", "模型评估");
    expect(drawer.querySelector("[data-vcr-assessments]")).not.toBeNull();
  });

  it("offers the edit to the lead and to nobody else", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={study(["read", "write", "run", "export"])} />);
    const drawer = await openRecord(container);
    expect(within(drawer).queryByRole("button", { name: /^编辑模型评估/ })).not.toBeInTheDocument();
  });

  it("edits the record: no field for the risk, the risk follows the ratings on screen, and the save is the next version", async () => {
    const user = userEvent.setup();
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    const drawer = await openRecord(container);
    await user.click(await within(drawer).findByRole("button", { name: /^编辑模型评估/ }));
    const dialog = (await screen.findAllByRole("dialog")).find((node) => node.querySelector("form")) as HTMLElement;
    const form = within(dialog);
    // The risk is shown beside what it is made of, and has no field.
    expect(dialog.querySelector("[data-vcr-assessment-risk]")).toHaveTextContent("高");
    expect(dialog).toHaveTextContent("由影响力和后果推算");
    expect(dialog.textContent).not.toContain("不能直接填写");
    expect(form.queryByRole("radiogroup", { name: "模型风险" })).not.toBeInTheDocument();
    expect(form.getByLabelText("关注的问题")).toHaveValue("对照组的无进展生存分布是否足以支持单臂试验的样本量计算");

    // Lowering the consequence lowers the derived risk on screen: the domain's own rule, not a typed value.
    await user.click(within(form.getByRole("radiogroup", { name: "错误决策的后果" })).getByRole("radio", { name: "低" }));
    expect(dialog.querySelector("[data-vcr-assessment-risk]")).toHaveTextContent("中");
    await user.clear(form.getByLabelText("错误决策的后果的理由"));
    await user.type(form.getByLabelText("错误决策的后果的理由"), "只用于设计阶段");
    network.productRequest.mockClear();
    network.productRequest.mockImplementation(async (_path: string, method = "GET") => (method === "POST"
      ? { id: "mia_9", key: "pfs_projection", version: 2, risk: "medium" } : fixture("ev201/patients.json")));
    await user.click(form.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已保存为版本 2。"));
    const post = network.productRequest.mock.calls.find(([, method]) => method === "POST");
    expect(post?.[0]).toBe(`/vcr/studies/${STUDY_ID}/model-assessments`);
    const body = post?.[2] as Record<string, unknown>;
    expect(body).toMatchObject({ key: "pfs_projection", consequence: "low", consequenceJustification: "只用于设计阶段", influence: "medium" });
    // The body is exactly the route's allow-list: the risk and the model are not in it.
    expect(Object.keys(body)).not.toContain("risk");
    expect(Object.keys(body)).not.toContain("modelName");
    await waitFor(() => expect(container.ownerDocument.querySelector("form[data-vcr-assessment-form], dialog form")).toBeNull());
  });

  it("does not say the frozen plan is untouched, and keeps the dialog open when the save fails", async () => {
    const user = userEvent.setup();
    const frozen = fixture("ev201/patients.json");
    frozen.assessments.plan = { version: 2, frozenAt: "昨天" };
    network.productRequest.mockImplementation(async (_path: string, method = "GET") => {
      if (method === "POST") throw new Error("refused");
      return frozen;
    });
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    const drawer = await openRecord(container);
    await user.click(await within(drawer).findByRole("button", { name: /^编辑模型评估/ }));
    const dialog = (await screen.findAllByRole("dialog")).find((node) => node.querySelector("form")) as HTMLElement;
    expect(dialog.textContent).not.toContain("已冻结的模型分析计划不会改动");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect((await screen.findAllByRole("dialog")).some((node) => node.querySelector("form"))).toBe(true);
  });
});
