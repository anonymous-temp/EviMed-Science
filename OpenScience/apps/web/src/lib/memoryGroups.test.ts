import { describe, expect, it } from "vitest";
import { SELF_SECTIONS, entryGroup, kindTitle, recordGroup, recordProjectId, selfSection } from "./memoryGroups";

describe("where a fact belongs", () => {
  it("files a memory by kind and scope: a project's, or the person's — and never as 做法, which is what the platform learned", () => {
    expect(recordGroup({ scope: "project", kind: "preference" })).toBe("project");
    expect(recordGroup({ scope: "user", kind: "decision" })).toBe("project");
    expect(recordGroup({ scope: "user", kind: "behavior" })).toBe("self");
    expect(recordGroup({ scope: "user", kind: "correction" })).toBe("self");
    expect(recordProjectId({ scope: "project", scopeId: "p1" })).toBe("p1");
    expect(recordProjectId({ scope: "user", scopeId: "" })).toBeNull();
  });

  it("files a note of the researcher's own capsule the same way, by its fact kind and the project it was noted in", () => {
    const entry = (factKind: string, projectId: string | null = null) => ({ projectId, payload: { factKind } }) as never;
    expect(entryGroup(entry("project_fact"))).toBe("project");
    expect(entryGroup(entry("preference", "p1"))).toBe("project");
    expect(entryGroup(entry("method_preference"))).toBe("self");
    expect(entryGroup(entry("writing_style"))).toBe("self");
  });

  it("puts every kind of fact about the person under one of the small headers, in either store's vocabulary", () => {
    expect(selfSection("profile")).toBe("background");
    expect(selfSection("expertise")).toBe("background");
    expect(selfSection("preference")).toBe("preference");
    expect(selfSection("behavior")).toBe("habit");
    expect(selfSection("writing_style")).toBe("habit");
    expect(selfSection("method_preference")).toBe("habit");
    expect(selfSection("correction")).toBe("correction");
    expect(selfSection("something_new")).toBe("other");
    expect(SELF_SECTIONS.map((section) => section.key)).toEqual(["background", "preference", "habit", "correction", "other"]);
  });

  it("titles a drawer by the kind, in words a researcher uses", () => {
    expect(kindTitle("preference")).toBe("偏好");
    expect(kindTitle("project_fact")).toBe("项目事实");
    expect(kindTitle("writing_style")).toBe("写作习惯");
    expect(kindTitle("something_new")).toBe("记忆");
  });
});
