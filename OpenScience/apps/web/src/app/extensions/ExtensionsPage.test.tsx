import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { useToastStore } from "@/lib/toast";
import { ExtensionsPage } from "./ExtensionsPage";

const skills = vi.hoisted(() => ({
  listPlatformSkills: vi.fn(), readPlatformSkill: vi.fn(), copyPlatformSkill: vi.fn(), listPersonalSkills: vi.fn(), pendingPersonalSkillTransfers: vi.fn(),
  getPersonalSkill: vi.fn(), personalSkillHistory: vi.fn(), personalSkillDefaults: vi.fn(), projectSkills: vi.fn(), personalSkillSupply: vi.fn(), createPersonalSkill: vi.fn(), saveProjectSkills: vi.fn(),
}));
const extensions = vi.hoisted(() => ({ pluginInventory: vi.fn(), extensionCatalogue: vi.fn(), extensionInstallations: vi.fn(), installExtension: vi.fn() }));
const api = vi.hoisted(() => ({ listWebPlugins: vi.fn(), saveWebPlugin: vi.fn(), listWebPluginRevisions: vi.fn(), retryWebPlugin: vi.fn(), rollbackWebPlugin: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", async original => ({ ...(await original<object>()), ...skills }));
vi.mock("@/lib/extensionsClient", async original => ({ ...(await original<object>()), ...extensions }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<object>()), ...api }));

const row = (name: string, group: string, extra: object = {}) => ({ id: `curated:${name}`, name, title: `${group}技能 ${name}`, use: `${name} 的一句话用途`, group, source: "platform", canCopy: true, ...extra });
const platformList = {
  groups: ["科研分析", "写作与核查", "办公文档", "社区", "循证 GEO"], geoGroup: "循证 GEO",
  items: [
    ...["a", "b", "c", "d", "e", "f"].map(name => row(name, "科研分析")),
    row("check", "写作与核查"),
    row("word", "办公文档"),
    row("ppt", "社区", { id: "community:ppt", source: "community", canCopy: false }),
  ],
};
const mine = { id: "skill:mine", revision: 1, payload: { title: "我的检索方案", description: "自己写的", instructions: "Use sources.", nativeName: "personal-x", digest: "sha256:x", resources: [], prepared: true }, createdAt: "", updatedAt: "", deletedAt: null };
const inventory = {
  projectId: "owned-project",
  items: [{ id: "dsh-cite", management: "project", enabled: true }, { id: "dsh-annotation", management: "deployment", enabled: true }, { id: "dsh-mermaid", management: "deployment", enabled: true }],
  webRead: true,
  researchTools: { count: 54, groups: [{ title: "文献与指南检索", tools: ["按关键词在 PubMed 里查论文。"] }, { title: "药品与安全", tools: ["查药品说明书。"] }] },
  engines: [
    { id: "meta_analysis", available: true }, { id: "vcr", available: true }, { id: "mendelian_randomization", available: false },
    { id: "drug_safety_analysis", available: true }, { id: "bibliometric_analysis", available: true }, { id: "peer_review", available: true }, { id: "research_topic_selection", available: true },
  ],
};
const citePlugin = {
  id: "dsh-cite", binaryVersion: "9.9.9", tools: ["cite_lookup", "cite_bibtex", "cite_health"], settingsSchema: { timeoutMs: { min: 2000, max: 15000 } },
  desired: { revision: 0, enabled: true, settings: { timeoutMs: 15000 } }, effective: null, phase: "saved", error: null, removed: false, limits: { minTimeoutMs: 2000, maxTimeoutMs: 15000 },
};

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
function open(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Where />
    <Routes><Route path="/app/extensions/:tab/:itemId?" element={<ExtensionsPage />} /></Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.setState({ currentId: "owned-project", projects: [{ id: "owned-project", name: "我的研究" }] });
  skills.listPlatformSkills.mockResolvedValue(platformList);
  skills.listPersonalSkills.mockResolvedValue({ items: [], nextCursor: null });
  skills.pendingPersonalSkillTransfers.mockResolvedValue({ items: [], nextCursor: null });
  skills.personalSkillHistory.mockResolvedValue([]);
  skills.personalSkillDefaults.mockResolvedValue({ revision: 1, payload: { skills: [] } });
  skills.projectSkills.mockResolvedValue({ revision: 1, payload: { skills: [] } });
  skills.personalSkillSupply.mockResolvedValue(null);
  skills.saveProjectSkills.mockResolvedValue({ revision: 2, payload: { skills: [] } });
  extensions.pluginInventory.mockResolvedValue(inventory);
  extensions.extensionCatalogue.mockResolvedValue({ items: [], generatedAt: "2026-10-07T00:00:00Z" });
  extensions.extensionInstallations.mockResolvedValue({ items: [], nextCursor: null });
  api.listWebPlugins.mockResolvedValue([citePlugin]);
  api.listWebPluginRevisions.mockResolvedValue([]);
});

it("lists the platform's skills by use with the reader's own first, four to a group and the rest on request", async () => {
  skills.listPersonalSkills.mockResolvedValue({ items: [mine], nextCursor: null });
  open("/app/extensions/skills");
  const own = await screen.findByRole("region", { name: "我的技能" });
  expect(within(own).getByText("我的检索方案")).toBeInTheDocument();
  const analysis = screen.getByRole("region", { name: "科研分析" });
  expect(within(analysis).getAllByRole("listitem")).toHaveLength(4);
  await userEvent.click(within(analysis).getByRole("button", { name: "展开其余 2 个" }));
  expect(within(analysis).getAllByRole("listitem")).toHaveLength(6);
  await userEvent.click(within(analysis).getByRole("button", { name: "收起" }));
  expect(within(analysis).getAllByRole("listitem")).toHaveLength(4);
  expect(screen.getByRole("region", { name: "写作与核查" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "循证 GEO" })).not.toBeInTheDocument();
  // Each row is the Chinese name and one line of use — never an identifier, and not the system word 「平台」 on every line.
  expect(within(analysis).getByText("a 的一句话用途")).toBeInTheDocument();
  expect(screen.queryByText("平台")).not.toBeInTheDocument();
  // The community group names itself once, in its heading; its row does not say it again (the drawer names the source).
  expect(within(screen.getByRole("region", { name: "社区" })).getAllByText("社区")).toHaveLength(1);
});

it("is one page titled for both tabs, with the counts, and has no runtime section and no learned-methods link", async () => {
  skills.listPersonalSkills.mockResolvedValue({ items: [mine], nextCursor: null });
  open("/app/extensions/skills");
  await screen.findByText("我的检索方案");
  expect(screen.getByRole("heading", { level: 1, name: "插件与技能" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /^技能\s*10$/ })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(screen.getByRole("tab", { name: /^插件\s*\d+$/ })).toBeInTheDocument());
  for (const gone of ["当前会话技能", "已学方法", "科研会话", "暂不可用", "来源尚未确认"]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
  expect(skills.listPlatformSkills).toHaveBeenCalledTimes(1);
});

it("one primary action creates or imports, and an empty library says what it can be given", async () => {
  open("/app/extensions/skills");
  const own = await screen.findByRole("region", { name: "我的技能" });
  expect(within(own).getByText(/还没有自己的技能/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "新建技能" }));
  expect(screen.getByRole("menuitem", { name: "创建技能" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitem", { name: "导入" }));
  const drawer = screen.getByRole("dialog", { name: "导入技能" });
  expect(within(drawer).getByLabelText("技能名称")).toBeInTheDocument();
});

it("a search shows every match across the groups, unfolded", async () => {
  open("/app/extensions/skills");
  await screen.findByRole("region", { name: "科研分析" });
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "技能 f");
  const analysis = screen.getByRole("region", { name: "科研分析" });
  expect(within(analysis).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "办公文档" })).not.toBeInTheDocument();
  await userEvent.clear(screen.getByRole("searchbox", { name: "搜索" }));
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "没有这个");
  expect(await screen.findByText("没有找到技能")).toBeInTheDocument();
});

it("a module's retired name still finds the module's skills, as its current name, and is never shown back", async () => {
  skills.listPlatformSkills.mockResolvedValue({ ...platformList, items: [...platformList.items, row("geo-x", "循证 GEO", { id: "geo-private:geo-x", canCopy: false })] });
  open("/app/extensions/skills");
  await screen.findByRole("region", { name: "科研分析" });
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "循证传播");
  const pack = await screen.findByRole("region", { name: "循证 GEO" });
  expect(within(pack).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "科研分析" })).not.toBeInTheDocument();
  expect(screen.queryByText(/循证传播/)).not.toBeInTheDocument();
});

it("a row opens its drawer on what it does, when it is used and its full text, and copies it as the reader's own", async () => {
  skills.readPlatformSkill.mockResolvedValue({ ...row("a", "科研分析"), when: "你提到生存时间时。", instructions: "## 步骤\n1. 确认时间变量" });
  skills.copyPlatformSkill.mockResolvedValue({ ...mine, id: "skill:copied" });
  skills.getPersonalSkill.mockResolvedValue({ ...mine, id: "skill:copied" });
  open("/app/extensions/skills");
  await userEvent.click(await screen.findByRole("button", { name: "科研分析技能 a" }));
  const drawer = await screen.findByRole("dialog", { name: "科研分析技能 a" });
  expect(within(drawer).getByText("平台内置 · 科研分析")).toBeInTheDocument();
  expect(within(drawer).getByText("它会做什么")).toBeInTheDocument();
  expect(within(drawer).getByText("a 的一句话用途")).toBeInTheDocument();
  expect(await within(drawer).findByText("你提到生存时间时。")).toBeInTheDocument();
  expect(within(drawer).getByText(/确认时间变量/)).toBeInTheDocument();
  await userEvent.click(within(drawer).getByRole("button", { name: "复制为我的技能" }));
  await waitFor(() => expect(skills.copyPlatformSkill).toHaveBeenCalledWith("curated:a", { title: "科研分析技能 a", idempotencyKey: expect.any(String) }));
  // The visible result: the copy is open as the reader's own skill, at its own address.
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/skills/skill%3Acopied"));
  expect(await screen.findByRole("dialog", { name: "我的检索方案" })).toBeInTheDocument();
});

it("a skill this image cannot copy offers no copy, and one whose text cannot be read still shows its words", async () => {
  skills.readPlatformSkill.mockResolvedValue({ ...row("ppt", "社区", { id: "community:ppt", source: "community", canCopy: false }), when: null, instructions: null });
  open("/app/extensions/skills");
  await userEvent.click(await screen.findByRole("button", { name: "社区技能 ppt" }));
  const drawer = await screen.findByRole("dialog", { name: "社区技能 ppt" });
  expect(within(drawer).getByText("ppt 的一句话用途")).toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "复制为我的技能" })).not.toBeInTheDocument();
  expect(within(drawer).queryByText("全文")).not.toBeInTheDocument();
});

it("a list that cannot be read says so with a way to try again, and the reader's own skills still show", async () => {
  skills.listPlatformSkills.mockRejectedValueOnce(new WebApiError("down", { status: 503 })).mockResolvedValue(platformList);
  skills.listPersonalSkills.mockResolvedValue({ items: [mine], nextCursor: null });
  open("/app/extensions/skills");
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByText("我的检索方案")).toBeInTheDocument();
  await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("region", { name: "科研分析" })).toBeInTheDocument();
});

it("the plugins tab lists what a conversation works with and the engines, each with only what is true of it", async () => {
  open("/app/extensions/plugins");
  const tools = await screen.findByRole("region", { name: "对话里的工具" });
  for (const name of ["文献引用核对", "医学研究工具集", "网页阅读", "划词批注", "Mermaid 图表"]) expect(within(tools).getByText(name)).toBeInTheDocument();
  expect(within(tools).getAllByText("始终开启")).toHaveLength(4);
  expect(within(tools).getByRole("switch", { name: "在当前项目里使用文献引用核对" })).toBeChecked();
  const engines = screen.getByRole("region", { name: "计算引擎" });
  expect(within(engines).getAllByRole("listitem")).toHaveLength(3);
  expect(within(engines).getByText("Meta 分析引擎")).toBeInTheDocument();
  await userEvent.click(within(engines).getByRole("button", { name: "展开其余 4 个：药物警戒、文献计量、论文审稿、科研选题" }));
  expect(within(engines).getAllByRole("listitem")).toHaveLength(7);
  // Only the engine that cannot take work says so; an engine that can says nothing, because that is not a state to act on.
  expect(within(engines).getAllByText("暂不可用")).toHaveLength(1);
  expect(within(engines).queryByText("可用")).not.toBeInTheDocument();
  const text = document.body.textContent ?? "";
  for (const word of ["尚未确认", "版本 0", "毫秒", "技术标识", "已验证生效配置", "内置能力", "发现"]) expect(text).not.toContain(word);
  expect(screen.getByRole("tab", { name: /^插件\s*12$/ })).toBeInTheDocument();
});

it("the switch on the citation row saves for this project at once and the row says nothing about versions", async () => {
  api.saveWebPlugin.mockResolvedValue({ ...citePlugin, desired: { revision: 1, enabled: false, settings: { timeoutMs: 15000 } } });
  open("/app/extensions/plugins");
  const toggle = await screen.findByRole("switch", { name: "在当前项目里使用文献引用核对" });
  await waitFor(() => expect(toggle).toBeEnabled());
  await userEvent.click(toggle);
  await waitFor(() => expect(api.saveWebPlugin).toHaveBeenCalledWith("owned-project", "dsh-cite", { expectedRevision: 0, enabled: false, settings: { timeoutMs: 15000 } }, expect.anything()));
  await waitFor(() => expect(screen.getByRole("switch", { name: "在当前项目里使用文献引用核对" })).not.toBeChecked());
});

it.each(["failed", "rolled_back", "unavailable"])("a citation setting that did not take (%s) is said on its row, where the switch would otherwise show the saved wish", async phase => {
  api.listWebPlugins.mockResolvedValue([{ ...citePlugin, phase }]);
  open("/app/extensions/plugins");
  const row = (await screen.findByRole("switch", { name: "在当前项目里使用文献引用核对" })).closest("li")!;
  await waitFor(() => expect(within(row).getByText("这项设置没能生效，点开重试")).toBeInTheDocument());
});

it("a citation setting that took, or is still on its way, says nothing of the kind on its row", async () => {
  for (const phase of ["effective", "pending"]) {
    api.listWebPlugins.mockResolvedValue([{ ...citePlugin, phase }]);
    const view = open("/app/extensions/plugins");
    const row = (await screen.findByRole("switch", { name: "在当前项目里使用文献引用核对" })).closest("li")!;
    await waitFor(() => expect(row.textContent).toContain("核对"));
    expect(screen.queryByText("这项设置没能生效，点开重试")).not.toBeInTheDocument();
    view.unmount();
  }
});

it("the research tool set opens on its tools by group, one sentence each, with no tool name", async () => {
  open("/app/extensions/plugins");
  await userEvent.click(await screen.findByRole("button", { name: "医学研究工具集" }));
  const drawer = await screen.findByRole("dialog", { name: "医学研究工具集" });
  expect(within(drawer).getByText("提供的工具 · 54 个")).toBeInTheDocument();
  expect(within(drawer).getByText("文献与指南检索")).toBeInTheDocument();
  expect(within(drawer).getByText("按关键词在 PubMed 里查论文。")).toBeInTheDocument();
  expect(drawer.textContent).not.toMatch(/literature_search|mcp__/);
});

it("an engine opens on what it does and whether it can take work now", async () => {
  open("/app/extensions/plugins");
  const engines = await screen.findByRole("region", { name: "计算引擎" });
  await userEvent.click(within(engines).getByRole("button", { name: "Meta 分析引擎" }));
  const drawer = await screen.findByRole("dialog", { name: "Meta 分析引擎" });
  expect(within(drawer).getByText("计算引擎 · 可用")).toBeInTheDocument();
  expect(within(drawer).getByText("什么时候会用到")).toBeInTheDocument();
});

it("web reading, annotation and diagrams the deployment turned off are not listed", async () => {
  extensions.pluginInventory.mockResolvedValue({ ...inventory, webRead: false, items: [inventory.items[0], { ...inventory.items[1], enabled: false }, inventory.items[2]], engines: [] });
  open("/app/extensions/plugins");
  const tools = await screen.findByRole("region", { name: "对话里的工具" });
  expect(within(tools).queryByText("网页阅读")).not.toBeInTheDocument();
  expect(within(tools).queryByText("划词批注")).not.toBeInTheDocument();
  expect(within(tools).getByText("Mermaid 图表")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "计算引擎" })).not.toBeInTheDocument();
});

it("discovery appears as 「可以添加」 only when the deployment offers a package, and adding one opens it", async () => {
  const offered = { id: "table-tool", title: "表格工具", coordinate: { kind: "npm", name: "table-tool", version: "1.0.0" }, executionClass: "isolated-tool", settingsSchema: {}, evidenceState: "source-assessed", qualification: null };
  extensions.extensionCatalogue.mockResolvedValue({ items: [offered], generatedAt: "2026-10-07T00:00:00Z" });
  extensions.installExtension.mockResolvedValue({ installation: { id: "extension:added" }, job: null });
  open("/app/extensions/plugins");
  const group = await screen.findByRole("region", { name: "可以添加" });
  expect(within(group).getByText("表格工具")).toBeInTheDocument();
  await userEvent.click(within(group).getByRole("button", { name: "添加" }));
  await waitFor(() => expect(extensions.installExtension).toHaveBeenCalledWith(offered.coordinate, expect.any(String)));
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/plugins/extension%3Aadded"));
});

it("an inventory that cannot be read says so with a way to try again", async () => {
  extensions.pluginInventory.mockRejectedValueOnce(new WebApiError("down", { status: 503 })).mockResolvedValue(inventory);
  open("/app/extensions/plugins");
  const alert = await screen.findByRole("alert");
  await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("region", { name: "对话里的工具" })).toBeInTheDocument();
});

it("switching tabs keeps one page and clears the search", async () => {
  open("/app/extensions/skills");
  await screen.findByRole("region", { name: "科研分析" });
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "没有这个");
  await userEvent.click(screen.getByRole("tab", { name: /^插件/ }));
  expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/plugins");
  expect(screen.getByRole("searchbox", { name: "搜索" })).toHaveValue("");
  await screen.findByRole("region", { name: "对话里的工具" });
  expect(screen.queryByRole("button", { name: "新建技能" })).not.toBeInTheDocument();
  // Both lists were read once, on arrival: going back and forth reads nothing again.
  await userEvent.click(screen.getByRole("tab", { name: /^技能/ }));
  await screen.findByRole("region", { name: "科研分析" });
  expect(skills.listPlatformSkills).toHaveBeenCalledTimes(1);
  expect(skills.listPersonalSkills).toHaveBeenCalledTimes(1);
  expect(extensions.pluginInventory).toHaveBeenCalledTimes(1);
});

it("an address with no such tab goes to the skills tab", async () => {
  open("/app/extensions/nothing");
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/skills"));
  expect(await screen.findByRole("region", { name: "科研分析" })).toBeInTheDocument();
});

const openCreate = async () => {
  open("/app/extensions/skills");
  await userEvent.click(await screen.findByRole("button", { name: "新建技能" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "创建技能" }));
  return screen.getByRole("dialog", { name: "新建技能" });
};
const created = { ...mine, id: "skill:created", revision: 1 };

it("creating a skill saves it from the drawer, selects it for the current project and opens it at its own address", async () => {
  skills.createPersonalSkill.mockResolvedValue(created);
  skills.getPersonalSkill.mockResolvedValue(created);
  skills.projectSkills.mockResolvedValue({ revision: 7, payload: { skills: [{ skillId: "skill:other", revision: 3 }] } });
  const drawer = await openCreate();
  await userEvent.type(within(drawer).getByLabelText("名称"), "我的检索方案");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "先查指南，再查试验登记。");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(skills.createPersonalSkill).toHaveBeenCalledWith({ expectedRevision: 0, title: "我的检索方案", description: "", instructions: "先查指南，再查试验登记。" }));
  // The skill is on for the project the reader is in without a second visit.
  await waitFor(() => expect(skills.saveProjectSkills).toHaveBeenCalledTimes(1));
  expect(skills.saveProjectSkills).toHaveBeenCalledWith("owned-project", 7, [{ skillId: "skill:other", revision: 3 }, { skillId: "skill:created", revision: 1 }]);
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/skills/skill%3Acreated"));
  expect(await screen.findByRole("dialog", { name: "我的检索方案" })).toBeInTheDocument();
});

it("the create form says what the purpose and the text are for, with an example in each field and the switch on", async () => {
  const drawer = await openCreate();
  expect(within(drawer).getByLabelText("名称")).toHaveAttribute("placeholder", "例如：随访资料整理");
  const purpose = within(drawer).getByLabelText("用途");
  expect(purpose).toHaveAttribute("placeholder", expect.stringContaining("例如：我给出一批随访记录"));
  expect(purpose).toHaveAccessibleDescription("写清什么时候该用它。对话里 EviMed 靠这一句决定要不要用到这个技能。");
  const text = within(drawer).getByLabelText("技能说明");
  expect(text).toHaveAttribute("placeholder", expect.stringContaining("需要的输入：…"));
  expect(text).toHaveAccessibleDescription("写清怎么做：需要什么输入、分几步、产出什么、哪些事不能做。");
  expect(text).not.toHaveClass("font-mono");
  expect(within(drawer).getByRole("switch", { name: "保存后在“我的研究”里使用" })).toBeChecked();
});

it("a skill saved with the switch off is not selected for the project", async () => {
  skills.createPersonalSkill.mockResolvedValue(created);
  skills.getPersonalSkill.mockResolvedValue(created);
  const drawer = await openCreate();
  await userEvent.type(within(drawer).getByLabelText("名称"), "我的检索方案");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "先查指南。");
  await userEvent.click(within(drawer).getByRole("switch", { name: "保存后在“我的研究”里使用" }));
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/skills/skill%3Acreated"));
  expect(skills.saveProjectSkills).not.toHaveBeenCalled();
});

it("an empty or space-only name or text is named in place and nothing is sent", async () => {
  const drawer = await openCreate();
  await userEvent.type(within(drawer).getByLabelText("名称"), "   ");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  expect(within(drawer).getByText("请填写名称")).toBeInTheDocument();
  expect(within(drawer).getByLabelText("名称")).toHaveFocus();
  expect(within(drawer).getByText("请写出这个技能怎么做")).toBeInTheDocument();
  expect(skills.createPersonalSkill).not.toHaveBeenCalled();
  // The sentence leaves as soon as the field is being filled in.
  await userEvent.type(within(drawer).getByLabelText("名称"), "检索");
  expect(within(drawer).queryByText("请填写名称")).not.toBeInTheDocument();
  expect(within(drawer).getByText("请写出这个技能怎么做")).toBeInTheDocument();
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "  \n ");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  expect(within(drawer).getByText("请写出这个技能怎么做")).toBeInTheDocument();
  expect(within(drawer).getByLabelText("技能说明")).toHaveFocus();
  expect(skills.createPersonalSkill).not.toHaveBeenCalled();
});

it("two clicks on 保存 while the first is on its way make one skill", async () => {
  let finish!: (value: typeof created) => void;
  skills.createPersonalSkill.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  skills.getPersonalSkill.mockResolvedValue(created);
  const drawer = await openCreate();
  await userEvent.type(within(drawer).getByLabelText("名称"), "我的检索方案");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "先查指南。");
  const save = within(drawer).getByRole("button", { name: "保存" });
  await userEvent.click(save);
  await userEvent.click(save);
  fireEvent.submit(drawer.querySelector("form")!);
  expect(skills.createPersonalSkill).toHaveBeenCalledTimes(1);
  // The drawer does not close under a save that has not finished.
  await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("dialog", { name: "新建技能" })).toBeInTheDocument();
  finish(created);
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/skills/skill%3Acreated"));
  expect(skills.createPersonalSkill).toHaveBeenCalledTimes(1);
  expect(skills.saveProjectSkills).toHaveBeenCalledTimes(1);
});

it("a skill that was saved but could not be switched on for the project is kept, opened, and the reader is told where to turn it on", async () => {
  skills.createPersonalSkill.mockResolvedValue(created);
  skills.getPersonalSkill.mockResolvedValue(created);
  skills.saveProjectSkills.mockRejectedValue(new WebApiError("later", { status: 503 }));
  const drawer = await openCreate();
  await userEvent.type(within(drawer).getByLabelText("名称"), "我的检索方案");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "先查指南。");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/extensions/skills/skill%3Acreated"));
  expect(await screen.findByRole("dialog", { name: "我的检索方案" })).toBeInTheDocument();
  expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain("技能已保存，但没能在当前项目启用，可在详情里打开。");
});

it("a skill the server refused to create says why and leaves the form as it was", async () => {
  skills.createPersonalSkill.mockRejectedValue(new WebApiError("bad", { status: 400, code: "extension_contract_invalid" }));
  const drawer = await openCreate();
  await userEvent.type(within(drawer).getByLabelText("名称"), "我的检索方案");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "先查指南。");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain("提交的内容格式不正确，请检查后重新提交。"));
  expect(screen.getByRole("dialog", { name: "新建技能" })).toBeInTheDocument();
  expect(within(drawer).getByLabelText("名称")).toHaveValue("我的检索方案");
  expect(skills.saveProjectSkills).not.toHaveBeenCalled();
});

it("an address that names one of the reader's skills opens it, and closing returns to the list", async () => {
  skills.listPersonalSkills.mockResolvedValue({ items: [mine], nextCursor: null });
  skills.getPersonalSkill.mockResolvedValue(mine);
  open("/app/extensions/skills/skill:mine");
  const drawer = await screen.findByRole("dialog", { name: "我的检索方案" });
  await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/extensions\/skills$/));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("the method pack's group is marked with the module's radar by the name the server gives it, never one the page spells", async () => {
  skills.listPlatformSkills.mockResolvedValue({ ...platformList, groups: [...platformList.groups, "方法包"], geoGroup: "方法包", items: [...platformList.items, row("geo-x", "方法包", { id: "geo-private:geo-x", canCopy: false })] });
  open("/app/extensions/skills");
  const group = await screen.findByRole("region", { name: "方法包" });
  expect(group.querySelector("svg.lucide-radar")).not.toBeNull();
  expect(screen.getByRole("region", { name: "科研分析" }).querySelector("svg.lucide-radar")).toBeNull();
});
