import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  invokeCommand: vi.fn(),
  webFileDownloadUrl: vi.fn(),
}));

vi.mock("./apiClient", () => ({
  hasWebApi: true,
  invokeCommand: apiMocks.invokeCommand,
  webFileDownloadUrl: apiMocks.webFileDownloadUrl,
}));

afterEach(() => {
  vi.restoreAllMocks();
  apiMocks.invokeCommand.mockReset();
  apiMocks.webFileDownloadUrl.mockReset();
});

describe("artifactFile", () => {
  it("downloads hosted artifacts through the server download URL without loading the file into JS memory", async () => {
    apiMocks.webFileDownloadUrl.mockReturnValue(
      "https://science.example/api/files/download/reports%2Fresult.csv?root=base&projectId=paper1",
    );
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { downloadArtifact } = await import("./artifactFile");

    await downloadArtifact("reports/result.csv", "base", "result.csv");

    expect(apiMocks.webFileDownloadUrl).toHaveBeenCalledWith("reports/result.csv", "base");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].href).toBe(
      "https://science.example/api/files/download/reports%2Fresult.csv?root=base&projectId=paper1",
    );
    expect(clicked[0].download).toBe("result.csv");
    expect(document.body.contains(clicked[0])).toBe(false);
  });

  it("reads, previews and downloads a file of another project when the caller names it, and leaves every other call as it was", async () => {
    apiMocks.invokeCommand.mockResolvedValue("ok");
    apiMocks.webFileDownloadUrl.mockReturnValue("https://science.example/api/files/download/a.pdf?root=base&projectId=paper2");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { readArtifact, previewUrl, probeLargeFile, downloadArtifact } = await import("./artifactFile");

    await readArtifact("knowledge-base/a.pdf", "base");
    expect(apiMocks.invokeCommand).toHaveBeenLastCalledWith("read_artifact", { path: "knowledge-base/a.pdf", root: "base" });
    await readArtifact("knowledge-base/a.pdf", "base", "paper2");
    expect(apiMocks.invokeCommand).toHaveBeenLastCalledWith("read_artifact", { path: "knowledge-base/a.pdf", root: "base" }, { projectId: "paper2" });
    await previewUrl("knowledge-base/a.pdf", "base", "paper2");
    expect(apiMocks.invokeCommand).toHaveBeenLastCalledWith("preview_url", { path: "knowledge-base/a.pdf", root: "base" }, { projectId: "paper2" });
    apiMocks.invokeCommand.mockResolvedValue("{}");
    await probeLargeFile("knowledge-base/a.pdf", "base", "paper2");
    expect(apiMocks.invokeCommand).toHaveBeenLastCalledWith("probe_large_file", { path: "knowledge-base/a.pdf", root: "base" }, { projectId: "paper2" });
    await downloadArtifact("knowledge-base/a.pdf", "base", "a.pdf", "paper2");
    expect(apiMocks.webFileDownloadUrl).toHaveBeenLastCalledWith("knowledge-base/a.pdf", "base", "paper2");
  });
});
