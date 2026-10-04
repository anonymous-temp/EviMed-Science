import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { PatientsTab } from "./tabs/PatientsTab";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";

/**
 * 模型评估 on the patients tab, rendered from what the server sends (the seeded EV-201 study's record, written by a run):
 * the nine elements in the guideline's order, the risk the platform worked out and the rule that settled it, who wrote this
 * version, and the lead's edit — which has no field for the risk and saves the next version of the record.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const study = (abilities?: string[]): VcrStudy => {
  const raw = fixture("ev201/study.json");
  if (abilities) raw.abilities = abilities;
  return readVcrStudy(raw);
};
const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
const card = () => screen.findByText("模型评估").then((heading) => heading.closest("section") as HTMLElement);

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
});

describe("模型评估", () => {
  it("reads the record as the guideline's table: each element, the derived risk with the rule that settled it, and who wrote it", async () => {
    draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    const section = within(await card());
    expect(section.getByText("nsclc-docetaxel-pfs-weibull")).toBeInTheDocument();
    for (const label of ["关注的问题", "使用情境", "模型影响力", "错误决策的后果", "模型风险", "模型冲击", "技术标准", "所拟用法的适当性", "模型与模型结果的评价", "证据评估的结论"]) {
      expect(section.getByText(label)).toBeInTheDocument();
    }
    const risk = section.getByText("模型风险").closest("[data-vcr-assessment-row]") as HTMLElement;
    expect(within(risk).getByText("高")).toBeInTheDocument();
    expect(within(risk).getByText("两项评级不同，模型风险随影响更大的一项——错误决策的后果。")).toBeInTheDocument();
    expect(within(risk).getByText("后果为高而影响力为中，风险随后果")).toBeInTheDocument();
    expect(section.getByText("AI 写入 · 昨天")).toBeInTheDocument();
    // What nobody has written yet says so; it is never a blank that reads as a finding.
    expect(within(section.getByText("模型与模型结果的评价").closest("[data-vcr-assessment-row]") as HTMLElement).getByText("未填写")).toBeInTheDocument();
  });

  it("offers the edit to the lead and to nobody else", async () => {
    draw(<PatientsTab studyId={STUDY_ID} study={study(["read", "write", "run", "export"])} />);
    await card();
    expect(screen.queryByRole("button", { name: /^编辑模型评估/ })).not.toBeInTheDocument();
  });

  it("edits the record: no field for the risk, the risk follows the ratings on screen, and the save is the next version", async () => {
    const user = userEvent.setup();
    network.productRequest.mockImplementationOnce(async () => fixture("ev201/patients.json"));
    draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    await user.click(await screen.findByRole("button", { name: /^编辑模型评估/ }));
    const dialog = await screen.findByRole("dialog");
    const form = within(dialog);
    expect(form.getByText("模型风险由影响力和后果两项评级推算，不能直接填写。")).toBeInTheDocument();
    expect(form.queryByRole("radiogroup", { name: "模型风险" })).not.toBeInTheDocument();
    expect(form.getByLabelText("关注的问题")).toHaveValue("对照组的无进展生存分布是否足以支持单臂试验的样本量计算");
    expect(dialog.querySelector("[data-vcr-assessment-risk]")).toHaveTextContent("高");

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
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("says the frozen plan is not moved when there is one, and keeps the dialog open when the save fails", async () => {
    const user = userEvent.setup();
    const frozen = fixture("ev201/patients.json");
    frozen.assessments.plan = { version: 2, frozenAt: "昨天" };
    network.productRequest.mockImplementation(async (_path: string, method = "GET") => {
      if (method === "POST") throw new Error("refused");
      return frozen;
    });
    draw(<PatientsTab studyId={STUDY_ID} study={study()} />);
    await user.click(await screen.findByRole("button", { name: /^编辑模型评估/ }));
    expect(await screen.findByText("已冻结的模型分析计划不会改动；下次冻结时会列出这次修改。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
