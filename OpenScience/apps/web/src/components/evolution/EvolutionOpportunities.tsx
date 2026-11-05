import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { listEvolutionOpportunities, useEvolutionAccess, type EvolutionOpportunity } from '@/lib/evolutionClient';
import { productErrorMessage, type ProductRecord } from '@/lib/productClient';
import { newRuntimeUiIntent, prepareRuntimeUiIntent } from '@/lib/runtimeUiNavigation';
import { Button } from '@/components/ui/Button';
import { List, ListRow } from '@/components/ui/ListRow';
import { LoadError } from '@/components/cards/LoadError';

/** What an opportunity asks the assistant: its own brief where it has one, else what it says of itself. */
function brief(opportunity: EvolutionOpportunity): string {
  return opportunity.prompt?.trim() || [opportunity.title, opportunity.description].filter(Boolean).join('\n\n');
}

/**
 * 研究机会: the platform's suggestions for research. Adopting one opens a new conversation with its brief as the draft; nothing is
 * sent until the person sends it. Nothing suggested, nothing drawn — and nothing while the list is still being read, so the group
 * does not appear and vanish on the way to an empty answer (2026-10-07: it used to say 「暂无研究机会」).
 */
export function EvolutionOpportunities({projectId}: {projectId: string}) {
  const navigate = useNavigate();
  const {enabled} = useEvolutionAccess(); const [rows, setRows] = useState<ProductRecord<EvolutionOpportunity>[] | null>(null); const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {setError(null); try {setRows(await listEvolutionOpportunities(projectId));} catch (caught) {setRows([]); setError(productErrorMessage(caught));}}, [projectId]);
  useEffect(() => {if (enabled) void load();}, [enabled, load]);
  if (!enabled || rows === null || (rows.length === 0 && !error)) return null;
  const adopt = (row: ProductRecord<EvolutionOpportunity>) => navigate('/app/chat', {state: {runtimeUiIntent: prepareRuntimeUiIntent(newRuntimeUiIntent(brief(row.payload)))}});
  return <section aria-label="研究机会" className="space-y-1"><h2 className="px-2 text-caption text-text-3">研究机会</h2>{error && <LoadError message={error} onRetry={() => void load()} />}
    <List divided>{rows.map(row => <ListRow key={row.id} title={row.payload.title} meta={row.payload.description || undefined}
      trailing={<Button size="sm" variant="secondary" onClick={() => adopt(row)}>在对话中开始</Button>} />)}</List>
  </section>;
}
