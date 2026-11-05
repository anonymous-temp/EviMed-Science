import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { conversationSourceStatus, deleteConversationSource, type ConversationSourceDeletionStatus } from '@/lib/conversationSourceDeletionClient';

/**
 * Component: SourceConversationDelete; owner: memory; rules: DS21, DESIGN.md.
 * Anatomy: source action, irreversible confirmation, result and progress action.
 * Variants: a source owned by the signed-in account.
 * States: ready, confirming, busy, pending, complete and retryable error.
 * Hit area: shared small Button control.
 * Keyboard: native button and ConfirmDialog focus/cancel cycle.
 * Long content: source consequence wraps in the bounded confirmation.
 * Theme: shared destructive controls and semantic text roles.
 * Responsive: wraps within the existing memory drawer.
 * Verification: SourceConversationDelete.test.tsx; native runtime acceptance is separate.
 */
export function SourceConversationDelete({ projectId, sessionId, onChanged }: { projectId: string; sessionId: string; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ConversationSourceDeletionStatus | null>(null);
  const [error, setError] = useState(false);
  async function act(remove: boolean) {
    setBusy(true); setError(false);
    try {
      const next = await (remove ? deleteConversationSource(projectId, sessionId) : conversationSourceStatus(projectId, sessionId));
      setStatus(next); setConfirming(false); onChanged();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-wrap items-center gap-2">
    {!status && <Button size="sm" variant="text" destructive disabled={busy} onClick={() => setConfirming(true)}>删除来源对话</Button>}
    {status && <span role="status" className="text-ui text-text-2">{status.sourceRemoved && status.cleanup === 'complete' ? '来源对话已删除' : '已隐藏来源对话，等待当前工作结束后清除。'}</span>}
    {status?.cleanup === 'pending' && <Button size="sm" variant="text" loading={busy} onClick={() => void act(false)}>查看删除进度</Button>}
    {error && <span role="alert" className="text-ui text-danger">删除未完成，请重试。</span>}
    {confirming && <ConfirmDialog title="删除来源对话？" consequences="这会永久删除这段对话及其子任务的原文、仅来自它的记忆。已生成的文件保留，当前工作结束后完成清除。" recovery="删除后无法恢复。" confirmLabel="永久删除" busy={busy} onCancel={() => { setConfirming(false); setError(false); }} onConfirm={() => void act(true)} />}
  </div>;
}
