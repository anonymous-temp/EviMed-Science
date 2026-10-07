import { describe, expect, it } from "vitest";
import { projectLabels } from "./projectNames";

const at = (iso: string) => new Date(iso).toISOString();

describe("projectLabels", () => {
  it("leaves a name that is alone as it is", () => {
    const labels = projectLabels([
      { id: "default", name: "我的研究", createdAt: at("2026-09-01T08:00:00") },
      { id: "p-1", name: "波立维", createdAt: at("2026-09-29T09:00:00") },
    ]);
    expect(labels.get("default")).toBe("我的研究");
    expect(labels.get("p-1")).toBe("波立维");
  });

  it("tells two projects of one name apart by the day they were made", () => {
    const year = new Date().getFullYear();
    const labels = projectLabels([
      { id: "a", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2).toISOString() },
      { id: "b", name: "波立维", createdAt: new Date(year, 9, 1, 9, 30).toISOString() },
    ]);
    expect(labels.get("a")).toBe("波立维 · 9月29日");
    expect(labels.get("b")).toBe("波立维 · 10月1日");
  });

  it("adds the time when two were made the same day, and only to those two", () => {
    const year = new Date().getFullYear();
    const labels = projectLabels([
      { id: "a", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2).toISOString() },
      { id: "b", name: "波立维", createdAt: new Date(year, 8, 29, 16, 40).toISOString() },
      { id: "c", name: "波立维", createdAt: new Date(year, 9, 2, 9, 0).toISOString() },
    ]);
    expect(labels.get("a")).toBe("波立维 · 9月29日 14:02");
    expect(labels.get("b")).toBe("波立维 · 9月29日 16:40");
    expect(labels.get("c")).toBe("波立维 · 10月2日");
  });

  it("counts them in the order they were made when there is no day, or the minute is the same", () => {
    const year = new Date().getFullYear();
    const none = projectLabels([
      { id: "z", name: "波立维" },
      { id: "m", name: "波立维", createdAt: null },
    ]);
    expect(none.get("m")).toBe("波立维 · 第 1 个");
    expect(none.get("z")).toBe("波立维 · 第 2 个");
    const sameMinute = projectLabels([
      { id: "b", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2, 40).toISOString() },
      { id: "a", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2, 10).toISOString() },
    ]);
    expect(sameMinute.get("a")).toBe("波立维 · 第 1 个");
    expect(sameMinute.get("b")).toBe("波立维 · 第 2 个");
  });

  it("gives every project of a list a different label, whatever order the list is read in", () => {
    const year = new Date().getFullYear();
    const projects = [
      { id: "a", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2).toISOString() },
      { id: "b", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2).toISOString() },
      { id: "c", name: "波立维" },
      { id: "d", name: "我的研究" },
    ];
    const forward = projectLabels(projects);
    const backward = projectLabels([...projects].reverse());
    expect(new Set(forward.values()).size).toBe(projects.length);
    for (const project of projects) expect(backward.get(project.id)).toBe(forward.get(project.id));
  });
});
