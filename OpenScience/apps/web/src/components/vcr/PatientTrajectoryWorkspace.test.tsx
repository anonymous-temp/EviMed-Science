import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { PatientTrajectoryWorkspace, personUncertainty, trajectoryDenominator } from './PatientTrajectoryWorkspace';
import { renderTab } from './__fixtures__/tabFrame';
import { WebApiError } from '@/lib/apiClient';
import type { LongitudinalRecord, TrajectorySubjectPage, VcrLongitudinalData } from '@/lib/vcrLongitudinalClient';

/** The batch surface (plan T08): the denominator says where everyone went, the table is the server's page, and a draw is not a person. */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock('@/lib/productClient', () => network);

const counts = { submitted: 100, admitted: 90, completed: 60, rejected: 30, failed: 10, unprocessed: 0, partial: 0 };
const prediction = (extra: Partial<LongitudinalRecord['summary']> = {}, id = 'pred-1'): LongitudinalRecord => ({ id, kind: 'prediction', createdAt: '2026-01-02', hash: 'h',
  summary: { origin: '2026-01-01T00:00:00.000Z', historyId: 'history-1', endpoint: { code: 'HbA1c', unit: '%', type: 'continuous' }, horizonsDays: [30], accepted: 60, invalidRows: 0,
    model: { name: 'm', version: '1' }, accounting: counts, versionNumber: 1, actionContext: { mode: 'factual_forecast', actionSource: 'none', deployable: true, label: 'factual_forecast' },
    uncertainty: { available: true, rowsWithUncertainty: 60, rows: 60, kinds: { monte_carlo: 60 }, drawsTotal: 180, note: 'named' },
    trajectories: [{ day: 30, subjects: 60, mean: 7.1, lower: 6.4, upper: 7.9 }],
    premises: [{ key: 'trajectory:uncertainty', label: '预测的不确定性', value: '这个模型没有给出不确定性，所以不显示预测区间，也不用抽样结果代替。', source: 'default', decisive: true, reason: null }], ...extra } });
const history: LongitudinalRecord = { id: 'history-1', kind: 'history', createdAt: '2026-01-01', hash: 'h', summary: { origin: '2026-01-01', subjects: 100, events: 100 } };
const data = (records: LongitudinalRecord[]): VcrLongitudinalData => ({ available: true, records, providers: [],
  templates: { events: { columns: ['subject_id'], example: ['x'] }, prediction: { schema: 1 } } });
const line = (n: number, status: TrajectorySubjectLine['status'] = 'completed', reason: string | null = null): TrajectorySubjectLine => ({ subjectKey: `subject-${String(n).padStart(4, '0')}-abcdef`, status, reason,
  horizonsRequested: 1, horizonsAccepted: status === 'completed' ? 1 : 0, ...(status === 'completed' ? { uncertainty: { available: true, rowsWithUncertainty: 1, rows: 1, kinds: { monte_carlo: 1 }, drawsTotal: 3, note: 'named' } } : {}) });
type TrajectorySubjectLine = import('@/lib/vcrLongitudinalClient').TrajectorySubjectLine;
const page = (lines: TrajectorySubjectLine[], extra: Partial<TrajectorySubjectPage> = {}): TrajectorySubjectPage => ({ id: 'pred-1', total: 100, matching: lines.length, offset: 0, limit: 50, more: false, lines,
  trajectories: Object.fromEntries(lines.filter(l => l.status === 'completed').map(l => [l.subjectKey, [{ horizonDays: 30, point: 7, sd: null, quantiles: [{ p: .05, value: 6.5 }, { p: .95, value: 7.5 }], draws: 3 }]])),
  actionContext: { label: 'factual_forecast', deployable: true }, ...extra });
beforeEach(() => { network.productRequest.mockReset(); });
/** A Note whose whole sentence reads this, its numbers being links inside it. */
const sentence = (re: RegExp) => screen.findByText((_, el) => el?.getAttribute('data-note') === '' && re.test(el.textContent ?? ''));
const draw = (records: LongitudinalRecord[]) => renderTab(<PatientTrajectoryWorkspace studyId="one" canRun canManage={false} data={data(records)} onReload={() => undefined} />, { studyId: 'one', version: 'v1' });

it('says where all 100 people went, in one sentence whose parts add up to the first number', async () => {
  network.productRequest.mockResolvedValue(page([line(1), line(2, 'rejected', 'unit_not_convertible')]));
  draw([history, prediction()]);
  expect(trajectoryDenominator(counts)).toBe('共提交 100 人：60 人已完成，30 人未纳入，10 人失败，0 人未处理。');
  expect(await sentence(/^共提交 100 人：60 人已完成，30 人未纳入，10 人失败，0 人未处理。$/)).toBeInTheDocument();
  // a draw is not a person, and the page says so beside the counts
  expect(await sentence(/抽样次数：共 180 次，都是同一个人未来的不同可能，不算更多的人/)).toBeInTheDocument();
  expect(await screen.findByText('观测的单位无法换算成终点的单位')).toBeInTheDocument();
});

it('shows the one premises block, and no table of people that is not the server\'s page', async () => {
  network.productRequest.mockResolvedValue(page([line(1)]));
  draw([history, prediction()]);
  expect(await screen.findByText('这个结论的前提')).toBeInTheDocument();
  expect(screen.getAllByText('这个结论的前提')).toHaveLength(1);
  expect(screen.getByText(/没有给出不确定性，所以不显示预测区间/)).toBeInTheDocument();
});

it('filters by status through the server and pages 50 at a time', async () => {
  network.productRequest.mockImplementation(async (url: string) => url.includes('status=failed')
    ? page([line(7, 'failed', 'provider_http_503')], { matching: 10 })
    : page(Array.from({ length: 50 }, (_, i) => line(i)), { matching: 100, more: true }));
  const user = userEvent.setup();
  draw([history, prediction()]);
  await screen.findAllByText('已完成');
  await user.click(screen.getByRole('button', { name: /失败/ }));
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal/pred-1/subjects?status=failed&offset=0&limit=50'));
  expect(await screen.findByText('预测服务暂时不可用')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /全部/ }));
  await screen.findByText(/第 1–50 人，共 100 人/);
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal/pred-1/subjects?offset=50&limit=50'));
});

it('opens one person\'s timeline, with the interval the model gave and no interval it did not', async () => {
  network.productRequest.mockResolvedValue(page([line(1)]));
  const user = userEvent.setup();
  draw([history, prediction()]);
  await user.click(await screen.findByRole('button', { name: /查看患者 1的轨迹/ }));
  const section = await screen.findByRole('region', { name: /的时间线/ }).catch(() => screen.getByText(/的时间线/).closest('section')!);
  expect(within(section as HTMLElement).getByText(/模型给出了预测区间/)).toBeInTheDocument();
});

it('keeps the counts and the cohort summary when the people list cannot be read', async () => {
  network.productRequest.mockRejectedValue(new WebApiError('not found', { status: 404, code: 'not_found' }));
  draw([history, prediction()]);
  expect(await sentence(/^共提交 100 人/)).toBeInTheDocument();
  expect(await sentence(/逐人的列表暂时无法读取/)).toBeInTheDocument();
  expect(screen.getByText('整批人群的汇总')).toBeInTheDocument();
});

it('tells logged-action replay apart in the heading, and says an unreconciled ledger plainly', async () => {
  network.productRequest.mockResolvedValue(page([line(1)]));
  draw([history, prediction({ actionContext: { mode: 'conditional_forecast', actionSource: 'logged_replay', deployable: false, label: 'logged_action_replay' }, accounting: { ...counts, failed: 9 } })]);
  expect(await screen.findByText('按实际用药回放的检验')).toBeInTheDocument();
  expect(await sentence(/各部分人数与提交人数对不上/)).toBeInTheDocument();
});

it('names a person\'s uncertainty or says the model gave none', () => {
  expect(personUncertainty(line(1))).toBe('蒙特卡罗抽样');
  expect(personUncertainty({ ...line(1), uncertainty: { available: false, rowsWithUncertainty: 0, rows: 1, kinds: {}, drawsTotal: 0, note: 'unavailable' } })).toBe('模型没有给出');
  expect(personUncertainty(line(2, 'failed', 'x'))).toBe('—');
});

it('an older import with no ledger is said to have none, not drawn as zero people', async () => {
  network.productRequest.mockResolvedValue(page([]));
  draw([history, prediction({ accounting: undefined })]);
  expect(await sentence(/没有逐人的去向记录；可用的预测值 60 个（不是人数）/)).toBeInTheDocument();
});

it('a number in the denominator opens the people it counts', async () => {
  network.productRequest.mockImplementation(async (url: string) => url.includes('status=rejected') ? page([line(2, 'rejected', 'unit_not_convertible')], { matching: 30 }) : page([line(1)]));
  const user = userEvent.setup();
  draw([history, prediction()]);
  await sentence(/^共提交 100 人/);
  await user.click(screen.getByRole('button', { name: '30' }));
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/longitudinal/pred-1/subjects?status=rejected&offset=0&limit=50'));
  expect(await screen.findByText(/第 1–1 人，共 30 人/)).toBeInTheDocument();
});

it('names people by their order, never by a key, and offers a version by its number and origin only', async () => {
  network.productRequest.mockResolvedValue(page([line(1), line(2)]));
  draw([history, prediction(), prediction({ versionNumber: 2 }, 'pred-2')]);
  expect(await screen.findByRole('button', { name: '查看患者 2的轨迹' })).toBeInTheDocument();
  expect(screen.queryByText(/subject-/)).toBeNull();
  const options = screen.getAllByRole('option').map(option => option.textContent ?? '').filter(text => text.startsWith('第'));
  expect(options.length).toBeGreaterThanOrEqual(2);
  for (const text of options) expect(text).toMatch(/^第 \d 版 · 起点 /);
  expect(options.join('')).not.toMatch(/HbA1c|版本未提供/);
});

it('never shows the previous version\'s people under another version, and says so when that read is denied (review F07)', async () => {
  network.productRequest.mockImplementation(async (url: string) => {
    if (url.includes('/longitudinal/pred-1/subjects')) throw new WebApiError('forbidden', { status: 403, code: 'forbidden' });
    return page([line(1)], { id: 'pred-2' });
  });
  const user = userEvent.setup();
  // pred-2 is the newer one, so it is the version the page opens on
  draw([history, prediction({ versionNumber: 1 }, 'pred-1'), { ...prediction({ versionNumber: 2 }, 'pred-2'), createdAt: '2026-01-03' }]);
  expect(await screen.findByRole('button', { name: '查看患者 1的轨迹' })).toBeInTheDocument();
  await user.selectOptions(screen.getAllByLabelText('预测版本')[0]!, 'pred-1');
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(expect.stringContaining('/longitudinal/pred-1/subjects')));
  await waitFor(() => expect(screen.queryByRole('button', { name: '查看患者 1的轨迹' })).toBeNull());
  expect(await screen.findByRole('button', { name: /重试/ })).toBeInTheDocument();
});
