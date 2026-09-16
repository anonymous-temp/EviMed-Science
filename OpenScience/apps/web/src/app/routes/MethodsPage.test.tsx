import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MethodsPage } from "./MethodsPage";
import type { WebMethod } from "@/lib/methodsClient";

const api = vi.hoisted(() => ({ listMethods: vi.fn(), createMethod: vi.fn(), retireMethod: vi.fn(), rollbackMethod: vi.fn() }));
vi.mock("@/lib/methodsClient", () => api);
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function method(overrides: Partial<WebMethod> = {}): WebMethod {
  return {
    id: "method-1", projectId: null, revision: 2, name: "SGLT2 证据分层", description: "先分 RCT 与观察性研究",
    whenToUse: "", status: "candidate", statusReason: null, origin: "inferred",
    counts: { eligible: 3, loaded: 3, invoked: 2, succeeded: 1, validated: 0, read: 1 },
    evaluations: [],
    promotion: {
      status: "candidate", reasons: [],
      missing: ["1 successful trajectories; 3 are needed", "no paired evaluation has been run against a frozen baseline", "a sentence from a newer server"],
      missingDetails: [{ code: "trajectories_needed", have: 1, need: 3 }, { code: "no_evaluation" }, { code: "something_new" }],
    },
    body: "## 步骤\n\n1. 分层", createdAt: "2026-09-16T08:00:00.000Z", updatedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  };
}

describe("MethodsPage", () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.listMethods.mockResolvedValue({ items: [method()], nextCursor: null });
  });

  it("shows each method's status and what a candidate still lacks in the reader's words", async () => {
    render(<MethodsPage />);
    const list = await screen.findByRole("list", { name: "方法列表" });
    const row = within(list).getAllByRole("listitem")[0];
    expect(within(row).getByText("待验证")).toBeInTheDocument();
    expect(within(row).getByText("成功用到它的任务还不够：已有 1 次，需要 3 次。")).toBeInTheDocument();
    expect(within(row).getByText("还没有和固定基线做过配对评测。")).toBeInTheDocument();
    // A code the page does not know yet is shown as its sentence, not dropped.
    expect(within(row).getByText("a sentence from a newer server")).toBeInTheDocument();
    expect(within(row).queryByText(/successful trajectories/)).not.toBeInTheDocument();
  });

  it("filters by status through the API", async () => {
    render(<MethodsPage />);
    await screen.findByRole("list", { name: "方法列表" });
    await userEvent.click(screen.getByRole("radio", { name: "已采用" }));
    await waitFor(() => expect(api.listMethods).toHaveBeenLastCalledWith("approved", null));
  });

  it("stops a method only after saying what stopping keeps, and rolls back to the previous revision", async () => {
    const current = method();
    api.retireMethod.mockResolvedValue({ ...current, status: "retired", revision: 3 });
    api.rollbackMethod.mockResolvedValue({ ...current, revision: 3 });
    render(<MethodsPage />);
    await screen.findByRole("list", { name: "方法列表" });
    await userEvent.click(screen.getByRole("button", { name: "停用" }));
    expect(screen.getByText(/方法内容和历史版本都保留/)).toBeInTheDocument();
    expect(api.retireMethod).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(api.retireMethod).toHaveBeenCalledWith(current));
    // The badge changes; the filter control carries the same word, so read the row.
    const list = screen.getByRole("list", { name: "方法列表" });
    await waitFor(() => expect(within(within(list).getAllByRole("listitem")[0]).getByText("已停用")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /回到上一版/ }));
    await waitFor(() => expect(api.rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ id: "method-1", revision: 3 }), 2));
  });

  it("saves a method the researcher writes, and reloads the list", async () => {
    api.createMethod.mockResolvedValue(method({ id: "method-2", name: "我的方法", origin: "explicit", status: "approved" }));
    render(<MethodsPage />);
    await screen.findByRole("list", { name: "方法列表" });
    await userEvent.click(screen.getByRole("button", { name: /写一个方法/ }));
    const editor = screen.getByRole("textbox", { name: "方法内容（SKILL.md）" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "---{enter}name: 我的方法{enter}description: 测试{enter}---{enter}正文");
    await userEvent.click(screen.getByRole("button", { name: "保存并生效" }));
    await waitFor(() => expect(api.createMethod).toHaveBeenCalledWith(expect.stringContaining("name: 我的方法")));
    expect(api.listMethods).toHaveBeenCalledTimes(2);
  });

  it("says when the list could not be read and offers a retry", async () => {
    api.listMethods.mockRejectedValueOnce(new Error("offline"));
    render(<MethodsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("方法列表没有读到");
    api.listMethods.mockResolvedValue({ items: [], nextCursor: null });
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有方法")).toBeInTheDocument();
  });
});
