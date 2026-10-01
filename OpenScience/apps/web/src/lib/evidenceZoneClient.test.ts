import { WebApiError } from "./apiClient";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evidenceErrorMessage,
  prepareEvidenceResearch,
  listZoneEvidence,
  saveEvidenceCard,
  saveEvidenceMaintenance,
  refreshEvidenceZone,
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
});
