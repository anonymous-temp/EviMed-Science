import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebApiError } from '@/lib/apiClient';
import type { VcrIntakeSource } from '@/lib/vcrClient';
import { WithdrawConsent, withdrawableSubjects, withdrawalSentence } from './WithdrawConsent';

const api = vi.hoisted(() => ({ withdraw: vi.fn() }));
vi.mock('@/lib/vcrClient', () => ({ withdrawVcrSubject: api.withdraw }));
beforeEach(() => vi.clearAllMocks());

const source = (files: Array<Record<string, unknown>>) => ({ id: 'src', files }) as unknown as VcrIntakeSource;
const documents = [
  { id: 'd1', role: 'document', subjectKey: 'P-0002' }, { id: 'd2', role: 'document', subjectKey: 'P-0001' }, { id: 'd3', role: 'document', subjectKey: 'P-0002' },
  { id: 'd4', role: 'document', subjectKey: 'P-0009', erased: true }, { id: 'd5', role: 'data', subjectKey: 'P-0005' }, { id: 'd6', role: 'document', subjectKey: null },
];

describe('a patient withdraws consent', () => {
  it('offers each patient whose record still holds text, once, in order — not an erased record, a table or a record with no patient', () => {
    expect(withdrawableSubjects(source(documents))).toEqual(['P-0001', 'P-0002']);
    expect(withdrawableSubjects(source([]))).toEqual([]);
  });
  it('says nothing, and shows nothing, where there is no record to erase', () => {
    const { container } = render(<WithdrawConsent studyId="s1" source={source([{ id: 'd5', role: 'data', subjectKey: null }])} onChanged={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('erases one patient with one choice and one press, and says what was done in counts', async () => {
    api.withdraw.mockResolvedValue({ withdrawn: { files: 2, projections: 1, factsRemoved: 1, factsRedacted: 2, referralsClosed: 1 } });
    const changed = vi.fn();
    render(<WithdrawConsent studyId="s1" source={source(documents)} onChanged={changed} />);
    fireEvent.click(screen.getByText('患者撤回同意'));
    const press = screen.getByRole('button', { name: '清除该患者的病历文本' });
    expect(press).toBeDisabled();
    fireEvent.change(screen.getByLabelText('撤回的患者'), { target: { value: 'P-0002' } });
    fireEvent.click(press);
    await waitFor(() => expect(api.withdraw).toHaveBeenCalledWith('s1', 'P-0002'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(await screen.findByText(/已清除 2 份病历文本、1 份脱敏文本、3 条据此读出的事实。哈希和审计记录保留，该患者不再参与评估。/)).toBeVisible();
    expect(screen.getByLabelText('撤回的患者')).toHaveValue('');
  });
  it('says a failure as one, and keeps the choice', async () => {
    api.withdraw.mockRejectedValue(new WebApiError('no', { status: 403, code: 'vcr_forbidden' }));
    render(<WithdrawConsent studyId="s1" source={source(documents)} onChanged={() => {}} />);
    fireEvent.click(screen.getByText('患者撤回同意'));
    fireEvent.change(screen.getByLabelText('撤回的患者'), { target: { value: 'P-0001' } });
    fireEvent.click(screen.getByRole('button', { name: '清除该患者的病历文本' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByLabelText('撤回的患者')).toHaveValue('P-0001');
  });
  it('writes the counts in the reader’s words, and the files that could not be erased', () => {
    expect(withdrawalSentence({ files: 1 })).toBe('已清除 1 份病历文本。哈希和审计记录保留，该患者不再参与评估。');
    expect(withdrawalSentence({ files: 1, filesFailed: 2 })).toContain('有 2 个文件没能清除，请重试。');
  });
});
