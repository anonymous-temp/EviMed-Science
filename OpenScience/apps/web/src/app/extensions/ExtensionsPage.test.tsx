import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { useToastStore } from "@/lib/toast";
import { ExtensionsPage } from "./ExtensionsPage";

// Existing authoring and deep-link journeys remain supported by the new catalogue.
const skills = vi.hoisted(() => ({ listPlatformSkills: vi.fn(), projectPlatformSkills: vi.fn(), listPersonalSkills: vi.fn(), pendingPersonalSkillTransfers: vi.fn(),
  getPersonalSkill: vi.fn(), personalSkillHistory: vi.fn(), personalSkillDefaults: vi.fn(), projectSkills: vi.fn(), personalSkillSupply: vi.fn(), createPersonalSkill: vi.fn(), saveProjectSkills: vi.fn() }));
const extensions = vi.hoisted(() => ({ inventory: vi.fn(), extensionCatalogue: vi.fn(), extensionInstallations: vi.fn(), projectExtensions: vi.fn(), projectBuiltinPlugins: vi.fn() }));
const api = vi.hoisted(() => ({ listWebPlugins: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", async original => ({ ...(await original<object>()), ...skills }));
vi.mock("@/lib/extensionsClient", async original => ({ ...(await original<object>()), ...extensions }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<object>()), ...api }));
const mine = { id: "skill:mine", revision: 1, payload: { title: "我的检索方案", description: "自己写的", instructions: "Use sources.", nativeName: "personal-x", digest: "sha256:x", resources: [], prepared: true }, createdAt: "", updatedAt: "", deletedAt: null };
function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
function open(path: string) { return render(<MemoryRouter initialEntries={[path]}><Where /><Routes><Route path="/app/extensions/:tab/:itemId?" element={<ExtensionsPage />} /></Routes></MemoryRouter>); }
beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.setState({ currentId: "owned-project", projects: [{ id: "owned-project", name: "我的研究" }] });
  skills.listPlatformSkills.mockResolvedValue({ groups: [], geoGroup: "循证 GEO", loopxGroup: "长任务", items: [] });
  skills.projectPlatformSkills.mockResolvedValue({ id: "policy", revision: 1, payload: { disabled: [] }, items: [], activation: { phase: "effective", savedRevision: 1, effectiveRevision: 1, error: null } });
  skills.listPersonalSkills.mockResolvedValue({ items: [], nextCursor: null });
  skills.pendingPersonalSkillTransfers.mockResolvedValue({ items: [], nextCursor: null });
  skills.personalSkillHistory.mockResolvedValue([]);
  skills.personalSkillDefaults.mockResolvedValue({ revision: 1, payload: { skills: [] } });
  skills.projectSkills.mockResolvedValue({ revision: 1, payload: { skills: [] } });
  skills.personalSkillSupply.mockResolvedValue(null);
  skills.saveProjectSkills.mockResolvedValue({ revision: 2, payload: { skills: [] } });
  extensions.inventory.mockResolvedValue({ projectId: "owned-project", groups: [], researchTools: { count: 0, groups: [] } });
  extensions.extensionCatalogue.mockResolvedValue({ items: [], generatedAt: "" });
  extensions.extensionInstallations.mockResolvedValue({ items: [], nextCursor: null });
  extensions.projectExtensions.mockResolvedValue({ revision: 0, selections: [], effectiveGeneration: null });
  extensions.projectBuiltinPlugins.mockResolvedValue({ revision: 1, payload: { disabled: [] }, items: [], activation: { phase: "saved", savedRevision: 1, effectiveRevision: null, error: null } });
  api.listWebPlugins.mockResolvedValue([]);
});

const openCreate = async () => {
  open("/app/extensions/skills");
  await userEvent.click(await screen.findByRole("button", { name: "导入与创建" }));
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
  await userEvent.type(within(drawer).getByLabelText("用途"), "核对检索资料时使用。");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "先查指南，再查试验登记。");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(skills.createPersonalSkill).toHaveBeenCalledWith({ expectedRevision: 0, title: "我的检索方案", description: "核对检索资料时使用。", instructions: "先查指南，再查试验登记。" }));
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
  await userEvent.type(within(drawer).getByLabelText("用途"), "核对检索资料时使用。");
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
  await userEvent.type(within(drawer).getByLabelText("用途"), "核对检索资料时使用。");
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
  await userEvent.type(within(drawer).getByLabelText("用途"), "核对检索资料时使用。");
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
  await userEvent.type(within(drawer).getByLabelText("用途"), "核对检索资料时使用。");
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
  await userEvent.type(within(drawer).getByLabelText("用途"), "核对检索资料时使用。");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "先查指南。");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  expect(await within(drawer).findByRole("alert")).toHaveTextContent("提交的内容格式不正确，请检查后重新提交。");
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
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/extensions\/installed$/));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("an empty native purpose is refused in place before saving, then clears as it is supplied", async () => {
  const drawer = await openCreate();
  await userEvent.type(within(drawer).getByLabelText("名称"), "检索核对");
  await userEvent.type(within(drawer).getByLabelText("技能说明"), "Preserve quotations.");
  await userEvent.type(within(drawer).getByLabelText("用途"), "   ");
  await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
  expect(within(drawer).getByText("请写出什么时候使用这个技能")).toBeInTheDocument();
  expect(within(drawer).getByLabelText("用途")).toHaveFocus();
  expect(within(drawer).getByLabelText("用途")).toHaveAttribute("aria-required", "true");
  expect(skills.createPersonalSkill).not.toHaveBeenCalled();
  await userEvent.type(within(drawer).getByLabelText("用途"), "核对来源时使用。");
  expect(within(drawer).queryByText("请写出什么时候使用这个技能")).not.toBeInTheDocument();
});
