import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectLabels } from "./projectNames";

const at = (iso: string) => new Date(iso).toISOString();

// A day of this year reads 「9月29日」, one of another year 「2025-09-29」, and the year is the display zone's (Beijing, AT45) at the
// clock's now. Fix the clock, and write every instant with its +08:00, so the labels do not depend on the date or the zone of the machine.
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-26T12:00:00+08:00")); });
afterAll(() => { vi.useRealTimers(); });

describe("projectLabels", () => {
  it("leaves a name that is alone as it is", () => {
    const labels = projectLabels([
      { id: "default", name: "我的研究", createdAt: at("2026-09-01T08:00:00+08:00") },
      { id: "p-1", name: "波立维", createdAt: at("2026-09-29T09:00:00+08:00") },
    ]);
    expect(labels.get("default")).toBe("我的研究");
    expect(labels.get("p-1")).toBe("波立维");
  });

  it("tells two projects of one name apart by the day they were made", () => {
    const labels = projectLabels([
      { id: "a", name: "波立维", createdAt: at("2026-09-29T14:02:00+08:00") },
      { id: "b", name: "波立维", createdAt: at("2026-10-01T09:30:00+08:00") },
    ]);
    expect(labels.get("a")).toBe("波立维 · 9月29日");
    expect(labels.get("b")).toBe("波立维 · 10月1日");
  });

  it("adds the time when two were made the same day, and only to those two", () => {
    const labels = projectLabels([
      { id: "a", name: "波立维", createdAt: at("2026-09-29T14:02:00+08:00") },
      { id: "b", name: "波立维", createdAt: at("2026-09-29T16:40:00+08:00") },
      { id: "c", name: "波立维", createdAt: at("2026-10-02T09:00:00+08:00") },
    ]);
    expect(labels.get("a")).toBe("波立维 · 9月29日 14:02");
    expect(labels.get("b")).toBe("波立维 · 9月29日 16:40");
    expect(labels.get("c")).toBe("波立维 · 10月2日");
  });

  it("counts them in the order they were made when there is no day, or the minute is the same", () => {
    const none = projectLabels([
      { id: "z", name: "波立维" },
      { id: "m", name: "波立维", createdAt: null },
    ]);
    expect(none.get("m")).toBe("波立维 · 第 1 个");
    expect(none.get("z")).toBe("波立维 · 第 2 个");
    const sameMinute = projectLabels([
      { id: "b", name: "波立维", createdAt: at("2026-09-29T14:02:40+08:00") },
      { id: "a", name: "波立维", createdAt: at("2026-09-29T14:02:10+08:00") },
    ]);
    expect(sameMinute.get("a")).toBe("波立维 · 第 1 个");
    expect(sameMinute.get("b")).toBe("波立维 · 第 2 个");
  });

  it("gives every project of a list a different label, whatever order the list is read in", () => {
    const projects = [
      { id: "a", name: "波立维", createdAt: at("2026-09-29T14:02:00+08:00") },
      { id: "b", name: "波立维", createdAt: at("2026-09-29T14:02:00+08:00") },
      { id: "c", name: "波立维" },
      { id: "d", name: "我的研究" },
    ];
    const forward = projectLabels(projects);
    const backward = projectLabels([...projects].reverse());
    expect(new Set(forward.values()).size).toBe(projects.length);
    for (const project of projects) expect(backward.get(project.id)).toBe(forward.get(project.id));
  });
});

it("reserves the distinguishing project tail independently of prefix clipping", async () => {
  const { projectLabelParts } = await import("./projectNames");
  const name = "同一系列的临床研究共享前缀共享前缀 · 第 2 个";
  const parts = projectLabelParts(name);
  expect(parts.prefix + parts.tail).toBe(name);
  expect(parts.tail.endsWith("第 2 个")).toBe(true);
  expect(projectLabelParts("短项目名")).toEqual({ prefix: "短项目名", tail: "" });
});
