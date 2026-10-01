import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { downloadInlineArtifact } from '@/lib/artifactFile';
import { webErrorMessage } from '@/lib/apiClient';
import { exportVcrCorrectionCases, replayVcrCorrectionCases, type VcrCorrectionDataset, type VcrCorrectionReplay } from '@/lib/vcrClient';

/** Download references only; replay always rechecks current source access on the server. */
export function VcrCorrectionCasesActions({ studyId }: { studyId: string }) {
  const [dataset, setDataset] = useState<VcrCorrectionDataset | null>(null);
  const [report, setReport] = useState<VcrCorrectionReplay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function exportCases(after = '0') {
    setBusy(true); setError(null); setReport(null);
    try {
      const next = await exportVcrCorrectionCases(studyId, after);
      setDataset(next);
      if (next.cases.length) downloadInlineArtifact(JSON.stringify(next, null, 2), `correction-cases-${next.datasetId}.json`);
    } catch (failure) { setError(webErrorMessage(failure, { fallback: '纠正案例暂时无法导出。' })); }
    finally { setBusy(false); }
  }
  async function replay() {
    if (!dataset) return;
    setBusy(true); setError(null);
    try { setReport(await replayVcrCorrectionCases(studyId, dataset.datasetId)); }
    catch (failure) { setError(webErrorMessage(failure, { fallback: '案例暂时无法重放，请检查来源授权与版本。' })); }
    finally { setBusy(false); }
  }
  return <section aria-label="纠正案例" className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void exportCases()}>导出纠正案例</Button>
      {dataset?.cases.some(item => item.partition === 'held_out') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void replay()}>重放留出案例</Button>}
      {dataset?.selection.more && dataset.selection.nextCursor && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void exportCases(dataset.selection.nextCursor ?? '0')}>导出下一页</Button>}
    </div>
    {busy && <p role="status" className="text-caption text-text-3">正在处理纠正案例</p>}
    {error && <p role="alert" className="text-caption text-error">{error}</p>}
    {dataset?.cases.length === 0 && <p className="text-caption text-text-3">还没有可导出的已冻结纠正案例。</p>}
    {!!dataset?.selection.legacyUnfrozen && <p className="text-caption text-text-3">部分纠正没有完整输入快照，未纳入本次导出。</p>}
    {report && <p role="status" className="text-caption text-text-2">{`在 ${report.evaluated} 条留出判定中，${report.matched} 条复现了纠正结果。只重放已保存的事实和语言判定，未重新进行病历抽取。`}</p>}
  </section>;
}
