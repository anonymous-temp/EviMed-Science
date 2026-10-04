import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillUpdatePanel } from "./SkillUpdatePanel";

const api = vi.hoisted(() => ({ previewPersonalSkillRepository: vi.fn(), previewSkillUpdate: vi.fn(), applySkillUpdate: vi.fn(), uploadPersonalSkill: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", async (original) => ({ ...(await original<object>()), ...api }));

const source = { kind: "repository", repository: "owner/skill", commit: "a".repeat(40), path: "skills/a", package: null, digest: null };
const plan = {
  revision: 2, baseKnown: true, changes: 1, conflicts: 1,
  counts: { unchanged: 3, same: 0, "keep-local": 1, "take-upstream": 1, add: 0, remove: 0, conflict: 1 },
  entries: [
    { scope: "part", name: "description", decision: "take-upstream", side: "upstream" },
    { scope: "part", name: "instructions", decision: "conflict", side: "local" },
    { scope: "part", name: "metadata", decision: "unchanged", side: "local" },
    { scope: "resource", name: "scripts/a.py", decision: "keep-local", side: "local" },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  api.previewPersonalSkillRepository.mockResolvedValue({ resourceId: "upload:new", immutableSource: {}, preview: {}, findings: [] });
  api.previewSkillUpdate.mockResolvedValue(plan);
  api.applySkillUpdate.mockResolvedValue({ ...plan, skill: { revision: 3 }, applied: true, taken: ["description"], kept: ["instructions"], pinnedRevision: 2 });
});

it("shows what an update would change before it changes anything, with the repository prefilled from where the skill came from", async () => {
  const user = userEvent.setup();
  render(<SkillUpdatePanel skillId="skill:one" revision={2} source={source as never} onApplied={() => {}} />);
  expect(screen.getByLabelText("公开仓库")).toHaveValue("owner/skill");
  expect(screen.getByLabelText("技能子目录")).toHaveValue("skills/a");
  await user.type(screen.getByLabelText("新版本的提交"), "b".repeat(40));
  await user.click(screen.getByRole("button", { name: "查看会改什么" }));
  expect(await screen.findByText("采用新版本的更新")).toBeInTheDocument();
  expect(screen.getByText("保留你的修改")).toBeInTheDocument();
  expect(screen.getByText("两边都改了")).toBeInTheDocument();
  expect(screen.queryByText("无变化")).not.toBeInTheDocument();
  expect(api.previewPersonalSkillRepository).toHaveBeenCalledWith({ repository: "owner/skill", commit: "b".repeat(40), subdirectory: "skills/a" });
  expect(api.previewSkillUpdate).toHaveBeenCalledWith("skill:one", "upload:new");
  expect(api.applySkillUpdate).not.toHaveBeenCalled();
});

it("keeps the researcher's text on a conflict unless they choose the new one, and says that projects keep the old revision", async () => {
  const user = userEvent.setup(), applied = vi.fn();
  render(<SkillUpdatePanel skillId="skill:one" revision={2} source={source as never} onApplied={applied} />);
  await user.type(screen.getByLabelText("新版本的提交"), "b".repeat(40));
  await user.click(screen.getByRole("button", { name: "查看会改什么" }));
  const choice = await screen.findByLabelText("说明正文 的处理");
  expect(choice).toHaveValue("local");
  await user.selectOptions(choice, "upstream");
  await user.click(screen.getByRole("button", { name: "更新为新版本" }));
  await waitFor(() => expect(api.applySkillUpdate).toHaveBeenCalledWith("skill:one", { resourceId: "upload:new", expectedRevision: 2, resolutions: { instructions: "upstream" } }));
  expect(await screen.findByText(/已生成新版本 3；项目和对话仍使用版本 2/)).toBeInTheDocument();
  expect(applied).toHaveBeenCalled();
});

it("an unknown origin is a conflict everywhere and the page says why; a short commit is refused before any request", async () => {
  const user = userEvent.setup();
  api.previewSkillUpdate.mockResolvedValue({ ...plan, baseKnown: false, changes: 0, conflicts: 2 });
  render(<SkillUpdatePanel skillId="skill:one" revision={2} source={source as never} onApplied={() => {}} />);
  await user.type(screen.getByLabelText("新版本的提交"), "abc");
  await user.click(screen.getByRole("button", { name: "查看会改什么" }));
  expect(await screen.findByText("请填写公开仓库名称和完整的 40 位提交编号。")).toBeInTheDocument();
  expect(api.previewPersonalSkillRepository).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText("新版本的提交"));
  await user.type(screen.getByLabelText("新版本的提交"), "c".repeat(40));
  await user.click(screen.getByRole("button", { name: "查看会改什么" }));
  expect(await screen.findByText(/没有记录它当初的版本/)).toBeInTheDocument();
});
