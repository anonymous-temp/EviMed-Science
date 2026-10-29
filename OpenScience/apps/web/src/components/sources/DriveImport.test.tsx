import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SyncedFolders } from "./DriveImport";
const api = vi.hoisted(() => ({ listSourceFolders: vi.fn(), setSourceFolderStatus: vi.fn() }));
vi.mock("@/lib/sourceClient", async original => ({ ...(await original<object>()), ...api }));
vi.mock("@/lib/useOperator", () => ({ useOperator: () => false }));

it("keeps a folder status write single and focused, then uses an explicit authoritative read to unlock an unknown outcome", async () => {
  const folder = { id: "folder", revision: 3, projectId: "one", payload: { connector: { id: "/papers" }, status: "active" } };
  api.listSourceFolders.mockResolvedValue({ items: [folder] });
  let reject!: (error: unknown) => void;
  api.setSourceFolderStatus.mockImplementation(() => new Promise((_, no) => { reject = no; }));
  render(<SyncedFolders projectId="one" refreshToken={0} />);
  const control = await screen.findByRole("switch", { name: "同步“papers”" });
  control.focus(); fireEvent.click(control); fireEvent.click(control);
  expect(api.setSourceFolderStatus).toHaveBeenCalledTimes(1);
  expect(api.setSourceFolderStatus).toHaveBeenCalledWith("folder", 3, "paused");
  expect(control).toHaveFocus(); expect(control).not.toBeDisabled();
  await act(async () => reject(new Error("timeout")));
  fireEvent.click(control); expect(api.setSourceFolderStatus).toHaveBeenCalledTimes(1);
  api.listSourceFolders.mockResolvedValue({ items: [{ ...folder, revision: 4, payload: { ...folder.payload, status: "paused" } }] });
  fireEvent.click(screen.getByRole("button", { name: "刷新核对状态" }));
  await waitFor(() => expect(control).toHaveAttribute("aria-checked", "false"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "刷新核对状态" })).not.toBeInTheDocument());
});
