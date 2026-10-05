import { useCallback, useEffect, useState } from 'react';
import { listEvolutionOpportunities, adoptEvolutionOpportunity, useEvolutionAccess, type EvolutionOpportunity } from '@/lib/evolutionClient';
import { productErrorMessage, type ProductRecord } from '@/lib/productClient';
import { Button } from '@/components/ui/Button';
import { LoadError } from '@/components/cards/LoadError';
import { FilesSkeleton } from '@/components/cards/Skeletons';
import { EmptyState } from '@/components/cards/EmptyState';

export function EvolutionOpportunities({projectId, onAdopted}: {projectId: string; onAdopted: (id: string) => void}) {
  const {enabled} = useEvolutionAccess(); const [rows, setRows] = useState<ProductRecord<EvolutionOpportunity>[] | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {setError(null); try {setRows(await listEvolutionOpportunities(projectId));} catch (caught) {setRows([]); setError(productErrorMessage(caught));}}, [projectId]);
  useEffect(() => {if (enabled) void load();}, [enabled, load]);
  if (!enabled) return null;
  async function adopt(id: string) {setBusy(id); try {const agenda = await adoptEvolutionOpportunity(projectId, id); onAdopted(agenda.id);} catch (caught) {setError(productErrorMessage(caught));} finally {setBusy(null);}}
  return <section aria-label="研究机会" className="space-y-2"><h2 className="px-3 text-caption font-medium text-text-3">研究机会</h2>{error && <LoadError message={error} onRetry={() => void load()} />}{rows === null ? <FilesSkeleton /> : rows.length === 0 ? !error && <EmptyState title="暂无研究机会" /> : <ul>{rows.map(row => <li key={row.id} className="space-y-2 px-3 py-2"><p className="text-ui text-text">{row.payload.title}</p>{row.payload.description && <p className="text-caption text-text-2">{row.payload.description}</p>}<Button size="sm" variant="secondary" loading={busy === row.id} disabled={busy !== null} onClick={() => void adopt(row.id)}>创建研究议程</Button></li>)}</ul>}</section>;
}
