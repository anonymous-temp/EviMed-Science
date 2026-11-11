#!/usr/bin/env node
// HaluMem product arm as a labelled REPLAY: the saved opening blocks and the saved tool results of every product answer are put
// back in front of the model, and it answers with the concise style instruction and no tools. No retrieval is performed, so this
// measures answer style on fixed evidence, not memory retrieval. Output: cases/<caseId>/answers.replay.jsonl (resumable, by qid).
// Usage: node halumem-replay.mjs <run dir> <deepseek key file> <plugin tgz>
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(here, "..", "run");
const [runDir, keyFile, pluginTgz] = process.argv.slice(2);
process.env.CAPSULE_PROVING_PLUGIN_TGZ = path.resolve(pluginTgz);
const { buildSystemPrompt, buildSkillCatalog, buildTimeContext } = await import(pathToFileURL(path.join(run, "openingBlock.mjs")).href);
const { createDeepSeekClient, normalizeUsage } = await import(pathToFileURL(path.join(run, "deepseek.mjs")).href);
const facts = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
const client = createDeepSeekClient({ keyFile, model: "deepseek-flash", thinking: "enabled", reasoningEffort: "high", timeoutMs: 300_000 });
const catalog = await buildSkillCatalog({ pluginTgz, includeMemory: true });
const readJsonl = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const prefix = "mcp__openviking__";

async function replay(row) {
  const started = performance.now();
  const record = { qid: row.qid, caseId: row.caseId, arm: "product", replay: true, asOf: row.asOf, question: row.question, answer: "",
    opening: row.opening, options: { ...row.options, answerStyle: "concise" }, toolCalls: row.toolCalls.map(({ round, name, args, blocks, isError }) => ({ round, name, args, blocks, isError, replayed: true })),
    rounds: 1, model: { name: client.model, thinking: client.thinking, resolvedModel: null }, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, ms: 0 };
  try {
    const messages = [{ role: "system", content: buildSystemPrompt({ model: client.model, config: facts.flags?.config ?? {} }) }, { role: "user", content: catalog.text }];
    for (const content of [row.opening?.profileBlock, row.opening?.residentBlock]) if (content) messages.push({ role: "user", content });
    const style = /\p{Script=Han}/u.test(row.question) ? "\n\n请用一两句话回答，只回答所问的内容。" : "\n\nAnswer in one or two sentences, only what was asked.";
    messages.push({ role: "user", content: `${buildTimeContext(row.asOf, row.question)}\n\n${row.question}${style}` });
    // Saved tool results go back in the order they were first obtained, as ordinary tool turns.
    row.toolCalls.forEach((call, index) => {
      const id = `replay_${index}`;
      messages.push({ role: "assistant", content: null, reasoning_content: "", tool_calls: [{ id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] });
      messages.push({ role: "tool", tool_call_id: id, name: call.name, content: `${call.isError ? "Error: " : ""}${(call.blocks ?? []).join("\n\n")}` });
    });
    const response = await client.complete({ messages, tools: [], toolChoice: "none" });
    const usage = normalizeUsage(response.usage);
    for (const key of Object.keys(record.usage)) record.usage[key] += usage[key];
    record.model.resolvedModel = response.model ?? null;
    if (typeof response.message?.content !== "string") throw new Error("answer is not text");
    record.answer = response.message.content;
  } catch (error) { record.error = `replay_error: ${client.redact(error)}`; }
  record.ms = Math.round(performance.now() - started);
  void prefix;
  return record;
}

const cases = (await readdir(path.join(runDir, "cases"))).sort();
const queue = [];
for (const caseId of cases) {
  const dir = path.join(runDir, "cases", caseId);
  const done = new Set((await readJsonl(path.join(dir, "answers.replay.jsonl"))).filter((row) => !row.error).map((row) => row.qid));
  for (const row of await readJsonl(path.join(dir, "answers.jsonl"))) if (!done.has(row.qid)) queue.push({ dir, row });
}
console.log(`replaying ${queue.length} questions`);
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  for (;;) {
    const item = queue[next++]; if (!item) return;
    const record = await replay(item.row);
    const file = path.join(item.dir, "answers.replay.jsonl");
    const rows = (await readJsonl(file)).filter((row) => row.qid !== record.qid); rows.push(record);
    await writeFile(`${file}.tmp`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); await rename(`${file}.tmp`, file);
    console.log(record.qid, record.error ?? "ok", record.usage.promptTokens, record.usage.completionTokens);
  }
}));
