import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EvolutionDecisionCard } from './EvolutionDecisionCard';
const mocks = vi.hoisted(() => ({ access: {enabled: true, operator: true}, get: vi.fn(), resolve: vi.fn() }));
vi.mock('@/lib/evolutionClient', () => ({ useEvolutionAccess: () => mocks.access, getEvolutionDecision: mocks.get, resolveEvolutionDecision: mocks.resolve }));
const card = (payload: Record<string, unknown> = {}) => ({ id: 'evolution-decision-1', revision: 3, payload: { title: '选择工具研发方向', body: '已经试了两条路。', decisionClass: 'B', status: 'pending',
  recommended: 'rescout', conservative: 'wait', attemptedPaths: ['initial', 'repair', 'unnamed-internal-path'], dueAt: '2026-10-06T00:00:00.000Z',
  options: [{ id: 'wait', label: '保留结果并等待新资料' }, { id: 'rescout', label: '重新寻找实现路径' }], ...payload } });
beforeEach(() => { mocks.access = {enabled: true, operator: true}; mocks.get.mockReset().mockResolvedValue(card()); mocks.resolve.mockReset(); });
describe('the decision card', () => {
  it('says which option is recommended, and does not print the notice body or internal path ids again', async () => {
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(await screen.findByRole('button', { name: '按推荐继续：重新寻找实现路径' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保留结果并等待新资料' })).toBeInTheDocument();
    expect(screen.queryByText('已经试了两条路。')).not.toBeInTheDocument();
    expect(screen.getByText('已尝试：首次实现；修复后重试')).toBeInTheDocument();
    expect(screen.queryByText(/unnamed-internal-path|initial|repair/)).not.toBeInTheDocument();
  });
  it('answers with the recommended option and the revision it was shown', async () => {
    mocks.resolve.mockResolvedValue(card({ status: 'executed', selected: 'rescout' }));
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '按推荐继续：重新寻找实现路径' }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('evolution-decision-1', { option: 'rescout', expectedRevision: 3 }));
    expect(await screen.findByText(/当前选择：重新寻找实现路径/)).toBeInTheDocument();
  });
  it('tells the operator when the review that decides an expired card could not be had', async () => {
    mocks.get.mockResolvedValue(card({ expiry: { state: 'review-unavailable', attempts: 1, of: 3 } }));
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(await screen.findByText('到期时的复核暂时没有完成，稍后会再试；你现在答复同样有效。')).toBeInTheDocument();
  });
  it('is absent and silent unless the module is on and the reader is an operator', async () => {
    mocks.access = {enabled: true, operator: false};
    const view = render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(view.container).toBeEmptyDOMElement(); expect(mocks.get).not.toHaveBeenCalled();
  });
});
