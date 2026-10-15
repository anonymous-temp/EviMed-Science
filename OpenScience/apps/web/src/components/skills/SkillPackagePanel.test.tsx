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
  expect(screen.getByText("1 个脚本 · 2 个参考文件")).toBeInTheDocument();
  expect(screen.getByText(/未记录：版本、来源提交/)).toBeInTheDocument();
  // A package's digest is how versions are told apart inside the platform; the reader is not shown it, nor told it is missing.
  expect(screen.queryByText("包摘要")).not.toBeInTheDocument();
  expect(screen.queryByText("aaaaaaaaaaaa")).not.toBeInTheDocument();
  expect(screen.getByText(/只在个别路径用到、运行环境没有安装的软件：h5py/)).toBeInTheDocument();
  expect(screen.getByText(/rdkit · Python 库$/)).toBeInTheDocument();
  expect(screen.getByText(/h5py · Python 库 · 只在个别路径用到 · 从脚本读出/)).toBeInTheDocument();
  expect(screen.getByText("支持的操作：cheminformatics baseline")).toBeInTheDocument();
});

it("a revision saved before packages travelled says so instead of showing an empty record", () => {
  render(<SkillPackagePanel view={null} availability={null} />);
  expect(screen.getByText("这个版本保存时没有记录来源和依赖。")).toBeInTheDocument();
});

it("does not name a missing digest among the fields the record does not know", () => {
  render(<SkillPackagePanel view={{ ...view, digest: null, unknown: [{ field: "digest", reason: "没有可核对的包摘要。" }, { field: "version", reason: "没有记录版本。" }] }} availability={null} />);
  expect(screen.getByText(/未记录：版本。/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/摘要|digest/);
});

// The panel draws an availability by the capability page's rule, which is a rule about REASONS (R19, plan §5.6): where the reader
// can act on it, and not how often it ran here, that nothing could be proven, or what the deployment declines to carry.
it.each([
  ["executable", "可运行", "1.0.0 版已在这个部署上成功运行过，最近一次是 2026-10-03。", "succeeded-here"],
  ["installed", "已安装", "已安装，还没有在这个部署上成功运行过。", "no-successful-operation"],
  ["unverified", "未验证", "当前是模拟运行环境，不能证明真实可运行。", "mock-runtime"],
  // The deployment's: a reader cannot mend any of these, whatever state they put the package in.
  ["source-planned", "规划中", "目录里列了它，这个部署还没有安装。", "not-in-this-deployment"],
  ["unavailable", "不可用", "它依赖的「文献检索」在这个部署上没有提供。", "required-tool-not-offered"],
  ["limited", "受限", "最近一次运行没有成功（这次运行没有产出必须的文件）。", "last-operation-failed"],
] as const)("draws nothing about a package whose availability is %s for the deployment's own reason", (state, label, text, code) => {
  render(<SkillPackagePanel view={view} availability={{ state, label, text, reason: { code, source: "operation-record" }, notes: [] }} />);
  expect(screen.queryByText(label)).not.toBeInTheDocument();
  expect(screen.queryByText(text)).not.toBeInTheDocument();
  expect(screen.getByText("MIT")).toBeInTheDocument();
});

it.each([
  ["limited", "受限", "它需要的数据或模型权重「esm2」这个部署没有提供；其余部分照常。", "dependency-data-missing"],
  ["limited", "受限", "它指定「numpy」>=2，运行环境装的是 1.26；结果以运行环境的版本为准。", "dependency-version-differs"],
  ["source-planned", "规划中", "目录里有，你还没有安装。", "not-installed"],
] as const)("still says what the reader's own package needs or has not been installed (%s)", (state, label, text, code) => {
  render(<SkillPackagePanel view={view} availability={{ state, label, text, reason: { code, source: "image-recipe" }, notes: [] }} />);
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText(text)).toBeInTheDocument();
});
