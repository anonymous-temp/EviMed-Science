import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { useLongitudinal, VcrLongitudinalPanel } from './VcrLongitudinalPanel';
import { renderTab } from './__fixtures__/tabFrame';
import type { VcrLongitudinalData } from '@/lib/vcrLongitudinalClient';

/**
 * The longitudinal view is a second view of the virtual-patients tab (R19): the tab reads the records (`useLongitudinal`), hands the
 * view their data and `onReload`, and the view puts its templates and imports behind the band's 「⋯」. Rendered here the way the tab
 * renders it — under a frame that draws the band — so what a reader presses is what they would press.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock('@/lib/productClient', () => network);
const empty: VcrLongitudinalData = { available: true, records: [], providers: [], templates: { events: { columns: ['subject_id'], example: ['synthetic'] }, prediction: { schema: 1 } } };
const history = { id: 'history-1', kind: 'history', createdAt: '2026-01-01', hash: 'hash', summary: { origin: '2026-01-01', subjects: 40, events: 80 } };
beforeEach(() => { network.productRequest.mockReset(); });

function Harness({ canRun = true }: { canRun?: boolean }) {
  const { state, reload } = useLongitudinal('one');
  if (state.kind !== 'ready') return null;
  return <VcrLongitudinalPanel studyId="one" canRun={canRun} data={state.data} onReload={reload} />;
}
const draw = (canRun = true, options: { version?: string } = {}) => renderTab(<Harness canRun={canRun} />, { studyId: 'one', ...options });
/** The band's 「⋯」, opened. */
const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: '模板与导入' }));
  return screen.getByRole('menu', { name: '模板与导入' });
};

it('puts the templates behind the band\'s ⋯ and offers no import that has nothing to attach to', async () => {
  network.productRequest.mockResolvedValue(empty);
  const user = userEvent.setup();
  draw();
  const menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: '下载事件模板' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: '下载预测模板' })).toBeInTheDocument();
  // A prediction file attaches to a history; with none there is no such entry (it used to be a primary button that was always grey).
  expect(within(menu).queryByRole('menuitem', { name: '导入预测文件' })).toBeNull();
  expect(within(menu).getByRole('menuitem', { name: '导入试验预测' })).toBeInTheDocument();
  // And no sentence tells the reader how to bring a history in.
  expect(screen.queryByText(/在数据页接入随访记录/)).toBeNull();
  expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal');
});

it('imports against the selected history, displays partial acceptance and reads the records again', async () => {
  network.productRequest.mockImplementation(async (_url: string, method?: string) => method === 'POST'
    ? { id: 'prediction-1', summary: { accepted: 39, invalidRows: 1 } }
    : { ...empty, records: [history] });
  const user = userEvent.setup();
  draw();
  await screen.findByLabelText('输入历史');
  const menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: '导入预测文件' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  const file = new File(['{}'], 'prediction.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ schema: 1, historyId: 'unselected' }) });
  await user.upload(screen.getByLabelText('选择预测结果文件'), file);
  expect(await screen.findByRole('status')).toHaveTextContent('39 条预测，1 条需补充或更正');
  expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal/predictions', 'POST', { schema: 1, historyId: 'history-1' });
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledTimes(3));
});

it('a reader can inspect histories without receiving import controls', async () => {
  network.productRequest.mockResolvedValue({ ...empty, records: [history] });
  const user = userEvent.setup();
  draw(false);
  await screen.findByLabelText('输入历史');
  const menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: '下载事件模板' })).toBeInTheDocument();
  expect(within(menu).queryByRole('menuitem', { name: '导入预测文件' })).toBeNull();
  expect(within(menu).queryByRole('menuitem', { name: '导入试验预测' })).toBeNull();
});

it('hydrates an older history, explains missing forecasts and shows the same-subject baseline — and has no button to refresh', async () => {
  const prediction = { id: 'pred', kind: 'prediction', createdAt: '2026-01-01', hash: 'p', summary: { historyId: history.id, model: { name: 'External', version: '2' }, accepted: 9, failures: [{ code: 'provider_rows_invalid' }] } };
  const evaluation = { id: 'evaluation', kind: 'evaluation', parentId: 'pred', createdAt: '2026-02-01', hash: 'e', summary: { validationClass: 'engineering_synthetic', trainingOverlap: 'unknown', groups: [{ horizonDays: 30, requested: 12, evaluated: 8, missingForecasts: 2, invalidForecasts: 1, missingOutcomes: 1, events: 0, metrics: { brier: { value: .04, lower: null, upper: null } }, baselines: { persistence: { subjects: 8, comparisons: { brier: { model: .04, baseline: .05, modelMinusBaseline: -.01, preferred: 'model' } } } }, distributionAvailability: { sampleRows: 0, intervalRows: 0, sdRows: 8 } }] } };
  network.productRequest.mockResolvedValue({ ...empty, records: [evaluation, prediction], related: [history], more: true, nextOffset: 100 });
  const user = userEvent.setup();
  draw();
  expect(await screen.findByLabelText('输入历史')).toHaveValue(history.id);
  expect(screen.getByText(/应预测 12 人.*缺少预测 2 人.*无效预测 1 人.*缺少结局 1 人.*事件 0 人/)).toBeInTheDocument();
  expect(screen.getByText(/与最近一次观测比较/)).toBeInTheDocument();
  expect(screen.getByText(/点估计较优不代表/)).toBeInTheDocument();
  expect(screen.getByText(/云端返回的部分预测格式有误/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '加载较早版本' }));
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal?offset=100'));
  // The records follow the study; a button that admits they would not is gone.
  expect(screen.queryByRole('button', { name: '刷新结果' })).toBeNull();
});

it('imports external trial predictions without a patient history', async () => {
  network.productRequest.mockImplementation(async (_url: string, method?: string) => method === 'POST'
    ? { id: 'benchmark', kind: 'trial_benchmark', hash: 'b', summary: { comparisons: 3, matched: 2, issues: [{ code: 'target_identity_mismatch' }] } }
    : { ...empty, templates: { ...empty.templates, benchmark: { comparisons: [] } } });
  const user = userEvent.setup();
  draw();
  const menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: '导入试验预测' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  const file = new File(['{}'], 'trial.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ comparisons: [] }) });
  await user.upload(screen.getByLabelText('选择试验预测文件'), file);
  expect(await screen.findByRole('status')).toHaveTextContent('已导入 3 条试验预测，其中 2 条已对应到证据');
  expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal/benchmarks', 'POST', { comparisons: [] });
});

it('keeps a selected older version when the study moves and places its latest evaluation first', async () => {
  const olderHistory = { ...history, id: 'history-old', createdAt: '2025-01-01' };
  const prediction = { id: 'old-pred', kind: 'prediction', hash: 'p', createdAt: '2025-02-01', summary: { historyId: olderHistory.id } };
  const evaluation = { id: 'old-eval', kind: 'evaluation', hash: 'e', createdAt: '2025-03-01', parentId: prediction.id,
    summary: { groups: [{ horizonDays: 30, requested: 20, evaluated: 18 }] } };
  const latest = { ...evaluation, id: 'new-eval', createdAt: '2026-03-01', summary: { groups: [{ horizonDays: 30, requested: 20, evaluated: 20 }] } };
  network.productRequest.mockResolvedValueOnce({ ...empty, records: [history], more: true, nextOffset: 30 })
    .mockResolvedValueOnce({ ...empty, records: [evaluation, prediction], related: [olderHistory] })
    .mockResolvedValueOnce({ ...empty, records: [latest, history] });
  const user = userEvent.setup();
  const view = draw(true, { version: 'v1' });
  await user.click(await screen.findByRole('button', { name: '加载较早版本' }));
  await user.selectOptions(screen.getByLabelText('输入历史'), olderHistory.id);
  expect(screen.getByText(/应预测 20 人.*已验证 18 人/)).toBeInTheDocument();
  // The study moved (an engine job finished): the records are read again by themselves, and the reader's choice stays.
  view.rerenderTab(<Harness />, { version: 'v2' });
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledTimes(3));
  expect(await screen.findByLabelText('输入历史')).toHaveValue(olderHistory.id);
  expect(screen.getAllByText(/应预测 20 人/)[0]).toHaveTextContent('已验证 20 人');
});

it('explains a real small-cell display limit without claiming that outcomes are missing', async () => {
  network.productRequest.mockResolvedValue({ ...empty, related: [history], records: [
    { id: 'pred', kind: 'prediction', summary: { historyId: history.id } },
    { id: 'eval', kind: 'evaluation', parentId: 'pred', summary: { groups: [{ horizonDays: 30, displayReason: 'small_cell_suppression' }] } },
  ] });
  draw(false);
  expect(await screen.findByText(/不代表结局缺失/)).toBeInTheDocument();
  expect(screen.getByText('30 天')).toBeInTheDocument();
});

it('imports multiple endpoints in one file and keeps partial component results discoverable', async () => {
  const component = { id: 'panel-one', kind: 'prediction', hash: 'p', createdAt: '2026-03-01', summary: { historyId: history.id, endpoint: { code: 'HbA1c', type: 'continuous', unit: '%' } } };
  let uploaded = false;
  network.productRequest.mockImplementation(async (_url: string, method?: string) => {
    if (method === 'POST') { uploaded = true; return { id: 'set', kind: 'prediction_set', summary: { acceptedComponents: 2, invalidComponents: 1, accepted: 80, components: [{ id: component.id }] } }; }
    return { ...empty, templates: { ...empty.templates, predictionSet: { predictions: [] } }, records: [history], related: uploaded ? [component] : [] };
  });
  const user = userEvent.setup();
  draw();
  const menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: '下载多终点模板' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  const file = new File(['{}'], 'panel.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ predictions: [] }) });
  await user.upload(screen.getByLabelText('选择预测结果文件'), file);
  expect(await screen.findByRole('status')).toHaveTextContent('2 个终点的 80 条预测，1 个终点需更正');
  await waitFor(() => expect(screen.getByLabelText('预测版本')).toHaveValue(component.id));
});

it('compares forecasts from updated histories and automatically displays the completed comparison', async () => {
  const endpoint = { code: 'HbA1c', type: 'continuous', unit: '%' };
  const first = { id: 'first', kind: 'prediction', createdAt: '2026-03-01', hash: 'p', summary: { historyId: history.id, origin: '2026-01-31', endpoint } };
  const second = { id: 'second', kind: 'prediction', createdAt: '2026-02-01', hash: 'q', summary: { historyId: 'older', origin: '2026-01-01', endpoint } };
  const comparison = { id: 'comparison', kind: 'comparison', parentId: first.id, createdAt: '2026-04-01', summary: { available: true, mode: 'update', predictionIds: ['first', 'second'], origins: ['2026-01-31', '2026-01-01'], groups: [{ horizonDays: 30, secondHorizonDays: 60, targetAt: '2026-03-02', subjects: 40, firstMean: 7, secondMean: 8, meanDifference: -1, lower: -1.2, upper: -.8 }] } };
  let done = false;
  network.productRequest.mockImplementation(async (url: string, method?: string) => {
    if (method === 'POST') return { id: 'job', state: 'queued' };
    if (url.endsWith('/jobs/job')) { done = true; return { id: 'job', state: 'succeeded' }; }
    return { ...empty, records: [history, first, second, ...(done ? [comparison] : [])] };
  });
  const user = userEvent.setup();
  draw();
  await user.click(await screen.findByText('预测之间的比较', { exact: true }));
  expect(screen.getByLabelText('比较目的')).toHaveValue('update');
  await user.click(screen.getByRole('button', { name: '比较所选预测' }));
  expect(await screen.findByText('比较已完成。')).toBeInTheDocument();
  expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/jobs', 'POST', { kind: 'compare_forecasts', scenario: { predictionId: 'first', otherPredictionId: 'second', mode: 'update' } });
  expect(await screen.findByRole('table', { name: '同一日期、相同受试者的预测差异' })).toHaveTextContent('-1');
});
