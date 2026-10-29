import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PlatformSkillDrawer } from "./PlatformSkillDrawer";

const skills = vi.hoisted(() => ({ readPlatformSkill: vi.fn(), projectPlatformSkills: vi.fn(), saveProjectPlatformSkills: vi.fn(), copyPlatformSkill: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", async original => ({ ...(await original<object>()), ...skills }));

const skill = { id: "core:docx", name: "docx", title: "Word 文档", use: "读取、编辑和创建 Word 文档。", group: "办公", source: "platform" as const, canCopy: true };
const activation = { phase: "effective" as const, savedRevision: 3, effectiveRevision: 3, error: null };

beforeEach(() => {
  vi.resetAllMocks();
  skills.readPlatformSkill.mockResolvedValue({ ...skill, when: "需要处理 .docx 文件时", instructions: "Use python-docx." });
  skills.projectPlatformSkills.mockResolvedValue({ id: "policy", revision: 3, payload: { disabled: [] }, items: [{ ...skill, enabled: true, effective: true }], activation });
});

it("describes what the skill does and where it applies, and never prints its internal identifier", async () => {
  render(<PlatformSkillDrawer skill={skill} projectId="project-1" projectName="我的研究" onClose={vi.fn()} onCopied={vi.fn()} onSelectionChanged={vi.fn()} />);
  const drawer = await screen.findByRole("dialog", { name: /Word 文档|docx/ });
  await waitFor(() => expect(within(drawer).getByText("需要处理 .docx 文件时")).toBeInTheDocument());
  expect(within(drawer).getByText("读取、编辑和创建 Word 文档。")).toBeInTheDocument();
  expect(drawer.textContent).not.toContain("core:docx");
  expect(drawer.textContent).not.toContain("技能标识");
});
