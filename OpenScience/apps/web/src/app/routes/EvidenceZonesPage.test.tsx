import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceZonesPage } from "./EvidenceZonesPage";
import { expectComposed } from "@/test/expectComposed";
const client = vi.hoisted(() => ({ listEvidenceZones: vi.fn(), followEvidenceZone: vi.fn() }));
const features = vi.hoisted(() => ({ fetchEvidenceFeatures: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()), ...features }));
const zone = { id: "zone-one", revision: 1, title: "急诊医学", description: "急诊证据", evidenceCount: 3, following: false, canFollow: true };
function Where() { const location = useLocation(); return <pre data-testid="where">{location.pathname + location.search}</pre>; }
const mount = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/app/frontier/zones" element={<EvidenceZonesPage />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);
beforeEach(() => {
  vi.clearAllMocks();
  features.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
  client.listEvidenceZones.mockResolvedValue({ items: [zone], nextCursor: null, canCreate: true });
});

describe("the directory's old address", () => {
  it.each([
    ["/app/frontier/zones", "/app/frontier?view=zones"],
    ["/app/frontier/zones?scope=following", "/app/frontier?view=zones&scope=following"],
    ["/app/frontier/zones?scope=owned", "/app/frontier?view=zones&scope=owned"],
    ["/app/frontier/zones?scope=nonsense", "/app/frontier?view=zones"],
    [`/app/frontier/zones?request=${encodeURIComponent("乳腺癌")}`, `/app/frontier?view=zones&request=${encodeURIComponent("乳腺癌")}`],
  ])("hands %s over to the feed page's 证据专区 view", async (from, to) => {
    mount(from);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(to));
    expect(client.listEvidenceZones).not.toHaveBeenCalled();
  });
});

describe("the chooser of a zone for a feed item", () => {
  it("stays a page of its own: its title, the reader's own zones only, no scope to choose and no 申请选题", async () => {
    const { container } = mount("/app/frontier/zones?fromItem=item-1");
    expect(await screen.findByRole("link", { name: "急诊医学" })).toHaveAttribute("href", "/app/frontier/zones/zone-one?fromItem=item-1");
    expect(screen.getByRole("heading", { level: 1, name: "选择证据专区" })).toBeInTheDocument();
    expect(client.listEvidenceZones).toHaveBeenCalledWith("", null, "owned");
    expect(screen.queryByRole("group", { name: "专区范围" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "申请选题" })).not.toBeInTheDocument();
    const facts = expectComposed(container, { tablists: 0, stepRail: false, toolbar: true });
    expect(within(facts.toolbars[0]).getByRole("searchbox", { name: "搜索" })).toBeInTheDocument();
    // 新建专区 is in the header's menu, with nothing else beside it.
    expect(within(container.querySelector("[data-page-header]") as HTMLElement).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["更多操作"]);
  });
});
