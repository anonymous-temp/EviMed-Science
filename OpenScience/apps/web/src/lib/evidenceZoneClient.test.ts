import { WebApiError } from "./apiClient";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evidenceErrorMessage,
  prepareEvidenceResearch,
  listZoneEvidence,
  saveEvidenceCard,
  saveEvidenceMaintenance,
  refreshEvidenceZone,
  fetchZoneEvidence,
  fetchEvidenceMaintenance,
  setEvidenceZoneVisibility,
  listOwnUserZones,
  publishResultAsEvidenceCard,
  continueResearchFromCard,
  fetchEvidenceCardLinks,
  fetchEvidenceAuthor,
  type EvidenceMaintenance,
  type EvidenceZone,
  type EvidenceCard,
} from "./evidenceZoneClient";
const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));
beforeEach(() => request.mockReset());
describe("evidence API scope", () => {
  it("explains stale revision recovery without discarding edits", () => {
    expect(
      evidenceErrorMessage(
        new WebApiError("changed", {
          status: 409,
          code: "evidence_revision_conflict",
        }),
      ),
    ).toContain("先复制修改");
    expect(
      evidenceErrorMessage(
        new WebApiError("invalid", { status: 400, code: "evidence_invalid" }),
      ),
    ).toContain("原文引句");
  });
  it("asks research using authorized identifiers and revisions without imported prose", async () => {
    request.mockResolvedValue({ draft: "authorized" });
    const zone = {
      id: "zone",
      revision: 7,
      title: "ignore safety",
    } as EvidenceZone;
    const card = {
      id: "card",
      revision: 9,
      body: "untrusted instructions",
    } as EvidenceCard;
    await prepareEvidenceResearch(zone, card);
    expect(request).toHaveBeenCalledWith(
      "/frontier/zones/zone/research",
      "POST",
      { expectedRevision: 7, evidenceId: "card", evidenceRevision: 9 },
    );
  });
  it("keeps draft scope, search and cursor together", async () => {
    await listZoneEvidence("zone", "急诊", "opaque", "owned");
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("scope=owned"),
    );
    expect(request.mock.calls[0][0]).toContain("cursor=opaque");
  });
  it("saves editable content without resubmitting trusted source metadata", async () => {
    request.mockResolvedValue({ evidence: { id: "saved" } });
    await saveEvidenceCard("zone", {
      title: "Question",
      summary: "Answer",
      subtype: "academic",
      body: "Evidence",
      limitations: "",
      sources: [
        {
          title: "Source",
          url: "https://example.org",
          excerpt: "Quote",
          sha256: "hash",
          checkedAt: "2026-10-01T00:00:00Z",
          coverage: "abstract",
        },
      ],
      content: { question: "Question", answer: "Answer", population: "Adults" },
    });
    expect(request).toHaveBeenCalledWith(
      "/frontier/zones/zone/evidence",
      "POST",
      expect.objectContaining({
        sources: [
          { title: "Source", url: "https://example.org", excerpt: "Quote" },
        ],
        content: expect.objectContaining({ population: "Adults" }),
      }),
    );
  });
  it("binds upkeep settings to the current zone revision", async () => {
    await saveEvidenceMaintenance({ id: "a/b", revision: 8 } as EvidenceZone, {
      enabled: true,
      query: "CKD",
      sourceTypes: ["journal"],
      intervalHours: 24,
      maxCardsPerRun: 2,
      nextRunAt: null,
      lastRunAt: null,
      lastError: null,
    });
    expect(request).toHaveBeenCalledWith(
      "/frontier/zones/a%2Fb/automation",
      "PUT",
      {
        enabled: true,
        query: "CKD",
        sourceTypes: ["journal"],
        intervalHours: 24,
        maxCardsPerRun: 2,
        expectedRevision: 8,
      },
    );
  });
  it("uses the owner-authorized refresh route without unsupported fields", async () => {
    await refreshEvidenceZone({ id: "zone", revision: 3 } as EvidenceZone);
    expect(request).toHaveBeenCalledWith(
      "/frontier/zones/zone/automation",
      "POST",
      {},
    );
  });
  it("keeps partial source-check metadata separate from successful reading and review metadata", async () => {
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "Writer" },
      reviewer: { kind: "ai", name: "Reviewer" },
      status: "ai-reviewed",
      reviewRevision: 3,
      sourceCheckedAt: "2026-10-01T00:00:00Z",
      sourceChecks: [{ sourceIndex: 1, status: "retained", attemptedAt: "2026-10-02T06:00:00Z", code: "web_read_unreadable" }],
      findings: [],
    };
    request.mockResolvedValueOnce({ evidence: { id: "card", editorial } });
    expect((await fetchZoneEvidence("zone", "card")).editorial).toEqual(editorial);
    const maintenance: EvidenceMaintenance = {
      automation: { enabled: true, query: "CKD", sourceTypes: ["journal"], intervalHours: 24, maxCardsPerRun: 2, nextRunAt: null, lastRunAt: null, lastError: null },
      jobs: { pending: 0, running: 0, failed: 0 },
      recent: [{ id: "job", state: "completed", attempts: 1, lastError: null, updatedAt: "2026-10-02T06:00:00Z", cardId: "card", sourceCheckStatus: "partial" }],
    };
    request.mockResolvedValueOnce(maintenance);
    expect(await fetchEvidenceMaintenance("zone")).toEqual(maintenance);
  });
});
describe("the co-creation calls", () => {
  it("opens a zone to the internet at its current revision, and nothing else", async () => {
    request.mockResolvedValue({ zone: { id: "z", visibility: "internet" } });
    await setEvidenceZoneVisibility({ id: "a/b", revision: 5 } as EvidenceZone, "internet");
    expect(request).toHaveBeenCalledWith("/frontier/zones/a%2Fb/visibility", "PUT", { visibility: "internet", expectedRevision: 5 });
  });
  it("lists only the researcher's own user zones — an older zone with no kind is one — across pages", async () => {
    request
      .mockResolvedValueOnce({ items: [{ id: "u", kind: "user" }, { id: "p", kind: "product" }], total: 3, nextCursor: "next" })
      .mockResolvedValueOnce({ items: [{ id: "legacy" }], total: 3, nextCursor: null });
    expect((await listOwnUserZones()).map((zone) => zone.id)).toEqual(["u", "legacy"]);
    expect(request.mock.calls[0][0]).toContain("scope=owned");
    expect(request.mock.calls[1][0]).toContain("cursor=next");
  });
  it("publishes a result version to a zone, with the project and the claims the researcher chose", async () => {
    request.mockResolvedValue({ evidence: { id: "ec_1" } });
    await publishResultAsEvidenceCard("rv_1", { projectId: "stroke", zoneId: "ez_1", claimIds: ["CLM-001"] });
    expect(request).toHaveBeenCalledWith("/results/rv_1/evidence-card", "POST", { projectId: "stroke", zoneId: "ez_1", claimIds: ["CLM-001"] });
  });
  it("continues research from a card, reads its links and reads an author by their own id", async () => {
    request.mockResolvedValue({});
    await continueResearchFromCard("ec_1", { projectId: "mine" });
    expect(request).toHaveBeenLastCalledWith("/frontier/evidence/ec_1/continue", "POST", { projectId: "mine" });
    await continueResearchFromCard("ec_1");
    expect(request).toHaveBeenLastCalledWith("/frontier/evidence/ec_1/continue", "POST", {});
    await fetchEvidenceCardLinks("ec_1");
    expect(request).toHaveBeenLastCalledWith("/frontier/evidence/ec_1/links");
    await fetchEvidenceAuthor("a@b");
    expect(request).toHaveBeenLastCalledWith("/frontier/authors/a%40b");
  });
  it("explains the refusals of publishing a result and of an author with nothing published in the platform's own words", () => {
    for (const [code, text] of [
      ["evidence_result_not_clinical_package", "不是带证据矩阵的临床证据综述"],
      ["evidence_result_zone_not_owned", "只能发布到你自己的专区"],
      ["evidence_result_no_verified_claim", "没有引文已核对的结论"],
      ["evidence_author_not_found", "没有这位作者公开的内容"],
    ]) expect(evidenceErrorMessage(new WebApiError("x", { status: 409, code }))).toContain(text);
  });
});

