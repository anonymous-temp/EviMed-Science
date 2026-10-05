import { evolutionToolVisible } from '@evimed/domain';
/** Only the supply publisher mints native identities. @param {any} publication */
export const trustedEvolutionNativeName = publication => /^platform-[a-f0-9]{24}$/.test(publication?.nativeName ?? '') ? publication.nativeName : undefined;
/** An exact installed identity in an explicit execution request selects its public capability, with statistics as the calculation-only default.
 * Metadata discovery never grants permission; the existing gateway still enforces the pinned scope.
 * @param {string} text @param {any[]} tools @param {readonly any[]} agents @param {any} session @param {any} chosenLine */
export function routeExplicitEvolutionTool(text,tools,agents,session,chosenLine) {
  if(chosenLine || session?.mode!=='open-domain' || !/^(?:\s*(?:请(?:帮我)?|please|can you|could you)\s*)?(?:使用|调用|运行|执行|实际调用|实际执行|use\b|invoke\b|run\b|execute\b)/i.test(text))return null;
  const mentioned=tools.filter(row=>evolutionToolVisible(row.payload)&&[row.id,row.payload.nativeName].filter(Boolean).some(name=>{
    const index=text.indexOf(name);if(index<0)return false;
    return !/[A-Za-z0-9_-]/.test(text[index-1]??'') && !/[A-Za-z0-9_-]/.test(text[index+name.length]??'');
  }));
  if(!mentioned.length)return null;
  const publicAgents=agents.filter(agent=>agent.visibility!=='internal'&&agent.id!=='open-domain-answer');
  const supported=publicAgents.filter(agent=>mentioned.every(row=>row.payload.capabilityIds?.includes(agent.id)));
  const statisticalDefault=mentioned.every(row=>row.payload.toolKind==='calculation') ? supported.find(agent=>agent.id==='statistical-analysis') : null;
  if(!statisticalDefault && supported.length!==1)return null;
  const agent=statisticalDefault??supported[0];
  return {agentId:agent.id,agentVersion:agent.version,runtimeAgent:agent.runtimeAgent,reason:`installed-tool:${mentioned.map(row=>row.id).sort().join(',')}`};
}
