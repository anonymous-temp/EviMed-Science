import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { Select } from '@/components/ui/Input';
import { webErrorMessage } from '@/lib/apiClient';
import { withdrawVcrSubject, type VcrErasure, type VcrIntakeSource } from '@/lib/vcrClient';

/** The subjects whose records the source still holds as text, once each. */
export function withdrawableSubjects(source: Pick<VcrIntakeSource, 'files'>): string[] {
  const keys = source.files.filter(file => file.role === 'document' && !file.erased && file.subjectKey).map(file => file.subjectKey as string);
  return [...new Set(keys)].sort();
}

/** What a withdrawal did, in the reader's words: counts, never a record. */
export function withdrawalSentence(done: VcrErasure): string {
  const parts = [`已清除 ${done.files ?? 0} 份病历文本`];
  if (done.projections) parts.push(`${done.projections} 份脱敏文本`);
  const taken = (done.factsRemoved ?? 0) + (done.factsRedacted ?? 0);
  if (taken) parts.push(`${taken} 条据此读出的事实`);
  return `${parts.join('、')}。哈希和审计记录保留，该患者不再参与评估。${done.filesFailed ? ` 有 ${done.filesFailed} 个文件没能清除，请重试。` : ''}`;
}

/**
 * A patient's consent withdrawn: the text of their records, and of the reviewed texts of them, is erased; what an evaluation was
 * frozen on keeps its hashes and reads as withdrawn. One choice and one press, beside the records it concerns.
 */
export function WithdrawConsent({ studyId, source, onChanged }: { studyId: string; source: VcrIntakeSource; onChanged: () => void }) {
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const subjects = withdrawableSubjects(source);
  if (!subjects.length) return null;
  const withdraw = async () => {
    if (busy || !subject) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const answer = await withdrawVcrSubject(studyId, subject);
      setMessage(withdrawalSentence(answer.withdrawn)); setSubject(''); onChanged();
    } catch (error) { setFailed(true); setMessage(webErrorMessage(error, { fallback: '暂时无法清除，请重试。' })); }
    finally { setBusy(false); }
  };
  return <Disclosure summary="患者撤回同意">
    <div className="flex flex-col gap-3">
      <Select label="撤回的患者" value={subject} onChange={event => setSubject(event.target.value)}>
        <option value="">选择患者</option>{subjects.map(key => <option key={key} value={key}>{key}</option>)}
      </Select>
      <Button variant="secondary" loading={busy} disabled={busy || !subject} onClick={() => void withdraw()}>清除该患者的病历文本</Button>
      {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'text-caption text-error' : 'text-caption text-text-3'}>{message}</p>}
    </div>
  </Disclosure>;
}
