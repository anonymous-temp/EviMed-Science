import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zone } from "@/components/frontier/__fixtures__/evidenceCards";
import { EvidenceZonePage } from "./EvidenceZonePage";

const client = vi.hoisted(() => ({ fetchEvidenceZoneDetail: vi.fn(), listZoneEvidence: vi.fn() }));
const upkeep = vi.hoisted(() => ({ fetchEvidenceFeatures: vi.fn(), fetchEvidenceChanges: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()), ...upkeep }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), fetchFrontierItem: vi.fn() }));

const mount = () => render(
  <MemoryRouter initialEntries={["/app/frontier/zones/ez_1"]}>
    <Routes><Route path="/app/frontier/zones/:zoneId" element={<EvidenceZonePage />} /></Routes>
  </MemoryRouter>,
);
const open = { ...zone, visibility: "internet" as const, canEdit: false };
beforeEach(() => {
  vi.clearAllMocks();
  client.listZoneEvidence.mockResolvedValue({ items: [], total: 0, nextCursor: null });
  upkeep.fetchEvidenceChanges.mockResolvedValue({ items: [], nextBefore: null });
});

describe("a zone's page and the features the server says it has", () => {
  it("links the public page of a published zone opened to the internet, when the server reports public pages", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    mount();
    const link = await screen.findByRole("link", { name: "公开页" });
    expect(link).toHaveAttribute("href", "/evidence/z/ez_1");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows no 公开页 link for a zone that is platform-only, a draft, or on a deployment without public pages", async () => {
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...open, visibility: "platform" }, feedback: [] });
    const platformOnly = mount();
    await screen.findByRole("heading", { name: "卒中研究" });
    expect(screen.queryByRole("link", { name: "公开页" })).toBeNull();
    platformOnly.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...open, state: "draft" }, feedback: [] });
    const draft = mount();
    await screen.findByRole("heading", { name: "卒中研究" });
    expect(screen.queryByRole("link", { name: "公开页" })).toBeNull();
    draft.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: false });
    mount();
    await screen.findByRole("heading", { name: "卒中研究" });
    expect(screen.queryByRole("link", { name: "公开页" })).toBeNull();
  });

  it("places the change log behind the upkeep flag, and reads it only when the reader opens it", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: true });
    mount();
    const summary = await screen.findByText("变更记录");
    expect(upkeep.fetchEvidenceChanges).not.toHaveBeenCalled();
    await userEvent.click(summary);
    expect(await screen.findByText("还没有变更记录")).toBeInTheDocument();
    expect(upkeep.fetchEvidenceChanges).toHaveBeenCalledWith("ez_1", expect.objectContaining({ limit: 20 }));
  });

  it("offers no change log where the deployment keeps none", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    mount();
    await screen.findByRole("link", { name: "公开页" });
    expect(screen.queryByText("变更记录")).toBeNull();
  });
});
