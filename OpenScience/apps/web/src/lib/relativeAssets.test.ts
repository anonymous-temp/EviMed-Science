import { describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
vi.mock("./artifactFile", () => ({ readArtifact: read }));

import { inlineHtmlWorkspaceAssets, isRelativeReference, readWorkspaceDataUrl, resolveWorkspaceReference } from "./relativeAssets";

describe("a report's relative references", () => {
  it("resolves against the report's folder and stays in the workspace", () => {
    expect(resolveWorkspaceReference("reports/a/report.md", "figures/trend.png")).toBe("reports/a/figures/trend.png");
    expect(resolveWorkspaceReference("reports/a/report.md", "./图/趋势 1.png?raw=1#x")).toBe("reports/a/图/趋势 1.png");
    expect(resolveWorkspaceReference("reports/a/report.md", "%E5%9B%BE/%E8%B6%8B%E5%8A%BF.png")).toBe("reports/a/图/趋势.png");
    expect(resolveWorkspaceReference("reports/a/report.md", "../shared/x.png")).toBe("reports/shared/x.png");
    expect(resolveWorkspaceReference("report.md", "x.png")).toBe("x.png");
    expect(resolveWorkspaceReference("reports/report.md", "../../x.png")).toBeNull();
    expect(resolveWorkspaceReference("report.md", "../x.png")).toBeNull();
    expect(resolveWorkspaceReference("report.md", "a\\b.png")).toBeNull();
    expect(resolveWorkspaceReference("report.md", "%E0%A4%A.png")).toBeNull();
  });

  it("leaves addresses of their own alone", () => {
    for (const ref of ["https://x.org/a.png", "data:image/png;base64,AA", "blob:x", "//cdn/a.png", "/abs/a.png", "#top", ""]) {
      expect(isRelativeReference(ref)).toBe(false);
      expect(resolveWorkspaceReference("r/report.md", ref)).toBeNull();
    }
  });

  it("reads a picture as a data address and says nothing for a missing, unreadable or unknown one", async () => {
    read.mockResolvedValueOnce({ encoding: "base64", data: "AAEC" });
    expect(await readWorkspaceDataUrl("a/b.png", "workspace")).toBe("data:image/png;base64,AAEC");
    read.mockResolvedValueOnce(null);
    expect(await readWorkspaceDataUrl("a/missing.png", "workspace")).toBeNull();
    read.mockRejectedValueOnce(new Error("404"));
    expect(await readWorkspaceDataUrl("a/gone.png", "workspace")).toBeNull();
    expect(await readWorkspaceDataUrl("a/b.exe", "workspace")).toBeNull();
    read.mockResolvedValueOnce({ encoding: "utf8", data: "<svg/>" });
    expect(await readWorkspaceDataUrl("a/b.svg", "workspace")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent("<svg/>")}`);
  });

  it("puts a report's own pictures and style sheet into its HTML and leaves a missing one as written", async () => {
    read.mockImplementation(async (path: string) => {
      if (path === "reports/图表/趋势.png") return { encoding: "base64", data: "QUJD" };
      if (path === "reports/style.css") return { encoding: "utf8", data: "p{color:red}" };
      return null;
    });
    const html = '<html><head><link rel="stylesheet" href="style.css"></head><body><img src="图表/趋势.png"><img src="missing.png"><img src="https://x.org/a.png"></body></html>';
    const out = await inlineHtmlWorkspaceAssets(html, "reports/report.html", "workspace");
    expect(out).toContain('src="data:image/png;base64,QUJD"');
    expect(out).toContain('src="missing.png"');
    expect(out).toContain('src="https://x.org/a.png"');
    expect(out).toContain("<style>p{color:red}</style>");
    expect(await inlineHtmlWorkspaceAssets("<p>no pictures</p>", "reports/report.html", "workspace")).toBe("<p>no pictures</p>");
  });
});
