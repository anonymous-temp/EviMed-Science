import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

vi.mock("@/lib/backend", () => ({
  addFilesToWorkspace: vi.fn(async () => ["data.csv"]),
  addTextToWorkspace: vi.fn(async () => "pasted.txt"),
  uploadFilesToWorkspace: vi.fn(async () => []),
}));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
}));

describe("Composer attachments", () => {
  it("adds picked files as removable chips and sends them as a file note", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.click(screen.getByLabelText("添加文件"));
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());

    // Chip is outside the textarea — typing text is independent of the file.
    const input = screen.getByLabelText("输入问题或科研任务");
    fireEvent.change(input, { target: { value: "analyze this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith(
      "analyze this\n\n本次任务已添加文件：data.csv",
    );
    // Chips are cleared after sending.
    expect(screen.queryByText("data.csv")).toBeNull();
  });

  it("removes a chip via its X button without touching the text", async () => {
    render(<Composer onSend={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("添加文件"));
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("移除 data.csv"));
    expect(screen.queryByText("data.csv")).toBeNull();
  });

  it("turns an oversized paste into a workspace file chip, keeping the box clean", async () => {
    render(<Composer onSend={vi.fn()} />);
    const input = screen.getByLabelText("输入问题或科研任务") as HTMLTextAreaElement;

    fireEvent.paste(input, {
      clipboardData: { getData: () => "x".repeat(3000) },
    });
    await waitFor(() => expect(screen.getByText("pasted.txt")).toBeTruthy());
    expect(input.value).toBe("");

    // A short paste stays a normal paste (no new chip).
    fireEvent.paste(input, { clipboardData: { getData: () => "short text" } });
    expect(screen.getAllByText("pasted.txt")).toHaveLength(1);
  });
});
