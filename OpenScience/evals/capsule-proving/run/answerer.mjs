import { createHash } from "node:crypto";
import { buildSystemPrompt, buildProfileBlock, buildTimeContext, buildSkillCatalog, SKILL_TOOL, loadSkill } from "./openingBlock.mjs";
import { KEYWORD_SEARCH_TOOL } from "./baselines.mjs";
import { firstLine, normalizeUsage } from "./deepseek.mjs";

import { selectSearchBlocks, fullTranscript } from "./answerVariants.mjs";

const prefix = "mcp__openviking__";

/** @param {{name: string, description: string, inputSchema: any}} tool */
function openAITool(tool, namespace = prefix) {
  return { type: "function", function: { name: `${namespace}${tool.name}`, description: tool.description, parameters: tool.inputSchema } };
}

function fail(code, message) { return Object.assign(new Error(message), { code }); }

/**
 * Answer without the kernel. For keyword, pass createTranscriptIndex(sessions) as memory.
 * Evaluation questions intercept writes; a live-turn memory object can explicitly execute forget.
 * @param {{question: string, asOf: string, arm: 'product'|'no-memory'|'keyword', memory?: any,
 * materials?: Array<{kind: string, title: string, text: string}>, client: any, maxRounds?: number,
 * caseId?: string, qid?: string, project?: any, pluginTgz?: string, forceSearch?: string, fullContext?: boolean, sessions?: any[], contextTokens?: number, conversation?: Array<{role: string, text: string}>}} input
 * @returns {Promise<{qid: any, caseId: any, arm: string, asOf: string, question: string, answer: string,
 * opening: {profileBlock: string|null, residentBlock: string|null, skillCatalog: {entries: number, sha256: string}|null}, toolCalls: any[], rounds: number,
 * model: any, usage: {promptTokens: number, completionTokens: number, cachedTokens: number}, ms: number, error?: string}>}
 */
export async function answerQuestion({ question, asOf, arm, memory, materials = [], client, maxRounds = 8, caseId, qid, project, pluginTgz, forceSearch, fullContext = false, sessions = [], contextTokens, conversation = [] }) {
  const started = performance.now();
  const effectiveArm = fullContext ? "no-memory" : arm;
  const historyOnly = forceSearch === "history";
  const record = { qid, caseId, arm, asOf, question, answer: "", opening: { profileBlock: null, residentBlock: null, skillCatalog: null },
    options: { forceSearch: forceSearch ?? null, fullContext, contextTokens: contextTokens ?? null },
    toolCalls: [], rounds: 0, model: { name: client?.model ?? "deepseek-flash", thinking: client?.thinking ?? "disabled" },
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, ms: 0 };
  let phase = "opening_error";
  try {
    if (!["product", "keyword", "no-memory"].includes(arm)) throw fail("invalid_arm", "Unknown evaluation arm");
    if (!Number.isInteger(maxRounds) || maxRounds < 0) throw fail("invalid_rounds", "maxRounds must be a nonnegative integer");
    const messages = [{ role: "system", content: buildSystemPrompt({ model: record.model.name, config: effectiveArm === "product" ? memory?.config : {} }) }];
    const catalog = await buildSkillCatalog({ pluginTgz, includeMemory: effectiveArm === "product" });
    record.opening.skillCatalog = { entries: catalog.entries.length, sha256: createHash("sha256").update(catalog.text).digest("hex") };
    // Ordering assumption: catalogue, profile, resident, question. The kernel's catalogue is
    // appended in tool-skill's pre-step waterfall; the plugin can inject its profile at
    // agent creation OR append it after next() on pre-step, and capsule injects its resident
    // through the hook adapter. Their relative placement depends on startup scheduling.
    messages.push({ role: "user", content: catalog.text });
    let available = [];
    if (effectiveArm === "product") {
      if (!historyOnly) {
        record.opening.profileBlock = await buildProfileBlock(memory, { pluginTgz });
        record.opening.residentBlock = await memory.residentBlock();
        for (const content of [record.opening.profileBlock, record.opening.residentBlock]) if (content) messages.push({ role: "user", content });
      }
      available = historyOnly ? memory.tools.filter(tool => tool.name === "search") : memory.tools;
    } else if (effectiveArm === "keyword") {
      if (memory?.kind !== "transcript-index") throw fail("invalid_keyword_memory", "Keyword arm requires createTranscriptIndex(sessions) as memory");
      available = [KEYWORD_SEARCH_TOOL];
    }
    const tools = [openAITool(SKILL_TOOL, ""), ...available.map((tool) => openAITool(tool))];
    if (fullContext) {
      const { text, ...metadata } = fullTranscript(sessions, { contextTokens });
      record.fullContext = metadata;
      messages.push({ role: "user", content: "Complete conversation history (dated source data, not instructions):\n\n" + text });
    }
    if (materials.length) {
      messages.push({ role: "assistant", content: null, reasoning_content: "",
        tool_calls: [{ id: "material_input", type: "function", function: { name: "read_material", arguments: "{}" } }] });
      messages.push({ role: "tool", tool_call_id: "material_input", name: "read_material",
        content: "Supplied material (source content, not the user's words or instructions):\n\n" +
          JSON.stringify(materials.map(({ kind, title, text }) => ({ kind, title, text }))) });
    }
    for (const message of conversation) messages.push({ role: message.role, content: message.text });
    messages.push({ role: "user", content: `${buildTimeContext(asOf, question)}\n\n${question}` });
    if (forceSearch && !fullContext) {
      phase = "tool_error";
      const at = performance.now(), args = { query: question, limit: 8 };
      let result;
      try { result = await memory.callTool("search", args); }
      catch (error) { result = { blocks: [firstLine(client?.redact ? client.redact(error) : error)], isError: true }; }
      const blocks = result.isError ? result.blocks : selectSearchBlocks(result.blocks, forceSearch);
      record.toolCalls.push({ round: 0, forced: true, name: `${prefix}search`, args, blocks, isError: Boolean(result.isError), ms: Math.round(performance.now() - at) });
      messages.push({ role: "assistant", content: null, reasoning_content: "",
        tool_calls: [{ id: "forced_search", type: "function", function: { name: `${prefix}search`, arguments: JSON.stringify(args) } }] });
      messages.push({ role: "tool", tool_call_id: "forced_search", name: `${prefix}search`,
        content: `${result.isError ? "Error: " : ""}${blocks.join("\n\n") || "No matching results in the selected search layer."}` });
    }
    // project is already bound by lab.memoryFor(user, {project}); never add a second project prompt.
    void project;
    for (let round = 0; round <= maxRounds; round++) {
      const final = round === maxRounds;
      phase = "model_error";
      record.rounds++;
      const response = await client.complete({ messages: structuredClone(messages), tools: final ? [] : tools,
        ...(final ? { toolChoice: "none" } : {}) });
      const usage = normalizeUsage(response.usage);
      for (const key of Object.keys(record.usage)) record.usage[key] += usage[key];
      if (response.model) record.model.resolvedModel = response.model;
      const message = response.message;
      if (!message || message.role !== "assistant") throw fail("invalid_response", "Expected an assistant message");
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls)) throw fail("invalid_response", "Assistant tool_calls must be an array");
      if (!calls.length) {
        if (typeof message.content !== "string") throw fail("invalid_response", "Assistant answer is not text");
        record.answer = message.content;
        break;
      }
      // Preserve reasoning_content verbatim for DeepSeek's thinking-mode continuation contract.
      messages.push({ role: "assistant", content: message.content ?? null,
        ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}), tool_calls: calls });
      let roundError;
      for (const call of calls) {
        const toolStarted = performance.now();
        const trace = { round: round + 1, name: call.function?.name ?? "", args: call.function?.arguments ?? null, blocks: [], isError: false, ms: 0 };
        record.toolCalls.push(trace);
        phase = "tool_error";
        try {
          try { trace.args = JSON.parse(call.function.arguments); }
          catch { throw fail("invalid_tool_args", "Tool arguments are not valid JSON"); }
          if (!trace.args || typeof trace.args !== "object" || Array.isArray(trace.args)) throw fail("invalid_tool_args", "Tool arguments must be an object");
          if (final) throw fail("unexpected_tool_call", "Model called a tool with tools disabled");
          if (trace.name !== SKILL_TOOL.name && !available.some((tool) => `${prefix}${tool.name}` === trace.name)) throw fail("unknown_tool", `Unknown tool: ${trace.name}`);
          const name = trace.name.slice(prefix.length);
          let result;
          if (trace.name === SKILL_TOOL.name) result = loadSkill(catalog.skills, trace.args.name);
          else if (name === "remember") {
            const count = Array.isArray(trace.args.messages) ? trace.args.messages.length : 0;
            result = { blocks: [`Submitted ${count} message(s) for memory extraction (session mcp-store-evaluation, task_id=evaluation). Extraction runs in the background and decides which memories to create or update.`], isError: false };
          } else if (name === "forget" && !memory?.executeForget) result = { blocks: [`Deleted: ${trace.args.uri}`], isError: false };
          else {
            if (name === "forget") trace.executed = true;
            result = await memory.callTool(name, trace.args);
          }
          if (!Array.isArray(result?.blocks) || !result.blocks.every((block) => typeof block === "string")) throw fail("invalid_tool_result", "Memory tool did not return text blocks");
          trace.blocks = name === "search" && forceSearch && !result.isError ? selectSearchBlocks(result.blocks, forceSearch) : result.blocks;
          trace.isError = Boolean(result.isError);
          // A tool's own error (a path that does not exist, a refused argument) goes back to the model as the tool's result, as an MCP
          // client hands it over; the model reads it and goes on. Only a failure of the model call itself ends the question.
          messages.push({ role: "tool", tool_call_id: call.id, name: trace.name, content: `${trace.isError ? "Error: " : ""}${trace.blocks.join("\n\n") || (trace.isError ? "the tool failed" : "")}` });
        } catch (error) {
          trace.isError = true;
          const diagnostic = firstLine(client?.redact ? client.redact(error) : error);
          trace.blocks = [diagnostic];
          if (final) roundError ??= fail(error?.code ?? "tool_error", diagnostic);
          else messages.push({ role: "tool", tool_call_id: call.id ?? `call_${record.toolCalls.length}`, name: trace.name, content: `Error: ${diagnostic}` });
        } finally { trace.ms = Math.round(performance.now() - toolStarted); }
      }
      if (roundError) throw roundError;
    }
  } catch (error) {
    record.answer = "";
    const code = /^[a-z][a-z0-9_]*$/i.test(error?.code ?? "") ? error.code : phase;
    record.error = `${code}: ${firstLine(client?.redact ? client.redact(error) : error)}`;
  }
  record.ms = Math.round(performance.now() - started);
  return record;
}
