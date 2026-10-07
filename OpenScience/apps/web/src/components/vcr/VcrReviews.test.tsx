import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VcrReviews } from './VcrReviews';

describe('the reviews a study shows', () => {
  it('names an AI review by what it reviewed, says what it found and that one did not finish, and offers no approval', () => {
    render(<VcrReviews reviews={[
      { id: 'clinical', reviewerKind: 'ai', role: 'clinical', label: 'AI临床复核', state: '有修订建议', status: 'done', current: true,
        by: null, at: '2026-10-01', note: '审查意见供参考，不代表实证验证。', findings: [{ id: 'F1', location: '结论', fix: '保留适用人群限制。' }] },
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
    render(<VcrReviews reviews={[
      { id: 'human', reviewerKind: 'human', role: 'clinical', label: '人工临床复核', state: '已复核', status: 'done', current: true, by: '李医生', at: '2026-10-02', note: '', findings: [] },
    ]} />);
    expect(screen.getByText('李医生 · 2026-10-02')).toBeInTheDocument();
  });
});
