import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { VcrReviews } from './VcrReviews';

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

describe('the reviews a study shows', () => {
  it('names an AI review by what it reviewed, says what it found and that one did not finish, and offers no approval', () => {
    draw(<VcrReviews reviews={[
      { id: 'clinical', reviewerKind: 'ai', role: 'clinical', label: 'AI临床复核', state: '有修订建议', status: 'done', current: true,
        by: null, at: '昨天 09:07', note: '审查意见供参考，不代表实证验证。', findings: [{ id: 'F1', fix: '保留适用人群限制。' }] },
      { id: 'stats', reviewerKind: 'ai', role: 'statistical', label: 'AI统计复核', state: '审查未完成', status: 'failed', current: false,
        by: null, note: '审查暂未完成；已完成的研究与导出仍可使用。', findings: [] },
    ]} />);
    expect(screen.getByText(/AI临床复核 · 有修订建议/)).toBeInTheDocument();
    expect(screen.getByText(/保留适用人群限制/)).toBeInTheDocument();
    expect(screen.getByText(/导出仍可使用/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The model that wrote a review, its configuration and its input digest are the platform's record, not the reader's.
    expect(document.body.textContent).not.toMatch(/qwen|deepseek|revision|digest|study-review/i);
  });

  it('names a person who reviewed, and says nothing of a reviewer it does not know', () => {
    draw(<VcrReviews reviews={[
      { id: 'human', reviewerKind: 'human', role: 'clinical', label: '人工临床复核', state: '已复核', status: 'done', current: true, by: '李医生', at: '昨天 09:07', note: '', findings: [] },
    ]} />);
    expect(screen.getByText('李医生 · 昨天 09:07')).toBeInTheDocument();
  });

  it('reads each finding as its one sentence — the fix, or the message when the reviewer wrote none — with no path, no quotation and no timestamp of the record', () => {
    // The payload carries neither `location` nor `evidence` (the server keeps them in the stored record); even if an old payload did, they are not read.
    const finding = { id: 'F2', kind: 'number_untraced', message: '这个数字没有对应的运行。', fix: '', location: 'snapshot.model.results.trial_scenario.diagnostics.issues', evidence: '{"issues":[{"code":"cpu_budget_exhausted"}]}' };
    draw(<VcrReviews reviews={[
      { id: 'stats', reviewerKind: 'ai', role: 'statistical', label: 'AI统计复核', state: '有修订建议', status: 'done', current: true, by: null,
        at: '昨天 09:07', note: '', findings: [finding as never] },
    ]} />);
    expect(screen.getByText('这个数字没有对应的运行。')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/snapshot\.|cpu_budget|issues|\d{4}-\d\d-\d\dT/);
    expect(screen.queryByRole('blockquote')).toBeNull();
    expect(document.querySelector('blockquote')).toBeNull();
  });

  it('links a finding about an object the study holds to that object — a card opens on its own page by its key — and closes the drawer it was read in', async () => {
    const away = vi.fn();
    draw(<VcrReviews studyId="std_1" onNavigate={away} reviews={[
      { id: 'stats', reviewerKind: 'ai', role: 'statistical', label: 'AI统计复核', state: '有修订建议', status: 'done', current: true, by: null, at: '昨天 09:07', note: '',
        findings: [
          { id: 'F1', fix: '把入组时长改成 18 个月。', target: { label: '假设卡「入组时长」', tab: 'data', key: 'accrual_duration' } },
          { id: 'F2', fix: '重新核对试验方案。', target: { label: '试验方案', tab: 'trial', key: null } },
          { id: 'F3', fix: '没有对应对象的意见。', target: null },
        ] },
    ]} />);
    const card = screen.getByRole('link', { name: '查看假设卡「入组时长」' });
    expect(card).toHaveAttribute('href', '/app/virtual-research/std_1/data?card=accrual_duration');
    expect(screen.getByRole('link', { name: '查看试验方案' })).toHaveAttribute('href', '/app/virtual-research/std_1/trial');
    expect(screen.getAllByRole('link')).toHaveLength(2);
    await userEvent.click(card);
    expect(away).toHaveBeenCalledTimes(1);
  });

  it('draws no link without a study to link into, and none to a tab this build does not have', () => {
    draw(<VcrReviews reviews={[
      { id: 'stats', reviewerKind: 'ai', role: 'statistical', label: 'AI统计复核', state: '有修订建议', status: 'done', current: true, by: null, note: '',
        findings: [{ id: 'F1', fix: '改。', target: { label: '试验方案', tab: 'trial', key: null } }] },
    ]} />);
    expect(screen.queryByRole('link')).toBeNull();
    draw(<VcrReviews studyId="std_1" reviews={[
      { id: 'stats2', reviewerKind: 'ai', role: 'statistical', label: 'AI统计复核', state: '有修订建议', status: 'done', current: true, by: null, note: '',
        findings: [{ id: 'F1', fix: '改。', target: { label: '某页', tab: 'nowhere', key: null } }] },
    ]} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
