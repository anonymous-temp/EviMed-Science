import { useCallback, useEffect, useState } from 'react';
import { getEvolutionDecision, resolveEvolutionDecision, useEvolutionAccess, type EvolutionDecision } from '@/lib/evolutionClient';
import { productErrorMessage, type ProductRecord } from '@/lib/productClient';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FilesSkeleton } from '@/components/cards/Skeletons';
import { LoadError } from '@/components/cards/LoadError';
import { EmptyState } from '@/components/cards/EmptyState';

export function EvolutionDecisionCard({ id }: { id: string }) {
  const access = useEvolutionAccess();
  const [row, setRow] = useState<ProductRecord<EvolutionDecision> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const load = useCallback(async () => { setError(null); try { setRow(await getEvolutionDecision(id)); } catch (caught) { setError(productErrorMessage(caught)); } }, [id]);
  useEffect(() => { if (access.enabled && access.operator) void load(); }, [load, access.enabled, access.operator]);
  async function choose(input: {option?: string; text?: string; delegate?: boolean}) {
    if (!row) return; setBusy(true); setError(null);
    try { setRow(await resolveEvolutionDecision(id, { ...input, expectedRevision: row.revision })); }
    catch (caught) { setError(productErrorMessage(caught)); } finally { setBusy(false); }
  }
  if (!access.enabled || !access.operator) return null;
  return <div className="relative z-10 mt-3 space-y-3">
    {error && <LoadError message={error} onRetry={() => void load()} />}
    {!row ? !error && <FilesSkeleton /> : <>
      <p className="text-ui text-text-2">{row.payload.body}</p>
      {row.payload.attemptedPaths?.length ? <p className="text-caption text-text-3">已尝试：{row.payload.attemptedPaths.join('；')}</p> : null}
      {row.payload.dueAt && <p className="text-caption text-text-3">{new Date(row.payload.dueAt).toLocaleString('zh-CN')} 后{row.payload.decisionClass === 'C' ? '保留当前方案' : '按复核后的推荐继续'}。</p>}
      {row.payload.status === 'executed' && <p className="text-caption text-text-2">当前选择：{row.payload.options.find(item => item.id === row.payload.selected)?.label}。仍可调整后续方向。</p>}
      <div className="flex flex-wrap gap-2"><Button loading={busy} onClick={() => void choose({option: row.payload.recommended})}>按推荐继续</Button>{row.payload.options.filter(item => item.id !== row.payload.recommended).map(item => <Button key={item.id} variant="secondary" disabled={busy} onClick={() => void choose({option: item.id})}>{item.label}</Button>)}<Button variant="text" disabled={busy || row.payload.decisionClass === 'C'} onClick={() => void choose({delegate: true})}>以后这类你定</Button></div>
      <Input label="改成" value={text} onChange={event => setText(event.target.value)} placeholder="写下希望调整的方向" />
      <Button variant="secondary" disabled={busy || !text.trim()} onClick={() => void choose({text: text.trim()})}>调整方向</Button>
      {row.payload.rollback && <p className="text-caption text-text-3">撤回方式：{row.payload.rollback}</p>}
    </>}
    {!row && error && <EmptyState title="裁决暂时无法读取" />}
  </div>;
}
