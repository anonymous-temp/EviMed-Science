/** One persistent native kernel; one original root session per public benchmark topic. */
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { loadHarnessModule } from '../../packages/harness-port/index.mjs';
export const name = 'matching-campaign-runtime';
export const inject = ['llm', 'agents'];
export async function apply(ctx) {
  const { registerDeepSeekProvider, resolveAdapterOptions } = await loadHarnessModule('@deepseek-ai/dsh-llm-deepseek');
  const { createUserMessage } = await loadHarnessModule('@deepseek-ai/dsh-llm');
  const connection = resolveAdapterOptions({ baseURL: process.env.MATCHING_CAMPAIGN_PROXY, maxTokens: 16000, thinking: 'enabled', reasoningEffort: 'high',
    models: [{ id: 'deepseek-flash', contextWindow: 1000000, maxTokens: 16000 }], retryPolicy: { mode: 'normal', maxRetries: 0 }, streamIdleTimeoutMs: 240000 });
  registerDeepSeekProvider(ctx, 'deepseek', { options: () => connection, resolveAuth: async () => ({ headers: { 'x-api-key': process.env.MATCHING_CAMPAIGN_WORKLOAD } }),
    providerName: 'Campaign host-owned Flash gateway', admit: (_connection, model) => { if (model !== 'deepseek-flash') throw new Error('Only Flash is admitted'); } });
  const handles = new Map();
  const event = value => fs.appendFile(process.env.MATCHING_CAMPAIGN_EVENTS, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
  ctx.on('agent/created', async ({ agent }) => {
    const parent = agent.session.header.parentSession ?? null;
    await event({ kind: parent || agent.session.header.origin === 'subagent' ? 'child-created' : 'root-created', sessionId: agent.id, parent, model: agent.options?.model });
    if (!parent && agent.session.header.origin !== 'subagent') {
      agent.ctx.on('tools/result', async (exec, result) => {
        await event({ kind: 'root-tool', sessionId: agent.id, tool: exec.name, callId: exec.callId, result });
        await fetch(`${process.env.MATCHING_CAMPAIGN_HOST}/root-result`, { method: 'POST', headers: { authorization: `Bearer ${process.env.MATCHING_CAMPAIGN_WORKLOAD}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: agent.id, tool: exec.name, result }) });
      });
      return;
    }
    const binding = await fetch(`${process.env.MATCHING_CAMPAIGN_HOST}/lineage`, { method: 'POST', headers: { authorization: `Bearer ${process.env.MATCHING_CAMPAIGN_WORKLOAD}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: agent.id, parent }) });
    if (!binding.ok) throw new Error('The clinical child lineage was not admitted');
    agent.ctx.on('tools/result', async (exec, result) => event({ kind: 'child-tool', sessionId: agent.id, parent, tool: exec.name, callId: exec.callId, ok: !result.isError && result.value?.ok !== false }));
  });
  const metadata = (provider, id) => ({ provider, id, name: 'Frozen public benchmark driver', context: { contextWindow: 1000000 }, defaultMaxTokens: 1024 });
  const adapter = {
    providerInfo: id => ({ id, name: 'Scripted benchmark driver; zero clinical judgments' }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_provider, _model, image) => image,
    listModels: async provider => [metadata(provider, 'campaign-root')], resolveModel: async (provider, model) => metadata(provider, model),
    async prepareCall(provider, model) { return { model: metadata(provider, model), stream: options => adapter.stream(options) }; },
    async *stream(options) {
      const response = await fetch(`${process.env.MATCHING_CAMPAIGN_HOST}/driver`, { method: 'POST', headers: { authorization: `Bearer ${process.env.MATCHING_CAMPAIGN_WORKLOAD}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: options.sessionId, tools: (options.tools ?? []).map(tool => tool.name) }) });
      if (!response.ok) throw new Error('Campaign driver unavailable');
      const step = await response.json();
      const block = step.tool ? { type: 'tool-call', id: step.callId, name: step.tool, arguments: JSON.stringify(step.args) }
        : { type: 'text', text: 'The native benchmark topic ended. Its persisted result and partial diagnostics are retained.' };
      yield { type: 'block-start', index: 0, blockType: block.type }; yield { type: 'block-end', index: 0, block };
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }; yield { type: 'finish', reason: { kind: step.tool ? 'tool-calls' : 'stop' } };
    },
  };
  ctx.effect(() => ctx.llm.registerAdapter(['campaign-root'], adapter));
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${process.env.MATCHING_CAMPAIGN_WORKLOAD}` || request.url !== '/run' || request.method !== 'POST') { response.writeHead(403); response.end(); return; }
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 20000) throw new Error('request limit'); }
      const { sessionId, resume = false } = JSON.parse(raw);
      if (!/^campaign-[a-z0-9-]+$/.test(sessionId) || handles.has(sessionId)) throw new Error('Repeated original session refused');
      const presets = ctx.get('agentPresets'), preset = presets ? await presets.resolve() : null;
      const options = { agentOptions: { provider: 'campaign-root', model: 'campaign-root' }, meta: { cwd: process.cwd(), title: sessionId, ...(preset ? { agentPreset: preset.id } : {}) }, setup: async agentCtx => { if (preset) await presets.mount(agentCtx, preset.id); } };
      const handle = resume ? await ctx.agents.resume({ ...options, resumeSessionId: sessionId }) : await ctx.agents.create({ ...options, sessionId });
      handles.set(sessionId, handle);
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Execute the frozen public benchmark topic through the native patient matching tools.' }], source: { kind: 'user-rpc', requestId: sessionId } }));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ sessionId }));
    } catch { response.writeHead(500); response.end(JSON.stringify({ code: 'campaign_native_session_failed' })); }
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  await fs.writeFile(process.env.MATCHING_CAMPAIGN_READY, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, pid: process.pid }), { mode: 0o600 });
  ctx.effect(() => () => server.close());
}
