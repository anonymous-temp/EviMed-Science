import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillDetailPage } from "./SkillDetailPage";

const skills = vi.hoisted(() => ({ getPersonalSkill: vi.fn(), personalSkillHistory: vi.fn(), personalSkillDefaults: vi.fn(), projectSkills: vi.fn(), personalSkillSupply: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", async (original) => ({ ...(await original<object>()), ...skills }));
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<object>()), getWebProjectId: () => "project-1" }));

const skill = { id: "skill:one", revision: 2, payload: { title: "检索方案", description: "检索", instructions: "Use sources.", nativeName: "personal-one", digest: "sha256:two", resources: [], prepared: true }, createdAt: "", updatedAt: "", deletedAt: null };
const packaged = (source: unknown) => ({
  revision: 2, nativeName: "personal-one", baseKnown: true,
  package: { id: "personal/skill:one", name: "personal-one", origin: "personal", version: null, source, sourceText: "公开仓库 owner/skill @ aaaaaaaaaaaa", licence: null, licenceText: "许可证未记录", digest: "sha256:" + "b".repeat(64), digestAlgorithm: "personal-skill-v1", scripts: 0, references: 0, dependencies: [], operations: [], unknown: [{ field: "licence", reason: "没有记录许可证。" }] },
  availability: { state: "installed", label: "已安装", text: "已安装，还没有在这个部署上成功运行过。", reason: { code: "no-successful-operation", source: "operation-record" }, notes: [] },
});
function open() { render(<MemoryRouter initialEntries={["/skills/skill:one"]}><Routes><Route path="/skills/:skillId" element={<SkillDetailPage />} /></Routes></MemoryRouter>); }
beforeEach(() => {
  vi.resetAllMocks();
  skills.getPersonalSkill.mockResolvedValue(skill);
  skills.personalSkillHistory.mockResolvedValue([]);
  skills.personalSkillDefaults.mockResolvedValue({ revision: 5, payload: { skills: [] } });
  skills.projectSkills.mockResolvedValue({ revision: 6, payload: { skills: [] } });
});

it("shows where an imported skill came from and offers to update it toward a newer version", async () => {
  skills.personalSkillSupply.mockResolvedValue(packaged({ kind: "repository", repository: "owner/skill", commit: "a".repeat(40), path: null, package: null, digest: null }));
  open();
  expect(await screen.findByText("公开仓库 owner/skill @ aaaaaaaaaaaa")).toBeInTheDocument();
  expect(screen.getByText("许可证未记录")).toBeInTheDocument();
  expect(screen.getByText(/未记录：许可证/)).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "更新技能" })).toBeInTheDocument();
});

it("an authored skill has nothing to update from, and a package that cannot be read does not stop the skill opening", async () => {
  skills.personalSkillSupply.mockResolvedValue(packaged({ kind: "authored", repository: null, commit: null, path: null, package: null, digest: null }));
  open();
  expect(await screen.findByText("检索")).toBeInTheDocument();
  await screen.findByRole("region", { name: "技能来源与依赖" });
  expect(screen.queryByRole("region", { name: "更新技能" })).not.toBeInTheDocument();
});

it("a failed package read leaves the skill readable", async () => {
  skills.personalSkillSupply.mockRejectedValue(new Error("unavailable"));
  open();
  expect(await screen.findByText("检索")).toBeInTheDocument();
  expect(screen.getByText("这个版本保存时没有记录来源和依赖。")).toBeInTheDocument();
});
