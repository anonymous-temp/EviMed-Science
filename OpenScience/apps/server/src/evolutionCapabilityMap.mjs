import { METHOD_RECORDS } from '@evimed/domain/method-records';
import { evolutionKey } from './evolutionService.mjs';

/** A task family describes research operations, not a paper title or a customer's question. @param {any} input */
export function evolutionTaskFamily(input = {}) {
  return { operation: input.operation ?? 'unknown', estimator: input.estimator ?? 'unspecified',
    inputShape: input.inputShape ?? input.dataShape ?? 'unknown', evidenceType: input.evidenceType ?? 'unspecified', deliverable: input.deliverable ?? 'unspecified' };
}

/** Rebuildable projection. Inventory alone means untested, never supported.
 * @param {{registry:any[],tools?:any[],signals?:any[],evaluations?:any[],supportedFamilies?:any[],graph?:any[],methods?:any,now?:Date}} input */
export function deriveEvolutionCapabilityMap({ registry, tools = [], signals = [], evaluations = [], supportedFamilies = [], graph = [], methods = METHOD_RECORDS, now = new Date() }) {
  const cells = new Map();
  function add(capabilityId, version, family, evidence = null, dependencies = []) {
    const taskFamily = evolutionTaskFamily(family);
    const key = evolutionKey([capabilityId, version, taskFamily]);
    const measured = evidence?.confirmatory === true && evidence?.receiptValid === true;
    const status = measured ? evidence.passed ? 'supported' : evidence.partiallyPassed ? 'partial' : 'unsupported' : 'untested';
    const previous = cells.get(key);
    cells.set(key, { id: key, capabilityId, version, taskFamily, status, newThisMonth:false, evidence: measured ? evidence : null,
      dependencies: [...new Set([...(previous?.dependencies ?? []), ...dependencies])], demand: previous?.demand ?? { occurrences: 0, distinctAccounts: 0 }, adjacent: [] });
    return cells.get(key);
  }
  for (const capability of registry.filter(item => item.visibility !== 'internal')) {
    add(capability.id, capability.version ?? 'shipped', capability.taskFamily ?? { operation: capability.id, deliverable: capability.produces?.[0] ?? 'unspecified' });
  }
  for (const [id, method] of Object.entries(methods)) {
    const record = /** @type {any} */ (method);
    for (const capabilityId of record.capabilityIds ?? []) add(capabilityId, record.version ?? id, record.taskFamily ?? { estimator: id }, null, record.dependencies ?? []);
  }
  for (const row of tools) {
    const tool = row.payload ?? row;
    if (tool.status === 'retired') continue;
    const latest = tool.status === 'active' ? evaluations.map(item => item.payload ?? item).filter(item => item.toolId === (row.id ?? tool.id) && item.artifactDigest === tool.artifactDigest).at(-1) : null;
    for (const capabilityId of tool.capabilityIds ?? []) add(capabilityId, tool.artifactDigest ?? tool.id, tool.taskFamily ?? { estimator: tool.methodId }, latest, tool.missingDependencies ?? []);
  }
  const listed=new Set(registry.filter(item=>item.visibility!=='internal').map(item=>item.id));
  for(const row of supportedFamilies){
    const support=row.payload ?? row;
    const verdict=evaluations.find(item=>item.id===support.verdictId)?.payload;
    if(!verdict?.promote||!verdict.confirmatory||!verdict.receiptValid||verdict.auditOnly||verdict.candidateId!==support.candidateId)continue;
    const capabilityIds=support.capabilityIds ?? [support.capabilityId ?? support.taskFamily?.capability ?? ({geo:'geo-content'}[support.moduleId])];
    for(const capabilityId of capabilityIds){
      if(!listed.has(capabilityId))continue;
      const cell=add(capabilityId,support.candidateId,support.taskFamily,{...verdict,passed:true},[]);
      cell.newThisMonth=String(support.confirmedAt??'').slice(0,7)===now.toISOString().slice(0,7);
    }
  }
  for (const row of signals) {
    const signal = row.payload ?? row;
    if (signal.distinctAccounts < 5) continue;
    const family = evolutionTaskFamily(signal.codes), capabilityId = signal.codes.capability;
    let cell = [...cells.values()].find(item => item.capabilityId === capabilityId && item.taskFamily.operation === family.operation && item.taskFamily.inputShape === family.inputShape);
    if (!cell) cell = add(capabilityId, 'unavailable', family, null, [signal.codes.reason]);
    if (cell.version === 'unavailable' && signal.kind === 'unmet-demand') cell.status = 'unsupported';
    // Several signal types from the same people are not independent demand.
    cell.demand.occurrences = Math.max(cell.demand.occurrences, signal.occurrences ?? 0);
    cell.demand.distinctAccounts = Math.max(cell.demand.distinctAccounts, signal.distinctAccounts ?? 0);
    cell.adjacent.push({ signalId: row.id, dependency: signal.codes.reason, unlocks: cell.id });
  }
  return { schema: 1, derivedAt: now.toISOString(), cells: [...cells.values()], graph: graph.map(item => ({ id: item.id, sha256: item.sha256, capability: item.capability, edges: item.edges })),
    counts: Object.fromEntries(['supported', 'partial', 'unsupported', 'untested'].map(status => [status, [...cells.values()].filter(cell => cell.status === status).length])) };
}

/** @param {{service:any,registry:any,readGraph:()=>Promise<any[]>}} dependencies */
export function createEvolutionCapabilityMap({ service, registry, readGraph }) {
  return { async rebuild() {
    const map = deriveEvolutionCapabilityMap({ registry: (await registry).list({ includeInternal: false }), tools: await service.tools(),
      signals: await service.list('signal-summary'), evaluations: await service.list('candidate-verdict'), supportedFamilies:await service.list('supported-family'), graph: await readGraph(), now: service.now() });
    const id = 'evolution-capability-map';
    await service.save('capability-map', id, map, await service.get(id));
    return map;
  } };
}
