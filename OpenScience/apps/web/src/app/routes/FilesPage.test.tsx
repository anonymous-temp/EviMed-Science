import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "@/lib/artifactFile";
import { KNOWLEDGE_BASE_FORMATS } from "@evimed/domain";
import { FilesPage, KNOWLEDGE_BASE_FORMAT_FAMILIES, SessionFilesPane, partitionKnowledgeBaseFiles } from "./FilesPage";

const listDir = vi.fn();
const mocks = vi.hoisted(() => ({
  addFilesToWorkspace: vi.fn(),
  pickFiles: vi.fn(),
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
  pickFiles: mocks.pickFiles,
  uploadFilesToWorkspace: mocks.uploadFilesToWorkspace,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({ data }: { data: { filename: string; language?: string } }) => (
    <div data-testid="preview" data-language={data.language}>preview:{data.filename}</div>
  ),
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
    mocks.pickFiles.mockReset();
    mocks.pickFiles.mockResolvedValue([new File(["a,b"], "uploaded.csv")]);
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

  // The runnable notebook editor was deleted on 2026-09-19. A notebook a run
  // delivered is still a file: listed, readable, downloadable from the preview.
  it("opens a notebook read-only in the file preview, as JSON", async () => {
    render(<FilesPage />);
    await userEvent.click(await screen.findByText("run.ipynb"));
    expect(screen.getByTestId("preview")).toHaveTextContent("preview:run.ipynb");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-language", "json");
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

    // The picker opens filtered to what the knowledge base accepts.
    await waitFor(() => expect(mocks.pickFiles).toHaveBeenCalledTimes(1));
    const accept = String(mocks.pickFiles.mock.calls[0][0]).split(",");
    expect(accept).toEqual(expect.arrayContaining([".pdf", ".docx", ".pptx", ".xlsx", ".png", ".epub", ".html", ".md"]));
    expect(accept).not.toContain(".mp4");
    await waitFor(() => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "uploaded.csv" })], "knowledge-base/data", "base"));
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("knowledge-base/data", "base"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 1 个文件。");
  });

  it("refuses a recording or an unlisted format by name before uploading, and still uploads the rest", async () => {
    const { container } = render(<FilesPage />);
    await screen.findByText("figure.png");
    const zone = container.firstElementChild!;
    const files = [new File(["v"], "clip.mp4"), new File(["x"], "tool.exe"), new File(["%PDF"], "guideline.pdf")];
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"], files: [] } });
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files } });

    await waitFor(() => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([files[2]], "knowledge-base", "base"));
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("clip.mp4（音视频暂不支持）"));
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("tool.exe（格式不在支持范围内）"));
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("音视频暂不支持。"));
  });

  it("names the accepted formats as families that are exactly what the upload check accepts", () => {
    const named = KNOWLEDGE_BASE_FORMAT_FAMILIES.flatMap(([, formats]) => formats);
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual([...KNOWLEDGE_BASE_FORMATS].sort());
    const { accepted, refused } = partitionKnowledgeBaseFiles([new File([""], "a.PDF"), new File([""], "b.wav"), new File([""], "noext")]);
    expect(accepted.map((file) => file.name)).toEqual(["a.PDF"]);
    expect(refused).toEqual([{ name: "b.wav", reason: "音视频暂不支持" }, { name: "noext", reason: "格式不在支持范围内" }]);
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
