import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZoneDirectory, followZoneSummary, parseZoneSummary } from "./evidenceTopicClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

const rawZone = (over: Record<string, unknown> = {}) => ({ id: "z1", title: "GLP-1 受体激动剂减重", counts: { week: 3, month: 9, all: 20 }, ...over });

describe("a zone as the directory lists it", () => {
  beforeEach(() => request.mockReset());

  it("keeps the revision, the ownership flag and the follower count where the server sends them, and has none where it does not", () => {
    expect(parseZoneSummary(rawZone({ revision: 4, owned: true, followers: 12 }))).toMatchObject({ id: "z1", revision: 4, owned: true, followers: 12 });
    const bare = parseZoneSummary(rawZone())!;
    expect("revision" in bare).toBe(false);
    expect("owned" in bare).toBe(false);
    expect("followers" in bare).toBe(false);
    expect(parseZoneSummary(rawZone({ revision: "4", owned: "yes" }))).not.toHaveProperty("revision");
  });

  it("asks for a view with its specialty and search, and reads the whole of the answer", async () => {
    request.mockResolvedValue({ view: "mine", zones: [rawZone()], total: 1, canCreate: true, userZones: { count: 1, max: 30 } });
    const directory = await fetchZoneDirectory("mine", { specialty: "oncology", q: "ADC" });
    expect(request).toHaveBeenCalledWith("/frontier/zones?view=mine&specialty=oncology&q=ADC");
    expect(directory).toMatchObject({ view: "mine", total: 1, canCreate: true, userZones: { count: 1, max: 30 } });
    expect(directory.zones.map((zone) => zone.title)).toEqual(["GLP-1 受体激动剂减重"]);
  });
});

describe("following a zone from a list", () => {
  beforeEach(() => request.mockReset());

  it("uses the revision the row carries, with no read of the zone first", async () => {
    request.mockResolvedValue({ zone: rawZone({ following: true, revision: 6 }) });
    const zone = await followZoneSummary({ id: "z1", revision: 5 }, true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/frontier/zones/z1/follow", "POST", { expectedRevision: 5 });
    expect(zone).toMatchObject({ following: true, revision: 6 });
  });

  it("reads the zone for its revision where the row has none, and unfollows with DELETE", async () => {
    request.mockResolvedValueOnce({ zone: rawZone({ following: true, revision: 9 }) }).mockResolvedValueOnce({ zone: rawZone({ following: false, revision: 10 }) });
    const zone = await followZoneSummary({ id: "z1" }, false);
    expect(request).toHaveBeenNthCalledWith(1, "/frontier/zones/z1");
    expect(request).toHaveBeenNthCalledWith(2, "/frontier/zones/z1/follow", "DELETE", { expectedRevision: 9 });
    expect(zone.following).toBe(false);
  });
});
