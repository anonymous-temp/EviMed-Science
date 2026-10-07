import { SpecialistClassifier } from '../../apps/server/src/specialistClassifier.mjs';
import { decideRouting } from '../../apps/server/src/routingDecision.mjs';

// Replay measured provider answers through the production classifier and final
// dispatch. Counting only confident Jev selections hides false routes made by
// the regex fallback after an uncertain answer.
export async function routeRecordedDecision(question, catalog, decision, baseline) {
  const classifier = new SpecialistClassifier({ llmRoutingEnabled: true,
    deepseekProviderEnabled: true, deepseekApiKey: 'offline-evaluation-reference' }, {
    judgeService: decision ? { judge: async () => decision } : null,
  });
  classifier.classifyWithModel = async (_query, _agents, trace) => {
    if (baseline?.agentId === 'none') trace.verdict = 'none';
    return baseline?.agentId && baseline.agentId !== 'none' ? { agentId: baseline.agentId } : null;
  };
  const result = await decideRouting({ question, agents: catalog, classifier });
  return { agentId: result.capability?.id ?? 'none', decidedBy: result.decidedBy };
}
