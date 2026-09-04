import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "@/lib/artifactFile";
import { FilesPage, SessionFilesPane } from "./FilesPage";

const listDir = vi.fn();
const mocks = vi.hoisted(() => ({
  addFilesToWorkspace: vi.fn(),
  uploadFilesToWorkspace: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/artifactFile", () => ({
  listDir: (rel: string, root?: string) => listDir(rel, root),
}));
vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true,
  getWebProjectId: () => "default",
}));
vi.mock("@/lib/backend", () => ({
  addFilesToWorkspace: mocks.addFilesToWorkspace,
  uploadFilesToWorkspace: mocks.uploadFilesToWorkspace,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({ data }: { data: { filename: string } }) => (
    <div data-testid="preview">preview:{data.filename}</div>
  ),
}));
vi.mock("@/components/notebook/NotebookEditor", () => ({
  NotebookEditor: ({ path }: { path: string }) => <div data-testid="nb">nb:{path}</div>,
}));

const knowledgeRoot: DirEntry[] = [
  { path: "knowledge-base/data", name: "data", isDir: true, size: 0, modified: 2 },
  { path: "knowledge-base/figure.png", name: "figure.png", isDir: false, size: 2048, modified: 3 },
  { path: "knowledge-base/run.ipynb", name: "run.ipynb", isDir: false, size: 500, modified: 1 },
];
const knowledgeSub: DirEntry[] = [{ path: "knowledge-base/data/genes.bed", name: "genes.bed", isDir: false, size: 120, modified: 4 }];
const sessionRoot: DirEntry[] = [
  { path: "data", name: "data", isDir: true, size: 0, modified: 2 },
];
const sessionSub: DirEntry[] = [{ path: "data/genes.bed", name: "genes.bed", isDir: false, size: 120, modified: 4 }];

describe("FilesPage", () => {
  beforeEach(() => {
    listDir.mockReset();
    listDir.mockImplementation((rel: string, root?: string) => {
      if (root === "base") return Promise.resolve(rel === "knowledge-base/data" ? knowledgeSub : knowledgeRoot);
      return Promise.resolve(rel === "data" ? sessionSub : sessionRoot);
    });
    mocks.addFilesToWorkspace.mockReset();
    mocks.addFilesToWorkspace.mockResolvedValue(["data/uploaded.csv"]);
    mocks.uploadFilesToWorkspace.mockReset();
    mocks.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/dropped.csv"]);
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it("lists workspace entries with sizes and opens a file in the previewer", async () => {
    render(<FilesPage />);
    expect(await screen.findByText("figure.png")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();

    await userEvent.click(screen.getByText("figure.png"));
    expect(screen.getByTestId("preview")).toHaveTextContent("preview:figure.png");
  });

  it("allows the preview column to shrink inside the available viewport", async () => {
    render(<FilesPage />);
    await userEvent.click(await screen.findByText("figure.png"));

    // Flex children default to min-width:auto; without min-w-0 a wide report
    // forces the inspector past the viewport and clips its header actions.
    const previewColumn = screen.getByTestId("preview").parentElement!;
    expect(previewColumn).toHaveClass("min-w-0");
    // Below md there is not enough room for both the 288px browser and the
    // inspector controls. The selected file takes the page and Close returns
    // to the browser; md+ keeps the normal split view.
    expect(previewColumn.previousElementSibling).toHaveClass("hidden", "md:flex");
  });

  it("shows directory-row skeletons while the listing loads", () => {
    listDir.mockReturnValue(new Promise(() => {}));
    const { container } = render(<FilesPage />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByText("正在加载…")).not.toBeInTheDocument();
  });

  it("opens notebooks in the runnable editor", async () => {
    render(<FilesPage />);
    await userEvent.click(await screen.findByText("run.ipynb"));
    expect(screen.getByTestId("nb")).toHaveTextContent("nb:knowledge-base/run.ipynb");
  });

  it("navigates into a folder and back via the breadcrumb", async () => {
    render(<FilesPage />);
    await userEvent.click(await screen.findByText("data"));
    expect(await screen.findByText("genes.bed")).toBeInTheDocument();
    // The page is GLOBAL: every listing resolves in the base folder tree.
    expect(listDir).toHaveBeenCalledWith("knowledge-base/data", "base");

    await userEvent.click(screen.getByRole("button", { name: "个人知识库" }));
    await waitFor(() => expect(screen.getByText("figure.png")).toBeInTheDocument());
  });

  it("uploads files into the current hosted project folder from the global files page", async () => {
    render(<FilesPage />);
    await userEvent.click(await screen.findByText("data"));
    await screen.findByText("genes.bed");

    await userEvent.click(screen.getByRole("button", { name: "上传资料" }));

    await waitFor(() => expect(mocks.addFilesToWorkspace).toHaveBeenCalledWith("knowledge-base/data", "base"));
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("knowledge-base/data", "base"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 1 个文件。");
  });

  it("uploads dropped files into the current folder, same as the upload button", async () => {
    const { container } = render(<FilesPage />);
    await screen.findByText("figure.png");
    const zone = container.firstElementChild!;
    const dt = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files } });

    // The overlay appears while files hover either the browser or the preview.
    fireEvent.dragEnter(zone, dt());
    expect(screen.getByText("松开以上传到个人知识库")).toBeInTheDocument();
    fireEvent.dragLeave(zone, dt());
    expect(screen.queryByText("松开以上传到个人知识库")).toBeNull();

    const file = new File(["a,b"], "dropped.csv");
    fireEvent.dragEnter(zone, dt());
    fireEvent.drop(zone, dt([file]));

    await waitFor(() =>
      expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base"),
    );
    // The listing reloads after the upload (initial load + refresh).
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(2));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 1 个文件。");
  });

  it("uploads files into the current session folder and refreshes the listing", async () => {
    render(<SessionFilesPane onClose={vi.fn()} />);

    await userEvent.click(await screen.findByText("data"));
    await screen.findByText("genes.bed");

    await userEvent.click(screen.getByRole("button", { name: "上传文件" }));

    await waitFor(() => expect(mocks.addFilesToWorkspace).toHaveBeenCalledWith("data"));
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("data", "workspace"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 1 个文件。");
  });
});
