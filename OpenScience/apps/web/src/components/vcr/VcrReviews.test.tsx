import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VcrReviews } from './VcrReviews';
describe('research review provenance', () => {
  it('shows actual AI roles, disagreement and unavailable review without approval actions', () => {
    render(<VcrReviews reviews={[
      { id: 'clinical', reviewerKind: 'ai', role: 'clinical', label: 'AI临床复核', state: '有修订建议', status: 'done', current: true,
        by: 'actual-clinical-model', at: '2026-10-01', configurationRevision: 'study-review-v1', note: '审查意见供参考，不代表实证验证。', findings: [{ id: 'F1', location: '结论', fix: '保留适用人群限制。' }] },
      { id: 'stats', reviewerKind: 'ai', role: 'statistical', label: 'AI统计复核', state: '审查未完成', status: 'failed', current: false,
        by: null, note: '审查暂未完成；已完成的研究与导出仍可使用。', findings: [] },
    ]} />);
    expect(screen.getByText(/actual-clinical-model/)).toBeInTheDocument();
    expect(screen.getByText(/保留适用人群限制/)).toBeInTheDocument();
    expect(screen.getByText(/导出仍可使用/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
