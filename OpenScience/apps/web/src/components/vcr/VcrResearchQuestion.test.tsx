import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { VcrResearchQuestionCard } from "./VcrResearchQuestion";

/**
 * 研究问题与假设 on the overview: what was written and by whom, each intercurrent event with whether the simulation can represent it,
 * and the editor that sends only the fields the person changed. Rendered over the server's own shape (`presentResearchQuestion`).
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const WRITTEN = {
  id: "main", version: 2,
  fields: {
    question: "多奈哌齐在 78 周能否延缓 ADAS-Cog 恶化？", population: { text: "轻中度阿尔茨海默病" },
    variable: { endpoint: "ADAS-Cog 11", timePoint: "第 78 周" },
    intercurrentEvents: [{ event: "因不良反应停药", strategy: "treatment_policy", mechanism: "停药后继续随访" }, { event: "退出研究", strategy: "hypothetical", mechanism: "" }],
  },
  bases: { question: { basis: "person_edited", label: "你在页面上改的" }, population: { basis: "person_stated", label: "你在对话里说的" },
    variable: { basis: "model_assembled", label: "助手根据对话整理" }, intercurrentEvents: { basis: "model_assembled", label: "助手根据对话整理" } },
  gaps: [{ field: "treatment", label: "治疗条件" }, { field: "summary", label: "群体层面的汇总方式" }],
  events: [
    { event: "因不良反应停药", strategy: "treatment_policy", strategyLabel: "不论是否发生都按原来的分组分析（治疗策略）", mechanism: "停药后继续随访", state: "not_representable", stateLabel: "这个模拟表示不了" },
    { event: "退出研究", strategy: "hypothetical", strategyLabel: "假设事件没有发生（假想情境）", mechanism: "", state: "representable", stateLabel: "这个模拟可以表示" },
  ],
  calibration: null,
};

const serve = (question: unknown, post?: (body: any) => unknown) => {
  network.productRequest.mockImplementation(async (_path: string, method = "GET", body?: unknown) => {
    if (method === "POST") return post ? post(body) : { question, created: true };
    return { questions: question ? [question] : [] };
  });
};
const posted = () => network.productRequest.mock.calls.filter((call) => call[1] === "POST");

beforeEach(() => {
  network.productRequest.mockReset();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

describe("the written question", () => {
  it("shows each field with who wrote it and each event with whether the simulation can represent it", async () => {
    serve(WRITTEN);
    const { container } = render(<VcrResearchQuestionCard studyId="std_1" canWrite />);
    expect(await screen.findByText("研究问题与假设")).toBeTruthy();
    expect(screen.getByText("第 2 版")).toBeTruthy();
    expect(screen.getByText("多奈哌齐在 78 周能否延缓 ADAS-Cog 恶化？")).toBeTruthy();
    expect(screen.getByText("你在页面上改的")).toBeTruthy();
    expect(screen.getByText("ADAS-Cog 11，第 78 周")).toBeTruthy();
    const events = within(screen.getByRole("list", { name: "中途事件" })).getAllByRole("listitem");
    expect(events.map((row) => row.getAttribute("data-vcr-question-event"))).toEqual(["not_representable", "representable"]);
    expect(within(events[0]).getByText("这个模拟表示不了")).toBeTruthy();
    // a field nobody wrote is not drawn as a blank and not named as missing
    expect(screen.queryByText("治疗条件")).toBeNull();
    expect(container.querySelector("[data-vcr-research-question]")).toBeTruthy();
  });

  it("says nothing while the question cannot be read, and a member who may not write sees no editor on an empty study", async () => {
    network.productRequest.mockRejectedValue(new WebApiError("boom", { status: 500 }));
    const { container } = render(<VcrResearchQuestionCard studyId="std_1" canWrite />);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toBe("");
    serve(null);
    const viewer = render(<VcrResearchQuestionCard studyId="std_1" canWrite={false} />);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewer.container.textContent).toBe("");
  });

  it("offers a reader without a question the way to write one, as a recipe and not a form", async () => {
    serve(null);
    render(<VcrResearchQuestionCard studyId="std_1" canWrite />);
    expect(await screen.findByText(/还没有写研究问题；在对话里说一句/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "写下研究问题" }));
    expect(screen.getByRole("textbox", { name: "研究问题" })).toBeTruthy();
  });
});

describe("editing", () => {
  it("sends only the fields the person changed, as the person's edit, and shows the saved version", async () => {
    const saved = { ...WRITTEN, version: 3, fields: { ...WRITTEN.fields, summary: "第 78 周平均变化之差" }, gaps: [{ field: "treatment", label: "治疗条件" }] };
    serve(WRITTEN, () => ({ question: saved, created: true }));
    render(<VcrResearchQuestionCard studyId="std_1" canWrite />);
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await userEvent.type(screen.getByRole("textbox", { name: "汇总方式" }), "第 78 周平均变化之差");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0][0]).toBe("/vcr/studies/std_1/research-question");
    expect(posted()[0][2]).toEqual({ summary: "第 78 周平均变化之差" });
    expect(toasts.success).toHaveBeenCalledWith("研究问题已保存。");
    expect(await screen.findByText("第 3 版")).toBeTruthy();
    expect(screen.getByText("第 78 周平均变化之差")).toBeTruthy();
  });

  it("adds an event with its strategy, and clearing a field sends null", async () => {
    serve(WRITTEN);
    render(<VcrResearchQuestionCard studyId="std_1" canWrite />);
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "人群" }));
    await userEvent.click(screen.getByRole("button", { name: "添加事件" }));
    const rows = document.querySelectorAll("[data-vcr-event-row]");
    expect(rows).toHaveLength(3);
    const last = rows[2] as HTMLElement;
    await userEvent.type(within(last).getByRole("textbox", { name: "事件" }), "使用其他抗痴呆药");
    await userEvent.selectOptions(within(last).getByRole("combobox", { name: "处理方式" }), "composite");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    const body = posted()[0][2];
    expect(body.population).toEqual({ text: null });
    expect(body.intercurrentEvents).toHaveLength(3);
    expect(body.intercurrentEvents[2]).toEqual({ event: "使用其他抗痴呆药", strategy: "composite", mechanism: "" });
    expect(Object.keys(body).sort()).toEqual(["intercurrentEvents", "population"]);
  });

  it("an unchanged form saves nothing, and a failed save keeps the form and says why", async () => {
    serve(WRITTEN, () => { throw new WebApiError("intercurrentEvents[0].strategy 不对", { status: 400, code: "vcr_research_question_invalid" }); });
    render(<VcrResearchQuestionCard studyId="std_1" canWrite />);
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(posted()).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.type(screen.getByRole("textbox", { name: "汇总方式" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByRole("textbox", { name: "汇总方式" })).toHaveProperty("value", "x");
    expect(toasts.success).not.toHaveBeenCalled();
  });
});
