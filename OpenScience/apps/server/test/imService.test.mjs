import assert from "node:assert/strict";
import test from "node:test";
import { appLink, finalReplyText, noticeLink, progressView, pushNotBefore, runFileLink, runLink } from "../src/imService.mjs";

/** A moment given in China Standard Time. @param {string} local "YYYY-MM-DDTHH:MM" */
const cst = (local) => new Date(`${local}:00+08:00`);
const preferences = { quietHours: { start: "22:00", end: "08:00" }, digestTime: "08:30" };

test("a push waits out the researcher's quiet hours, read in China Standard Time", () => {
  const notice = { severity: "info", source: { type: "run", id: "r1" } };
  assert.equal(pushNotBefore(notice, preferences, cst("2026-09-20T15:00")).toISOString(), cst("2026-09-20T15:00").toISOString());
  assert.equal(pushNotBefore(notice, preferences, cst("2026-09-20T23:10")).toISOString(), cst("2026-09-21T08:00").toISOString());
  assert.equal(pushNotBefore(notice, preferences, cst("2026-09-21T03:00")).toISOString(), cst("2026-09-21T08:00").toISOString());
  // A window that does not wrap midnight, and one that is empty.
  assert.equal(pushNotBefore(notice, { quietHours: { start: "12:00", end: "14:00" } }, cst("2026-09-20T13:00")).toISOString(),
    cst("2026-09-20T14:00").toISOString());
  assert.equal(pushNotBefore(notice, { quietHours: { start: "00:00", end: "00:00" } }, cst("2026-09-20T03:00")).toISOString(),
    cst("2026-09-20T03:00").toISOString());
});

test("a clinical-safety finding interrupts; a digest waits for the morning", () => {
  assert.equal(pushNotBefore({ severity: "safety" }, preferences, cst("2026-09-20T23:10")).toISOString(), cst("2026-09-20T23:10").toISOString());
  const digest = { severity: "info", source: { type: "digest", id: "d1" } };
  assert.equal(pushNotBefore(digest, preferences, cst("2026-09-21T03:00")).toISOString(), cst("2026-09-21T08:30").toISOString(),
    "written during the night, sent at the digest time");
  assert.equal(pushNotBefore(digest, preferences, cst("2026-09-20T23:10")).toISOString(), cst("2026-09-21T08:30").toISOString(),
    "written after the evening's quiet start, sent the next morning");
  assert.equal(pushNotBefore(digest, preferences, cst("2026-09-20T14:00")).toISOString(), cst("2026-09-20T14:00").toISOString(),
    "written in the afternoon, sent now");
});

test("the progress card says how long, which line, and what the run observed — nothing it did not", () => {
  const now = Date.parse("2026-09-20T10:15:00Z");
  const plain = progressView({ startedAt: "2026-09-20T10:14:30Z", effectiveAgentId: "open-domain-answer" }, now);
  assert.equal(plain.status, "⏳ 进行中 · 普通问答 · 已用 1 分钟");
  assert.equal(plain.progress, "", "a plain question that made no tool call shows no phase");
  const deep = progressView({
    startedAt: "2026-09-20T10:00:00Z", effectiveAgentId: "clinical-evidence-synthesis", estimatedMinutes: { min: 15, max: 30 },
    progress: {
      currentPhase: "search", sources: { searched: 42, included: 12, fullText: 5 }, claims: { total: 8, verified: 6 },
      deliverables: [{ id: "d1", title: "临床证据报告", status: "accepted" }, { id: "d2", title: "证据矩阵", status: "planned" }],
    },
  }, now);
  assert.match(deep.status, /^⏳ 进行中 · .+ · 已用 15 分钟 · 通常 15–30 分钟$/);
  assert.equal(deep.progress, ["当前：检索", "文献：检索 42 · 纳入 12 · 全文 5", "结论核验：6/8", "✓ 临床证据报告", "· 证据矩阵"].join("\n"));
});

test("the answer is the run's last assistant text inside its own window", () => {
  const run = { startedAt: "2026-09-20T10:00:00Z", finishedAt: "2026-09-20T10:05:00Z" };
  const at = (iso) => Date.parse(iso);
  const messages = [
    { role: "assistant", time: at("2026-09-20T09:00:00Z"), parts: [{ type: "text", text: "上一轮的回答" }] },
    { role: "user", time: at("2026-09-20T10:00:01Z"), parts: [{ type: "text", text: "问题" }] },
    { role: "assistant", time: at("2026-09-20T10:04:00Z"), parts: [{ type: "reasoning", text: "思考" }, { type: "text", text: "这一轮的回答" }] },
    { role: "assistant", time: at("2026-09-20T10:04:30Z"), parts: [{ type: "tool", tool: "write" }] },
    { role: "assistant", time: at("2026-09-20T10:20:00Z"), parts: [{ type: "text", text: "下一轮的回答" }] },
  ];
  assert.equal(finalReplyText(messages, run), "这一轮的回答");
  assert.equal(finalReplyText(messages.slice(0, 2), run), null, "an earlier turn's answer is not this run's");
});

test("links go to the web app's own routes, and there are none without a public URL", () => {
  const config = { publicUrl: "https://science.example.com/" };
  assert.equal(appLink(config, "/app/chat"), "https://science.example.com/app/chat");
  assert.equal(runLink(config, "run_1"), "https://science.example.com/app/runs?run=run_1");
  assert.equal(runFileLink(config, "run_1", "deliverables/报告/report 1.md"),
    "https://science.example.com/app/runs/run_1/files/deliverables/%E6%8A%A5%E5%91%8A/report%201.md");
  assert.equal(noticeLink(config, { source: { type: "digest", id: "d 1" } }), "https://science.example.com/app/autopilot?digest=d%201");
  assert.equal(noticeLink(config, { source: null }), "https://science.example.com/app/inbox");
  assert.equal(runLink({ publicUrl: "" }, "run_1"), null);
  assert.equal(runLink({ publicUrl: "science.example.com" }, "run_1"), null);
});
