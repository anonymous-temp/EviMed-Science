import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookEntry } from "@/lib/artifactFile";
import { NotebooksPage } from "./NotebooksPage";

const listNotebooks = vi.fn();
vi.mock("@/lib/apiClient", () => ({
  hasWebApi: false,
  invokeCommand: vi.fn(),
  webErrorMessage: (_error: unknown, overrides?: { fallback?: string }) => overrides?.fallback ?? "操作未完成，请重试。",
}));
vi.mock("@/lib/backend", () => ({
  addTextToWorkspace: vi.fn(),
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

  // Four states: 「暂无笔记本」 used to show before the first answer, and in
  // place of a failed read.
  it("says nothing is there only once the list has answered", async () => {
    let answer!: (value: NotebookEntry[]) => void;
    listNotebooks.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { container } = render(<NotebooksPage />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByText(/暂无笔记本|当前未配置/)).not.toBeInTheDocument();
    answer([]);
    expect(await screen.findByText("当前未配置可用的笔记本后端。")).toBeInTheDocument();
  });

  it("says a failed read failed, and retries it", async () => {
    listNotebooks.mockRejectedValueOnce(new Error("network"));
    render(<NotebooksPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("笔记本列表暂时读不到。");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("nature_figure.ipynb")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
