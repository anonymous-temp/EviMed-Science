import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { ExtensionsPage } from "./ExtensionsPage";

const skills = vi.hoisted(() => ({ listPlatformSkills: vi.fn(), projectPlatformSkills: vi.fn(), saveProjectPlatformSkills: vi.fn(), listPersonalSkills: vi.fn(), projectSkills: vi.fn(), pendingPersonalSkillTransfers: vi.fn() }));
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
it("opens discovery with publisher-visible cards, without a creation-first empty library or duplicated workflows", async () => {
  open();
  expect(await screen.findByRole("tab", { name: /发现/ })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByText("K-Dense · 适配版")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "科学绘图" })).toBeInTheDocument();
  expect(screen.queryByText(/还没有自己的技能/)).not.toBeInTheDocument();
  expect(api.listWebResearchAgents).not.toHaveBeenCalled();
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
it("hides required and module-private skills from discovery", async () => {
  skills.listPlatformSkills.mockResolvedValue({ groups: [skill.group, "循证 GEO"], geoGroup: "循证 GEO", items: [skill,
    { ...skill, id: "core:guard", title: "必需校验", requirement: { required: true, reason: "system" } },
    { ...skill, id: "geo-private:internal", title: "内部方法", group: "循证 GEO" },
  ] });
  open();
  await screen.findByRole("button", { name: "科学绘图" });
  expect(screen.queryByRole("button", { name: "必需校验" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "内部方法" })).not.toBeInTheDocument();
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
  await waitFor(() => expect(screen.getByRole("switch", { name: /科学绘图/ })).toHaveAttribute("aria-checked", "false"));
  await act(async () => finish(project));
  expect(screen.getByRole("switch", { name: /科学绘图/ })).toHaveAttribute("aria-checked", "false");
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
