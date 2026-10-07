import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import type { EvidenceCard, EvidenceZone } from "@/lib/evidenceZoneClient";
import { FollowedEvidenceZones } from "./FollowedEvidenceZones";

const zone = (index: number) => ({ id: `zone${index}`, title: `专区 ${index}`, evidenceCount: index }) as unknown as EvidenceZone;
const card = (index: number) => ({ id: `card${index}`, zoneId: "zone0", title: `证据 ${index}` }) as unknown as EvidenceCard;

it("keeps followed evidence preview to three zones and three latest cards with full directory access", () => {
  render(<MemoryRouter><FollowedEvidenceZones zones={Array.from({ length: 20 }, (_, index) => zone(index))} cards={Array.from({ length: 20 }, (_, index) => card(index))} /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "最近证据更新" })).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /^专区 / })).toHaveLength(3);
  expect(screen.getAllByRole("link", { name: /^证据 / })).toHaveLength(3);
  expect(screen.getByRole("link", { name: "查看全部关注专区" })).toHaveAttribute("href", "/app/frontier/zones?scope=following");
  expect(screen.queryByRole("button", { name: "加载更多专区" })).not.toBeInTheDocument();
});

it("says each zone's evidence count where the server gave one, and no heading for cards that are not there", () => {
  render(<MemoryRouter><FollowedEvidenceZones zones={[zone(2), { ...zone(3), evidenceCount: null }]} cards={[]} /></MemoryRouter>);
  expect(screen.getByText("2 条证据")).toBeInTheDocument();
  expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "最近证据更新" })).not.toBeInTheDocument();
});
