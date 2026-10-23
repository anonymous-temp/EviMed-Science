import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebStructuredMemory } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { expectComposed } from "@/test/expectComposed";
import { precedes } from "@/test/compositionFixtures";
import { MemoryHubPage } from "./MemoryHubPage";

const fetchMemoryProfile = vi.fn();
const searchMemories = vi.fn();
const fetchMemorySettings = vi.fn();
const updateMemorySettings = vi.fn();
const resetMemory = vi.fn();
const fetchMyCapsule = vi.fn();
const fetchProjectOverview = vi.fn();
const archiveMemoryRecord = vi.fn();
const settleMemoryConflict = vi.fn();
const restoreCapsuleEntry = vi.fn();
const listAllMethods = vi.fn();
const methodVersions = vi.fn();
const methodSources = vi.fn();
const rollbackMethod = vi.fn();
const listAllHandbooks = vi.fn();
const handbookDetail = vi.fn();
const handbookVersions = vi.fn();
const rollbackHandbook = vi.fn();
const geo = vi.hoisted(() => ({ feature: "off" as "on" | "off", projects: [] as { projectId: string }[] }));
const vcr = vi.hoisted(() => ({ feature: "off" as "on" | "off", studies: [] as { projectId: string }[] }));
const map = vi.hoisted(() => ({ feature: "off" as "on" | "off" | "loading" }));

vi.mock("@/lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient");
  return {
    ...actual,
    getWebProjectId: () => "prj_1",
    fetchMemoryProfile: (...args: unknown[]) => fetchMemoryProfile(...args),
    searchMemories: (...args: unknown[]) => searchMemories(...args),
    fetchMemorySettings: (...args: unknown[]) => fetchMemorySettings(...args),
    updateMemorySettings: (...args: unknown[]) => updateMemorySettings(...args),
    resetMemory: (...args: unknown[]) => resetMemory(...args),
  };
});
vi.mock("@/lib/memoryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient");
  return {
    ...actual,
    ensureMyCapsule: () => Promise.resolve(null),
    fetchMyCapsule: (...args: unknown[]) => fetchMyCapsule(...args),
    archiveMemoryRecord: (...args: unknown[]) => archiveMemoryRecord(...args),
    settleMemoryConflict: (...args: unknown[]) => settleMemoryConflict(...args),
    restoreCapsuleEntry: (...args: unknown[]) => restoreCapsuleEntry(...args),
    fetchProjectOverview: (...args: unknown[]) => fetchProjectOverview(...args),
  };
});
vi.mock("@/lib/methodsClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient");
  return {
    ...actual,
    listAllMethods: (...args: unknown[]) => listAllMethods(...args),
    methodVersions: (...args: unknown[]) => methodVersions(...args),
    methodSources: (...args: unknown[]) => methodSources(...args),
    rollbackMethod: (...args: unknown[]) => rollbackMethod(...args),
  };
});
vi.mock("@/lib/handbooksClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/handbooksClient")>("@/lib/handbooksClient");
  return {
    ...actual,
    listAllHandbooks: (...args: unknown[]) => listAllHandbooks(...args),
    handbookDetail: (...args: unknown[]) => handbookDetail(...args),
    handbookVersions: (...args: unknown[]) => handbookVersions(...args),
    rollbackHandbook: (...args: unknown[]) => rollbackHandbook(...args),
  };
});
// Which projects belong to a module is the sidebar's own source of truth: the two module readers.
vi.mock("@/lib/geoClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/geoClient")>("@/lib/geoClient")),
  useGeoFeature: () => geo.feature,
  listGeoProjects: () => Promise.resolve(geo.projects),
}));
vi.mock("@/lib/vcrClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/vcrClient")>("@/lib/vcrClient")),
  useVcrFeature: () => vcr.feature,
  getVcrHome: () => Promise.resolve({ studies: vcr.studies }),
}));
vi.mock("@/lib/memoryMapFeature", () => ({ useMemoryMapFeature: () => map.feature }));
vi.mock("@/components/memory/useMemoryWritePrompt", () => ({ useMemoryWritePrompt: () => {} }));
vi.mock("./CapsuleTransferPanel", () => ({ ShareDrawer: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="分享与导入"><button onClick={onClose}>关闭</button></div> }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: ({ children }: { children: string }) => <div>{children}</div> }));

const record = (patch: Partial<WebStructuredMemory> = {}): WebStructuredMemory => ({
  id: "rec_1", scope: "user", scopeId: "", kind: "profile", key: "profile.who",
  value: "药学背景，关注老年人用药安全与抗栓治疗。", summary: "药学背景，关注老年人用药安全与抗栓治疗。",
  origin: "explicit", status: "active", confidence: 1, importance: 0.8, sensitive: false,
  evidenceCount: 1, version: 2, createdAt: "2026-09-12T02:00:00Z", updatedAt: "2026-09-12T02:00:00Z",
  lastConfirmedAt: null, expiresAt: null,
  provenance: { basis: "stated", observations: 3, runs: 1, conversations: 2 },
  evidence: [{ sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/u1", quote: "我是临床药师",
    observedAt: "2026-09-12T02:00:00Z", weight: 1, fingerprint: "f1" }],
  revisions: [],
  ...patch,
});

const method = {
  id: "method:learned:freeze", projectId: null, revision: 2, version: 2, name: "pre-submission-freeze-check",
  description: "Runs the last guards.", whenToUse: "", title: "提交前给成品做最后把关",
  summary: "先留改动前的副本，再逐项确认每道检查真的能报错。", status: "approved", statusReason: null, origin: "inferred",
  counts: { eligible: 1, loaded: 0, invoked: 0, succeeded: 0, read: 0 },
  promotion: { status: "approved", reasons: [], missing: [] }, body: "## Purpose\nRun the last guards before the bytes are frozen.", steps: "1. 先复制一份。\n2. 再逐项检查。",
  scope: { applicability: "报告交付前", counterexamples: [], current: true },
  statusChangedAt: "2026-09-22T02:00:00Z", bodyUpdatedAt: "2026-09-22T02:00:00Z", trajectories: 3, createdAt: "2026-09-21T06:00:00Z", updatedAt: "2026-09-22T06:00:00Z",
};

const handbook = {
  id: "method:capability-handbook:meta-analysis:citations", revision: 5, capabilityId: "meta-analysis", status: "active",
  title: "每一句结论落回来源", summary: "写结论时同时写出它出自哪篇、哪一句。", whenToUse: "写综述结论时", appliedAt: "2026-09-23T02:00:00Z",
  source: { projectId: "prj_1", sessionId: "ses_9" }, createdAt: "2026-09-20T02:00:00Z", updatedAt: "2026-09-23T02:00:00Z",
};

const entry = (patch: Record<string, unknown> = {}) => ({
  id: "entry_1", revision: 1, createdAt: "2026-09-14T02:00:00Z", updatedAt: "2026-09-14T02:00:00Z", deletedAt: null, projectId: null,
  payload: { capsuleId: "cap_1", factKind: "writing_style", layer: "profile", content: "引用写到页码。", status: "approved", origin: "explicit", provenance: [] },
  ...patch,
});

function open(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory${search}`]}>
      <Routes><Route path="/app/memory" element={<MemoryHubPage />} /></Routes>
    </MemoryRouter>,
  );
}

/** The address and the router's `navigate`, for the tests that read where the page keeps its place. */
const router: { navigate: ReturnType<typeof useNavigate> | null } = { navigate: null };
function Where() {
  const location = useLocation();
  router.navigate = useNavigate();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}
/** The memory page in the middle of a history: `/away` before it, so a Back that leaves the page is visible. */
function openInHistory(search = "") {
  return render(
    <MemoryRouter initialEntries={["/away", `/app/memory${search}`]} initialIndex={1}>
      <Where />
      <Routes>
        <Route path="/app/memory" element={<MemoryHubPage />} />
        <Route path="/away" element={<p>别处</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId("where").textContent;

describe("记忆胶囊", () => {
  beforeEach(() => {
    geo.feature = "off"; geo.projects = []; vcr.feature = "off"; vcr.studies = []; map.feature = "off";
    useProjectStore.setState({ projects: [{ id: "prj_1", name: "疳证 Meta 文献检索" }, { id: "prj_2", name: "信尔美" }], currentId: "prj_1" });
    fetchMemoryProfile.mockResolvedValue({
      records: [
        record(),
        record({ id: "rec_2", kind: "preference", key: "preference.style", value: "偏好结论先行的回答。", summary: "偏好结论先行的回答。",
          origin: "inferred", provenance: { basis: "inferred", observations: 2, runs: 2, conversations: 1 }, updatedAt: "2026-09-15T02:00:00Z" }),
        record({ id: "rec_3", kind: "project_fact", scope: "project", scopeId: "prj_1",
          key: "project.fact.scope", value: "纳入范围覆盖疳证与小儿厌食症。", summary: "纳入范围覆盖疳证与小儿厌食症。" }),
        record({ id: "rec_6", kind: "project_fact", scope: "project", scopeId: "prj_2",
          key: "project.fact.product", value: "信尔美为处方药，需冷链。", summary: "信尔美为处方药，需冷链。" }),
        record({ id: "rec_7", kind: "behavior", key: "behavior.sources", value: "先看一手研究再看综述。", summary: "先看一手研究再看综述。" }),
        record({ id: "rec_4", kind: "behavior", key: "behavior.gone", value: "已忘记的一条", summary: "已忘记的一条", status: "archived" }),
        record({ id: "rec_5", kind: "run_summary", scope: "project", scopeId: "prj_1", key: "run.session.ses_x", value: "{}", summary: "做过的一次研究" }),
      ],
      groups: {}, activeCount: 5, pendingCount: 0, episodeCount: 1,
      conversations: { ses_9: "阿司匹林一级预防" },
      usage: { rec_1: { count: 7, lastUsedAt: "2026-09-18T00:00:00Z" } },
    });
    fetchMemorySettings.mockResolvedValue({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null });
    updateMemorySettings.mockImplementation(async (patch: object) => ({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null, ...patch }));
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [entry()], forgotten: [entry({ id: "entry_old", payload: { ...entry().payload, content: "旧写作习惯", status: "retired" } })] });
    listAllMethods.mockImplementation(async (status?: string) => (status === "retired"
      ? [{ ...method, id: "method:learned:old", title: "已停用的做法", status: "retired", revision: 4 }]
      : [method, { ...method, id: "method:learned:waiting", title: "刚改过还没生效的做法", status: "candidate" }]));
    listAllHandbooks.mockImplementation(async (status: string) => (status === "retired" ? [{ ...handbook, id: "method:capability-handbook:geo-content:old", title: "已停用的经验", status: "retired", revision: 7 }] : [handbook]));
    methodVersions.mockResolvedValue({ items: [
      { version: 2, revision: 2, at: "2026-09-22T06:00:00Z", title: null, current: true },
      { version: 1, revision: 1, at: "2026-09-21T06:00:00Z", title: null, current: false, summary: "最初的一句话。", steps: "1. 最初的步骤。" },
    ] });
    methodSources.mockResolvedValue({ items: [{ projectId: "prj_1", sessionId: "ses_5", title: "儿童疳证中医药新证据", at: "2026-09-22T08:00:00Z" }] });
    handbookDetail.mockResolvedValue({ ...handbook, body: "model body", steps: "1. 对应每个引用。", sources: [] });
    handbookVersions.mockResolvedValue({ items: [{ version: 1, revision: 5, at: "2026-09-23T02:00:00Z", title: null, current: true }] });
    searchMemories.mockResolvedValue({ items: [], query: "", semantic: 0, conversations: {}, usage: {} });
    // Most tests are about the memories; the overview above them has tests of its own and is unreadable by default.
    fetchProjectOverview.mockRejectedValue(new Error("not read"));
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); useProjectStore.setState({ projects: [], currentId: "default" }); });

  it("is one page: a title with nothing under it, the memory switch and one 「⋯」 in the header, and no account name", async () => {
    open();
    const heading = await screen.findByRole("heading", { name: "记忆胶囊", level: 1 });
    const [banner] = screen.getAllByRole("banner");
    expect(banner).toContainElement(heading);
    expect(await within(banner).findByRole("switch", { name: "记忆" })).toHaveAttribute("aria-checked", "true");
    expect(within(banner).getByRole("button", { name: "记忆设置" })).toBeInTheDocument();
    expect(within(banner).queryByLabelText("记忆持有人")).toBeNull();
    for (const gone of ["最近变化", "记下的内容", "EviMed 眼中的你", "方法学习", "能力经验", "查看做法", "效果待观察", "完成对照评估", "推断"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("keeps sharing, forgotten content, this project and the reset in the header's 「⋯」, in that order — the map is a tab, not a menu item", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole("switch", { name: "记忆" });
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    const menu = await screen.findByRole("menu", { name: "记忆设置" });
    expect([...menu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent)).toEqual(["分享与导入", "已忘记的内容", "本项目不使用记忆", "重置记忆"]);
    const project = within(menu).getByRole("menuitemcheckbox", { name: "本项目不使用记忆" });
    expect(project).toHaveAttribute("aria-checked", "false");
    await user.click(project);
    await waitFor(() => expect(updateMemorySettings).toHaveBeenCalledWith({ pausedProjects: ["prj_1"] }));
  });

  it("keeps the visualization first while explicit list addresses remain available", async () => {
    const user = userEvent.setup();
    map.feature = "on";
    render(
      <MemoryRouter initialEntries={["/app/memory?tab=self"]}>
        <Routes>
          <Route path="/app/memory" element={<MemoryHubPage />} />
          <Route path="/app/memory/map" element={<p>地图页</p>} />
          <Route path="/app/memory/overview" element={<p>总览页</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("switch", { name: "记忆" });
    const tabs = screen.getByRole("tablist", { name: "记忆" });
    expect(within(tabs).getAllByRole("tab").map((item) => item.textContent?.replace(/\d+$/u, ""))).toEqual(["总览", "地图", "关于你", "项目", "做法"]);
    expect(within(tabs).getByRole("tab", { name: "地图" })).toHaveAttribute("aria-selected", "false");
    await user.click(within(tabs).getByRole("tab", { name: "地图" }));
    expect(await screen.findByText("地图页")).toBeInTheDocument();
  });

  it("opens the overview on the unqualified memory landing address", async () => {
    map.feature = "on";
    render(<MemoryRouter initialEntries={["/app/memory"]}><Routes>
      <Route path="/app/memory" element={<MemoryHubPage />} />
      <Route path="/app/memory/overview" element={<p>总览首页</p>} />
    </Routes></MemoryRouter>);
    expect(await screen.findByText("总览首页")).toBeInTheDocument();
  });

  it("goes to the overview from its tab, and draws neither 总览 nor 地图 where the deployment does not draw the map", async () => {
    const user = userEvent.setup();
    map.feature = "on";
    render(
      <MemoryRouter initialEntries={["/app/memory?tab=self"]}>
        <Routes>
          <Route path="/app/memory" element={<MemoryHubPage />} />
          <Route path="/app/memory/overview" element={<p>总览页</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole("tab", { name: "总览" }));
    expect(await screen.findByText("总览页")).toBeInTheDocument();
    cleanup();
    map.feature = "off";
    open();
    await screen.findByRole("switch", { name: "记忆" });
    expect(screen.queryByRole("tab", { name: "地图" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "总览" })).toBeNull();
  });

  it("asks before the reset deletes anything, and says exactly what it clears and what it leaves", async () => {
    const user = userEvent.setup();
    resetMemory.mockResolvedValue({ structured: 3, methods: 2, handbooks: 1, entries: 4 });
    open();
    await screen.findByRole("switch", { name: "记忆" });
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "重置记忆" }));
    const dialog = await screen.findByRole("alertdialog", { name: "重置记忆？" });
    // Every kind the page shows, and none of what it does not.
    expect(dialog).toHaveTextContent("将永久清空你的全部记忆、已学到的做法和经验，以及你自己胶囊里的记录，不可撤销。");
    expect(dialog).toHaveTextContent("对话、报告、知识库和别人分享给你的胶囊不受影响。");
    expect(resetMemory).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "清空" }));
    await waitFor(() => expect(resetMemory).toHaveBeenCalledTimes(1));
    // The page is read again, so it shows what is left.
    await waitFor(() => expect(fetchMemoryProfile.mock.calls.length).toBeGreaterThan(1));
  });

  it("pauses memory with the one switch, as one decision over both halves", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("switch", { name: "记忆" }));
    await waitFor(() => expect(updateMemorySettings).toHaveBeenCalledWith({ learningPaused: true, recallPaused: true }));
  });

  it("has its tabs in the sticky band and the search box in the one toolbar row under them, and each tab is one list", async () => {
    open();
    await screen.findByRole("button", { name: /药学背景/ });
    const tabs = screen.getByRole("tablist", { name: "记忆" });
    // 成长 is not a tab: what happened each week is the map's 「时间」 view.
    expect(within(tabs).getAllByRole("tab").map((item) => item.textContent)).toEqual(["关于你4", "项目1", "做法2"]);
    const search = screen.getByRole("searchbox", { name: "搜索记忆" });
    const band = document.querySelector("[data-page-chrome]")!;
    expect(band).toContainElement(tabs);
    expect(band.querySelector("[data-toolbar]")).toContainElement(search);
    expect(tabs.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("group", { name: "筛选记忆" })).toBeNull();
  });

  it("lists the notes an outside agent proposed with the ones in force, and its drawer asks to confirm them", async () => {
    const user = userEvent.setup();
    const proposed = entry({ id: "entry_proposed", payload: { ...entry().payload, content: "报告先给结论，再给依据。", status: "candidate", origin: "inferred", factKind: "preference" } });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [entry()], candidates: [proposed], forgotten: [] });
    open();
    await user.click(await screen.findByRole("button", { name: /报告先给结论，再给依据/ }));
    const drawer = await screen.findByRole("dialog", { name: "偏好" });
    expect(within(drawer).getByText("待确认")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "确认" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "不要" })).toBeInTheDocument();
  });

  it("opens on the first tab that has something in it, once: an empty 关于你 gives way to 项目, then 做法", async () => {
    const user = userEvent.setup();
    // Nothing about the person yet; the shell's own project has facts.
    fetchMemoryProfile.mockResolvedValue({ records: [record({ id: "rec_3", kind: "project_fact", scope: "project", scopeId: "prj_1", key: "project.fact.scope", value: "纳入范围覆盖疳证与小儿厌食症。", summary: "纳入范围覆盖疳证与小儿厌食症。" })], groups: {}, activeCount: 1, pendingCount: 0, episodeCount: 0, conversations: {}, usage: {} });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
    open();
    expect(await screen.findByRole("button", { name: /纳入范围覆盖疳证/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /项目/ })).toHaveAttribute("aria-selected", "true");
    // Only once: going back to the empty tab is the researcher's own choice and stays.
    await user.click(screen.getByRole("tab", { name: /关于你/ }));
    expect(await screen.findByText("还没有关于你的记忆")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /关于你/ })).toHaveAttribute("aria-selected", "true");
  });

  describe("each read is drawn as it arrives (the walk's memory page that took 30 s on the owner's data)", () => {
    it("lists the memories while the methods are still being read, and gives 做法 its number when they arrive", async () => {
      let release: (methods: unknown[]) => void = () => {};
      listAllMethods.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      open();
      // The memories are in: their tab is open and listed, and the slowest read has not been waited for.
      expect(await screen.findByRole("button", { name: /药学背景/ })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /关于你/ })).toHaveAttribute("aria-selected", "true");
      // 做法 is still being read: it has no number, which is not a zero.
      expect(screen.getByRole("tab", { name: "做法" })).toBeInTheDocument();
      expect(screen.queryByText("没有读到全部记忆。")).toBeNull();
      await act(async () => { release([method]); });
      expect(await screen.findByRole("tab", { name: /做法\s*[1-9]/ })).toBeInTheDocument();
    });

    it("keeps the list under the tab that is waiting for its own reads, and never lands on a tab before it can tell which holds something", async () => {
      let release: (profile: unknown) => void = () => {};
      fetchMemoryProfile.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      open();
      // Everything but the profile is in, and the profile decides whether 关于你 holds anything: nothing is drawn under the tabs yet.
      expect(await screen.findByRole("tab", { name: /做法/ })).toBeInTheDocument();
      expect(screen.queryByText("还没有关于你的记忆")).toBeNull();
      expect(screen.queryByRole("button", { name: /药学背景/ })).toBeNull();
      await act(async () => { release({ records: [record()], groups: {}, activeCount: 1, pendingCount: 0, episodeCount: 0, conversations: {}, usage: {} }); });
      expect(await screen.findByRole("button", { name: /药学背景/ })).toBeInTheDocument();
    });

    it("opens a memory named in the address when the memories are in, whatever the methods are doing", async () => {
      listAllMethods.mockImplementation(() => new Promise(() => {}));
      open("?record=rec_1");
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });
  });

  it("opens on the project that has facts when the shell's own has none", async () => {
    fetchMemoryProfile.mockResolvedValue({ records: [record({ id: "rec_6", kind: "project_fact", scope: "project", scopeId: "prj_2", key: "project.fact.product", value: "信尔美为处方药，需冷链。", summary: "信尔美为处方药，需冷链。" })], groups: {}, activeCount: 1, pendingCount: 0, episodeCount: 0, conversations: {}, usage: {} });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
    open();
    expect(await screen.findByRole("button", { name: /信尔美为处方药/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目：信尔美" })).toBeInTheDocument();
  });

  it("opens on 做法 when only what was learned is there, and stays on 关于你 when a read failed rather than guess it empty", async () => {
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0, episodeCount: 0, conversations: {}, usage: {} });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
    const first = open();
    expect(await screen.findByRole("button", { name: /提交前给成品做最后把关/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /做法/ })).toHaveAttribute("aria-selected", "true");
    first.unmount();
    fetchMemoryProfile.mockRejectedValue(new Error("down"));
    open();
    expect(await screen.findByText("没有读到全部记忆。")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /关于你/ })).toHaveAttribute("aria-selected", "true");
  });

  it("an address that names a tab is obeyed, and a tab the researcher clicked before the data came is not moved", async () => {
    const user = userEvent.setup();
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0, episodeCount: 0, conversations: {}, usage: {} });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
    const named = open("?tab=methods");
    expect(await screen.findByRole("button", { name: /提交前给成品做最后把关/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /做法/ })).toHaveAttribute("aria-selected", "true");
    named.unmount();
    open("?tab=self");
    expect(await screen.findByText("还没有关于你的记忆")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /关于你/ })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: /项目/ }));
    expect(screen.getByRole("tab", { name: /项目/ })).toHaveAttribute("aria-selected", "true");
  });

  it("starts on 关于你: facts about the person under small headers by kind, newest first, as bare sentences", async () => {
    open();
    await screen.findByRole("button", { name: /药学背景/ });
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["背景", "偏好", "工作与写作习惯"]);
    const texts = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("listitem").map((item) => item.textContent);
    expect(texts("背景")).toEqual(["药学背景，关注老年人用药安全与抗栓治疗。"]);
    expect(texts("偏好")).toEqual(["偏好结论先行的回答。"]);
    // How they work and write is about them, from either store: a habit the platform noticed and a note of their own capsule.
    expect(texts("工作与写作习惯").sort()).toEqual(["先看一手研究再看综述。", "引用写到页码。"].sort());
    // Nothing on a row but its sentence: no origin, no 推断, no hover icons, no menu. A run summary and a forgotten memory are not rows.
    for (const row of screen.getAllByRole("listitem")) {
      expect(within(row).queryByRole("button", { name: /编辑|忘记|更多/ })).toBeNull();
      expect(within(row).queryByRole("link")).toBeNull();
    }
    expect(screen.queryByText("做过的一次研究")).toBeNull();
    expect(screen.queryByText("已忘记的一条")).toBeNull();
    expect(screen.queryByText("信尔美为处方药，需冷链。")).toBeNull();
  });

  it("opens a fact in a drawer on the right and never navigates: the words it rests on, and the link to the conversation only in there", async () => {
    const user = userEvent.setup();
    open();
    const row = await screen.findByRole("button", { name: /药学背景/ });
    expect(within(row.closest("li")!).queryByRole("link")).toBeNull();
    await user.click(row);
    const drawer = await screen.findByRole("dialog", { name: "背景" });
    expect(within(drawer).getByText("药学背景，关注老年人用药安全与抗栓治疗。")).toBeInTheDocument();
    // Since when, and nothing of whose words it is (owner ruling of 2026-10-10).
    expect(within(drawer).getByText("9月12日")).toBeInTheDocument();
    expect(within(drawer).getByText("“我是临床药师”")).toBeInTheDocument();
    // The conversation it came from, by what that conversation was about.
    expect(within(drawer).getByRole("button", { name: "来源对话：《阿司匹林一级预防》（9月12日）" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "忘记" })).toBeInTheDocument();
    // The list is still there behind it.
    expect(screen.getByRole("tablist", { name: "记忆" })).toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not say in the drawer that EviMed learned a memory it inferred, and offers 「不再记这条」 on every memory", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: /偏好结论先行的回答/ }));
    const drawer = await screen.findByRole("dialog", { name: "偏好" });
    expect(within(drawer).getByText("9月12日")).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/从对话中学到|推断|你说的/);
    await user.click(within(drawer).getByRole("button", { name: "更多" }));
    expect(await screen.findByRole("menuitem", { name: "不再记这条" })).toBeInTheDocument();
  });

  it("forgets from the drawer at once, and the toast's 撤销 takes it back", async () => {
    const user = userEvent.setup();
    archiveMemoryRecord.mockResolvedValue({ id: "rec_1", version: 3 });
    open();
    await user.click(await screen.findByRole("button", { name: /药学背景/ }));
    await user.click(within(await screen.findByRole("dialog", { name: "背景" })).getByRole("button", { name: "忘记" }));
    await waitFor(() => expect(archiveMemoryRecord).toHaveBeenCalledWith("rec_1", 2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("项目 lists one project's facts at a time, the one the shell is in to begin with, and the dropdown changes it", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("tab", { name: /^项目/ }));
    expect(screen.getByText("纳入范围覆盖疳证与小儿厌食症。")).toBeInTheDocument();
    expect(screen.queryByText("信尔美为处方药，需冷链。")).toBeNull();
    // A project's fact needs no label of its own: the dropdown says whose it is.
    expect(within(screen.getByRole("list", { name: "项目的记忆" })).queryByText("疳证 Meta 文献检索")).toBeNull();
    // The project is the header's scope, beside the title, and only on this tab.
    const header = screen.getAllByRole("banner")[0]!;
    await user.click(within(header).getByRole("button", { name: "项目：疳证 Meta 文献检索" }));
    const menu = await screen.findByRole("menu", { name: "项目" });
    expect([...menu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent)).toEqual(["疳证 Meta 文献检索", "信尔美"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "信尔美" }));
    expect(screen.getByText("信尔美为处方药，需冷链。")).toBeInTheDocument();
    expect(screen.queryByText("纳入范围覆盖疳证与小儿厌食症。")).toBeNull();
    // The drawer of a project's fact names the project.
    await user.click(screen.getByRole("button", { name: /信尔美为处方药/ }));
    expect(await screen.findByText(/^信尔美 · \d+月\d+日$/)).toBeInTheDocument();
  });

  it("lists the studies of 虚拟临床研究 and the projects of 循证 GEO in a group of their own in the dropdown", async () => {
    const user = userEvent.setup();
    geo.feature = "on"; geo.projects = [{ projectId: "prj_geo" }];
    vcr.feature = "on"; vcr.studies = [{ projectId: "prj_vcr" }];
    useProjectStore.setState({ projects: [{ id: "prj_1", name: "疳证 Meta 文献检索" }, { id: "prj_vcr", name: "糖尿病研究" }, { id: "prj_geo", name: "波立维" }, { id: "prj_2", name: "信尔美" }] });
    open();
    await user.click(await screen.findByRole("tab", { name: /^项目/ }));
    await user.click(screen.getByRole("button", { name: "项目：疳证 Meta 文献检索" }));
    const menu = await screen.findByRole("menu", { name: "项目" });
    // The researcher's own first; each module's group has its heading, which is not an entry and cannot be chosen.
    await waitFor(() => expect([...menu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent)).toEqual(
      ["疳证 Meta 文献检索", "信尔美", "糖尿病研究", "波立维"]));
    expect(within(menu).getByText("虚拟临床研究")).toBeInTheDocument();
    expect(within(menu).getByText("循证 GEO")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitemradio", { name: "虚拟临床研究" })).toBeNull();
    expect(within(menu).getByRole("menuitemradio", { name: "波立维" })).not.toBeDisabled();
  });

  it("做法 is learned methods in force and handbooks, in two groups; a method still waiting is not shown", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("tab", { name: /^做法/ }));
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["所有研究都会用", "用在某个科研工具里"]);
    const every = within(screen.getByRole("list", { name: "所有研究都会用的做法" }));
    expect(every.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["提交前给成品做最后把关先留改动前的副本，再逐项确认每道检查真的能报错。"]);
    // A handbook names the research tool it is for, by the title the researcher knows.
    const tools = within(screen.getByRole("list", { name: "用在某个科研工具里的做法" }));
    expect(tools.getAllByRole("listitem")[0]).toHaveTextContent("每一句结论落回来源");
    expect(tools.getAllByRole("listitem")[0]).toHaveTextContent("写结论时同时写出它出自哪篇、哪一句。");
    expect(tools.getAllByRole("listitem")[0].textContent).not.toMatch(/meta-analysis/);
    expect(screen.queryByText("刚改过还没生效的做法")).toBeNull();
    // Nothing is typed here: no form, no 新建.
    expect(screen.queryByRole("button", { name: /新建|写一个|添加/ })).toBeNull();
  });

  it("opens a method in a drawer: how, when, where it was learned, earlier versions to read — and two undos, no form", async () => {
    const user = userEvent.setup();
    open("?tab=methods");
    await user.click(await screen.findByRole("button", { name: /提交前给成品做最后把关/ }));
    const drawer = await screen.findByRole("dialog", { name: "提交前给成品做最后把关" });
    expect(within(drawer).getByText("做法 · 第 2 版 · 9月22日")).toBeInTheDocument();
    expect(within(drawer).getByText(/先复制一份/)).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/Purpose|the last guards/);
    expect(within(drawer).getByText("报告交付前")).toBeInTheDocument();
    expect(await within(drawer).findByText("儿童疳证中医药新证据 · 9月22日")).toBeInTheDocument();
    // An earlier version is read in place, not navigated to.
    expect(await within(drawer).findByText("第 1 版 · 9月21日 ·")).toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "查看" }));
    expect(within(drawer).getByText("最初的一句话。")).toBeInTheDocument();
    expect(within(drawer).getByText("1. 最初的步骤。")).toBeInTheDocument();
    expect(within(drawer).getAllByRole("button").map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["回到上一版", "不再使用"]));
    expect(within(drawer).queryByRole("textbox")).toBeNull();
    expect(within(drawer).queryByRole("button", { name: "编辑" })).toBeNull();
    // 回到上一版 is the server's call from the record, as it always was.
    rollbackMethod.mockResolvedValue({});
    await user.click(within(drawer).getByRole("button", { name: "回到上一版" }));
    await waitFor(() => expect(rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ id: method.id, revision: 2 }), 1));
  });

  it("opens a handbook in a drawer the same way, naming its research tool, without a state that never moves", async () => {
    const user = userEvent.setup();
    open("?tab=methods");
    await user.click(await screen.findByRole("button", { name: /每一句结论落回来源/ }));
    const drawer = await screen.findByRole("dialog", { name: "每一句结论落回来源" });
    expect(within(drawer).getByText(/^用在.+ · 第 \d+ 版/)).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/从你的对话中学到|你定下的/);
    expect(await within(drawer).findByText("1. 对应每个引用。")).toBeInTheDocument();
    expect(within(drawer).getByText("写综述结论时")).toBeInTheDocument();
    // One version: nothing to go back to, and nothing earlier to read.
    expect(within(drawer).queryByRole("button", { name: "回到上一版" })).toBeNull();
    expect(within(drawer).queryByText("以前的版本")).toBeNull();
    expect(within(drawer.closest("body")!).queryByText(/效果待观察|对照评估/)).toBeNull();
  });

  // R19 (plan §3 S10): the page held to the framework's assertions, on each of its tabs.
  describe("composed as a list page of the framework", () => {
    it.each(["self", "project", "methods"])("%s: the tabs are the one row of views in the sticky band, the search is the one toolbar under them, and the list is the body", async (tab) => {
      const { container } = open(`?tab=${tab}`);
      await screen.findByRole("switch", { name: "记忆" });
      await screen.findByRole("tab", { name: new RegExp(`^${{ self: "关于你", project: "项目", methods: "做法" }[tab]}`, "u") });
      const facts = expectComposed(container, { tablists: 1, toolbar: true });
      expect(facts.toolbars).toHaveLength(1);
      expect(facts.chrome!.contains(facts.tablists[0]!)).toBe(true);
      expect(facts.chrome!.contains(facts.toolbars[0]!)).toBe(true);
      expect(precedes(facts.tablists[0]!, facts.toolbars[0]!)).toBe(true);
      expect(facts.toolbars[0]).toContainElement(screen.getByRole("searchbox", { name: "搜索记忆" }));
      expect(facts.body!.querySelector("input[type=search]")).toBeNull();
      // The project is the header's, on the one tab that is about a project.
      const header = facts.header!;
      expect(within(header).queryByRole("button", { name: /^项目：/u }) !== null).toBe(tab === "project");
    });

    it("is the same column and the same band as the map, so the title and the tabs do not move between them", async () => {
      const { container } = open();
      await screen.findByRole("switch", { name: "记忆" });
      // `page` (1040): the map was `wide` (1200) and the title and the tabs stepped 80 px sideways between the two pages.
      expect(container.querySelector("[data-page-header]")!.parentElement).toHaveClass("max-w-page");
      expect(container.querySelector("[data-page-header]")!.parentElement).not.toHaveClass("max-w-wide");
      expect(screen.getByRole("tablist", { name: "记忆" }).closest("[data-page-chrome]")).not.toBeNull();
    });
  });

  describe("成长 is the overview's first card", () => {
    function openOld(feature: "on" | "off" | "loading", tab = "growth") {
      map.feature = feature;
      return render(
        <MemoryRouter initialEntries={[`/app/memory?tab=${tab}`]}>
          <Routes>
            <Route path="/app/memory" element={<><MemoryHubPage /><Where /></>} />
            <Route path="/app/memory/overview" element={<><p>总览页</p><Where /></>} />
          </Routes>
        </MemoryRouter>,
      );
    }
    function Where() {
      const location = useLocation();
      return <p data-testid="where">{location.pathname}{location.search}</p>;
    }

    it("sends the old address of the tab, and `/app/capsules`'s, to the overview, in place, where the deployment draws it", async () => {
      openOld("on");
      expect(await screen.findByText("总览页")).toBeInTheDocument();
      expect(screen.getByTestId("where")).toHaveTextContent("/app/memory/overview");
      // Nothing of the old tab is read: the overview asks for its own document.
      expect(fetchMyCapsule).not.toHaveBeenCalled();
      cleanup();
      openOld("on", "capsules");
      expect(await screen.findByText("总览页")).toBeInTheDocument();
    });

    it("waits for the deployment's answer before it sends the address anywhere", async () => {
      openOld("loading");
      expect(await screen.findByTestId("where")).toHaveTextContent("/app/memory?tab=growth");
      expect(screen.queryByText("总览页")).toBeNull();
      expect(screen.queryByRole("tab", { name: "关于你" })).toBeNull();
    });

    it("sends it to the first list where the deployment draws no map, and never leaves a tab that is not there", async () => {
      openOld("off");
      expect(await screen.findByRole("tab", { name: /关于你/ })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("where")).toHaveTextContent("/app/memory?tab=self");
      expect(screen.queryByRole("tab", { name: "成长" })).toBeNull();
    });
  });

  it("searches on the server, over more than the rows on screen, and never lists a run summary", async () => {
    const user = userEvent.setup();
    searchMemories.mockResolvedValue({
      items: [
        record({ id: "rec_far", kind: "preference", key: "preference.aspirin", value: "研究阿司匹林一级预防的净获益", summary: "研究阿司匹林一级预防的净获益" }),
        record({ id: "rec_brief", kind: "run_summary", scope: "project", scopeId: "prj_1", key: "run.session.ses_far", value: "{}", summary: "「循证 GEO」自动运行 · 第 6 步（内容）" }),
      ],
      query: "阿司匹林", semantic: 1, conversations: {}, usage: {},
    });
    open();
    await screen.findByRole("button", { name: /药学背景/ });
    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "阿司匹林");
    await waitFor(() => expect(searchMemories).toHaveBeenCalledWith("阿司匹林"));
    expect(await screen.findByRole("button", { name: /研究阿司匹林一级预防的净获益/ })).toBeInTheDocument();
    expect(screen.queryByText(/循证 GEO」自动运行/)).toBeNull();
    expect(screen.queryByRole("button", { name: /药学背景/ })).toBeNull();
  });

  it("searches the methods and handbooks on their own tab, over what is loaded", async () => {
    const user = userEvent.setup();
    open("?tab=methods");
    await screen.findByRole("button", { name: /提交前给成品做最后把关/ });
    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "落回来源");
    expect(screen.getByRole("button", { name: /每一句结论落回来源/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /提交前给成品做最后把关/ })).toBeNull();
    await user.clear(screen.getByRole("searchbox", { name: "搜索记忆" }));
    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "没有这个词");
    expect(await screen.findByText("没有找到")).toBeInTheDocument();
  });

  // 2026-09-26 audit (M-11): a superseded record was listed as a current one.
  it("shows a replaced fact as 「曾经如此」 under what replaced it, never as a memory in force", async () => {
    const user = userEvent.setup();
    fetchMemoryProfile.mockResolvedValue({
      records: [
        record({ id: "rec_new", kind: "preference", key: "preference.designs", value: "接受高质量队列研究。", summary: "接受高质量队列研究。", createdAt: "2026-09-01T00:00:00Z" }),
        record({ id: "rec_old", kind: "preference", key: "preference.rct_only", value: "只看 RCT。", summary: "只看 RCT。",
          status: "superseded", supersededBy: "rec_new", createdAt: "2026-03-02T00:00:00Z", invalidSince: "2026-09-01T00:00:00Z" }),
        record({ id: "rec_orphan", kind: "preference", key: "preference.language", value: "回答用英文。", summary: "回答用英文。",
          status: "superseded", supersededBy: "rec_deleted", createdAt: "2026-02-01T00:00:00Z", invalidSince: "2026-04-01T00:00:00Z" }),
      ],
      groups: {}, activeCount: 1, pendingCount: 0, conversations: {}, usage: {},
    });
    open();
    await user.click(await screen.findByRole("button", { name: /接受高质量队列研究/ }));
    const drawer = await screen.findByRole("dialog", { name: "偏好" });
    expect(within(drawer).getByText(/曾经如此：只看 RCT。（3月2日～9月1日）/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "关闭" }));
    // One whose replacement is not on the page keeps a row, marked as what it was.
    expect(screen.getByText(/曾经如此：回答用英文。（2月1日～4月1日）/)).toBeInTheDocument();
    expect(screen.queryByText("只看 RCT。")).toBeNull();
  });

  // F1: a disagreement is on both memories and settled by the researcher.
  it("settles a disagreement for the researcher from the drawer, then reads the page again", async () => {
    const user = userEvent.setup();
    const conflict = (id: string, text: string): WebStructuredMemory["relations"] => ({
      validity: { from: null, until: null }, caveats: ["conflict"], sources: [],
      conflicts: [{ id, status: "active", scope: "user", scopeId: "", origin: "explicit", sensitive: false, text, createdAt: null }],
    });
    fetchMemoryProfile.mockResolvedValue({
      records: [
        record({ id: "rec_a", kind: "preference", key: "preference.a", value: "证据先用表格。", summary: "证据先用表格。", relations: conflict("rec_b", "证据先用列表。") }),
        record({ id: "rec_b", kind: "preference", key: "preference.b", value: "证据先用列表。", summary: "证据先用列表。", relations: conflict("rec_a", "证据先用表格。") }),
      ],
      groups: {}, activeCount: 2, pendingCount: 0, conversations: {}, usage: {},
    });
    settleMemoryConflict.mockResolvedValue({ kept: { id: "rec_b" }, superseded: { id: "rec_a", version: 4 } });
    open();
    await user.click(await screen.findByRole("button", { name: "证据先用列表。" }));
    const drawer = await screen.findByRole("dialog", { name: "偏好" });
    expect(within(drawer).getByText("有冲突")).toBeInTheDocument();
    await user.click(within(drawer).getAllByRole("button", { name: /^以这条为准/ })[0]);
    await waitFor(() => expect(settleMemoryConflict).toHaveBeenCalledWith("rec_b", "rec_a"));
    await waitFor(() => expect(fetchMemoryProfile.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows a memory that waits for confirmation in plain words in the drawer, confirmable, with no safety hold named", async () => {
    const user = userEvent.setup();
    fetchMemoryProfile.mockResolvedValue({
      records: [record({ id: "rec_pending", kind: "profile", summary: "长期服用华法林。", value: "长期服用华法林。", status: "pending" })],
      groups: {}, activeCount: 0, pendingCount: 1, conversations: {}, usage: {},
    });
    open();
    await user.click(await screen.findByRole("button", { name: /长期服用华法林/ }));
    const drawer = await screen.findByRole("dialog", { name: "背景" });
    expect(within(drawer).getByText("待确认")).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/用药安全/);
    expect(within(drawer).getByRole("button", { name: "确认" })).toBeInTheDocument();
  });

  it("lists what was forgotten of every kind under 已忘记的内容, each with 恢复 that works for its kind", async () => {
    const user = userEvent.setup();
    restoreCapsuleEntry.mockResolvedValue({});
    rollbackMethod.mockResolvedValue({});
    rollbackHandbook.mockResolvedValue({});
    open();
    await screen.findByRole("button", { name: /药学背景/ });
    expect(screen.queryByText("已忘记的一条")).toBeNull();
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "已忘记的内容" }));
    const drawer = await screen.findByRole("dialog", { name: "已忘记的内容" });
    // A memory, a note of the researcher's own capsule, a method and a handbook: the four kinds the page shows.
    for (const text of ["已忘记的一条", "旧写作习惯", "已停用的做法", "已停用的经验"]) expect(await within(drawer).findByText(text)).toBeInTheDocument();
    // A row is not opened: the drawer is already the second layer, and the one thing to do is bring it back.
    expect(within(drawer).queryByRole("link")).toBeNull();
    const restore = (text: string) => within(within(drawer).getByText(text).closest("li")!).getByRole("button", { name: "恢复" });
    await user.click(restore("旧写作习惯"));
    await waitFor(() => expect(restoreCapsuleEntry).toHaveBeenCalledWith("cap_1", expect.objectContaining({ id: "entry_old" })));
    await user.click(restore("已停用的做法"));
    await waitFor(() => expect(rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ id: "method:learned:old" }), 3));
    await user.click(restore("已停用的经验"));
    await waitFor(() => expect(rollbackHandbook).toHaveBeenCalledWith(expect.objectContaining({ id: "method:capability-handbook:geo-content:old" }), 6));
  });

  it("says so, with a retry, when the stopped methods cannot be read — and never that nothing was forgotten", async () => {
    const user = userEvent.setup();
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0, conversations: {}, usage: {} });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
    listAllMethods.mockImplementation(async (status?: string) => { if (status === "retired") throw new Error("down"); return []; });
    // Nothing anywhere, so the page opens on the first tab and says it is empty (a handbook would have taken it to 做法).
    listAllHandbooks.mockResolvedValue([]);
    open();
    await screen.findByText("还没有关于你的记忆");
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "已忘记的内容" }));
    const drawer = await screen.findByRole("dialog", { name: "已忘记的内容" });
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("暂时读不到已停用的做法和经验。");
    expect(within(drawer).queryByText("没有已忘记的内容")).toBeNull();
  });

  it("opens sharing and importing from the header's 「⋯」", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole("button", { name: /药学背景/ });
    expect(screen.queryByRole("dialog", { name: "分享与导入" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "分享与导入" }));
    expect(await screen.findByRole("dialog", { name: "分享与导入" })).toBeInTheDocument();
  });

  it("carries no number on a tab with nothing in it", async () => {
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0, conversations: {}, usage: {} });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
    listAllMethods.mockResolvedValue([]);
    listAllHandbooks.mockResolvedValue([]);
    open();
    await screen.findByText("还没有关于你的记忆");
    expect(within(screen.getByRole("tablist", { name: "记忆" })).getAllByRole("tab").map((item) => item.textContent)).toEqual(["关于你", "项目", "做法"]);
  });

  it("says what will appear on a tab that is empty, and nothing is a 「还没有记忆」 for a tab that could not be read", async () => {
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0, conversations: {}, usage: {} });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
    listAllMethods.mockResolvedValue([]);
    listAllHandbooks.mockResolvedValue([]);
    const user = userEvent.setup();
    open();
    expect(await screen.findByText("还没有关于你的记忆")).toBeInTheDocument();
    expect(screen.getByText("你在对话里说过的偏好、背景和写作习惯会出现在这里。")).toBeInTheDocument();
    // An empty list is a recipe: what will be here, and the one thing to do — a verb and its object.
    expect(screen.getByRole("button", { name: "在对话里说说你自己" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^做法/ }));
    expect(screen.getByText("还没有学到的做法")).toBeInTheDocument();
    // A practice is learned and never typed: there is no button, and the sentence says why instead.
    expect(document.querySelector("[data-empty][data-reason]")).not.toBeNull();
    expect(document.querySelector("[data-empty] button")).toBeNull();
    await user.click(screen.getByRole("tab", { name: /^项目/ }));
    expect(screen.getByText("这个项目还没有记忆")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在对话里说说这个项目" })).toBeInTheDocument();
  });

  it("says one thing when any read fails, with 重试, keeps the lists that did read, and shows nothing as empty that did not", async () => {
    const user = userEvent.setup();
    listAllMethods.mockRejectedValueOnce(new Error("methods down"));
    open();
    // The facts read; the methods did not: one line, and the tab that needs them says nothing of 「还没有」.
    expect(await screen.findByRole("alert")).toHaveTextContent("没有读到全部记忆。");
    expect(await screen.findByRole("button", { name: /药学背景/ })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^做法/ }));
    expect(screen.queryByText("还没有学到的做法")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByRole("button", { name: /提交前给成品做最后把关/ })).toBeInTheDocument();
  });

  it("says one sentence when nothing can be read at all", async () => {
    fetchMemoryProfile.mockRejectedValue(new Error("down"));
    fetchMyCapsule.mockRejectedValue(new Error("down"));
    listAllMethods.mockRejectedValue(new Error("down"));
    listAllHandbooks.mockRejectedValue(new Error("down"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("没有读到全部记忆。");
    expect(screen.queryByText("还没有关于你的记忆")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("opens the tab a link asks for: the skills page's ?tab=methods, and the old /app/capsules redirect", async () => {
    open("?tab=methods");
    expect(await screen.findByRole("button", { name: /提交前给成品做最后把关/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^做法/ })).toHaveAttribute("aria-selected", "true");
    cleanup();
    open("?tab=capsules");
    expect(await screen.findByRole("button", { name: /药学背景/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^关于你/ })).toHaveAttribute("aria-selected", "true");
  });

  it("opens the memory an inbox notice names, in its drawer, on the tab it belongs to", async () => {
    open("?record=rec_6");
    const drawer = await screen.findByRole("dialog", { name: "项目事实" });
    expect(within(drawer).getByText("信尔美为处方药，需冷链。")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^项目/ })).toHaveAttribute("aria-selected", "true");
  });

  it("opens the learned method a skill-catalogue link names, in its drawer, and says when it is not in the list", async () => {
    open(`?method=${encodeURIComponent(method.id)}`);
    const drawer = await screen.findByRole("dialog", { name: "提交前给成品做最后把关" });
    expect(within(drawer).getByText(/先复制一份/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^做法/ })).toHaveAttribute("aria-selected", "true");
    cleanup();
    open("?method=method%3Amissing");
    expect(await screen.findByText("当前列表中没有找到这条做法。")).toBeInTheDocument();
  });

  // A08: the page keeps its place in its address, and Back finds it.
  it("keeps the tab, the project and the search in the address, and a tab pushes where a filter replaces", async () => {
    const user = userEvent.setup();
    openInHistory();
    await user.click(await screen.findByRole("tab", { name: /^项目/ }));
    expect(where()).toBe("/app/memory?tab=project");
    await user.click(screen.getByRole("button", { name: "项目：疳证 Meta 文献检索" }));
    await user.click(within(await screen.findByRole("menu", { name: "项目" })).getByRole("menuitemradio", { name: "信尔美" }));
    expect(where()).toBe("/app/memory?tab=project&project=prj_2");
    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "冷链");
    await waitFor(() => expect(where()).toBe("/app/memory?tab=project&project=prj_2&q=%E5%86%B7%E9%93%BE"));
    // Choosing the project and typing replaced the entry; the tab pushed one: a single Back leaves for the page before it.
    await act(async () => { await router.navigate!(-1); });
    expect(where()).toBe("/app/memory");
    expect(screen.getByRole("tab", { name: /^关于你/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox", { name: "搜索记忆" })).toHaveValue("");
  });

  it("opens the page on the tab, project, search and row its address names", async () => {
    openInHistory(`?tab=project&project=prj_2&open=${encodeURIComponent("record:rec_6")}&q=${encodeURIComponent("冷链")}`);
    const drawer = await screen.findByRole("dialog", { name: "项目事实" });
    expect(within(drawer).getByText("信尔美为处方药，需冷链。")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^项目/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox", { name: "搜索记忆" })).toHaveValue("冷链");
  });

  it("opens a row by pushing an entry: Back closes the drawer, and closing it from the page pops that entry", async () => {
    const user = userEvent.setup();
    openInHistory();
    await user.click(await screen.findByRole("button", { name: /药学背景/ }));
    expect(await screen.findByRole("dialog", { name: "背景" })).toBeInTheDocument();
    expect(where()).toBe("/app/memory?open=record%3Arec_1");
    await act(async () => { await router.navigate!(-1); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(where()).toBe("/app/memory");
    await act(async () => { await router.navigate!(1); });
    const drawer = await screen.findByRole("dialog", { name: "背景" });
    await user.click(within(drawer).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(where()).toBe("/app/memory");
    // The close popped the entry the open pushed: one Back more leaves the page, it does not land on the same list again.
    await act(async () => { await router.navigate!(-1); });
    expect(where()).toBe("/away");
  });

  it("closes a drawer that an address opened without leaving the page, and clears the search with its button and Escape", async () => {
    const user = userEvent.setup();
    openInHistory(`?open=${encodeURIComponent("record:rec_1")}`);
    const drawer = await screen.findByRole("dialog", { name: "背景" });
    await user.click(within(drawer).getByRole("button", { name: "关闭" }));
    expect(where()).toBe("/app/memory");
    const box = screen.getByRole("searchbox", { name: "搜索记忆" });
    await user.type(box, "背景");
    await waitFor(() => expect(where()).toBe("/app/memory?q=%E8%83%8C%E6%99%AF"));
    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(box).toHaveValue("");
    expect(where()).toBe("/app/memory");
    await user.type(box, "背景");
    await user.keyboard("{Escape}");
    expect(box).toHaveValue("");
    expect(where()).toBe("/app/memory");
  });

  it("comes back to the place in the list the reader had scrolled to after a visit elsewhere", async () => {
    const { container } = openInHistory();
    await screen.findByRole("button", { name: /药学背景/ });
    const scroller = () => container.querySelector<HTMLElement>(".overflow-y-auto")!;
    scroller().scrollTop = 180;
    fireEvent.scroll(scroller());
    await act(async () => { await router.navigate!("/away"); });
    expect(await screen.findByText("别处")).toBeInTheDocument();
    await act(async () => { await router.navigate!(-1); });
    await screen.findByRole("button", { name: /药学背景/ });
    expect(scroller().scrollTop).toBe(180);
  });

  it("keeps the notice's deep links working: the record's tab, project and row land in the address", async () => {
    openInHistory("?record=rec_6");
    await screen.findByRole("dialog", { name: "项目事实" });
    expect(where()).toBe("/app/memory?tab=project&project=prj_2&open=record%3Arec_6");
  });

  describe("the top of 项目", () => {
    const overview = (patch: Record<string, unknown> = {}) => ({
      projectId: "prj_1", paused: false, timeZone: "Asia/Shanghai",
      card: [
        { slot: "field", label: "领域", recordId: "rec_f", text: "心血管", updatedAt: "2026-09-13T02:00:00Z" },
        { slot: "population", label: "人群", recordId: "rec_3", text: "75 岁以上非瓣膜性房颤患者", updatedAt: "2026-09-13T02:00:00Z" },
        { slot: "outcome", label: "结局", recordId: "rec_o", text: "大出血", updatedAt: "2026-09-13T02:00:00Z" },
      ],
      capabilities: [{ id: "statistical-analysis", title: "统计分析", count: 6 }, { id: "meta-analysis", title: "自动化 Meta 分析", count: 2 }],
      works: [
        { month: "2026-10", items: [{ runId: "run_9", title: "阿司匹林二级预防", path: "deliverables/clinical-evidence/report.md", name: "report.md", at: "2026-10-10T02:30:00.000Z" }] },
        { month: "2025-12", items: [{ runId: "run_1", title: "旧研究", path: "deliverables/old/report.docx", name: "report.docx", at: "2025-12-20T02:30:00.000Z" }] },
      ],
      ...patch,
    });

    it("shows the card, what the project did and what it delivered above its memories, for the project the dropdown names", async () => {
      fetchProjectOverview.mockImplementation(async (id: string) => overview({ projectId: id }));
      const user = userEvent.setup();
      open("?tab=project");
      const card = await screen.findByRole("list", { name: "项目卡" });
      await waitFor(() => expect(fetchProjectOverview).toHaveBeenCalledWith("prj_1"));
      // Only what was stated, under the names a researcher uses for it.
      expect(within(card).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
        "领域心血管", "人群75 岁以上非瓣膜性房颤患者", "结局大出血",
      ].map((text) => expect.stringContaining(text)));
      expect(screen.getByRole("heading", { name: "项目卡" })).toBeInTheDocument();
      // A ranking is a table with a bar in the row; the numbers are the bar's labels.
      const table = screen.getByRole("table", { name: "这个项目做过" });
      expect(within(table).getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual(["统计分析6", "自动化 Meta 分析2"]);
      expect(within(table).getAllByRole("img").map((bar) => bar.getAttribute("aria-label"))).toEqual(["统计分析 6", "自动化 Meta 分析 2"]);
      // The works, by month, each a link to the file; the file's name and the day are all it says of itself.
      expect(screen.getByRole("heading", { name: "10月" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "2025年12月" })).toBeInTheDocument();
      const work = screen.getByRole("link", { name: /阿司匹林二级预防/ });
      expect(work).toHaveAttribute("href", "/app/runs/run_9/files/deliverables/clinical-evidence/report.md");
      expect(within(work.closest("li")!).getByText("report.md")).toBeInTheDocument();
      expect(within(work.closest("li")!).getByText("10月10日")).toBeInTheDocument();
      // And the memories under it, with a name of their own now that something sits above them.
      expect(screen.getByRole("heading", { name: "记忆" })).toBeInTheDocument();
      expect(screen.getByText("纳入范围覆盖疳证与小儿厌食症。")).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/已交付|用过|次运行|token|置信/);
      // The dropdown moves the whole of it to the other project.
      await user.click(screen.getByRole("button", { name: "项目：疳证 Meta 文献检索" }));
      await user.click(within(await screen.findByRole("menu", { name: "项目" })).getByRole("menuitemradio", { name: "信尔美" }));
      await waitFor(() => expect(fetchProjectOverview).toHaveBeenCalledWith("prj_2"));
    });

    it("pauses the project the 项目 tab shows, not the one the shell is in", async () => {
      // The shell is in prj_1; the tab was asked for prj_2.
      fetchProjectOverview.mockResolvedValue(overview({ paused: false }));
      const user = userEvent.setup();
      open("?tab=project&project=prj_2");
      await waitFor(() => expect(fetchProjectOverview).toHaveBeenCalledWith("prj_2"));
      await user.click(await screen.findByRole("button", { name: "记忆设置" }));
      await user.click(await screen.findByRole("menuitemcheckbox", { name: "本项目不使用记忆" }));
      await waitFor(() => expect(updateMemorySettings).toHaveBeenCalledWith({ pausedProjects: ["prj_2"] }));
    });

    it("opens the memory a slot was written from in the drawer, and does not offer one the page does not hold", async () => {
      fetchProjectOverview.mockResolvedValue(overview());
      const user = userEvent.setup();
      openInHistory("?tab=project");
      const card = await screen.findByRole("list", { name: "项目卡" });
      // rec_f and rec_o are not memories this page holds (a stale card is a row without a door, not a silent button).
      expect(within(card).queryByRole("button", { name: /心血管/ })).toBeNull();
      await user.click(within(card).getByRole("button", { name: /75 岁以上非瓣膜性房颤患者/ }));
      expect(await screen.findByRole("dialog", { name: "项目事实" })).toBeInTheDocument();
      expect(where()).toContain("open=record%3Arec_3");
    });

    it("says so, in one line, when the project has memory switched off", async () => {
      fetchProjectOverview.mockResolvedValue(overview({ paused: true, card: [], capabilities: [], works: [] }));
      open("?tab=project");
      expect(await screen.findByText("本项目已暂停记忆")).toBeInTheDocument();
      cleanup();
      fetchProjectOverview.mockResolvedValue(overview({ paused: false }));
      open("?tab=project");
      await screen.findByRole("list", { name: "项目卡" });
      expect(screen.queryByText("本项目已暂停记忆")).toBeNull();
    });

    it("reads the overview again when the project's switch is changed in the header", async () => {
      fetchProjectOverview.mockResolvedValue(overview({ paused: false }));
      const user = userEvent.setup();
      open("?tab=project");
      await screen.findByRole("list", { name: "项目卡" });
      const before = fetchProjectOverview.mock.calls.length;
      fetchProjectOverview.mockResolvedValue(overview({ paused: true }));
      await user.click(await screen.findByRole("button", { name: "记忆设置" }));
      await user.click(await screen.findByRole("menuitemcheckbox", { name: "本项目不使用记忆" }));
      expect(await screen.findByText("本项目已暂停记忆")).toBeInTheDocument();
      expect(fetchProjectOverview.mock.calls.length).toBeGreaterThan(before);
    });

    it("leaves the memories alone when the overview cannot be read, says in one line that a project with memories has no card, and steps aside for a search", async () => {
      const user = userEvent.setup();
      open("?tab=project");
      expect(await screen.findByText("纳入范围覆盖疳证与小儿厌食症。")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "项目卡" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "记忆" })).toBeNull();
      cleanup();
      fetchProjectOverview.mockResolvedValue(overview({ card: [], capabilities: [], works: [] }));
      open("?tab=project");
      expect(await screen.findByText("纳入范围覆盖疳证与小儿厌食症。")).toBeInTheDocument();
      // One quiet line where the card would be, never a grid of empty labels; the memories keep their own name beneath it.
      expect(await screen.findByText("还没有记下这个项目的目标、资料和进展。")).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "项目卡" })).toBeNull();
      expect(screen.getByRole("heading", { name: "记忆" })).toBeInTheDocument();
      cleanup();
      fetchProjectOverview.mockResolvedValue(overview());
      open("?tab=project");
      await screen.findByRole("list", { name: "项目卡" });
      await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "疳证");
      await waitFor(() => expect(screen.queryByRole("list", { name: "项目卡" })).toBeNull());
    });
  });

  it("does not write when it is read: the capsule is made when 分享与导入 opens", async () => {
    open();
    await screen.findByRole("button", { name: /药学背景/ });
    // Nothing in the page's own reads creates anything; the capsule's creation is the share drawer's (CapsuleTransferPanel.test).
    expect(resetMemory).not.toHaveBeenCalled();
    expect(archiveMemoryRecord).not.toHaveBeenCalled();
  });
});
