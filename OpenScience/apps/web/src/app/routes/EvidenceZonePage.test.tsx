import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { card, zone } from "@/components/frontier/__fixtures__/evidenceCards";
import { EvidenceZonePage } from "./EvidenceZonePage";
import { expectComposed } from "@/test/expectComposed";

const client = vi.hoisted(() => ({ fetchEvidenceZoneDetail: vi.fn(), listZoneEvidence: vi.fn(), followEvidenceZone: vi.fn(), publishEvidenceZone: vi.fn(), prepareEvidenceResearch: vi.fn() }));
const upkeep = vi.hoisted(() => ({ fetchEvidenceFeatures: vi.fn(), fetchEvidenceChanges: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()), ...upkeep }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), fetchFrontierItem: vi.fn() }));
const capsule = vi.hoisted(() => ({ subscribeZone: vi.fn(), unsubscribeZone: vi.fn(), zoneSubscriptionStatus: vi.fn() }));
vi.mock("@/lib/capsuleShareClient", () => capsule);
// The deployment offers the project reference and the community column (`/api/me` features); the components ask before they call.
vi.mock("@/lib/meFeature", () => ({ useMeFeature: () => "on" }));
vi.mock("@/lib/projects", () => {
  const state = { currentId: "project-a", projects: [{ id: "project-a", name: "房颤研究" }] };
  return { useProjectStore: (select: (value: typeof state) => unknown) => select(state) };
});

const mount = (search = "") => render(
  <MemoryRouter initialEntries={[`/app/frontier/zones/ez_1${search}`]}>
    <Routes><Route path="/app/frontier/zones/:zoneId" element={<EvidenceZonePage />} /></Routes>
  </MemoryRouter>,
);
const open = { ...zone, visibility: "internet" as const, canEdit: false };
beforeEach(() => {
  vi.clearAllMocks();
  client.listZoneEvidence.mockResolvedValue({ items: [], total: 0, nextCursor: null });
  upkeep.fetchEvidenceChanges.mockResolvedValue({ items: [], nextBefore: null });
  upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: false });
  capsule.zoneSubscriptionStatus.mockResolvedValue({ subscribed: false, subscription: null });
});
/** A zone a reader may follow and ask, with evidence in it. */
const readable = { ...open, canFollow: true, canResearch: true, evidenceCount: 3, createdAt: "2026-09-20T12:00:00Z", creator: "李研究", description: "卒中的预防与治疗证据。" };

describe("a zone's page", () => {
  it("is titled by the zone, with one way back — 前沿动态 / 证据专区 — and no second link or heading for the same", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: readable, feedback: [] });
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "卒中研究" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "返回" });
    expect(within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["前沿动态", "/app/frontier"], ["证据专区", "/app/frontier?view=zones"]]);
    expect(screen.queryByRole("navigation", { name: "前沿动态" })).toBeNull();
    expect(screen.queryByRole("link", { name: "返回证据专区" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "卒中研究" })).toHaveLength(1);
  });

  it("goes back to the directory with the item it is choosing a zone for", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: readable, feedback: [] });
    mount("?fromItem=item-1");
    await screen.findByRole("heading", { level: 1, name: "卒中研究" });
    expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "证据专区" })).toHaveAttribute("href", "/app/frontier/zones?fromItem=item-1");
  });

  it("puts 关注 and the one primary 问这个专区 in the header, and the project reference under the description as a different thing", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: readable, feedback: [] });
    mount();
    const header = (await screen.findByRole("heading", { level: 1 })).closest("header")!;
    expect(within(header).getByRole("button", { name: "关注" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "问这个专区" })).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: /编辑专区|发布专区|撤回专区/ })).toBeNull();
    expect(screen.getByText("卒中的预防与治疗证据。")).toBeInTheDocument();
    // 关注 is the account's, 用作当前项目的参考 is one project's: different words, and the second is not in the header.
    const reference = await screen.findByRole("button", { name: "用作当前项目的参考" });
    expect(header).not.toContainElement(reference);
    expect(screen.queryByRole("button", { name: "订阅到当前项目" })).toBeNull();
  });

  it("follows and unfollows from the header through the server's answer, and asks the zone in the chat", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: readable, feedback: [] });
    client.followEvidenceZone.mockResolvedValue({ ...readable, following: true });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "关注" }));
    expect(await screen.findByRole("button", { name: "取消关注" })).toBeInTheDocument();
    client.prepareEvidenceResearch.mockResolvedValue({ draft: "请基于专区" });
    await userEvent.click(screen.getByRole("button", { name: "问这个专区" }));
    await waitFor(() => expect(client.prepareEvidenceResearch).toHaveBeenCalledWith(expect.objectContaining({ id: "ez_1" })));
  });

  it("tells a published zone by what it holds — a creator and the day, never 「已发布」 or a clock — and a draft by 「草稿」", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: readable, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [card], total: 3, nextCursor: null });
    // Review L-7: the zone header said 「2026/9/20」 where every other page writes 「9月20日」.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
    const published = mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("李研究 · 9月20日")).toBeInTheDocument();
    expect(screen.queryByText(/已发布/)).toBeNull();
    published.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...readable, state: "draft", canEdit: true }, feedback: [] });
    mount();
    expect(await screen.findByText("草稿 · 李研究 · 9月20日")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("puts an owner's edit and publish in a menu, and publishes through it", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...readable, canEdit: true }, feedback: [] });
    client.publishEvidenceZone.mockResolvedValue({ ...readable, canEdit: true, state: "draft" });
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "编辑专区" })).toBeNull();
    expect(screen.queryByRole("button", { name: "撤回专区" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "编辑专区" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "撤回专区" }));
    await waitFor(() => expect(client.publishEvidenceZone).toHaveBeenCalledWith(expect.objectContaining({ id: "ez_1" }), "draft"));
  });

  it("counts the evidence once — 「3 条证据」 — and the matches and the published only while a search or a draft makes them differ", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: readable, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [card], total: 3, nextCursor: null });
    const reader = mount();
    expect(await screen.findByText("3 条证据")).toBeInTheDocument();
    expect(screen.queryByText(/匹配|已发布/)).toBeNull();
    client.listZoneEvidence.mockResolvedValue({ items: [card], total: 1, nextCursor: null });
    // The same live search as the zone list: typing is searching, there is no 「搜索」 button, and the count comes after the box.
    expect(screen.queryByRole("button", { name: "搜索" })).toBeNull();
    const box = screen.getByRole("searchbox", { name: "搜索当前专区证据" });
    await userEvent.type(box, "卒中");
    expect(await screen.findByText("1 条匹配证据")).toBeInTheDocument();
    expect(client.listZoneEvidence).toHaveBeenLastCalledWith("ez_1", "卒中", null, undefined);
    expect(box.compareDocumentPosition(screen.getByText("1 条匹配证据")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    reader.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...readable, canEdit: true }, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [card], total: 4, nextCursor: null });
    mount();
    expect(await screen.findByText("3 条已发布，含草稿共 4 条")).toBeInTheDocument();
  });

  it("shows each card as its question, a two-line summary and one line of 性质 · 引文已核对 — not who wrote it, whether an AI reviewed it, nor when it was checked", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: readable, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [{ ...card, summary: "能，但出血增多。", content: { question: "试验药能预防卒中吗？", answer: "这张卡汇总了 1 条引文已逐字核对的结论；其中没有达到“发现”标准的结论，请逐条阅读下面的限定。" }, editorial: { author: { kind: "ai", name: "EviMed 证据 AI", model: "deepseek-v4-flash" }, reviewer: { kind: "ai", name: "核对 AI" }, status: "ai-reviewed", reviewRevision: card.revision, sourceCheckedAt: "2026-10-04T12:00:00Z" } }], total: 1, nextCursor: null });
    mount();
    const link = await screen.findByRole("link", { name: "试验药能预防卒中吗？" });
    expect(link).toHaveAttribute("href", "/app/frontier/zones/ez_1/evidence/ec_0123456789abcdef");
    const row = link.closest("li")!;
    expect(within(row).getByText("能，但出血增多。")).toHaveClass("line-clamp-2");
    // The row says the card's own line — never the neutral answer every card without a headline shares (R19, audit D C3).
    expect(row).not.toHaveTextContent("这张卡汇总了");
    expect(row).toHaveTextContent("解读 · 综合 · 引文已核对 1/2");
    expect(row).not.toHaveTextContent(/AI 编写|EviMed 证据 AI|来源核查|评议者|学术证据|deepseek|AI 已评议|AI 待评议/);
  });

  it("marks a draft card in the owner's list, and never says whether an AI reviewed it", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...readable, canEdit: true }, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [{ ...card, state: "draft", editorial: { author: { kind: "ai", name: "写作 AI" }, reviewer: null, status: "review-pending", reviewRevision: null } }], total: 1, nextCursor: null });
    mount();
    const row = (await screen.findByRole("link", { name: card.title })).closest("li")!;
    expect(row).toHaveTextContent("草稿 · 解读 · 综合 · 引文已核对 1/2");
    expect(row).not.toHaveTextContent(/AI 待评议|AI 已评议/);
  });

  it("is headed by the way back to 前沿动态 — no row of the feed's views", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    mount();
    await screen.findByRole("heading", { name: "卒中研究" });
    expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier");
    expect(screen.queryByRole("navigation", { name: "前沿动态" })).toBeNull();
  });
});

describe("a zone with no evidence yet", () => {
  const empty = { ...readable, evidenceCount: 0, kind: "official" as const };
  it("says one sentence and how to be told — no counts, no search, no 问这个专区 — and keeps 关注", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: empty, feedback: [] });
    mount();
    expect(await screen.findByText("这个专区还没有证据。关注后，有新证据会出现在“前沿动态”的“关注”里。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关注" })).toBeInTheDocument();
    expect(screen.getByText("卒中的预防与治疗证据。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "问这个专区" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "搜索当前专区证据" })).toBeNull();
    expect(screen.queryByText(/条匹配证据|条已发布证据|条证据|专区暂无证据/)).toBeNull();
    expect(screen.queryByRole("button", { name: /用作当前项目的参考/ })).toBeNull();
  });
  it("speaks to a reader who already follows it, and to one who cannot", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...empty, following: true }, feedback: [] });
    const following = mount();
    expect(await screen.findByText("这个专区还没有证据。有新证据时，会出现在“前沿动态”的“关注”里。")).toBeInTheDocument();
    following.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...empty, canFollow: false }, feedback: [] });
    mount();
    expect(await screen.findByText("这个专区还没有证据。")).toBeInTheDocument();
  });
  it("offers the request of a topic only for an official zone where the public pages are on, and carries the zone's name to the request", async () => {
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: empty, feedback: [] });
    const official = mount();
    const link = await screen.findByRole("link", { name: /申请这个主题的选题/ });
    expect(link).toHaveAttribute("href", `/app/frontier?view=zones&request=${encodeURIComponent("卒中研究")}`);
    official.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...empty, kind: "user" }, feedback: [] });
    mount();
    await screen.findByText(/这个专区还没有证据/);
    expect(screen.queryByRole("link", { name: /申请这个主题的选题/ })).toBeNull();
  });
  it("is not drawn for the owner, who still has to add the first card, nor for a draft zone, nor while a search finds nothing", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...empty, canEdit: true }, feedback: [] });
    const owner = mount();
    expect(await screen.findByRole("button", { name: "添加证据" })).toBeInTheDocument();
    expect(screen.queryByText(/关注后，有新证据会出现/)).toBeNull();
    owner.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...empty, state: "draft" }, feedback: [] });
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/关注后，有新证据会出现/)).toBeNull();
  });
});

describe("a zone's page and the features the server says it has", () => {
  it("links the public page of a published zone opened to the internet, when the server reports public pages", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    // It is an entry of the header's menu, and opens in a new window without handing it this one.
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "公开页" }));
    expect(opened).toHaveBeenCalledWith("/evidence/z/ez_1", "_blank", "noopener,noreferrer");
    opened.mockRestore();
  });

  it("links the public page under the base the server says the pages are served at", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, publicBasePath: "/evimed-evidence", upkeep: false });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "公开页" }));
    expect(opened).toHaveBeenCalledWith("/evimed-evidence/z/ez_1", "_blank", "noopener,noreferrer");
    opened.mockRestore();
  });

  it("shows no 公开页 for a zone that is platform-only, a draft, or on a deployment without public pages", async () => {
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...open, visibility: "platform" }, feedback: [] });
    const platformOnly = mount();
    await screen.findByRole("heading", { name: "卒中研究" });
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    platformOnly.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...open, state: "draft" }, feedback: [] });
    const draft = mount();
    await screen.findByRole("heading", { name: "卒中研究" });
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    draft.unmount();
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: false });
    mount();
    await screen.findByRole("heading", { name: "卒中研究" });
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it("places the change log behind the upkeep flag, in the header's menu, and reads it only when the reader opens it", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [card], total: 1, nextCursor: null });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: true });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(upkeep.fetchEvidenceChanges).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitem", { name: "变更记录" }));
    const drawer = await screen.findByRole("dialog", { name: "变更记录" });
    expect(await within(drawer).findByText("还没有变更记录")).toBeInTheDocument();
    expect(upkeep.fetchEvidenceChanges).toHaveBeenCalledWith("ez_1", expect.objectContaining({ limit: 20 }));
  });

  it("offers no change log where the deployment keeps none", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: open, feedback: [] });
    upkeep.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: "变更记录" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "公开页" })).toBeInTheDocument();
  });

  it("keeps a zone's background and experts, and a suggestion to its owner, in the menu's drawers — not as folds on the page", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...open, canFeedback: true, background: "卒中的背景。", experts: [{ name: "王医生", institution: "某医院" }] }, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [card], total: 1, nextCursor: null });
    const { container } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(container.querySelector("details")).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "领域背景与专家" }));
    const background = await screen.findByRole("dialog", { name: "领域背景与专家" });
    expect(within(background).getByText("卒中的背景。")).toBeInTheDocument();
    expect(within(background).getByText("王医生 · 某医院")).toBeInTheDocument();
    await userEvent.click(within(background).getByRole("button", { name: "关闭" }));
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "给专区提建议" }));
    expect(await screen.findByRole("dialog", { name: "给专区提建议" })).toContainElement(screen.getByLabelText("专区建议"));
  });
});

describe("the zone page's composition", () => {
  it("has its header, then the toolbar with the search and the count after it, then the list — and nothing of the zone's menu on the page", async () => {
    client.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...readable, canEdit: true }, feedback: [] });
    client.listZoneEvidence.mockResolvedValue({ items: [card], total: 3, nextCursor: null });
    const { container } = mount();
    await screen.findByRole("searchbox", { name: "搜索当前专区证据" });
    const facts = expectComposed(container, { tablists: 0, stepRail: false, toolbar: true });
    expect(facts.toolbars).toHaveLength(1);
    expect(facts.chrome).toContainElement(facts.toolbars[0]);
    // The owner's way to add to the list is the toolbar's, not a button above it.
    expect(within(facts.toolbars[0]).getByRole("button", { name: "添加证据" })).toBeInTheDocument();
    // What was a fold on the page — 领域背景与专家, 变更记录, 给专区提建议 — is the menu's, and is not on it.
    expect(screen.queryByText("领域背景与专家")).toBeNull();
    expect(screen.queryByText("变更记录")).toBeNull();
    expect(screen.queryByText("给专区提建议")).toBeNull();
  });
});
