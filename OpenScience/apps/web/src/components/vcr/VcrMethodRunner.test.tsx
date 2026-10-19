import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VCR_SCENARIO_SCHEMAS, validateScenario } from '@evimed/domain';
import { methodKind, methodTask, schemaDefault, VcrMethodRunner } from './VcrMethodRunner';
const api = vi.hoisted(() => ({ queueVcrJob: vi.fn(), getVcrHome: vi.fn(), getVcrJob: vi.fn(), cancelVcrJob: vi.fn(), getVcrMethodHistory: vi.fn(), getVcrMethodConfiguration: vi.fn() }));
vi.mock('@/lib/vcrClient', async (load) => ({ ...await load<object>(), ...api }));
const draw = (method = { id: 'evalue', name: 'E-value', method: 'comparator.evalue' }) => render(<MemoryRouter><VcrMethodRunner method={method} onClose={vi.fn()} /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [] });
  api.getVcrHome.mockResolvedValue({ studies: [{ id: 'study_1', name: 'Existing study' }] });
  api.queueVcrJob.mockResolvedValue({ id: 'job_1', kind: 'evalue', label: '敏感性分析', state: 'succeeded', seed: 42 });
});
describe('method configuration', () => {
  it('uses the actual domain method mapping and leaves unsupported methods unsupported', async () => {
    expect(methodKind('comparator.evalue')).toBe('evalue');
    expect(methodKind('model_comparator')).toBeNull();
    expect(methodTask('design.analytic')).toBe('设计试验');
    draw({ id: 'model_comparator', name: 'Model comparator', method: 'model_comparator' });
    expect(screen.getByText('此方法暂不支持直接运行。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存配置并运行' })).not.toBeInTheDocument();
    await waitFor(() => expect(api.getVcrHome).toHaveBeenCalled());
  });
  it('never treats an empty required numeric field as zero', () => {
    const schema = VCR_SCENARIO_SCHEMAS['comparator.evalue'];
    const initial = schemaDefault(schema as never);
    expect(validateScenario('comparator.evalue', initial).length).toBeGreaterThan(0);
  });
  it('queues only the chosen study with typed scenario, seed and snapshot references and reuses its frozen configuration', async () => {
    draw();
    await screen.findByRole('option', { name: 'Existing study' });
    fireEvent.change(screen.getByLabelText('用于现有研究'), { target: { value: 'study_1' } });
    fireEvent.click(screen.getByRole('button', { name: '载入示例 1（需按研究修改）' }));
    fireEvent.change(screen.getByLabelText('研究数据快照引用'), { target: { value: 'snapshot_saved' } });
    fireEvent.change(screen.getByLabelText('随机种子'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置并运行' }));
    await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalledWith('study_1', expect.objectContaining({ kind: 'evalue', seed: 123, inputs: [{ kind: 'snapshot', id: 'snapshot_saved' }] })));
    const sent = api.queueVcrJob.mock.calls[0][1];
    expect(validateScenario('comparator.evalue', sent.scenario)).toEqual([]);
    expect(await screen.findByText(/运行完成/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('随机种子'), { target: { value: '456' } });
    fireEvent.click(screen.getByRole('button', { name: '复用本次配置' }));
    expect(screen.getByLabelText('随机种子')).toHaveValue(123);
    expect(screen.getByRole('link', { name: '查看研究结果' })).toHaveAttribute('href', '/app/virtual-research/study_1/comparator');
  });
  it('allows multiple matrix rows when max constrains each correlation cell', async () => {
    draw({ id: 'population', name: 'Population', method: 'population.scenario' });
    await screen.findByRole('option', { name: 'Existing study' });
    fireEvent.click(screen.getByRole('button', { name: '载入示例 1（需按研究修改）' }));
    fireEvent.click(screen.getByRole('button', { name: '添加相关矩阵' }));
    const matrix = screen.getByRole('group', { name: '相关矩阵' });
    const addRow = () => within(matrix).getAllByRole('button', { name: '添加一项' }).at(-1)!;
    fireEvent.click(addRow());
    expect(addRow()).not.toBeDisabled();
    fireEvent.click(addRow());
    expect(within(matrix).getByRole('group', { name: '相关矩阵 2' })).toBeInTheDocument();
  });
  it('restores persisted configuration after reopening with its seed, replicates and references', async () => {
    api.getVcrMethodHistory.mockResolvedValue({ jobs: [{ id: 'old_job', kind: 'evalue', label: 'Previous run', state: 'succeeded' }, { id: 'other_job', kind: 'design_analytic', label: 'Other method', state: 'succeeded' }] });
    api.getVcrMethodConfiguration.mockResolvedValue({ kind: 'evalue', method: 'comparator.evalue', methodVersion: '1.0.0', scenarioHash: 'saved-fingerprint', scenario: { riskRatio: 2 }, seed: 987, replicates: 1234, inputRefs: [{ kind: 'snapshot', id: 'snapshot_preserved' }], unavailableInputs: 0 });
    draw();
    await screen.findByRole('option', { name: 'Existing study' });
    fireEvent.change(screen.getByLabelText('用于现有研究'), { target: { value: 'study_1' } });
    fireEvent.click(screen.getByText('复用历史配置'));
    fireEvent.click(await screen.findByRole('button', { name: '复用此配置' }));
    await waitFor(() => expect(screen.getByLabelText('随机种子')).toHaveValue(987));
    expect(api.getVcrMethodConfiguration).toHaveBeenCalledWith('study_1', 'old_job');
    expect(screen.getByLabelText('重复计算次数')).toHaveValue(1234);
    expect(screen.getByLabelText('研究数据快照引用')).toHaveValue('snapshot_preserved');
    expect(screen.queryByText('Other method')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存配置并运行' }));
    await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalledWith('study_1', expect.objectContaining({ scenario: { riskRatio: 2 }, seed: 987, replicates: 1234, inputs: [{ kind: 'snapshot', id: 'snapshot_preserved' }] })));
  });
  it('refuses reuse when derived data references cannot be reconstructed', async () => {
    api.getVcrMethodHistory.mockResolvedValue({ jobs: [{ id: 'old_job', kind: 'evalue', state: 'failed' }] });
    api.getVcrMethodConfiguration.mockResolvedValue({ kind: 'evalue', method: 'comparator.evalue', scenario: { riskRatio: 2 }, seed: 987, inputRefs: [], unavailableInputs: 1 });
    draw();
    await screen.findByRole('option', { name: 'Existing study' });
    fireEvent.change(screen.getByLabelText('用于现有研究'), { target: { value: 'study_1' } });
    fireEvent.click(screen.getByText('复用历史配置'));
    fireEvent.click(await screen.findByRole('button', { name: '复用此配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('此配置依赖的部分数据无法直接复用');
    expect(screen.getByLabelText('随机种子')).toHaveValue(42);
    expect(api.queueVcrJob).not.toHaveBeenCalled();
  });
  it('shows submission failure without inventing a successful result', async () => {
    api.queueVcrJob.mockRejectedValue(new Error('refused'));
    draw();
    await screen.findByRole('option', { name: 'Existing study' });
    fireEvent.change(screen.getByLabelText('用于现有研究'), { target: { value: 'study_1' } });
    fireEvent.click(screen.getByRole('button', { name: '载入示例 1（需按研究修改）' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置并运行' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/运行完成/)).not.toBeInTheDocument();
  });
});

it('keeps matching and curve reconstruction in their source-authorized study workflows', async () => {
  expect(methodKind('matching.evaluate')).toBeNull();
  expect(methodKind('evidence.reconstruct_km')).toBeNull();
  draw({ id: 'matching', name: 'Matching', method: 'matching.evaluate' });
  expect(screen.queryByRole('button', { name: '保存配置并运行' })).toBeNull();
  expect(await screen.findByRole('link', { name: 'Existing study' })).toHaveAttribute('href', '/app/virtual-research/study_1/matching');
});

it('replaces the opening model identity when reusing another immutable model configuration', async () => {
  const scenario = { design: { nTreat: 10, nControl: 10 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.4, treatmentRate: 0.6 } };
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [{ id: 'model_b_job', kind: 'generate_patients_binary', state: 'succeeded' }] });
  api.getVcrMethodConfiguration.mockResolvedValue({ kind: 'generate_patients_binary', method: 'patients.binary', scenario, seed: 987, inputRefs: [], unavailableInputs: 0, sourceModel: { id: 'model_b', version: '2' } });
  render(<MemoryRouter><VcrMethodRunner method={{ id: 'binary', name: 'Binary', method: 'patients.binary' }} sourceModel={{ id: 'model_a', version: '1', studyId: 'study_1', scenario }} onClose={vi.fn()} /></MemoryRouter>);
  await screen.findByRole('option', { name: 'Existing study' });
  fireEvent.click(screen.getByText('复用历史配置'));
  fireEvent.click(await screen.findByRole('button', { name: '复用此配置' }));
  await waitFor(() => expect(screen.getByLabelText('随机种子')).toHaveValue(987));
  fireEvent.click(screen.getByRole('button', { name: '保存配置并运行' }));
  await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalledWith('study_1', expect.objectContaining({ modelId: 'model_b' })));
});

it('renders Gamma recruitment parameters and Beta screening priors as shapes rather than trial significance', async () => {
  draw({ id: 'accrual', name: 'Accrual', method: 'accrual.poisson_gamma' });
  await screen.findByRole('option', { name: 'Existing study' });
  fireEvent.click(screen.getByRole('button', { name: '载入示例 1（需按研究修改）' }));
  expect(screen.getAllByLabelText('招募强度 Gamma 形状 α（无量纲）')[0]).toHaveValue(2);
  expect(screen.getAllByLabelText('招募强度 Gamma 速率 β（月）')[0]).toHaveValue(4);
  expect(screen.queryByLabelText(/显著性水平/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '添加筛选失败率 Beta 先验' }));
  expect(screen.getByLabelText('筛选失败率 Beta 先验形状 α（无量纲）')).toBeInTheDocument();
  expect(screen.getByLabelText('筛选失败率 Beta 先验形状 β（无量纲）')).toBeInTheDocument();
});

it('retains a test-alpha and calendar-unit boundary in a trial-design example', async () => {
  draw({ id: 'trial', name: 'Trial', method: 'design.analytic' });
  await screen.findByRole('option', { name: 'Existing study' });
  fireEvent.click(screen.getByRole('button', { name: '载入示例 1（需按研究修改）' }));
  expect(screen.getByLabelText('检验显著性水平 α（比例）')).toHaveValue(0.025);
  expect(screen.getByLabelText('对照中位时间（月（方法默认））')).toHaveValue(12);
  expect(screen.getByRole('button', { name: '载入示例 1（需按研究修改）' })).toBeInTheDocument();
});

it('keeps the population Beta distribution shape labels after selecting a variant inside an array', async () => {
  draw({ id: 'population', name: 'Population', method: 'population.scenario' });
  await screen.findByRole('option', { name: 'Existing study' });
  fireEvent.click(screen.getByRole('button', { name: '载入示例 1（需按研究修改）' }));
  fireEvent.change(screen.getAllByLabelText('类型')[0], { target: { value: 'beta' } });
  expect(screen.getByLabelText('Beta 分布形状参数 α（无量纲）')).toBeInTheDocument();
  expect(screen.getByLabelText('Beta 分布形状参数 β（无量纲）')).toBeInTheDocument();
  expect(screen.queryByLabelText(/显著性水平/)).toBeNull();
});
