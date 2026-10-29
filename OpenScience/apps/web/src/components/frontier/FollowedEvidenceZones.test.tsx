import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { topicZone } from "./__fixtures__/zoneDirectory";
import { FollowedEvidenceZones } from "./FollowedEvidenceZones";

const zone = (index: number) => topicZone({ id: `zone${index}`, title: `专区 ${index}`, counts: { week: index, month: index * 4, all: index * 9 } });
const card = (index: number) => ({ id: `card${index}`, zoneId: "zone0", title: `证据 ${index}` }) as unknown as EvidenceCard;

it("keeps the preview to five zones and three latest cards, with the way to all of them", () => {
  render(<MemoryRouter><FollowedEvidenceZones zones={Array.from({ length: 20 }, (_, index) => zone(index))} cards={Array.from({ length: 20 }, (_, index) => card(index))} /></MemoryRouter>);
  expect(screen.getByRole("region", { name: "我的专区与关注的专区" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "我的专区与关注的专区" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "最近证据更新" })).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /^专区 / })).toHaveLength(5);
  expect(screen.getAllByRole("link", { name: /^证据 / })).toHaveLength(3);
  expect(screen.getByRole("link", { name: "查看全部专区" })).toHaveAttribute("href", "/app/frontier?view=zones&scope=mine");
});

it("says each zone's week count, opens a zone by its slug where it has one, and has no heading for cards that are not there", () => {
  render(<MemoryRouter><FollowedEvidenceZones zones={[zone(2), topicZone({ id: "z3", title: "有别名的专区", slug: "alias", counts: { week: 0, month: 0, all: 5 } }), topicZone({ id: "z4", title: "沉寂的", lifecycle: "quiet" })]} cards={[]} /></MemoryRouter>);
  const list = screen.getByRole("list", { name: "我的专区与关注的专区" });
  expect(within(list).getByText("近 7 天 2 条")).toBeInTheDocument();
  expect(within(list).getByText("近 7 天 0 条")).toBeInTheDocument();
  expect(within(list).getByText("近期没有更新")).toBeInTheDocument();
  expect(within(list).getByRole("link", { name: "有别名的专区" })).toHaveAttribute("href", "/app/frontier/zones/s/alias");
  expect(screen.queryByRole("heading", { name: "最近证据更新" })).not.toBeInTheDocument();
});
