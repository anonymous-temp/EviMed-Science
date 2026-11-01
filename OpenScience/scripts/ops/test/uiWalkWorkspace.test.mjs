import assert from "node:assert/strict";
import test from "node:test";
import { workspaceFindings } from "../ui-walk.mjs";

const clean = { railWords: ["已完成", "进行中", "待开始"], primary: ["下一步：开始诊断"], dock: 1, split: null, actions: [{ kind: "draft", label: "让 AI 补充问题" }, { kind: "start", label: "开始诊断" }, { kind: "set", label: "保存" }] };

test("a page whose words and buttons agree has nothing to answer for", () => {
  assert.deepEqual(workspaceFindings("geo", clean), []);
  assert.deepEqual(workspaceFindings("geo", { ...clean, railWords: Array(8).fill("已完成") }), []);
});

test("work outside the request has no word, and eight of one word say nothing", () => {
  assert.match(workspaceFindings("geo", { ...clean, railWords: ["未请求"] })[0], /says only its name/);
  assert.match(workspaceFindings("geo", { ...clean, railWords: Array(8).fill("待开始") })[0], /8 times/);
});

test("the header's primary is never the conversation, and every view has one", () => {
  assert.match(workspaceFindings("geo", { ...clean, primary: ["对话"] })[0], /next step/);
  assert.match(workspaceFindings("geo", { ...clean, dock: 0 })[0], /neither a bar nor a column/);
  assert.deepEqual(workspaceFindings("geo", { ...clean, dock: 0, split: "split" }), []);
});

test("a button says what pressing it does", () => {
  assert.match(workspaceFindings("geo", { ...clean, actions: [{ kind: "draft", label: "生成虚拟患者" }] })[0], /draft action/);
  assert.match(workspaceFindings("geo", { ...clean, actions: [{ kind: "start", label: "看一下" }] })[0], /start action/);
});
