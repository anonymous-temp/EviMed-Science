import { beforeEach, describe, expect, it, vi } from "vitest";
import { listResearchGoals, pauseResearchGoal, resumeResearchGoal } from "./researchGoalClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

describe("research goal client", () => {
  beforeEach(() => { request.mockReset(); });

  it("reads a project's goals with its identifier encoded", async () => {
    request.mockResolvedValue({ available: true, goals: [] });
    await expect(listResearchGoals("project/one")).resolves.toEqual({ available: true, goals: [] });
    expect(request).toHaveBeenLastCalledWith("/research-goals?projectId=project%2Fone");
  });

  it("pauses and resumes one conversation's goal in one project, each as a POST", async () => {
    request.mockResolvedValue({ sessionId: "s/1", status: "paused" });
    await pauseResearchGoal("project/one", "s/1");
    expect(request).toHaveBeenLastCalledWith("/research-goals/s%2F1/pause?projectId=project%2Fone", "POST");
    await resumeResearchGoal("project/one", "s/1");
    expect(request).toHaveBeenLastCalledWith("/research-goals/s%2F1/resume?projectId=project%2Fone", "POST");
  });
});
