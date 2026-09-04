import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookEntry } from "@/lib/artifactFile";
import { NotebooksPage } from "./NotebooksPage";

const listNotebooks = vi.fn();
const invokeCommand = vi.fn();

vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true,
  invokeCommand: (...args: unknown[]) => invokeCommand(...args),
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
  { path: "2026-07-05-0319/analysis.ipynb", modified: 200 },
];

describe("NotebooksPage hosted web mode", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    listNotebooks.mockReset();
  });

  it("lists notebooks and offers Python and R hosted notebook creation", async () => {
    listNotebooks.mockResolvedValue(entries);
    render(<NotebooksPage />);

    expect(await screen.findByText("analysis.ipynb")).toBeInTheDocument();
    expect(screen.getByText(/服务端隔离内核/)).toBeInTheDocument();
    const create = screen.getByRole("button", { name: /新建笔记本/ });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(screen.getByRole("menuitem", { name: /Python 笔记本/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /R 笔记本/ })).toBeInTheDocument();
    expect(screen.getByText(/Python 或 R 单元格在服务端隔离内核/)).toBeInTheDocument();
  });

  it("creates a hosted Python notebook through the command backend", async () => {
    listNotebooks.mockResolvedValue([]);
    invokeCommand.mockResolvedValue("notebook.ipynb");
    render(<NotebooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /新建笔记本/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Python 笔记本/ }));

    await waitFor(() => expect(invokeCommand).toHaveBeenCalledWith("add_text_to_workspace", expect.any(Object)));
    expect(await screen.findByText(/nb:notebook.ipynb root:workspace/)).toBeInTheDocument();
  });

  it("creates a hosted R notebook through the command backend", async () => {
    listNotebooks.mockResolvedValue([]);
    invokeCommand.mockResolvedValue("notebook-r.ipynb");
    render(<NotebooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /新建笔记本/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /R 笔记本/ }));

    await waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
      "add_text_to_workspace",
      expect.objectContaining({ filename: "notebook-r.ipynb", content: expect.stringContaining('"language": "r"') }),
    ));
    expect(await screen.findByText(/nb:notebook-r.ipynb root:workspace/)).toBeInTheDocument();
  });

  it("uses upload-oriented empty state in hosted web", async () => {
    listNotebooks.mockResolvedValue([]);
    render(<NotebooksPage />);

    expect(await screen.findByText(/从知识库上传/)).toBeInTheDocument();
  });
});
