import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZone, fetchZoneDirectory, forgetZoneCreateAllowed, moduleHasContent, NotTopicZoneError, parseZoneOverview, zoneCreateAllowed } from "./evidenceTopicClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

const rawZone = (over: Record<string, unknown> = {}) => ({ id: "z1", title: "GLP-1 受体激动剂减重", counts: { week: 3, month: 9, all: 20 }, revision: 2, ...over });

describe("a deployment that does not serve the topic directory", () => {
  beforeEach(() => { request.mockReset(); forgetZoneCreateAllowed(); });

  it("answers the old service's list with a directory that lists nothing and offers nothing to make", async () => {
    request.mockResolvedValue({ items: [], total: 0, nextCursor: null, canCreate: true });
    const directory = await fetchZoneDirectory("recommended");
    expect(directory).toMatchObject({ view: "recommended", groups: [], zones: [], total: 0, canCreate: false, userZones: { count: 0, max: 0 } });
    expect(zoneCreateAllowed()).toBe(false);
  });

  it("keeps the view the reader asked for, and says no whatever the old list claimed about creating", async () => {
    request.mockResolvedValue({ items: [rawZone()], total: 1, canCreate: true });
    expect((await fetchZoneDirectory("community")).view).toBe("community");
    expect((await fetchZoneDirectory("mine")).zones).toEqual([]);
  });

  it("remembers what a served directory said about making a zone, in both directions, for the pages that are not the directory", async () => {
    expect(zoneCreateAllowed()).toBeNull();
    request.mockResolvedValue({ view: "recommended", groups: [], zones: [], total: 0, canCreate: false, userZones: { count: 0, max: 30 } });
    expect((await fetchZoneDirectory("recommended")).canCreate).toBe(false);
    expect(zoneCreateAllowed()).toBe(false);
    request.mockResolvedValue({ view: "mine", groups: [], zones: [rawZone()], total: 1, canCreate: true, userZones: { count: 1, max: 30 } });
    expect((await fetchZoneDirectory("mine")).canCreate).toBe(true);
    expect(zoneCreateAllowed()).toBe(true);
  });
});

describe("a zone read by its address", () => {
  beforeEach(() => request.mockReset());

  it("is a topic zone when the server sends its counts", async () => {
    request.mockResolvedValue({ zone: rawZone({ lifecycle: "archived", successors: [{ id: "z2", slug: "s2", title: "继任" }], lastItemAt: "2026-05-03T08:00:00.000Z" }) });
    expect(await fetchZone("z1")).toMatchObject({ id: "z1", lifecycle: "archived", successors: [{ id: "z2", slug: "s2", title: "继任" }], lastItemAt: "2026-05-03T08:00:00.000Z" });
  });

  it("keeps the time the counts were taken apart from the last edit, and has none to give while they are stale", async () => {
    request.mockResolvedValue({ zone: rawZone({ updatedAt: "2026-10-20T01:00:00.000Z", countsAt: "2026-10-29T06:20:00.000Z" }) });
    expect(await fetchZone("z1")).toMatchObject({ updatedAt: "2026-10-20T01:00:00.000Z", countsAt: "2026-10-29T06:20:00.000Z" });
    request.mockResolvedValue({ zone: rawZone({ updatedAt: "2026-10-20T01:00:00.000Z" }) });
    expect(await fetchZone("z1")).toMatchObject({ updatedAt: "2026-10-20T01:00:00.000Z", countsAt: null });
  });

  it("is not one when the server answers in the old service's shape — a state and a count of cards, no counts of items", async () => {
    request.mockResolvedValue({ zone: { id: "ez_result", title: "我的研究结果", state: "published", kind: "user", evidenceCount: 1, canEdit: true, revision: 2 }, feedback: [] });
    await expect(fetchZone("ez_result")).rejects.toBeInstanceOf(NotTopicZoneError);
  });

  it("is malformed when it has no id", async () => {
    request.mockResolvedValue({ zone: { title: "x" } });
    await expect(fetchZone("z1")).rejects.toMatchObject({ status: 502 });
  });
});

describe("the content of a module", () => {
  it("is what the module draws: a sentence, cards, rows, events or items — and nothing for a module the server sent empty", () => {
    const modules = parseZoneOverview({ modules: [
      { key: "progress", progress: { text: "有新进展", refs: [], at: "2026-10-29T06:00:00.000Z" } },
      { key: "cards", cards: [], total: 0 }, { key: "approved-drugs", rows: [{ label: "司美格鲁肽", key: null, approval: null, study: null, count30: 1 }] },
      { key: "multi-source", events: [] }, { key: "latest", items: [], more: null },
    ] }).modules;
    expect(modules.map((module) => [module.key, moduleHasContent(module)])).toEqual([
      ["progress", true], ["cards", false], ["approved-drugs", true], ["multi-source", false], ["latest", false],
    ]);
  });
});
