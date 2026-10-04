import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SkillPackagePanel } from "./SkillPackagePanel";
import type { SkillAvailabilityView, SkillPackageView } from "@/lib/skillLibraryClient";

const view: SkillPackageView = {
  id: "curated/cheminformatics", name: "cheminformatics", origin: "curated", version: null,
  source: { kind: "derived", repository: null, commit: null, path: "x", package: "scientific-agent-skills", digest: null },
  sourceText: "派生自 scientific-agent-skills（x），提交未记录", licence: { id: "MIT" }, licenceText: "MIT",
  digest: "sha256:" + "a".repeat(64), digestAlgorithm: "release-directory-v1", scripts: 1, references: 2,
  dependencies: [
    { kind: "python-package", name: "rdkit", constraint: null, optional: false, supply: "image", basis: "declared" },
    { kind: "python-package", name: "h5py", constraint: null, optional: true, supply: "image", basis: "observed" },
  ],
  operations: [{ name: "cheminformatics baseline", kind: "script" }],
  unknown: [{ field: "version", reason: "没有记录版本。" }, { field: "source.commit", reason: "没有记录提交。" }],
};
const limited: SkillAvailabilityView = {
  state: "limited", label: "受限", text: "它用到的软件「rdkit」运行环境里没有；需要它的方法会受阻，其余部分照常。",
  reason: { code: "dependency-software-missing", detail: "rdkit", source: "image-recipe" }, notes: [{ code: "dependency-software-missing", detail: "h5py" }],
};

it("says what the package is, where it came from, and what is missing, and names every field that is not recorded", () => {
  render(<SkillPackagePanel view={view} availability={limited} />);
  expect(screen.getByText("受限")).toBeInTheDocument();
  expect(screen.getByText(/rdkit.*运行环境里没有.*其余部分照常/)).toBeInTheDocument();
  expect(screen.getByText("派生自 scientific-agent-skills（x），提交未记录")).toBeInTheDocument();
  expect(screen.getByText("MIT")).toBeInTheDocument();
  expect(screen.getByText("未记录")).toBeInTheDocument();
  expect(screen.getByText("aaaaaaaaaaaa")).toBeInTheDocument();
  expect(screen.getByText("1 个脚本 · 2 个参考文件")).toBeInTheDocument();
  expect(screen.getByText(/未记录：版本、来源提交/)).toBeInTheDocument();
  expect(screen.getByText(/只在个别路径用到、运行环境没有安装的软件：h5py/)).toBeInTheDocument();
  expect(screen.getByText(/rdkit · Python 库$/)).toBeInTheDocument();
  expect(screen.getByText(/h5py · Python 库 · 只在个别路径用到 · 从脚本读出/)).toBeInTheDocument();
  expect(screen.getByText("支持的操作：cheminformatics baseline")).toBeInTheDocument();
});

it("a revision saved before packages travelled says so instead of showing an empty record", () => {
  render(<SkillPackagePanel view={null} availability={null} />);
  expect(screen.getByText("这个版本保存时没有记录来源和依赖。")).toBeInTheDocument();
});
