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
  it('offers the options only: no free-text answer and no standing delegation', async () => {
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    await screen.findByRole('button', { name: '按推荐继续：重新寻找实现路径' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /调整方向|以后这类你定/ })).not.toBeInTheDocument();
  });
  it('says what the server says happens at the due date, by the option it takes', async () => {
    mocks.get.mockResolvedValue({ ...card({ decisionClass: 'C', status: 'pending' }), dueOutcome: { kind: 'option', option: 'retire', label: '软退役并保留历史' } });
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(await screen.findByText(/前未答复，将按“软退役并保留历史”处理。/)).toBeInTheDocument();
    expect(screen.queryByText(/保留当前方案|复核后的推荐/)).not.toBeInTheDocument();
  });
  it('says the card will close when nothing it could take can be carried out', async () => {
    mocks.get.mockResolvedValue({ ...card(), dueOutcome: { kind: 'close' } });
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(await screen.findByText(/前未答复，这条裁决会关闭。/)).toBeInTheDocument();
  });
  it('promises nothing at a due date the server says nothing about', async () => {
    mocks.get.mockResolvedValue({ ...card({ status: 'executed', selected: 'wait' }), dueOutcome: null });
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(await screen.findByText(/当前选择：保留结果并等待新资料/)).toBeInTheDocument();
    expect(screen.queryByText(/前未答复/)).not.toBeInTheDocument();
  });
  it('says a closed card is closed, and nothing about trying again', async () => {
    mocks.get.mockResolvedValue({ ...card({ status: 'closed', closedReason: 'retired-to-lab' }), dueOutcome: null });
    render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(await screen.findByText('这条裁决已关闭，它要做的工作不再在线上进行。')).toBeInTheDocument();
    expect(screen.queryByText(/稍后会再试|已完成的工作会保留/)).not.toBeInTheDocument();
  });
  it('is absent and silent unless the module is on and the reader is an operator', async () => {
    mocks.access = {enabled: true, operator: false};
    const view = render(<EvolutionDecisionCard id="evolution-decision-1" />);
    expect(view.container).toBeEmptyDOMElement(); expect(mocks.get).not.toHaveBeenCalled();
  });
});
