import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { card, zone } from "@/components/frontier/__fixtures__/evidenceCards";
import { EvidenceReadingPage } from "./EvidenceReadingPage";

const client = vi.hoisted(() => ({ fetchEvidenceZone: vi.fn(), fetchZoneEvidence: vi.fn(), fetchEvidenceCardLinks: vi.fn() }));
const upkeep = vi.hoisted(() => ({ fetchEvidenceFeatures: vi.fn(), listMyEvidenceChallenges: vi.fn(), fetchEvidenceChanges: vi.fn(), submitEvidenceChallenge: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()), ...upkeep }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: async () => {} }) } }));

const mount = () => render(
  <MemoryRouter initialEntries={[`/app/frontier/zones/ez_1/evidence/${card.id}`]}>
    <Routes><Route path="/app/frontier/zones/:zoneId/evidence/:cardId" element={<EvidenceReadingPage />} /></Routes>
  </MemoryRouter>,
);
beforeEach(() => {
  vi.clearAllMocks();
  client.fetchEvidenceZone.mockResolvedValue(zone);
  client.fetchZoneEvidence.mockResolvedValue(card);
  client.fetchEvidenceCardLinks.mockResolvedValue({ author: { id: "alice", name: "李研究" }, origin: null, previous: null, related: [] });
  upkeep.listMyEvidenceChallenges.mockResolvedValue([]);
  upkeep.fetchEvidenceChanges.mockResolvedValue({
    items: [{ id: "7", zoneId: "ez_1", cardId: card.id, cardTitle: card.title, revisionBefore: 1, revisionAfter: 2, category: "correction", categoryLabel: "更正", trigger: "challenge", triggerLabel: "读者质疑", summary: "读者对结论 CLM-002 提出质疑。", occurredAt: "2026-10-05T00:00:00Z" }],
    nextBefore: null,
  });
});

describe("a card's page where the deployment keeps evidence current", () => {
  it("offers 质疑 on each claim, files it for that claim, and shows the card's own change log", async () => {
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: true });
    upkeep.submitEvidenceChallenge.mockResolvedValue({ id: "ch_1", cardId: card.id, claimId: "CLM-002", state: "open", route: "producer_notice", outcome: null, outcomeLabel: null, reason: "原文里没有这句话", createdAt: "2026-10-06T00:00:00Z", resolvedAt: null, explanation: null, changeLogId: null });
    mount();
    const challenge = await screen.findByRole("button", { name: "质疑结论 CLM-002" });
    expect(screen.getByRole("button", { name: "质疑结论 CLM-001" })).toBeInTheDocument();
    await userEvent.click(challenge);
    await userEvent.type(screen.getByRole("textbox", { name: /说明你认为哪里不对/ }), "原文里没有这句话");
    await userEvent.click(screen.getByRole("button", { name: "提交质疑" }));
    expect(upkeep.submitEvidenceChallenge).toHaveBeenCalledWith(card.id, "CLM-002", "原文里没有这句话");
    expect(await screen.findByText("读者对结论 CLM-002 提出质疑。")).toBeInTheDocument();
    expect(upkeep.fetchEvidenceChanges).toHaveBeenCalledWith("ez_1", expect.objectContaining({ cardId: card.id }));
    expect(upkeep.listMyEvidenceChallenges).toHaveBeenCalledWith(card.id);
  });

  it("shows where the reader's earlier challenge on a claim stands", async () => {
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: true });
    upkeep.listMyEvidenceChallenges.mockResolvedValue([{ id: "ch_0", cardId: card.id, claimId: "CLM-002", state: "notified", route: "producer_notice", outcome: null, outcomeLabel: null, reason: "x", createdAt: "2026-10-04T00:00:00Z", resolvedAt: null, explanation: null, changeLogId: null }]);
    mount();
    expect(await screen.findByText(/已通知出品方/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "质疑结论 CLM-002" })).toBeNull();
    expect(screen.getByRole("button", { name: "质疑结论 CLM-001" })).toBeInTheDocument();
  });

  it("offers neither the challenge nor the change log where the deployment keeps none", async () => {
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(screen.queryByRole("button", { name: /质疑结论/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "这张卡的变更记录" })).toBeNull();
    expect(upkeep.listMyEvidenceChallenges).not.toHaveBeenCalled();
    expect(upkeep.fetchEvidenceChanges).not.toHaveBeenCalled();
  });

  it("does not offer them on a draft, which has nothing to challenge yet", async () => {
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: true });
    client.fetchZoneEvidence.mockResolvedValue({ ...card, state: "draft", canEdit: true });
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(screen.queryByRole("button", { name: /质疑结论/ })).toBeNull();
    expect(upkeep.fetchEvidenceChanges).not.toHaveBeenCalled();
  });
});
