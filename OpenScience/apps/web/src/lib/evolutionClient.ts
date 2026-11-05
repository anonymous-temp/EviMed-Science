import { fetchWebMe } from './apiClient';
import { productRequest, type ProductRecord } from './productClient';
import { useEffect, useState } from 'react';

export interface EvolutionTool {
  id: string; name?: string; description?: string; track: string; validationLevel: string; dataLevel: string;
  papers?: Array<{id: string; title: string; url: string}>; usage?: {invoked?: number; retrieved?: number; runs?: number};
  maintenanceState?: 'deprecating';
  status?: 'staged' | 'active' | 'alias' | 'retired'; artifactDigest?: string; entrypoint?: string; capabilityIds?: string[]; dataRequirements?: Record<string, unknown> | null;
}
export interface EvolutionDecision {
  title: string; body: string; decisionClass: string; status: string; selected?: string; recommended: string; conservative: string;
  options: Array<{id: string; label: string}>; attemptedPaths?: string[]; dueAt?: string;
}
export function useEvolutionAccess() {
  const [access, setAccess] = useState({ enabled: false, operator: false });
  useEffect(() => { let active = true; void fetchWebMe().then(me => { if (active) setAccess({ enabled: me?.evolutionEnabled === true, operator: me?.operator === true }); }).catch(() => {}); return () => { active = false; }; }, []);
  return access;
}
export const listEvolutionTools = (projectId?: string) => productRequest<EvolutionTool[]>(projectId ? `/evolution/project-tools?projectId=${encodeURIComponent(projectId)}` : '/evolution/tools');
/** What the server says this card becomes at its due date; null when nothing is due on it. */
export type EvolutionDueOutcome = {kind: 'option'; option: string; label: string} | {kind: 'close'} | null;
export const getEvolutionDecision = (id: string) => productRequest<ProductRecord<EvolutionDecision> & {dueOutcome?: EvolutionDueOutcome}>(`/evolution/decisions/${encodeURIComponent(id)}`);
export const resolveEvolutionDecision = (id: string, input: {expectedRevision: number; option: string}) => productRequest<ProductRecord<EvolutionDecision>>(`/evolution/decisions/${encodeURIComponent(id)}/resolve`, 'POST', input);
export function downloadEvolutionRequirements(tool: EvolutionTool) {
  const blob = new Blob([JSON.stringify(tool.dataRequirements, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${tool.id}-data-requirements.json`; anchor.click(); URL.revokeObjectURL(url);
}

export function downloadEvolutionTemplate(tool: EvolutionTool) {
  const schema = tool.dataRequirements?.schema as {fields?: Array<{name: string}>} | undefined;
  const content = (schema?.fields ?? []).map(field => '"' + field.name.replaceAll('"', '""') + '"').join(',') + '\n';
  const url = URL.createObjectURL(new Blob([content], {type: 'text/csv;charset=utf-8'}));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${tool.id}-template.csv`; anchor.click(); URL.revokeObjectURL(url);
}
