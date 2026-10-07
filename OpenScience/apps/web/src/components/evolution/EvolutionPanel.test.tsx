import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { EvolutionPanel } from './EvolutionPanel';
const mocks = vi.hoisted(() => ({ access: {enabled: false, operator: false}, tools: vi.fn(), dossiers: vi.fn() }));
vi.mock('@/lib/evolutionClient', () => ({ useEvolutionAccess: () => mocks.access, listEvolutionTools: mocks.tools, listEvolutionDossiers: mocks.dossiers, downloadEvolutionRequirements: vi.fn(), downloadEvolutionTemplate: vi.fn() }));
const tool = {id: 't', name: '调查加权分析', track: 'P', validationLevel: 'V2', dataLevel: 'D2', dataRequirements: {schema: {fields: [{name: 'weight', type: 'number', unit: 'kg'}]}}, artifactDigest: 'digest'};
beforeEach(() => { mocks.access = {enabled: false, operator: false}; mocks.tools.mockReset().mockResolvedValue([tool]); mocks.dossiers.mockReset().mockResolvedValue([]); });
describe('evolution discovery boundaries', () => {
  it('does not call operator APIs when default off or researcher-only catalogue', async () => {
    const view = render(<MemoryRouter><EvolutionPanel /></MemoryRouter>);
    await waitFor(() => expect(mocks.tools).not.toHaveBeenCalled());
    mocks.access = {enabled: true, operator: false}; view.rerender(<MemoryRouter><EvolutionPanel /></MemoryRouter>);
    expect(mocks.tools).not.toHaveBeenCalled();
  });
  it('shows verification and data labels plus downloadable requirements for operators', async () => {
    mocks.access = {enabled: true, operator: true}; render(<MemoryRouter><EvolutionPanel /></MemoryRouter>);
    expect(await screen.findByText('调查加权分析')).toBeInTheDocument();
    // Its name on the operations page, where it moved to from under the tool grid.
    expect(screen.getByRole('heading', {name: '循证进化'})).toBeInTheDocument(); expect(screen.queryByText('进化工具')).not.toBeInTheDocument();
    expect(screen.getByText('已复现已发表算例')).toBeInTheDocument(); expect(screen.getByText('公开数据')).toBeInTheDocument();
    expect(mocks.dossiers).toHaveBeenCalledOnce();
  });
  it('shows public paper citations and the tool\'s state, and no call counts or raw requirement structure', async () => {
    mocks.access = {enabled: true, operator: false};
    mocks.tools.mockResolvedValue([{...tool, maintenanceState: 'deprecating', usage: {invoked: 7, retrieved: 99, runs: 2}, papers: [{id: '123', title: 'Published method', url: 'https://pubmed.ncbi.nlm.nih.gov/123/'}]}]);
    render(<MemoryRouter><EvolutionPanel projectId="p" /></MemoryRouter>);
    expect(await screen.findByText('待修复')).toBeInTheDocument();
    expect(screen.queryByText(/"schema"/)).not.toBeInTheDocument();
    expect(screen.getByText('Published method')).toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/123/');
    expect(screen.queryByText(/实际调用|暂无调用记录/)).not.toBeInTheDocument();
  });
  it('shows V4 research runs separately from actual invocation count', async () => {
    mocks.access = {enabled: true, operator: false}; mocks.tools.mockResolvedValue([{...tool, validationLevel: 'V4', usage: {runs: 9, invoked: 72}}]);
    render(<MemoryRouter><EvolutionPanel projectId="p" /></MemoryRouter>);
    expect(await screen.findByText('已用于 9 次研究')).toBeInTheDocument();expect(screen.queryByText(/实际调用/)).not.toBeInTheDocument();
  });
  it('unknown units do not advertise a dataset as matched and never fetch operator dossiers', async () => {
    mocks.access = {enabled: true, operator: false}; render(<MemoryRouter><EvolutionPanel projectId="p" dataset={{fields: [{name: 'weight', type: 'number'}], semanticsChecksPassed: true}} /></MemoryRouter>);
    await waitFor(() => expect(mocks.tools).toHaveBeenCalledWith('p'));
    expect(mocks.dossiers).not.toHaveBeenCalled();
    // Beside a dataset's meaning the panel is silent when no tool can use the data yet: no heading, no empty state.
    await waitFor(() => expect(screen.queryByText('这份数据可用的工具')).not.toBeInTheDocument());
    expect(screen.queryByText('暂无已匹配的工具')).not.toBeInTheDocument(); expect(screen.queryByText('调查加权分析')).not.toBeInTheDocument();
  });
});
