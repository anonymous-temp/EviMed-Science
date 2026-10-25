// 「从其他 AI 导入」: the four steps of the dialog — the question to copy, the answer to paste, the statements to keep or leave, the save.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { IMPORT_MAX_CHARS, IMPORT_PROMPT, ImportDialog } from "./ImportDialog";

const memory = vi.hoisted(() => ({ offerMemoryImport: vi.fn(), saveMemoryImport: vi.fn() }));
vi.mock("@/lib/memoryClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")), ...memory }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const OFFER = {
  id: "imp_0123456789abcdef01234567",
  statements: [
    { id: "s1", text: "我是心内科医生，主要做房颤的临床研究", sensitivity: "ordinary" as const, ticked: true },
    { id: "s2", text: "我对青霉素过敏", sensitivity: "on_request" as const, ticked: false },
    { id: "s3", text: "回答尽量简短", sensitivity: "ordinary" as const, ticked: true },
  ],
  leftOut: 2,
};

function open() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<ImportDialog onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved, dialog: screen.getByRole("dialog", { name: "从其他 AI 导入" }) };
}

async function toReview(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("button", { name: "下一步" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "原来助手的回答" }), "- 我是心内科医生");
  await userEvent.click(within(dialog).getByRole("button", { name: "读取" }));
  await within(dialog).findByText("下面是读出的内容。勾选的会记下，不勾的不会。");
}

beforeEach(() => { memory.offerMemoryImport.mockResolvedValue(OFFER); memory.saveMemoryImport.mockResolvedValue({ saved: 2 }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("从其他 AI 导入", () => {
  it("first says what to ask the assistant used before, in words that copy as they stand", async () => {
    const written = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: written }, configurable: true });
    const { dialog } = open();
    const asked = within(dialog).getByLabelText("要发给原来助手的话");
    expect(asked).toHaveTextContent("只写我自己的");
    expect(asked.textContent).toBe(IMPORT_PROMPT);
    expect(asked.textContent).toMatch(/不要写别人的信息，不要写密码、证件号、银行卡/);
    await userEvent.click(within(dialog).getByRole("button", { name: "复制这段话" }));
    expect(written).toHaveBeenCalledWith(IMPORT_PROMPT);
    expect(toasts.success).toHaveBeenCalledWith("已复制");
  });

  it("reads the pasted text, offers the ordinary statements ticked and the private one unticked, and says that some were left out", async () => {
    const { dialog } = open();
    await toReview(dialog);
    expect(memory.offerMemoryImport).toHaveBeenCalledWith("- 我是心内科医生");
    expect(within(dialog).getByRole("checkbox", { name: /我是心内科医生/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /回答尽量简短/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /我对青霉素过敏/ })).not.toBeChecked();
    expect(within(dialog).getByText("偏私人的内容，勾选就表示你明确要记住它。")).toBeInTheDocument();
    expect(within(dialog).getByText("有 2 条没有列出：密码、证件号、他人信息这类内容不会记下。")).toBeInTheDocument();
    expect(within(dialog).queryByText(/密码是/)).toBeNull();
  });

  it("saves the ticked ones, and what the person unticks or ticks is what is sent", async () => {
    const { dialog, onSaved, onClose } = open();
    await toReview(dialog);
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /回答尽量简短/ }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /我对青霉素过敏/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "保存所选" }));
    await waitFor(() => expect(memory.saveMemoryImport).toHaveBeenCalledWith(OFFER.id, ["s1", "s2"]));
    expect(toasts.success).toHaveBeenCalledWith("已交给记忆：2 条，几秒后出现在列表里");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("will not save with nothing ticked, and goes back to change the text", async () => {
    const { dialog } = open();
    await toReview(dialog);
    for (const box of within(dialog).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) await userEvent.click(box);
    expect(within(dialog).getByRole("button", { name: "保存所选" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "返回修改" }));
    expect(within(dialog).getByRole("textbox", { name: "原来助手的回答" })).toHaveValue("- 我是心内科医生");
  });

  it("says a refusal in the registry's sentence and keeps the text, in the paste step and in the save step", async () => {
    memory.offerMemoryImport.mockRejectedValueOnce(new WebApiError("limited", { status: 429, code: "memory_import_rate_limited" }));
    const { dialog } = open();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "原来助手的回答" }), "- 我是心内科医生");
    await userEvent.click(within(dialog).getByRole("button", { name: "读取" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("一小时内导入的次数太多了");
    expect(within(dialog).getByRole("textbox", { name: "原来助手的回答" })).toHaveValue("- 我是心内科医生");
    // The second try is read; the save is then refused for a gone offer.
    memory.saveMemoryImport.mockRejectedValueOnce(new WebApiError("gone", { status: 404, code: "memory_import_expired" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "读取" }));
    await within(dialog).findByText("下面是读出的内容。勾选的会记下，不勾的不会。");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存所选" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("这份导入清单已经失效");
    expect(within(dialog).getByRole("checkbox", { name: /我是心内科医生/ })).toBeChecked();
  });

  it("says plainly when nothing could be read, and holds the paste to what the control plane reads", async () => {
    memory.offerMemoryImport.mockResolvedValueOnce({ id: OFFER.id, statements: [], leftOut: 0 });
    const { dialog } = open();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步" }));
    const box = within(dialog).getByRole("textbox", { name: "原来助手的回答" });
    expect(box).toHaveAttribute("maxlength", String(IMPORT_MAX_CHARS));
    expect(within(dialog).getByRole("button", { name: "读取" })).toBeDisabled();
    await userEvent.type(box, "没什么可导入的");
    await userEvent.click(within(dialog).getByRole("button", { name: "读取" }));
    expect(await within(dialog).findByText("没有读出可以记下的内容。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "保存所选" })).toBeDisabled();
  });
});
