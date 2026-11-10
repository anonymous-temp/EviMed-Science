/** Narrow task-tool adapter around the same prompt/opening builders as answerQuestion. */
import { createHash } from 'node:crypto';
import { buildSystemPrompt, buildProfileBlock, buildTimeContext, buildSkillCatalog, SKILL_TOOL, loadSkill } from '../run/openingBlock.mjs';
import { firstLine, normalizeUsage } from '../run/deepseek.mjs';
import { loadGraphs } from '../synthetic/toolverse/graph.mjs';
import { KINDS } from '../synthetic/toolverse/kinds.mjs';
import { simulate } from '../synthetic/toolverse/env.mjs';
import { methodsSectionText } from '../../../packages/socket/plugins/capsule.mjs';
import { scoreCalls } from './score_l8.mjs';
const PREFIX = 'mcp__openviking__';
const METHOD_DIR = '/runtime/capsule-methods';
const METHOD_PATH = METHOD_DIR + '/l8-rule/SKILL.md';
const openAITool = (t, prefix = '') => ({ type: 'function', function: { name: prefix+t.name, description: t.description, parameters: t.inputSchema } });
export const ASK_TOOL = { name: 'ask_user', description: 'Ask the user for missing task parameters. Name the exact tool parameter(s) you need and ask a readable question. The user returns their values.', inputSchema: { type:'object', properties: { params:{type:'array',items:{type:'string'}}, question:{type:'string'} }, required:['params','question'] } };
const READ_TOOL = { name:'read', description:'Read a file by absolute path.', inputSchema:{ type:'object', properties:{path:{type:'string'}}, required:['path'] } };

/** Graph schemas only; no gold values or chain order are exposed. Three stable distractors. */
export function taskTools(item) {
  const graph = loadGraphs()[item.graph];
  if (!graph) throw new Error('Unsupported graph: '+item.graph);
  const hash = n => createHash('sha256').update(item.id+':'+n).digest('hex');
  const names = new Set(item.steps.map(s => s.tool));
  for (const t of graph.tools.filter(t => !names.has(t.name)).sort((a,b) => hash(a.name).localeCompare(hash(b.name))).slice(0,3)) names.add(t.name);
  return [...names].sort().map(name => {
    const t = graph.byName.get(name);
    if (!t) throw new Error('Tool missing from graph: '+name);
    const schema = p => p.type.endsWith('[]') ? {type:'array',items:{type:p.type.slice(0,-2)},description:KINDS[p.kind]?.label} : {type:p.type,description:KINDS[p.kind]?.label};
    return {name, description:t.desc+' Returns fields: '+t.outputs.map(p => p.name+' ('+p.type+')').join(', ')+'.', inputSchema:{type:'object',properties:Object.fromEntries(t.inputs.map(p => [p.name,schema(p)])),required:t.inputs.filter(p => p.required).map(p => p.name),additionalProperties:false}};
  });
}

/** A real-user fallback supplies only requested facts. Semantic parameter aliases never change scoring. */
export function askAnswer(item, args) {
  const params = Array.isArray(args.params) ? [...new Set(args.params.map(String))] : [];
  const values = {}, requested = new Set();
  const graph = loadGraphs()[item.graph];
  for (const param of params) {
    const exact = item.removed.filter(r => r.param === param);
    if (exact.length) { for (const r of exact) requested.add(r.param); continue; }
    const kinds = new Set(graph.tools.flatMap(t => t.inputs.filter(p => p.name === param).flatMap(p => p.accepts ?? [p.kind])));
    const aliases = item.removed.filter(r => kinds.has(r.kind));
    if (aliases.length === 1) requested.add(aliases[0].param);
    else if (item.removed.length === 1) requested.add(item.removed[0].param);
  }
  for (const p of requested) {
    const hits = item.removed.filter(r => r.param === p);
    values[p] = hits.length === 1 ? hits[0].value : hits.map(r => ({step:r.step,value:r.value}));
  }
  return { params, result: { values } };
}

/** builders are injectable for offline tests; production defaults import the actual runner/product functions. */
export async function answerTask({ item, arm, variant = '', memory, client, pluginTgz, maxRounds = 16, builders = {} }) {
  const started = performance.now();
  const b = { buildSystemPrompt, buildProfileBlock, buildTimeContext, buildSkillCatalog, ...builders };
  const input = item.arms[arm].input;
  const card = arm === 'memory+method' ? input.card ?? null : null;
  const row = { itemId:item.id, arm, variant, armLabel:arm+(variant ? ':'+variant : ''), graph:item.graph, level:item.level, length:item.length, source:item.source,
    question:input.request, answer:'', opening:{}, toolCalls:[], rounds:0, usage:{promptTokens:0,completionTokens:0,cachedTokens:0}, model:{name:client.model,thinking:client.thinking,reasoningEffort:client.reasoningEffort}, ms:0 };
  try {
    const catalog = await b.buildSkillCatalog({pluginTgz,includeMemory:arm !== 'no-memory'});
    let system = b.buildSystemPrompt({model:client.model,config:memory?.config ?? {}});
    if (card) {
      row.opening.methodsSection = methodsSectionText([{ name:card.title, description:card.title, directory:'l8-rule' }],METHOD_DIR);
      system += '\n\n'+row.opening.methodsSection;
    }
    const messages = [{role:'system',content:system},{role:'user',content:catalog.text}];
    row.opening.skillCatalog = {entries:catalog.entries.length,sha256:createHash('sha256').update(catalog.text).digest('hex')};
    const available = arm === 'no-memory' ? [] : memory.tools;
    if (arm !== 'no-memory') {
      row.opening.profileBlock = await b.buildProfileBlock(memory,{pluginTgz});
      row.opening.residentBlock = await memory.residentBlock();
      for (const content of [row.opening.profileBlock,row.opening.residentBlock]) if (content) messages.push({role:'user',content});
    }
    const task = taskTools(item), taskNames = new Set(task.map(t => t.name));
    const tools = [openAITool(SKILL_TOOL),...available.map(t => openAITool(t,PREFIX)),...task.map(t => openAITool(t)),openAITool(ASK_TOOL),...(card ? [openAITool(READ_TOOL)] : [])];
    row.taskToolNames = [...taskNames];
    messages.push({role:'user',content:b.buildTimeContext(item.asOf ?? '2026-11-10T00:00:00Z',input.request)+'\n\n'+input.request});
    for (let round = 0; round < maxRounds; round++) {
      row.rounds++;
      const response = await client.complete({messages:structuredClone(messages),tools});
      const usage = normalizeUsage(response.usage);
      for (const k of Object.keys(row.usage)) row.usage[k] += usage[k];
      row.model.resolvedModel = response.model ?? client.model;
      const message = response.message;
      if (message?.role !== 'assistant') throw new Error('Expected assistant response');
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls)) throw new Error('Invalid tool calls');
      if (!calls.length) { row.answer = message.content ?? ''; row.termination = 'answer'; break; }
      messages.push(message); // preserves reasoning_content for thinking-mode continuation
      for (const call of calls) {
        const at = performance.now(), name = call.function?.name ?? '';
        const trace = { round:round+1, name, args:call.function?.arguments, kind:name === 'ask_user' ? 'ask' : name.startsWith(PREFIX) ? 'memory' : name === 'skill' ? 'skill' : name === 'read' ? 'method-read' : 'task',blocks:[],isError:false };
        row.toolCalls.push(trace);
        try {
          trace.args = JSON.parse(call.function.arguments);
          if (!trace.args || typeof trace.args !== 'object' || Array.isArray(trace.args)) throw new Error('Arguments must be an object');
          let result;
          if (name === 'ask_user') {
            const ask = askAnswer(item,trace.args);
            trace.scoringCall = {ask:{params:ask.params}};
            result = {blocks:[JSON.stringify(ask.result)]};
          } else if (name === 'read') {
            result = card && trace.args.path === METHOD_PATH ? {blocks:[card.body]} : {blocks:['File not found'],isError:true};
          } else if (name === 'skill') result = loadSkill(catalog.skills,trace.args.name);
          else if (name.startsWith(PREFIX) && available.some(t => PREFIX+t.name === name)) {
            const short = name.slice(PREFIX.length);
            if (short === 'remember') result = {blocks:[`Submitted ${Array.isArray(trace.args.messages) ? trace.args.messages.length : 0} message(s) for memory extraction (session mcp-store-evaluation, task_id=evaluation). Extraction runs in the background and decides which memories to create or update.`]};
            else if (short === 'forget') result = {blocks:[`Deleted: ${trace.args.uri}`]};
            else result = await memory.callTool(short,trace.args);
          } else {
            trace.kind = 'task'; trace.scoringCall = {tool:name,args:trace.args};
            const simulated = taskNames.has(name) ? simulate(item,trace.scoringCall) : {ok:false,error:{code:'unknown_tool'}};
            result = {blocks:[JSON.stringify(simulated)],isError:!simulated.ok};
          }
          trace.blocks = result.blocks; trace.isError = Boolean(result.isError);
        } catch (error) {
          trace.isError = true; trace.blocks = [firstLine(client.redact ? client.redact(error) : error)];
          if (trace.kind === 'task') trace.scoringCall = {tool:name,args:trace.args};
          if (trace.kind === 'ask') trace.scoringCall = {ask:{params:[]}};
        }
        trace.ms = Math.round(performance.now()-at);
        messages.push({role:'tool',tool_call_id:call.id,name,content:(trace.isError ? 'Error: ' : '')+trace.blocks.join('\n\n')});
      }
    }
    if (!row.termination) { row.termination = 'round-limit'; row.error = 'round_limit: task did not finish within 16 rounds'; }
  } catch (error) { row.error = firstLine(client.redact ? client.redact(error) : error); }
  row.ms = Math.round(performance.now()-started);
  row.score = scoreCalls(item.arms[arm].gold,row.toolCalls,row.error);
  return row;
}
