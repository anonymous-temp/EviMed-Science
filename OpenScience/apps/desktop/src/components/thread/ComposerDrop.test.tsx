import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

// Drag-and-drop attach is a hosted-web behavior: the Tauri webview swallows OS
// file drops, so the drop zone only arms when a web command backend exists.
const uploadFilesToWorkspace = vi.fn(async (files: File[]) => files.map((f) => f.name));
vi.mock("@/lib/tauri", () => ({
  isTauri: false,
  addFilesToWorkspace: vi.fn(async () => []),
  addTextToWorkspace: vi.fn(async () => "pasted.txt"),
  uploadFilesToWorkspace: (files: File[]) => uploadFilesToWorkspace(files),
}));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  hasCommandBackend: true,
}));

const dt = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files } });

describe("Composer drag-and-drop (hosted web)", () => {
  it("shows the drop hint while files hover and uploads them as chips on drop", async () => {
    const onSend = vi.fn();
    const { container } = render(<Composer onSend={onSend} />);
    const zone = container.firstElementChild!;

    fireEvent.dragEnter(zone, dt());
    expect(screen.getByText("松开以添加文件")).toBeInTheDocument();
    fireEvent.dragLeave(zone, dt());
    expect(screen.queryByText("松开以添加文件")).toBeNull();

    const file = new File(["a,b"], "dropped.csv");
    fireEvent.dragEnter(zone, dt());
    fireEvent.drop(zone, dt([file]));

    await waitFor(() => expect(uploadFilesToWorkspace).toHaveBeenCalledWith([file]));
    expect(await screen.findByText("dropped.csv")).toBeInTheDocument();

    // Dropped chips send exactly like paperclip-added ones.
    const input = screen.getByLabelText("输入问题或科研任务");
    fireEvent.change(input, { target: { value: "analyze this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("analyze this\n\n本次任务已添加文件：dropped.csv");
  });

  it("does not arm the drop zone without a live session to send to", () => {
    const { container } = render(<Composer />); // no onSend — static mock session
    const zone = container.firstElementChild!;
    fireEvent.dragEnter(zone, dt());
    expect(screen.queryByText("松开以添加文件")).toBeNull();
  });
});
