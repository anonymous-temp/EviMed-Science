import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { FollowedEvidenceZones } from "./FollowedEvidenceZones";
const client = vi.hoisted(() => ({ listEvidenceZones: vi.fn(), listFollowedEvidence: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
it("keeps followed evidence preview to three zones and three latest cards with full directory access", async () => {
  client.listEvidenceZones.mockResolvedValue({ items: Array.from({ length: 20 }, (_, i) => ({ id: `zone${i}`, title: `专区 ${i}`, evidenceCount: i })), nextCursor: "more" });
  client.listFollowedEvidence.mockResolvedValue({ items: Array.from({ length: 20 }, (_, i) => ({ id: `card${i}`, zoneId: "zone0", title: `证据 ${i}` })), nextCursor: "more" });
  render(<MemoryRouter><FollowedEvidenceZones /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "最近证据更新" })).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /^专区 / })).toHaveLength(3); expect(screen.getAllByRole("link", { name: /^证据 / })).toHaveLength(3);
  expect(screen.getByRole("link", { name: "查看全部关注专区" })).toHaveAttribute("href", "/app/frontier/zones?scope=following"); expect(screen.queryByRole("button", { name: "加载更多专区" })).not.toBeInTheDocument();
});
