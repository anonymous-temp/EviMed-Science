import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProjectGroups } from "./useProjectGroups";

const mocks = vi.hoisted(() => ({
  projects: [
    { id: "default", name: "我的项目" },
    { id: "paper", name: "Paper" },
    { id: "old", name: "旧项目", archivedAt: "2026-09-01T00:00:00Z" },
    { id: "geo-one", name: "某药 GEO" },
    { id: "study", name: "SGLT2 研究" },
    { id: "draft", name: "草稿研究" },
    { id: "task", name: "研究任务" },
    { id: "evimed-library", name: "我的资料" },
  ],
}));
vi.mock("@/lib/projects", () => ({ useProjectStore: (selector: (state: { projects: typeof mocks.projects }) => unknown) => selector({ projects: mocks.projects }) }));
vi.mock("@/lib/geoClient", () => ({ useGeoFeature: () => "on" }));
vi.mock("@/lib/vcrClient", () => ({ useVcrFeature: () => "on" }));
vi.mock("@/components/geo/useGeoProjectIds", () => ({ useGeoProjectIds: () => new Set(["geo-one"]) }));
vi.mock("@/components/vcr/useVcrProjectIds", () => ({
  useVcrProjects: () => ({ studies: new Set(["study"]), drafts: new Set(["draft"]), tasks: new Set(["task"]), studyOf: new Map(), calculations: new Map() }),
}));

describe("the projects a document can be sent to", () => {
  it("are the server's own rule: a live ordinary project, and not an archived one, a study nobody has spoken in, or one kept for a task", () => {
    const { result } = renderHook(() => useProjectGroups());
    expect(result.current.applicable.map((choice) => choice.id)).toEqual(["default", "paper"]);
  });

  it("leave the other groups as the sidebar has them: the task's project is still one of the account's own, and storage is never a project", () => {
    const { result } = renderHook(() => useProjectGroups());
    expect(result.current.own.map((choice) => choice.id)).toEqual(["default", "paper", "old", "draft", "task"]);
    expect(result.current.studies.map((choice) => choice.id)).toEqual(["study"]);
    expect(result.current.communication.map((choice) => choice.id)).toEqual(["geo-one"]);
  });
});
