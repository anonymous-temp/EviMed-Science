import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { ExtensionsPage } from "./ExtensionsPage";

const skills = vi.hoisted(() => ({ listPlatformSkills: vi.fn(), projectPlatformSkills: vi.fn(), saveProjectPlatformSkills: vi.fn(), listPersonalSkills: vi.fn(), projectSkills: vi.fn(), pendingPersonalSkillTransfers: vi.fn(), readPlatformSkill: vi.fn() }));
const plugins = vi.hoisted(() => ({ inventory: vi.fn(), extensionCatalogue: vi.fn(), extensionInstallations: vi.fn(), projectExtensions: vi.fn(), projectBuiltinPlugins: vi.fn(), saveProjectBuiltinPlugins: vi.fn(), saveProjectExtensions: vi.fn(), extensionInstallation: vi.fn(), extensionHistory: vi.fn(), extensionConnections: vi.fn() }));
const api = vi.hoisted(() => ({ listWebPlugins: vi.fn(), saveWebPlugin: vi.fn(), listWebResearchAgents: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", async original => ({ ...(await original<object>()), ...skills }));
vi.mock("@/lib/extensionsClient", async original => ({ ...(await original<object>()), ...plugins }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<object>()), ...api }));
const source = { kind: "adapted", publisher: "K-Dense", repository: "K-Dense-AI/scientific-agent-skills", version: "v2.72.0", license: "MIT" };
const skill = { id: "curated:plot", name: "plot", title: "科学绘图", use: "制作可复现的研究图表", group: "数据与图表", source: "platform", canCopy: true, provenance: source, requirement: { required: false, reason: null } };
const activation = { phase: "effective", savedRevision: 3, effectiveRevision: 3, error: null };
const project = { id: "policy", revision: 3, payload: { disabled: [] }, items: [{ ...skill, enabled: true, effective: true }], activation };
const empty = { items: [], nextCursor: null };
function open(url = "/app/extensions/discover") {
  return render(<MemoryRouter initialEntries={[url]}><Routes><Route path="/app/extensions/:tab/:itemId?" element={<ExtensionsPage />} /></Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.setState({ currentId: "one", projects: [{ id: "one", name: "项目一" }, { id: "two", name: "项目二" }] });
  skills.listPlatformSkills.mockResolvedValue({ groups: [skill.group], geoGroup: "循证 GEO", loopxGroup: "长任务", items: [skill] });
  skills.projectPlatformSkills.mockResolvedValue(project);
  skills.listPersonalSkills.mockResolvedValue(empty);
  skills.projectSkills.mockResolvedValue({ revision: 3, payload: { skills: [] }, activation });
  skills.pendingPersonalSkillTransfers.mockResolvedValue(empty);
  plugins.inventory.mockResolvedValue({ projectId: "one", groups: [], researchTools: { count: 0, groups: [] } });
  plugins.extensionCatalogue.mockResolvedValue({ ...empty, generatedAt: "", availability: { state: "available", reason: null } });
  plugins.extensionInstallations.mockResolvedValue(empty);
  plugins.projectExtensions.mockResolvedValue({ revision: 0, selections: [], effectiveGeneration: null });
  plugins.projectBuiltinPlugins.mockResolvedValue({ revision: 3, payload: { disabled: [] }, items: [], activation });
  api.listWebPlugins.mockResolvedValue([]);
  api.listWebResearchAgents.mockResolvedValue([{ id: "peer-review", title: "审稿工具" }]);
});
it("opens discovery with publisher-visible cards, without a creation-first empty library", async () => {
  open();
  expect(await screen.findByRole("tab", { name: /发现/ })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByText("K-Dense")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "科学绘图" })).toBeInTheDocument();
  expect(screen.queryByText(/还没有自己的技能/)).not.toBeInTheDocument();
});

it("separates authored methods from upstream packages and exposes only the upstream GitHub link", async () => {
  skills.listPlatformSkills.mockResolvedValue({ groups: [skill.group], items: [skill,
    { ...skill, id: "curated:authored", title: "自研分析", provenance: { ...source, kind: "first-party-derived", publisher: "EviMed", upstreamPublisher: "K-Dense-AI" } },
  ] });
  open();
  const own = await screen.findByRole("region", { name: "EviMed Science" });
  expect(within(own).getByRole("button", { name: "自研分析" })).toBeInTheDocument();
  expect(within(own).queryByRole("link")).not.toBeInTheDocument();
  const upstream = screen.getByRole("region", { name: "第三方" });
  expect(within(upstream).getByRole("link", { name: "科学绘图 的 GitHub" })).toHaveAttribute("href", "https://github.com/K-Dense-AI/scientific-agent-skills");
  expect(screen.queryByText(/参考 K-Dense/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "清除筛选" })).not.toBeInTheDocument();
});

it("draws the GitHub link as the quiet text action beside it, not as a smaller link of its own", async () => {
  open("/app/extensions/installed");
  const link = await screen.findByRole("link", { name: "科学绘图 的 GitHub" });
  // One look for one job: a 20 px, 12 px link was a kind of control of its own on every view of the page (release walk of evimed-b559d4b7ebd0-1).
  expect(link).toHaveClass("h-sm", "text-ui", "rounded");
  expect(link).not.toHaveClass("text-caption");
  expect(link).toHaveAttribute("target", "_blank");
});

it("reads 发现 a page at a time: a section shows its first twelve cards and 显示更多, and a search starts it again", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ ...skill, id: `curated:own-${index}`, title: `自研方法 ${index + 1}`, provenance: { ...source, kind: "first-party" } }));
  skills.listPlatformSkills.mockResolvedValue({ groups: [skill.group], items: many });
  open();
  const own = await screen.findByRole("region", { name: "EviMed Science" });
  const cards = () => within(own).getAllByRole("listitem");
  await waitFor(() => expect(cards()).toHaveLength(12));
  // The section's count is the whole section's, not the window's.
  expect(within(own).getByText("31 项")).toBeInTheDocument();
  await userEvent.click(within(own).getByRole("button", { name: "显示更多 · 还有 19 个" }));
  expect(cards()).toHaveLength(31);
  expect(within(own).queryByRole("button", { name: /显示更多/ })).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索插件与技能" }), "自研");
  await waitFor(() => expect(cards()).toHaveLength(12));
  expect(within(own).getByRole("button", { name: "显示更多 · 还有 18 个" })).toBeInTheDocument();
});

it("keeps source filtering when switching between discovery and added", async () => {
  skills.listPlatformSkills.mockResolvedValue({ groups: [skill.group], items: [skill,
    { ...skill, id: "curated:authored", title: "自研分析", provenance: { ...source, kind: "first-party" } },
  ] });
  open("/app/extensions/discover?origin=first-party");
  expect(await screen.findByRole("button", { name: "自研分析" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "科学绘图" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "已添加" }));
  expect(await screen.findByRole("switch", { name: /自研分析/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "科学绘图" })).not.toBeInTheDocument();
});

it.each(["全部类型", "清除筛选"])("clears a legacy plugin route's implicit type with %s", async label => {
  open("/app/extensions/plugins");
  await screen.findByText("暂无可添加的扩展");
  if (label === "全部类型") {
    await userEvent.click(screen.getByRole("button", { name: "类型：插件" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: label }));
  } else await userEvent.click(screen.getByRole("button", { name: label }));
  expect(await screen.findByRole("button", { name: "科学绘图" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "类型" })).toBeInTheDocument();
});
it("offers a real current-project switch and keeps a disabled preinstalled skill in Added", async () => {
  const updated = { ...project, revision: 4, payload: { disabled: [skill.id] }, items: [{ ...skill, enabled: false, effective: true }], activation: { ...activation, phase: "waiting", savedRevision: 4 } };
  skills.saveProjectPlatformSkills.mockResolvedValue(updated);
  skills.projectPlatformSkills.mockResolvedValueOnce(project).mockResolvedValue(updated);
  open("/app/extensions/installed");
  const toggle = await screen.findByRole("switch", { name: /科学绘图/ });
  await userEvent.click(toggle);
  await waitFor(() => expect(skills.saveProjectPlatformSkills).toHaveBeenCalledWith("one", 3, [skill.id]));
  expect(await screen.findByText("等待当前任务结束后生效")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "科学绘图" })).toBeInTheDocument();
});
it("reports discovery failures while retaining usable preinstalled content", async () => {
  plugins.extensionCatalogue.mockRejectedValue(new Error("catalogue unavailable"));
  open();
  expect(await screen.findByRole("button", { name: "科学绘图" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "重试插件目录" })).toBeInTheDocument();
});
it("distinguishes a deployment catalogue that is unavailable from a successful empty catalogue", async () => {
  plugins.extensionCatalogue.mockResolvedValue({ ...empty, generatedAt: "", availability: { state: "unavailable", reason: "unconfigured" } });
  open("/app/extensions/discover?type=plugins");
  expect(await screen.findByText("暂未提供可添加的插件，已有功能仍可使用。")).toBeInTheDocument();
});
it("lists required and module skills under their groups with no control and no word about it", async () => {
  skills.listPlatformSkills.mockResolvedValue({ groups: [skill.group, "循证 GEO"], geoGroup: "循证 GEO", items: [skill,
    { ...skill, id: "core:guard", title: "必需校验", requirement: { required: true, reason: "system" } },
    { ...skill, id: "geo-private:internal", title: "内部方法", group: "循证 GEO", requirement: { required: true, reason: "private-workflow" } },
  ] });
  open("/app/extensions/installed");
  const guard = (await screen.findByRole("button", { name: "必需校验" })).closest("li")!;
  expect(within(guard).queryByRole("switch")).not.toBeInTheDocument();
  expect(within(guard).queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "内部方法" })).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: /内部方法/ })).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: /科学绘图/ })).toBeInTheDocument();
  expect(screen.queryByText(/始终开启|系统提供/)).not.toBeInTheDocument();
});
it("uses the selected project's effective plugin state", async () => {
  const coordinate = { kind: "npm", name: "sample-plugin", version: "1.0.0" };
  plugins.extensionCatalogue.mockResolvedValue({ items: [{ id: "sample", title: "示例插件", coordinate, settingsSchema: {} }], generatedAt: "" });
  plugins.extensionInstallations.mockResolvedValue({ items: [{ id: "extension:sample", catalogueId: "sample", coordinate, effective: false, phase: "waiting" }], nextCursor: null });
  plugins.projectExtensions.mockResolvedValue({ revision: 1, selections: [{ installationId: "extension:sample", enabled: true, effective: true, phase: "effective", settings: {}, connectionRefs: [] }], effectiveGeneration: "current" });
  open("/app/extensions/installed?type=plugins");
  const row = (await screen.findByRole("button", { name: "示例插件" })).closest("li")!;
  expect(within(row).getByText("已启用")).toBeInTheDocument();
  expect(within(row).queryByText("准备中")).not.toBeInTheDocument();
});
it("a late policy response from a previous project never replaces the current project's controls", async () => {
  let finish!: (value: typeof project) => void;
  skills.projectPlatformSkills.mockImplementation((id: string) => id === "one" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ...project, payload: { disabled: [skill.id] }, items: [{ ...skill, enabled: false, effective: false }] }));
  open("/app/extensions/installed");
  await screen.findByRole("button", { name: "科学绘图" });
  act(() => useProjectStore.setState({ currentId: "two" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: /科学绘图/ })).not.toBeChecked());
  await act(async () => finish(project));
  expect(screen.getByRole("switch", { name: /科学绘图/ })).not.toBeChecked();
});

it("changes an optional bundled plugin without routing it to citation settings", async () => {
  plugins.inventory.mockResolvedValue({ projectId: "one", groups: [{ id: "tools", title: "对话", items: [{ id: "diagrams", title: "Mermaid 图表", use: "呈现流程图", publisher: "社区作者", control: { kind: "switch", setting: "mermaid" }, opens: { kind: "drawer" } }] }], researchTools: { count: 0, groups: [] } });
  plugins.projectBuiltinPlugins.mockResolvedValue({ revision: 3, payload: { disabled: ["annotation"] }, items: [{ id: "annotation", enabled: false, effective: false, available: true }, { id: "mermaid", enabled: true, effective: true, available: true }], activation });
  plugins.saveProjectBuiltinPlugins.mockResolvedValue({ revision: 4, payload: { disabled: ["annotation", "mermaid"] }, items: [{ id: "annotation", enabled: false, effective: false, available: true }, { id: "mermaid", enabled: false, effective: true, available: true }], activation: { ...activation, phase: "waiting", savedRevision: 4 } });
  open("/app/extensions/installed?type=plugins");
  await userEvent.click(await screen.findByRole("switch", { name: /Mermaid 图表/ }));
  expect(plugins.saveProjectBuiltinPlugins).toHaveBeenCalledWith("one", 3, ["annotation", "mermaid"]);
  expect(await screen.findByText("等待当前任务结束后生效")).toBeInTheDocument();
});

it("keeps a removed account plugin's retained project version visible and removable", async () => {
  const retained = { installationId: "extension:removed", catalogueId: "removed", coordinate: { kind: "npm", name: "retained-plugin", version: "1.0.0" }, enabled: true, effective: true, phase: "effective", settings: {}, connectionRefs: [] };
  plugins.projectExtensions.mockResolvedValue({ revision: 5, selections: [retained], effectiveGeneration: "live" });
  plugins.saveProjectExtensions.mockResolvedValue({ revision: 6, selections: [], effectiveGeneration: null });
  open("/app/extensions/installed?type=plugins");
  expect(await screen.findByRole("button", { name: "retained-plugin" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "移出当前项目" }));
  expect(plugins.saveProjectExtensions).toHaveBeenCalledWith("one", 5, []);
  await waitFor(() => expect(screen.queryByRole("button", { name: "retained-plugin" })).not.toBeInTheDocument());
});

it("finds later installed pages before offering an Add action", async () => {
  const coordinate = { kind: "npm", name: "later-plugin", version: "1.0.0" };
  plugins.extensionCatalogue.mockResolvedValue({ items: [{ id: "later", title: "后页插件", coordinate, settingsSchema: {} }], generatedAt: "" });
  plugins.extensionInstallations.mockImplementation((cursor?: string) => Promise.resolve(cursor ? { items: [{ id: "extension:later", catalogueId: "later", coordinate, effective: false, phase: "waiting" }], nextCursor: null } : { items: [], nextCursor: "page2" }));
  open("/app/extensions/discover?type=plugins");
  await screen.findByRole("button", { name: "后页插件" });
  await waitFor(() => expect(plugins.extensionInstallations).toHaveBeenCalledWith("page2"));
  expect(screen.queryByRole("button", { name: "添加" })).not.toBeInTheDocument();
});

it("does not turn a deployment-disabled plugin into a personal disable while changing another plugin", async () => {
  plugins.inventory.mockResolvedValue({ projectId: "one", groups: [{ id: "tools", title: "对话", items: [{ id: "diagrams", title: "Mermaid 图表", use: "呈现流程图", control: { kind: "switch", setting: "mermaid" }, opens: { kind: "drawer" } }] }], researchTools: { count: 0, groups: [] } });
  plugins.projectBuiltinPlugins.mockResolvedValue({ revision: 3, payload: { disabled: [] }, items: [{ id: "annotation", enabled: false, effective: false, available: false }, { id: "mermaid", enabled: true, effective: true, available: true }], activation });
  plugins.saveProjectBuiltinPlugins.mockResolvedValue({ revision: 4, payload: { disabled: ["mermaid"] }, items: [], activation: { ...activation, phase: "waiting", savedRevision: 4 } });
  open("/app/extensions/installed?type=plugins");
  await userEvent.click(await screen.findByRole("switch", { name: /Mermaid 图表/ }));
  expect(plugins.saveProjectBuiltinPlugins).toHaveBeenCalledWith("one", 3, ["mermaid"]);
});

it("shows citation switch failures on the added page without requiring its drawer", async () => {
  plugins.inventory.mockResolvedValue({ projectId: "one", groups: [{ id: "tools", title: "对话", items: [{ id: "citations", title: "文献引用核对", use: "核对引用", control: { kind: "switch", setting: "dsh-cite" }, opens: { kind: "drawer" } }] }], researchTools: { count: 0, groups: [] } });
  api.listWebPlugins.mockResolvedValue([{ id: "dsh-cite", desired: { revision: 2, enabled: true, settings: {} }, effective: { enabled: true }, phase: "applied", settingsSchema: {} }]);
  api.saveWebPlugin.mockRejectedValue(new Error("temporary test failure"));
  open("/app/extensions/installed?type=plugins");
  await userEvent.click(await screen.findByRole("switch", { name: /文献引用核对/ }));
  expect(await screen.findByText("操作没有完成，请重试。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新引用设置" })).toBeInTheDocument();
});

it("closing a changed plugin drawer leaves the list current and its next switch uses the new revision", async () => {
  const coordinate = { kind: "npm", name: "drawer-plugin", version: "1.0.0" };
  const installation = { id: "extension:drawer", catalogueId: "drawer", coordinate, integrity: "sha256:fixture", revision: 1, effective: false, phase: "waiting" };
  let projectState = { revision: 5, selections: [{ installationId: installation.id, enabled: true, effective: true, phase: "effective", settings: {}, connectionRefs: [] }], effectiveGeneration: "live" };
  plugins.extensionCatalogue.mockResolvedValue({ items: [{ id: "drawer", title: "详情插件", coordinate, integrity: installation.integrity, settingsSchema: {} }], generatedAt: "" });
  plugins.extensionInstallations.mockResolvedValue({ items: [installation], nextCursor: null });
  plugins.extensionInstallation.mockResolvedValue(installation);
  plugins.extensionHistory.mockResolvedValue({ items: [], nextBeforeRevision: null });
  plugins.extensionConnections.mockResolvedValue({ items: [], supportedKinds: [] });
  plugins.projectExtensions.mockImplementation(async () => projectState);
  plugins.saveProjectExtensions.mockImplementation(async (_id: string, revision: number, selections: typeof projectState.selections) => {
    expect(revision).toBe(projectState.revision);
    projectState = { ...projectState, revision: revision + 1, selections: selections.map(item => ({ ...item, effective: item.enabled, phase: "effective" })) };
    return projectState;
  });
  open("/app/extensions/installed?type=plugins");
  await userEvent.click(await screen.findByRole("button", { name: "详情插件" }));
  const drawer = await screen.findByRole("dialog", { name: "详情插件" });
  await userEvent.click(await within(drawer).findByRole("button", { name: "停用" }));
  await waitFor(() => expect(plugins.saveProjectExtensions).toHaveBeenCalledTimes(1));
  await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
  const toggle = await screen.findByRole("switch", { name: /详情插件/ });
  await waitFor(() => expect(toggle).not.toBeChecked());
  await userEvent.click(toggle);
  await waitFor(() => expect(plugins.saveProjectExtensions).toHaveBeenCalledTimes(2));
  expect(plugins.saveProjectExtensions.mock.calls[1][1]).toBe(6);
});

it("a project with no runtime running says when its saved choice takes effect and is not polled", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const idle = { ...project, payload: { disabled: [skill.id] }, items: [{ ...skill, enabled: false, effective: null }], activation: { phase: "pending", savedRevision: 4, effectiveRevision: null, error: null, live: false } };
    skills.projectPlatformSkills.mockResolvedValue(idle);
    open("/app/extensions/installed");
    expect(await screen.findByText("下次对话生效")).toBeInTheDocument();
    expect(screen.queryByText("等待当前任务结束后生效")).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10 * 60 * 1000); });
    expect(skills.projectPlatformSkills).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("an apply under way on a running runtime is re-read with growing waits, then no more", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    skills.projectPlatformSkills.mockResolvedValue({ ...project, activation: { ...activation, phase: "waiting", savedRevision: 4, effectiveRevision: 3, live: true } });
    open("/app/extensions/installed");
    expect(await screen.findByText("等待当前任务结束后生效")).toBeInTheDocument();
    for (let round = 0; round < 12; round++) await act(async () => { vi.advanceTimersByTime(61000); });
    const calls = skills.projectPlatformSkills.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(8);
    await act(async () => { vi.advanceTimersByTime(30 * 60 * 1000); });
    expect(skills.projectPlatformSkills).toHaveBeenCalledTimes(calls);
  } finally { vi.useRealTimers(); }
});

it("a 循证 GEO project on its shared settings draws no project switch and says the choices do not apply there", async () => {
  const notApplicable = { phase: "not-applicable", savedRevision: 3, effectiveRevision: null, error: null, live: true };
  skills.projectPlatformSkills.mockResolvedValue({ ...project, activation: notApplicable });
  skills.projectSkills.mockResolvedValue({ revision: 3, payload: { skills: [] }, activation: notApplicable });
  plugins.inventory.mockResolvedValue({ projectId: "one", groups: [{ id: "tools", title: "对话", items: [
    { id: "diagrams", title: "Mermaid 图表", use: "呈现流程图", control: { kind: "switch", setting: "mermaid" }, opens: { kind: "drawer" } },
    { id: "citations", title: "文献引用核对", use: "核对引用", control: { kind: "switch", setting: "dsh-cite" }, opens: { kind: "drawer" } },
  ] }], researchTools: { count: 0, groups: [] } });
  plugins.projectBuiltinPlugins.mockResolvedValue({ revision: 3, payload: { disabled: [] }, items: [{ id: "annotation", enabled: true, effective: null, available: true }, { id: "mermaid", enabled: true, effective: null, available: true }], activation: notApplicable });
  api.listWebPlugins.mockResolvedValue([{ id: "dsh-cite", desired: { revision: 2, enabled: true, settings: {} }, effective: { enabled: true }, phase: "applied", settingsSchema: {} }]);
  open("/app/extensions/installed");
  const plot = (await screen.findByRole("button", { name: "科学绘图" })).closest("li")!;
  expect(within(plot).getByText("循证 GEO 项目中不适用")).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: /科学绘图/ })).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Mermaid 图表" })).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: /Mermaid 图表/ })).not.toBeInTheDocument();
  // The citation settings travel with the project's own plugin configuration, which a shared start keeps.
  expect(await screen.findByRole("switch", { name: /文献引用核对/ })).toBeInTheDocument();
});

it("an upstream skill the platform adapted says so on its row and in its drawer, which names no version or licence string", async () => {
  const adapted = { ...skill, provenance: { kind: "upstream-adapted", publisher: "K-Dense-AI", repository: "https://github.com/K-Dense-AI/scientific-agent-skills", version: "v2.72.0", license: "MIT" } };
  skills.listPlatformSkills.mockResolvedValue({ groups: [skill.group], items: [adapted] });
  skills.projectPlatformSkills.mockResolvedValue({ ...project, items: [{ ...adapted, enabled: true, effective: true }] });
  skills.readPlatformSkill.mockResolvedValue({ ...adapted, when: null, instructions: null });
  open("/app/extensions/installed");
  const row = (await screen.findByRole("button", { name: "科学绘图" })).closest("li")!;
  expect(within(row).getByText("K-Dense-AI · 已改编")).toBeInTheDocument();
  await userEvent.click(within(row).getByRole("button", { name: "科学绘图" }));
  const drawer = await screen.findByRole("dialog", { name: "科学绘图" });
  expect(within(drawer).getByText("已改编")).toBeInTheDocument();
  expect(within(drawer).getByText("K-Dense-AI 发布，平台为在线运行做过改编")).toBeInTheDocument();
  expect(within(drawer).queryByText("v2.72.0")).not.toBeInTheDocument();
  expect(within(drawer).queryByText("MIT")).not.toBeInTheDocument();
});
