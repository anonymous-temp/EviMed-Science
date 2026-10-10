import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { VcrLongitudinalPanel } from './VcrLongitudinalPanel';
import type { VcrLongitudinalData } from '@/lib/vcrLongitudinalClient';

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock('@/lib/productClient', () => network);
const empty: VcrLongitudinalData = { available: true, records: [], providers: [], templates: { events: { columns: ['subject_id'], example: ['synthetic'] }, prediction: { schema: 1 } } };
const history = { id: 'history-1', kind: 'history', createdAt: '2026-01-01', hash: 'hash', summary: { origin: '2026-01-01', subjects: 40, events: 80 } };
beforeEach(() => network.productRequest.mockReset());

it('offers templates and the conversation path without requiring a model or history', async () => {
  network.productRequest.mockResolvedValue(empty);
  render(<VcrLongitudinalPanel studyId="one" canRun />);
  expect(await screen.findByRole('button', { name: '导入预测文件' })).toBeDisabled();
  expect(screen.getByText(/可以继续用文献进行情景分析/)).toBeInTheDocument();
  expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal');
});

it('keeps an unreadable response inside the panel and permits retry', async () => {
  network.productRequest.mockResolvedValueOnce({ records: [] }).mockResolvedValue(empty);
  const user = userEvent.setup();
  render(<VcrLongitudinalPanel studyId="one" canRun />);
  await user.click(await screen.findByRole('button', { name: /重试/ }));
  expect(await screen.findByRole('button', { name: '下载事件模板' })).toBeEnabled();
});

it('imports against the selected history, displays partial acceptance and refreshes versions', async () => {
  network.productRequest.mockImplementation(async (_url: string, method?: string) => method === 'POST'
    ? { id: 'prediction-1', summary: { accepted: 39, invalidRows: 1 } }
    : { ...empty, records: [history] });
  const user = userEvent.setup();
  render(<VcrLongitudinalPanel studyId="one" canRun />);
  await screen.findByLabelText('输入历史');
  const file = new File(['{}'], 'prediction.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ schema: 1, historyId: 'unselected' }) });
  await user.upload(screen.getByLabelText('选择预测结果文件'), file);
  expect(await screen.findByRole('status')).toHaveTextContent('39 条预测，1 条需补充或更正');
  expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal/predictions', 'POST', { schema: 1, historyId: 'history-1' });
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledTimes(3));
});

it('a reader can inspect histories without receiving import controls', async () => {
  network.productRequest.mockResolvedValue({ ...empty, records: [history] });
  render(<VcrLongitudinalPanel studyId="one" canRun={false} />);
  await screen.findByLabelText('输入历史');
  expect(screen.queryByRole('button', { name: '导入预测文件' })).not.toBeInTheDocument();
});

it('hydrates an older history, explains missing forecasts and shows the same-subject baseline', async () => {
  const prediction = { id: 'pred', kind: 'prediction', createdAt: '2026-01-01', hash: 'p', summary: { historyId: history.id, model: { name: 'External', version: '2' }, accepted: 9, failures: [{ code: 'provider_rows_invalid' }] } };
  const evaluation = { id: 'evaluation', kind: 'evaluation', parentId: 'pred', createdAt: '2026-02-01', hash: 'e', summary: { validationClass: 'engineering_synthetic', trainingOverlap: 'unknown', groups: [{ horizonDays: 30, requested: 12, evaluated: 8, missingForecasts: 2, invalidForecasts: 1, missingOutcomes: 1, events: 0, metrics: { brier: { value: .04, lower: null, upper: null } }, baselines: { persistence: { subjects: 8, comparisons: { brier: { model: .04, baseline: .05, modelMinusBaseline: -.01, preferred: 'model' } } } }, distributionAvailability: { sampleRows: 0, intervalRows: 0, sdRows: 8 } }] } };
  network.productRequest.mockResolvedValue({ ...empty, records: [evaluation, prediction], related: [history], more: true, nextOffset: 100 });
  const user = userEvent.setup();
  render(<VcrLongitudinalPanel studyId="one" canRun />);
  expect(await screen.findByLabelText('输入历史')).toHaveValue(history.id);
  expect(screen.getByText(/应预测 12 人.*缺少预测 2 人.*无效预测 1 人.*缺少结局 1 人.*事件 0 人/)).toBeInTheDocument();
  expect(screen.getByText(/与最近一次观测比较/)).toBeInTheDocument();
  expect(screen.getByText(/点估计较优不代表/)).toBeInTheDocument();
  expect(screen.getByText(/云端返回的部分预测格式有误/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '加载较早版本' }));
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal?offset=100'));
  await user.click(screen.getByRole('button', { name: '刷新结果' }));
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledTimes(3));
});

it('imports external trial predictions without a patient history', async () => {
  network.productRequest.mockImplementation(async (_url: string, method?: string) => method === 'POST'
    ? { id: 'benchmark', kind: 'trial_benchmark', hash: 'b', summary: { comparisons: 3, matched: 2, issues: [{ code: 'target_identity_mismatch' }] } }
    : { ...empty, templates: { ...empty.templates, benchmark: { comparisons: [] } } });
  const user = userEvent.setup();
  render(<VcrLongitudinalPanel studyId="one" canRun />);
  await user.click(await screen.findByText('试验效果基准验证', { exact: true }));
  expect(screen.getByRole('button', { name: '导入试验预测' })).toBeEnabled();
  const file = new File(['{}'], 'trial.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ comparisons: [] }) });
  await user.upload(screen.getByLabelText('选择试验预测文件'), file);
  expect(await screen.findByRole('status')).toHaveTextContent('已导入 3 条试验预测，其中 2 条已对应到证据');
  expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal/benchmarks', 'POST', { comparisons: [] });
});

it('keeps a selected older version on refresh and places its latest evaluation first', async () => {
  const olderHistory = { ...history, id: 'history-old', createdAt: '2025-01-01' };
  const prediction = { id: 'old-pred', kind: 'prediction', hash: 'p', createdAt: '2025-02-01', summary: { historyId: olderHistory.id } };
  const evaluation = { id: 'old-eval', kind: 'evaluation', hash: 'e', createdAt: '2025-03-01', parentId: prediction.id,
    summary: { groups: [{ horizonDays: 30, requested: 20, evaluated: 18 }] } };
  const latest = { ...evaluation, id: 'new-eval', createdAt: '2026-03-01', summary: { groups: [{ horizonDays: 30, requested: 20, evaluated: 20 }] } };
  network.productRequest.mockResolvedValueOnce({ ...empty, records: [history], more: true, nextOffset: 30 })
    .mockResolvedValueOnce({ ...empty, records: [evaluation, prediction], related: [olderHistory] })
    .mockResolvedValueOnce({ ...empty, records: [latest, history] });
  const user = userEvent.setup();
  render(<VcrLongitudinalPanel studyId="one" canRun />);
  await user.click(await screen.findByRole('button', { name: '加载较早版本' }));
  await user.selectOptions(screen.getByLabelText('输入历史'), olderHistory.id);
  expect(screen.getByText(/应预测 20 人.*已验证 18 人/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '刷新结果' }));
  expect(await screen.findByLabelText('输入历史')).toHaveValue(olderHistory.id);
  expect(screen.getAllByText(/应预测 20 人/)[0]).toHaveTextContent('已验证 20 人');
});

it('explains a real small-cell display limit without claiming that outcomes are missing', async () => {
  network.productRequest.mockResolvedValue({ ...empty, related: [history], records: [
    { id: 'pred', kind: 'prediction', summary: { historyId: history.id } },
    { id: 'eval', kind: 'evaluation', parentId: 'pred', summary: { groups: [{ horizonDays: 30, displayReason: 'small_cell_suppression' }] } },
  ] });
  render(<VcrLongitudinalPanel studyId="one" canRun={false} />);
  expect(await screen.findByText(/不代表结局缺失/)).toBeInTheDocument();
  expect(screen.getByText('30 天')).toBeInTheDocument();
});
