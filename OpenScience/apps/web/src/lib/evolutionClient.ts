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
  /** Set while the review that decides an expired card could not be had; it is asked again and then the conservative option is taken. */
  expiry?: {state: 'review-unavailable' | 'conservative-taken'; attempts: number; of: number};
}
export interface EvolutionOpportunity { title: string; description?: string; prompt?: string; projectId: string; origin: string; }
export function useEvolutionAccess() {
  const [access, setAccess] = useState({ enabled: false, operator: false });
  useEffect(() => { let active = true; void fetchWebMe().then(me => { if (active) setAccess({ enabled: me?.evolutionEnabled === true, operator: me?.operator === true }); }).catch(() => {}); return () => { active = false; }; }, []);
  return access;
}
export const listEvolutionTools = (projectId?: string) => productRequest<EvolutionTool[]>(projectId ? `/evolution/project-tools?projectId=${encodeURIComponent(projectId)}` : '/evolution/tools');
export const listEvolutionDossiers = () => productRequest<ProductRecord<{ title?: string; goal?: string; status: string }>[]>('/evolution/dossiers');
export const listEvolutionDecisions = () => productRequest<ProductRecord<EvolutionDecision>[]>('/evolution/decisions');
export const getEvolutionDecision = (id: string) => productRequest<ProductRecord<EvolutionDecision>>(`/evolution/decisions/${encodeURIComponent(id)}`);
export const resolveEvolutionDecision = (id: string, input: {expectedRevision: number; option?: string; text?: string; delegate?: boolean}) => productRequest<ProductRecord<EvolutionDecision>>(`/evolution/decisions/${encodeURIComponent(id)}/resolve`, 'POST', input);
export const listEvolutionOpportunities = (projectId: string) => productRequest<ProductRecord<EvolutionOpportunity>[]>(`/evolution/opportunities?projectId=${encodeURIComponent(projectId)}`);
export const adoptEvolutionOpportunity = (projectId: string, opportunityId: string) => productRequest<{id: string}>('/evolution/opportunities/adopt', 'POST', {projectId, opportunityId});
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
