import { describe, expect, it } from "vitest";
import { artifactDisplayName } from "./artifactNames";

describe("artifact display names", () => {
  it("names the documents a researcher reads and leaves machine files as they are", () => {
    expect(artifactDisplayName("deliverables/aspirin-70plus-evidence/clinical-evidence-report.md")).toBe("证据分析报告");
    expect(artifactDisplayName("clinical-evidence-matrix.json")).toBe("证据矩阵");
    expect(artifactDisplayName("deliverables/x/revision-notes.md")).toBe("修订说明");
    expect(artifactDisplayName("deliverables/x/meta-analysis-run.json")).toBe("meta-analysis-run.json");
    expect(artifactDisplayName("work/patch2.py")).toBe("patch2.py");
  });
});
