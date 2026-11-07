import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { VirtualLabWorkspace } from './VirtualLabWorkspace';
import { renderTab } from './__fixtures__/tabFrame';
import { WebApiError } from '@/lib/apiClient';
import type { VcrCampaignCandidate, VcrCampaignView, VcrDesignExperimentView, VcrLabEntry, VcrValue } from '@/lib/vcrClient';

/** The lab's result surface (plan T09/T10): a design search's candidates, constraints and budget, and a comparison's arms. */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock('@/lib/productClient', () => network);

const value = (n: number, extra: Partial<VcrValue> = {}): VcrValue => ({ value: n, unit: '%', source: 'simulated', mcse: 0.4, ...extra } as VcrValue);
const verdict = (status: 'pass' | 'fail' | 'inconclusive', final: boolean) => ({ status, statusText: { pass: '满足', fail: '不满足', inconclusive: '无法确定' }[status], final, reason: null, boundKind: 'one_sided', confidence: 0.975,
  judgedAt: value(2.1, { source: 'calculated', mcse: undefined }) });
const candidate = (index: number, extra: Partial<VcrCampaignCandidate> = {}): VcrCampaignCandidate => ({ key: `c${index}`, index, set: { 'design.n_per_arm': 100 + index }, status: 'evaluated', statusText: '已复核', stage: 'final', reason: null, reasonText: null,
  objective: { screening: { ...value(70), stage: 'screening' }, final: { ...value(80), stage: 'final' } },
  constraints: [{ index: 0, measure: 'type_one_error', label: '第一类错误', kind: 'error_control', op: '<=', bound: 0.025, screening: verdict('pass', false), final: verdict('pass', true) }],
  resultIds: [], usage: { cpuSeconds: 3, queueSeconds: 1, wallSeconds: 4, replicates: 1000 }, ...extra });
const campaign = (extra: Partial<VcrCampaignView> = {}): VcrCampaignView => ({ id: 'cmp1', kind: 'campaign', question: '找出满足约束的最小样本量', status: 'stopped', method: 'design.simulate', methodVersion: '1', identity: 'x',
  objective: { measure: 'power', direction: 'max', truth: 'alt', label: '把握度' }, constraints: [], truths: ['alt'], stages: {},
  budget: { declared: { maxCandidates: 30, cpuSeconds: 600, modelCalls: 0 }, used: { cpuSeconds: 42.4, queueSeconds: 12.2, replicates: 9000, candidatesEvaluated: 3, candidatesPlanned: 3 } },
  candidates: [candidate(0), candidate(1, { status: 'finalist', statusText: '入围复核' }), candidate(2, { status: 'eliminated', statusText: '已排除', stage: 'screening', reasonText: '初筛时把握度已明显不满足约束（最有利的界值也不满足）。',
    objective: { screening: { ...value(40), stage: 'screening' }, final: null }, constraints: [{ index: 0, measure: 'type_one_error', label: '第一类错误', kind: 'error_control', op: '<=', bound: 0.025, screening: verdict('inconclusive', false), final: null }] })],
  finalists: ['c1'], best: 'c1', inconclusive: ['c0'], feasible: ['c1'], reference: 'c0', improvement: 4, inFlight: null, cancelRequested: false,
  stop: { reason: 'acceptable_precision', text: '找到了在预先设定的约束下全部满足的方案，并已在新的随机数上按正常次数复核。', at: null },
  premises: [{ key: 'campaign:precision', label: '初筛与复核', value: '初筛每个方案模拟 200 次，只用来排序；入围方案按正常次数重算后才判断是否满足约束。', source: 'given', decisive: true, reason: null }], createdAt: null, updatedAt: null, ...extra });
const experiment = (): VcrDesignExperimentView => ({ id: 'exp1', kind: 'experiment', question: '三个样本量方案比较', purpose: 'design', status: 'complete',
  arms: ['A', 'B', 'C'].map((name) => ({ name, method: 'design.simulate', methodVersion: '1', attached: name === 'A', status: 'complete', refused: null, resultId: `r${name}` })),
  comparison: [{ measure: 'power', label: '把握度', arms: ['A', 'B', 'C'].map((name, i) => ({ name, status: 'complete', value: value(70 + i * 5), precision: 'final' })),
    contrasts: [{ arm: 'B', against: 'A', coupling: 'paired', couplingText: '同一批模拟患者上的配对比较', difference: value(5) }, { arm: 'C', against: 'A', coupling: 'independent', couplingText: '独立随机数上的比较', difference: value(10) }] }],
  alignment: [{ field: 'endpoint', aligned: true, unknown: [] }, { field: 'timeUnit', aligned: false, unknown: [] }], incomplete: [],
  premises: [{ key: 'lab:aligned', label: '比较的前提', value: '各组的时间单位不一致，差值只能对照着看。', source: 'given', decisive: true, reason: null }], createdAt: null });
const entry = (id: string, kind: VcrLabEntry['kind'], status = 'stopped'): VcrLabEntry => ({ id, kind, question: kind === 'campaign' ? '找出满足约束的最小样本量' : '三个样本量方案比较', status, stopReason: null, createdAt: null, updatedAt: null });
const serve = (list: VcrLabEntry[], views: Record<string, unknown>) => network.productRequest.mockImplementation(async (url: string, method?: string) => {
  if (url.endsWith('/experiments')) return { experiments: list };
  if (url.endsWith('/cancel')) { expect(method).toBe('POST'); return { ...(views.cmp1 as object), status: 'stopped', cancelRequested: true }; }
  const id = url.split('/experiments/')[1];
  if (!(id in views)) throw new WebApiError('gone', { status: 404 });
  return views[id];
});
const draw = (canRun = true) => renderTab(<VirtualLabWorkspace studyId="one" canRun={canRun} />, { studyId: 'one', version: 'v1' });
const BACK_OFFICE = /design\.simulate|screening|stage|campaign|resultKind|jobId|manifest|virtual_trial|n_per_arm|MCSE/;

beforeEach(() => { network.productRequest.mockReset(); });

it('says what a first visit can do: examples fill the composer and send nothing', async () => {
  serve([], {});
  const user = userEvent.setup();
  const { spies } = draw();
  expect(await screen.findByText('还没有虚拟实验')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /比较三个样本量方案/ }));
  expect(spies.openChat).toHaveBeenCalledWith(expect.stringContaining('100、150、200'), expect.objectContaining({ studyId: 'one' }));
});

it('a reader without the run ability gets the reason and no example', async () => {
  serve([], {});
  draw(false);
  expect(await screen.findByText('有运行权限的成员可以在对话里开始。')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /比较三个样本量方案/ })).toBeNull();
});

it('shows the loading state, then an error with a retry', async () => {
  network.productRequest.mockRejectedValue(new WebApiError('boom', { status: 500 }));
  draw();
  expect(await screen.findByRole('button', { name: /重试/ })).toBeInTheDocument();
});

it('draws a finished search: candidates with objective, constraint verdicts and bounds in plain words, the stop and the budget with queue time', async () => {
  serve([entry('cmp1', 'campaign')], { cmp1: campaign() });
  draw();
  expect(await screen.findByText('找出满足约束的最小样本量')).toBeInTheDocument();
  const table = screen.getByRole('table', { name: '设计搜索比较的方案' });
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  expect(within(table).getAllByText(/第一类错误不超过 2.5%：/).length).toBeGreaterThan(0);
  expect(within(table).getByText('初筛时把握度已明显不满足约束（最有利的界值也不满足）。')).toBeInTheDocument();
  // one word for the coarse pass everywhere, no second column for the stage, and no footnote that explains it a second time
  expect(document.body.textContent).not.toMatch(/粗筛/);
  expect(within(table).queryByRole('columnheader', { name: '进行到' })).toBeNull();
  expect(within(table).getAllByText('（初筛）').length).toBeGreaterThan(0);
  expect(within(table).queryByText(/保守/)).toBeNull();
  expect(screen.getByText(/找到了在预先设定的约束下全部满足的方案/)).toBeInTheDocument();
  expect(screen.getByText(/42 秒（排队等待另计 12 秒）/)).toBeInTheDocument();
  expect(screen.getByText(/1 个方案无法确定是否满足约束/)).toBeInTheDocument();
  // exactly one premises block, with the precision premise in it
  expect(screen.getAllByText('这个结论的前提')).toHaveLength(1);
  expect(screen.getByText(/初筛每个方案模拟 200 次/)).toBeInTheDocument();
  expect(document.body.textContent?.match(BACK_OFFICE)?.[0]).toBeUndefined();
});

it('a running search is read again and can be stopped; the stop keeps what ran', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serve([entry('cmp1', 'campaign', 'running')], { cmp1: campaign({ status: 'running', stop: null, inFlight: { unit: 'u', stage: 'final' } }) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    draw();
    expect(await screen.findByText(/正在计算复核这一步/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '停止搜索' }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith('/vcr/studies/one/experiments/cmp1/cancel', 'POST', {}));
    const reads = () => network.productRequest.mock.calls.filter(([url]) => String(url).endsWith('/experiments/cmp1')).length;
    const before = reads();
    await vi.advanceTimersByTimeAsync(6000);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  } finally { vi.useRealTimers(); }
});

it('a cancelled search says it was asked to stop and offers no second stop', async () => {
  serve([entry('cmp1', 'campaign', 'running')], { cmp1: campaign({ status: 'running', stop: null, cancelRequested: true }) });
  draw();
  expect(await screen.findByText(/已要求停止，当前这一步算完后结束/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull();
});

it('a search that stopped by user cancellation reads the stop reason and has no stop button', async () => {
  serve([entry('cmp1', 'campaign')], { cmp1: campaign({ stop: { reason: 'user_cancellation', text: '已按要求停止，已完成的方案保留。', at: null }, finalists: [], best: null }) });
  draw();
  expect(await screen.findByText('已按要求停止，已完成的方案保留。')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull();
});

it('a search with no feasible candidate says so, and still shows the budget it used', async () => {
  serve([entry('cmp1', 'campaign')], { cmp1: campaign({ best: null, finalists: [], feasible: [], inconclusive: [], stop: { reason: 'no_feasible_beneficial_candidate', text: '没有找到在预先设定的约束下可行且优于参照的方案。', at: null } }) });
  draw();
  expect(await screen.findByText('没有找到在预先设定的约束下可行且优于参照的方案。')).toBeInTheDocument();
  expect(screen.getByText(/已用计算/)).toBeInTheDocument();
  expect(screen.queryByText('最优')).toBeNull();
});

it('an undecided stop names the closest design and shows the server\'s advice, never a promise that more replicates decide a rate on its bound', async () => {
  const advice = '“I 类错误”的模拟值是 2.5%（模拟误差约 0.11%），要求不超过 2.5%，正好在界上：再多模拟几次也判断不出来。这个设计可以把检验水准定得更低（例如 2.2%，约束仍是 2.5%）来留出余量；这要作为一个新的实验方案重新开始，约束本身不改。';
  serve([entry('cmp1', 'campaign')], { cmp1: campaign({ best: null, finalists: ['c1'], feasible: [], inconclusive: ['c1'], inFlight: null,
    stop: { reason: 'inconclusive_at_precision', text: '没有方案被确认不满足约束，但有方案在现有复核次数下无法确定是否满足。', at: null },
    undecided: { closest: { key: 'c1', index: 1, objective: value(40), constraints: [{ label: '第一类错误', estimate: value(2.5), advice }] }, advice: [advice] } }) });
  const user = userEvent.setup();
  draw();
  expect(await screen.findByText(/没有方案确认满足全部约束；最接近的是 #2/)).toBeInTheDocument();
  await user.click(screen.getByText(/个方案无法确定是否满足约束/));
  expect(await screen.findByText(/检验水准定得更低（例如 2.2%，约束仍是 2.5%）/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/增加复核次数/);
});

it('pages a large candidate table twenty at a time', async () => {
  const many = Array.from({ length: 45 }, (_, i) => candidate(i));
  serve([entry('cmp1', 'campaign')], { cmp1: campaign({ candidates: many, finalists: [], best: null, inconclusive: [] }) });
  const user = userEvent.setup();
  draw();
  await screen.findByText(/第 1–20 个，共 45 个/);
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText(/第 21–40 个，共 45 个/);
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText(/第 41–45 个，共 45 个/);
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('draws a three-arm comparison with the matched definitions, the coupling of each difference and the one premises block', async () => {
  serve([entry('exp1', 'experiment')], { exp1: experiment() });
  draw();
  expect(await screen.findByText('三个样本量方案比较')).toBeInTheDocument();
  expect(screen.getByRole('table', { name: '各组的把握度' })).toBeInTheDocument();
  expect(screen.getByText('同一批模拟患者上的配对比较')).toBeInTheDocument();
  expect(screen.getByText('独立随机数上的比较')).toBeInTheDocument();
  // the alignment is said once, in the premise; no second panel restates it
  expect(screen.queryByText(/比较的口径/)).toBeNull();
  expect(screen.getAllByText('这个结论的前提')).toHaveLength(1);
  expect(screen.getByText('各组的时间单位不一致，差值只能对照着看。')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '精度' })).toBeInTheDocument();
  expect(screen.getAllByText('完整').length).toBeGreaterThan(0);
  expect(document.body.textContent?.match(BACK_OFFICE)?.[0]).toBeUndefined();
});

it('draws three Alzheimer hypotheses with each arm\'s hypothesis, the calculated course and the model\'s claims in the one block', async () => {
  const view = experiment();
  view.experimentKind = 'disease';
  const kinds: Array<[string, string]> = [['none', '没有药物效果（只看检验会不会误判有效）'], ['symptomatic', '改善症状的假设'], ['disease_modifying', '减慢病情恶化的假设']];
  view.arms = ['安慰剂', '对症假设', '改病假设'].map((name, i) => ({ name, method: 'patients.progression', methodVersion: '1.1.0', attached: false, status: 'complete', refused: null, resultId: `r${i}`,
    hypothesis: { kind: kinds[i][0], text: kinds[i][1] }, trajectory: [0, 26, 52, 78].map((visit) => ({ visit, control: 24 + visit / 6, treated: i === 0 ? 24 + visit / 6 : 24 + visit / 7 })) }));
  view.comparison = [{ measure: 'expected_difference', label: '治疗组减对照组的平均差', arms: view.arms.map((arm, i) => ({ name: arm.name, status: 'complete', value: value(-i, { unit: '分', mcse: undefined, source: 'calculated' }), precision: null })), contrasts: [] }];
  view.alignment = [{ field: 'visits', aligned: true, unknown: [] }, { field: 'design', aligned: true, unknown: [] }];
  view.premises = [{ key: 'progression:ad:effect', label: '药物效果', value: '各组的药物效果都是你设定的假设，不是对某个药物疗效的预测。', source: 'assumed', decisive: true, reason: null }];
  serve([entry('exp1', 'experiment')], { exp1: view });
  draw();
  expect(await screen.findByText('三个样本量方案比较')).toBeInTheDocument();
  expect(screen.queryByText(/随访时间点一致/)).toBeNull();
  expect(screen.getByRole('table', { name: /各组的平均病程/ })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '不用药' })).toBeInTheDocument();
  expect(screen.getByText('改善症状的假设')).toBeInTheDocument();
  expect(screen.getAllByText('这个结论的前提')).toHaveLength(1);
  expect(screen.getByText(/不是对某个药物疗效的预测/)).toBeInTheDocument();
  expect(document.body.textContent?.match(BACK_OFFICE)?.[0]).toBeUndefined();
});

it('an arm still running or without a result is listed as incomplete, not as a zero', async () => {
  const view = experiment();
  view.status = 'running'; view.incomplete = ['C'];
  view.arms[2].status = 'running'; view.comparison[0].arms[2] = { name: 'C', status: 'running', value: null, precision: null }; view.comparison[0].contrasts = [];
  serve([entry('exp1', 'experiment')], { exp1: view });
  draw();
  await screen.findByRole('table', { name: '各组的把握度' });
  expect(screen.getAllByText('计算中').length).toBeGreaterThan(0);
});

it('switches between the experiments of a study', async () => {
  serve([entry('cmp1', 'campaign'), entry('exp1', 'experiment')], { cmp1: campaign(), exp1: experiment() });
  const user = userEvent.setup();
  draw();
  await screen.findByRole('table', { name: '设计搜索比较的方案' });
  // the choice of object is a filter of the band, never a select in the body
  expect(screen.queryByLabelText('实验')).toBeNull();
  await user.click(screen.getByRole('button', { name: /实验/ }));
  await user.click(await screen.findByRole('menuitemradio', { name: /设计比较/ }).catch(() => screen.findByRole('menuitem', { name: /设计比较/ })));
  expect(await screen.findByRole('table', { name: '各组的把握度' })).toBeInTheDocument();
});

it('an experiment that cannot be read shows the error, not the previous one', async () => {
  serve([entry('gone', 'campaign')], {});
  draw();
  expect(await screen.findByRole('button', { name: /重试/ })).toBeInTheDocument();
});

it('says what a measure of the search is in Chinese and a verdict on the test\'s own level in its own words, never the worst-case wording', async () => {
  const nominal = candidate(0, { constraints: [{ index: 0, measure: 'type_one_error', label: '第一类错误', kind: 'error_control', op: '<=', bound: 0.025, screening: verdict('pass', false), final: { ...verdict('pass', true), boundKind: 'nominal_level' } }] });
  serve([entry('cmp1', 'campaign')], { cmp1: campaign({ candidates: [nominal], finalists: [], best: null, inconclusive: [], objective: { measure: 'sample_size', direction: 'minimize', truth: 'alt', label: '样本量' } }) });
  draw();
  expect(await screen.findByText('按检验的名义水准，模拟没有否定它', { exact: false })).toBeInTheDocument();
  expect(screen.queryByText(/最不利情况下的值/)).toBeNull();
  expect(document.body.textContent).not.toMatch(/[a-z]{3,}_[a-z_]+|sample_size|\bcost\b/);
});

it('words an arm that could not be calculated, an attached preliminary result is not differenced, and a list setting reads as items', async () => {
  const view = experiment();
  view.arms[1] = { ...view.arms[1], status: 'unsupported', refused: ['这一组的设置无法用所选方法计算。'], resultId: null };
  view.comparison[0].arms[0] = { ...view.comparison[0].arms[0], precision: 'screening' };
  serve([entry('exp1', 'experiment')], { exp1: view });
  const user = userEvent.setup();
  draw();
  await screen.findByRole('table', { name: '各组的把握度' });
  await user.click(screen.getByText('各组的设置'));
  expect(await screen.findByText('这一组的设置无法用所选方法计算。')).toBeInTheDocument();
  expect(screen.getAllByText('初筛（只用于排序）').length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toMatch(/invalid_parameters|units_not_convertible|\[object Object\]/);
});
