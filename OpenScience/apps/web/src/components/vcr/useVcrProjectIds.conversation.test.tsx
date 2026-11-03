import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useVcrProjects } from "./useVcrProjectIds";
import { useProjectGroups } from "../sources/useProjectGroups";

// VCR remediation F1: the home lists the studies a conversation made in a field of its own. Those studies live in the person's own
// (default) project, so a reader that took them for studies would turn that project into a study's, and the knowledge base would
// lose it from the places a document can take effect in. Only the module's home reads `conversationStudies`.
const mocks = vi.hoisted(() => ({
  home: {
    studies: [] as unknown[],
    draftProjectIds: [] as string[],
    conversationStudies: [{ id: "std_conv", projectId: "default", name: "帮我匹配患者和临床试验", question: null, status: "active", originatingSessionId: "sess_1", tabs: ["matching"], updatedAt: "今天 10:12" }],
  },
  projects: [
    { id: "default", name: "我的项目" },
    { id: "paper", name: "Paper" },
  ],
}));
vi.mock("@/lib/vcrClient", () => ({ useVcrFeature: () => "on", getVcrHome: vi.fn(async () => mocks.home) }));
vi.mock("@/lib/projects", () => ({ useProjectStore: (selector: (state: { projects: typeof mocks.projects }) => unknown) => selector({ projects: mocks.projects }) }));
vi.mock("@/lib/geoClient", () => ({ useGeoFeature: () => "off" }));
vi.mock("@/components/geo/useGeoProjectIds", () => ({ useGeoProjectIds: () => new Set<string>() }));

describe("a home that lists conversation studies", () => {
  it("makes none of the projects a study's, a draft's or a task's: the sidebar has no new row", async () => {
    const { result } = renderHook(() => useVcrProjects(true, "default\u0000paper"));
    const { getVcrHome } = await import("@/lib/vcrClient");
    await waitFor(() => expect(getVcrHome).toHaveBeenCalled());
    await waitFor(() => expect(result.current.studies.size).toBe(0));
    expect(result.current.studyOf.size).toBe(0);
    expect(result.current.tasks.size).toBe(0);
    expect(result.current.drafts.size).toBe(0);
    expect(result.current.calculations.size).toBe(0);
  });

  it("leaves the default project among the places a document can take effect in, and among the account's own", async () => {
    const { result } = renderHook(() => useProjectGroups());
    const { getVcrHome } = await import("@/lib/vcrClient");
    await waitFor(() => expect(getVcrHome).toHaveBeenCalled());
    // The read has landed once the hook has settled on it; the groups must still hold the default project.
    await waitFor(() => expect(result.current.applicable.map((choice) => choice.id)).toEqual(["default", "paper"]));
    expect(result.current.own.map((choice) => choice.id)).toEqual(["default", "paper"]);
    expect(result.current.studies).toEqual([]);
  });
});
