import { describe, expect, it } from "vitest";
import { isTaskPath, taskIdFromPath, taskPath } from "./taskLocation";

describe("where a task lives", () => {
  it("is the list with no task, and the task's own page with one", () => {
    expect(taskPath()).toBe("/app/autopilot");
    expect(taskPath(null)).toBe("/app/autopilot");
    expect(taskPath("agenda-1a2b")).toBe("/app/autopilot/agenda-1a2b");
  });

  it("carries the list state in the address: the search on both, the chosen execution on a task", () => {
    expect(taskPath(null, { search: "心衰" })).toBe("/app/autopilot?q=%E5%BF%83%E8%A1%B0");
    expect(taskPath("agenda-1", { search: " " })).toBe("/app/autopilot/agenda-1");
    expect(taskPath("agenda-1", { execution: "ep-9" })).toBe("/app/autopilot/agenda-1?execution=ep-9");
    expect(taskPath("agenda-1", { search: "a", execution: "ep-9" })).toBe("/app/autopilot/agenda-1?q=a&execution=ep-9");
    // An execution belongs to a task: with no task there is nothing to choose it in.
    expect(taskPath(null, { execution: "ep-9" })).toBe("/app/autopilot");
  });

  it("puts only an id the shell is willing to address in the path", () => {
    expect(taskPath("a/b")).toBe("/app/autopilot");
    expect(taskPath("../x")).toBe("/app/autopilot");
    expect(taskPath("agenda-1", { execution: "../x" })).toBe("/app/autopilot/agenda-1");
  });

  it("reads an address as a task's page exactly as the route does, and nothing else", () => {
    expect(isTaskPath("/app/autopilot/agenda-1")).toBe(true);
    expect(isTaskPath("/app/autopilot/agenda-1/")).toBe(true);
    expect(isTaskPath("/app/autopilot")).toBe(false);
    expect(isTaskPath("/app/autopilot/")).toBe(false);
    expect(isTaskPath("/app/autopilot/a/b")).toBe(false);
    expect(isTaskPath("/app/chat/agenda-1")).toBe(false);
    expect(taskIdFromPath("/app/autopilot/agenda-1")).toBe("agenda-1");
    expect(taskIdFromPath("/app/autopilot/agenda-1/")).toBe("agenda-1");
    expect(taskIdFromPath("/app/autopilot")).toBeNull();
    expect(taskIdFromPath("/app/autopilot/%E0%A4%A")).toBeNull();
    expect(taskIdFromPath("/app/autopilot/a%2Fb")).toBeNull();
  });
});
