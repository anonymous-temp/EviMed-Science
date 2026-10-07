import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { PersonalSkillDrawer } from "./PersonalSkillDrawer";

const skills = vi.hoisted(() => ({
  getPersonalSkill: vi.fn(), personalSkillHistory: vi.fn(), personalSkillDefaults: vi.fn(), projectSkills: vi.fn(), personalSkillSupply: vi.fn(),
  saveProjectSkills: vi.fn(), savePersonalSkillDefaults: vi.fn(), restorePersonalSkill: vi.fn(), removePersonalSkill: vi.fn(), updatePersonalSkill: vi.fn(),
}));
vi.mock("@/lib/skillLibraryClient", async original => ({ ...(await original<object>()), ...skills }));

const skill = { id: "skill:one", revision: 2, payload: { title: "检索方案", description: "核对检索式", instructions: "Use sources.", nativeName: "search-plan", digest: "sha256:two", resources: [{ id: "res:1", path: "资料/表.csv", digest: "sha256:r", size: 3 }], prepared: true }, createdAt: "", updatedAt: "", deletedAt: null };
const older = { revision: 1, payload: { ...skill.payload, title: "检索方案（旧）", instructions: "Older text." }, deletedAt: null, recordedAt: "2026-10-05T08:30:00.000Z" };
const newer = { revision: 2, payload: skill.payload, deletedAt: null, recordedAt: "2026-10-06T09:45:00.000Z" };
const handlers = { onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn() };
const show = () => render(<PersonalSkillDrawer skillId={skill.id} projectId="project-1" {...handlers} />);
beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.setState({ currentId: "project-1", projects: [{ id: "project-1", name: "我的研究" }] });
  skills.getPersonalSkill.mockResolvedValue(skill);
  skills.personalSkillHistory.mockResolvedValue([newer, older]);
  skills.personalSkillDefaults.mockResolvedValue({ revision: 5, payload: { skills: [] } });
  skills.projectSkills.mockResolvedValue({ revision: 6, payload: { skills: [] } });
  skills.personalSkillSupply.mockResolvedValue(null);
  skills.saveProjectSkills.mockResolvedValue({});
  skills.savePersonalSkillDefaults.mockResolvedValue({});
  skills.restorePersonalSkill.mockResolvedValue(skill);
  skills.removePersonalSkill.mockResolvedValue(skill);
});

it("opens on the skill's text and where it is used, in two tabs rather than ten stacked sections", async () => {
  show();
  const drawer = await screen.findByRole("dialog", { name: "检索方案" });
  expect(within(drawer).getByRole("tab", { name: "内容" })).toHaveAttribute("aria-selected", "true");
  expect(within(drawer).getByText("核对检索式")).toBeInTheDocument();
  expect(within(drawer).getByText("Use sources.")).toBeInTheDocument();
  expect(within(drawer).getByRole("link", { name: "资料/表.csv" })).toBeInTheDocument();
  expect(within(drawer).getByRole("switch", { name: "在“我的研究”里使用" })).not.toBeChecked();
  expect(within(drawer).getByRole("switch", { name: "新项目默认使用" })).not.toBeChecked();
  expect(drawer.textContent).not.toMatch(/版本 \d|当前项目选用版本|包摘要/);
});

it("the switches select the skill for this project and for new ones, at its current state", async () => {
  show();
  const drawer = await screen.findByRole("dialog", { name: "检索方案" });
  await userEvent.click(within(drawer).getByRole("switch", { name: "在“我的研究”里使用" }));
  await waitFor(() => expect(skills.saveProjectSkills).toHaveBeenCalledWith("project-1", 6, [{ skillId: "skill:one", revision: 2 }]));
  await userEvent.click(within(drawer).getByRole("switch", { name: "新项目默认使用" }));
  await waitFor(() => expect(skills.savePersonalSkillDefaults).toHaveBeenCalledWith(5, [{ skillId: "skill:one", revision: 2 }]));
});

it("a skill selected at an older state says so and updates only when asked — never silently", async () => {
  skills.projectSkills.mockResolvedValue({ revision: 6, payload: { skills: [{ skillId: "skill:one", revision: 1 }] } });
  skills.personalSkillDefaults.mockResolvedValue({ revision: 5, payload: { skills: [{ skillId: "skill:one", revision: 1 }] } });
  show();
  const drawer = await screen.findByRole("dialog", { name: "检索方案" });
  const updates = await within(drawer).findAllByRole("button", { name: "更新到最新内容" });
  expect(updates).toHaveLength(2);
  expect(skills.saveProjectSkills).not.toHaveBeenCalled();
  await userEvent.click(updates[0]);
  await waitFor(() => expect(skills.saveProjectSkills).toHaveBeenCalledWith("project-1", 6, [{ skillId: "skill:one", revision: 2 }]));
});

it("earlier states are told apart by the day and time they were saved, and restoring one asks the ledger for exactly that state", async () => {
  show();
  const drawer = await screen.findByRole("dialog", { name: "检索方案" });
  await userEvent.click(within(drawer).getByRole("tab", { name: "版本" }));
  const list = within(drawer).getByRole("list", { name: "版本记录" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("当前")).toBeInTheDocument();
  expect(list.textContent).not.toMatch(/版本 \d/);
  await userEvent.click(within(list).getByRole("button", { name: "恢复此版本" }));
  await waitFor(() => expect(skills.restorePersonalSkill).toHaveBeenCalledWith("skill:one", 2, 1));
  await waitFor(() => expect(handlers.onChanged).toHaveBeenCalled());
});

it("opening an earlier state compares its text with the current one, and the comparison closes", async () => {
  show();
  const drawer = await screen.findByRole("dialog", { name: "检索方案" });
  await userEvent.click(within(drawer).getByRole("tab", { name: "版本" }));
  const list = within(drawer).getByRole("list", { name: "版本记录" });
  await userEvent.click(within(list).getAllByRole("button")[1]);
  const compare = await within(drawer).findByRole("region", { name: "版本比较" });
  expect(within(compare).getByText("Older text.")).toBeInTheDocument();
  expect(within(compare).getByText("Use sources.")).toBeInTheDocument();
  await userEvent.click(within(compare).getByRole("button", { name: "收起比较" }));
  expect(within(drawer).queryByRole("region", { name: "版本比较" })).not.toBeInTheDocument();
});

it("the menu edits in the drawer, and a saved edit tells the list", async () => {
  skills.updatePersonalSkill.mockResolvedValue(skill);
  show();
  await screen.findByRole("dialog", { name: "检索方案" });
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
  await userEvent.clear(screen.getByLabelText("名称"));
  await userEvent.type(screen.getByLabelText("名称"), "新的检索方案");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(skills.updatePersonalSkill).toHaveBeenCalledWith("skill:one", expect.objectContaining({ expectedRevision: 2, title: "新的检索方案" })));
  await waitFor(() => expect(handlers.onChanged).toHaveBeenCalled());
});

it("removing is confirmed first, says what stays, and closes the drawer when it is done", async () => {
  show();
  await screen.findByRole("dialog", { name: "检索方案" });
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "移除" }));
  expect(skills.removePersonalSkill).not.toHaveBeenCalled();
  expect(screen.getByText(/现有版本记录和已生成的文件会保留/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "移除" }));
  await waitFor(() => expect(skills.removePersonalSkill).toHaveBeenCalledWith("skill:one", 2));
  await waitFor(() => expect(handlers.onRemoved).toHaveBeenCalled());
});

it("a skill that cannot be read says so with a way to read it again", async () => {
  skills.getPersonalSkill.mockRejectedValueOnce(new Error("down")).mockResolvedValue(skill);
  show();
  const alert = await screen.findByRole("alert");
  await userEvent.click(within(alert).getByRole("button", { name: "刷新" }));
  expect(await screen.findByText("Use sources.")).toBeInTheDocument();
});

it("a skill that is not there says so and goes back to the list in one click, with nothing to refresh", async () => {
  skills.getPersonalSkill.mockRejectedValue(new WebApiError("gone", { status: 404 }));
  skills.personalSkillHistory.mockRejectedValue(new WebApiError("gone", { status: 404 }));
  show();
  const drawer = await screen.findByRole("dialog", { name: "技能" });
  expect(within(drawer).getByText("找不到这个技能，它可能已被移除。")).toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument();
  expect(within(drawer).queryByText("我的技能")).not.toBeInTheDocument();
  expect(drawer.querySelector("[aria-hidden].animate-pulse, .animate-pulse")).toBeNull();
  await userEvent.click(within(drawer).getByRole("button", { name: "回到技能列表" }));
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("a read about the project that fails is not a missing skill, and keeps the line and the way to read it again", async () => {
  skills.projectSkills.mockRejectedValueOnce(new WebApiError("gone", { status: 404 })).mockResolvedValue({ revision: 6, payload: { skills: [] } });
  show();
  const alert = await screen.findByRole("alert");
  expect(screen.queryByText("找不到这个技能，它可能已被移除。")).not.toBeInTheDocument();
  await userEvent.click(within(alert).getByRole("button", { name: "刷新" }));
  expect(await screen.findByText("Use sources.")).toBeInTheDocument();
});

it("any other failure of the skill's own read keeps the line and 刷新", async () => {
  skills.getPersonalSkill.mockRejectedValueOnce(new WebApiError("down", { status: 500 })).mockResolvedValue(skill);
  show();
  const alert = await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "回到技能列表" })).not.toBeInTheDocument();
  await userEvent.click(within(alert).getByRole("button", { name: "刷新" }));
  expect(await screen.findByText("Use sources.")).toBeInTheDocument();
});

it("exports the skill's history through the authenticated portable endpoint, from the menu", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { expect(this.href).toContain("/skills/skill%3Aone"); });
  show();
  await screen.findByRole("dialog", { name: "检索方案" });
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "导出历史" }));
  expect(click).toHaveBeenCalledTimes(1);
  click.mockRestore();
});
