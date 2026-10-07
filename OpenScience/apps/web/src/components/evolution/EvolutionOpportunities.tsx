import { useCallback, useEffect, useState } from 'react';
import { listEvolutionOpportunities, adoptEvolutionOpportunity, useEvolutionAccess, type EvolutionOpportunity } from '@/lib/evolutionClient';
import { productErrorMessage, type ProductRecord } from '@/lib/productClient';
import { Button } from '@/components/ui/Button';
import { List, ListRow } from '@/components/ui/ListRow';
import { LoadError } from '@/components/cards/LoadError';
import { TaskGroup } from '@/components/autopilot/TaskGroup';

/**
 * 研究机会: the platform's suggestions for new scheduled tasks, as a group of the tasks list.
 * Nothing suggested, nothing drawn — and nothing while the list is still being read, so the group
 * does not appear and vanish on the way to an empty answer (2026-10-07: it used to say 「暂无研究机会」).
 */
export function EvolutionOpportunities({projectId, onAdopted}: {projectId: string; onAdopted: (id: string) => void}) {
  const {enabled} = useEvolutionAccess(); const [rows, setRows] = useState<ProductRecord<EvolutionOpportunity>[] | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {setError(null); try {setRows(await listEvolutionOpportunities(projectId));} catch (caught) {setRows([]); setError(productErrorMessage(caught));}}, [projectId]);
  useEffect(() => {if (enabled) void load();}, [enabled, load]);
  if (!enabled || rows === null || (rows.length === 0 && !error)) return null;
  async function adopt(id: string) {setBusy(id); try {const agenda = await adoptEvolutionOpportunity(projectId, id); onAdopted(agenda.id);} catch (caught) {setError(productErrorMessage(caught));} finally {setBusy(null);}}
  return <TaskGroup label="研究机会">{error && <LoadError message={error} onRetry={() => void load()} />}
    <List divided>{rows.map(row => <ListRow key={row.id} title={row.payload.title} meta={row.payload.description || undefined}
      trailing={<Button size="sm" variant="secondary" loading={busy === row.id} disabled={busy !== null} onClick={() => void adopt(row.id)}>创建研究议程</Button>} />)}</List>
  </TaskGroup>;
}
