import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookEntry } from "@/lib/artifactFile";
import { NotebooksPage } from "./NotebooksPage";

const listNotebooks = vi.fn();
const jupyterStatus = vi.fn();
const startJupyter = vi.fn();
const openExternal = vi.fn();
vi.mock("@/lib/apiClient", () => ({
  hasWebApi: false,
  hasCommandBackend: true,
  isTauri: true,
  invokeCommand: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({
  addTextToWorkspace: vi.fn(),
  jupyterStatus: () => jupyterStatus(),
  openExternal: (url: string) => openExternal(url),
  setupJupyter: vi.fn(),
  startJupyter: () => startJupyter(),
}));
vi.mock("@/lib/artifactFile", () => ({
  listNotebooks: (root?: string) => listNotebooks(root),
}));
vi.mock("@/components/notebook/NotebookEditor", () => ({
  NotebookEditor: ({ path, root }: { path: string; root?: string }) => (
    <div data-testid="nb">
      nb:{path} root:{root}
    </div>
  ),
}));

const entries: NotebookEntry[] = [
  { path: "2026-07-05-0319/nature_figure.ipynb", modified: 200 },
  { path: "live-demo.ipynb", modified: 100 },
];

describe("NotebooksPage", () => {
  beforeEach(() => {
    listNotebooks.mockReset();
    listNotebooks.mockResolvedValue(entries);
    jupyterStatus.mockReset();
    startJupyter.mockReset();
    openExternal.mockReset();
  });

  it("lists notebooks across all session folders (base scope) with their folder", async () => {
    render(<NotebooksPage />);
    expect(await screen.findByText("nature_figure.ipynb")).toBeInTheDocument();
    // The containing session folder is visible; base-folder notebooks show none.
    expect(screen.getByText("2026-07-05-0319")).toBeInTheDocument();
    expect(screen.getByText("live-demo.ipynb")).toBeInTheDocument();
    expect(listNotebooks).toHaveBeenCalledWith("base");
  });

  it("opens a listed notebook in the editor scoped to the base tree", async () => {
    render(<NotebooksPage />);
    await userEvent.click(await screen.findByText("nature_figure.ipynb"));
    expect(screen.getByTestId("nb")).toHaveTextContent(
      "nb:2026-07-05-0319/nature_figure.ipynb root:base",
    );
  });

  it("opens the managed JupyterLab with its local access token", async () => {
    jupyterStatus.mockResolvedValue({
      installed: true,
      running: false,
      url: "http://127.0.0.1:43821",
      token: "local-token",
      mcp_command: "/managed/jupyter-mcp-server",
    });
    startJupyter.mockResolvedValue({
      installed: true,
      running: true,
      url: "http://127.0.0.1:43821",
      token: "local-token",
      mcp_command: "/managed/jupyter-mcp-server",
    });
    render(<NotebooksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "打开 JupyterLab" }));
    expect(startJupyter).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:43821/?token=local-token");
  });
});
