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
});
