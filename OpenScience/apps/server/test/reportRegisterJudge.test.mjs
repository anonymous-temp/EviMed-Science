import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reportProseLines, reviewDeliveredRegister } from "../src/reportRegisterJudge.mjs";
import { runGate } from "@evimed/domain";
import { runtimeLeakageLine } from "@evimed/domain/clinical-evidence";

test("the synchronous gate checks identifiers and leaves open language to J4", () => {
  assert.equal(runtimeLeakageLine("本轮检索提示资料有限，样本环境温度较低。"), null);
  assert.ok(runtimeLeakageLine("来源保存在 .evimed-sources/paper.txt"));
  assert.ok(runtimeLeakageLine("mcp__evimed__literature_search"));
  assert.equal(runGate({ contractKind: "research-brief", files: new Map([["brief.md", "本环境下的工件已完成。"]]), expectedOutputs: [] }).issues.some(issue => issue.code === "runtime_leakage"), false);
});

test("report line evidence preserves numbering and excludes code fences", () => {
  assert.deepEqual(reportProseLines("Result\n\n```text\ninternal command\n```\nConclusion"), [
    { line: 1, text: "Result" }, { line: 6, text: "Conclusion" },
  ]);
});

test("delivered reports receive advisory notices; revision notes, outside paths and VCR stay out", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "report.md"), "Research result\nA backstage diary");
  await writeFile(path.join(root, "revision-notes.md"), "Technical changes");
  await symlink("/etc/hosts", path.join(root, "outside.md"));
  const notices = [], calls = [];
  const run = { id: "run_1", status: "succeeded", artifacts: ["report.md", "revision-notes.md", "outside.md"], verification: "verified" };
  const original = structuredClone(run);
  const input = { project: { id: "p", userId: "u", workspaceDir: root }, run,
    judgeService: { judge: async (site, value) => { calls.push({ site, value }); return { outcome: "settled", value: { leakage: value.line === "A backstage diary" } }; } },
    onNotices: async value => notices.push(...value) };
  await reviewDeliveredRegister(input);
  assert.equal(calls.length, 2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].severity, "advice");
  assert.equal(notices[0].file, "report.md");
  assert.equal(notices[0].line, 2);
  assert.deepEqual(run, original);
  await reviewDeliveredRegister({ ...input, run: { ...run, effectiveAgentId: "vcr-analysis" } });
  assert.equal(calls.length, 2);
});
