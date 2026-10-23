import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { GeoQuestionWorkbench } from './GeoQuestionWorkbench';
import { geoProject } from './__fixtures__/geoTabs';
import type { GeoQuestions } from '@/lib/geoClient';
import type { GeoDiagnosisProgress } from '@/lib/geoQuestionWorkbenchClient';
const identity = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock('@/lib/apiClient', async original => ({ ...(await original<typeof import('@/lib/apiClient')>()), fetchWebMe: identity.fetchWebMe }));
const client = vi.hoisted(() => ({ getGeoDiagnosisProgress: vi.fn(), previewGeoQuestions: vi.fn(), importGeoQuestions: vi.fn(), startGeoDiagnosis: vi.fn(), recoverGeoDiagnosis: vi.fn() }));
vi.mock('@/lib/geoQuestionWorkbenchClient', () => client);
vi.mock('./useOpenGeoConversation', () => ({ useOpenGeoConversation: () => vi.fn() }));
const contract = { samplingMode: 'one_shot' as const, repeats: 1, engines: ['kimi'], metricIds: ['M-01S'], reportPresentation: 'summary' as const, sourceBasis: 'answers' as const };
const data: GeoQuestions = { sets: [], version: 3, groups: [], contract };
const progress = (patch: Partial<GeoDiagnosisProgress> = {}): GeoDiagnosisProgress => ({ roundId: 'r1', status: 'done', version: 3, planned: 102, contract: null, recoveryOf: null, absentEngines: [], counts: { total: 102, queued: 0, leased: 0, done: 100, failed: 2, skipped: 0, deliveryUnknown: 1, recoverable: 2 }, page: { limit: 100, offset: 0, shown: 100, total: 102, more: true, nextOffset: 100 }, cells: [
  { jobId: 'ok', questionId: 'q1', text: 'Successful original', originalId: '001', originalGroup: null, engine: 'kimi', status: 'done', answerStatus: 'valid', attempts: 1, errorCode: null, snapshotId: 's1', recoverable: false, deliveryUnknown: false },
  { jobId: 'unknown', questionId: 'q2', text: 'Unknown original', originalId: '0', originalGroup: null, engine: 'kimi', status: 'failed', answerStatus: null, attempts: 1, errorCode: 'delivery_unknown_no_automatic_retry', snapshotId: null, recoverable: true, deliveryUnknown: true },
], ...patch });
function Address() { const location = useLocation(); return <output>{location.search}</output>; }
function show(path = '/questions', viewer = false) { return render(<MemoryRouter initialEntries={[path]}><GeoQuestionWorkbench geoId="g1" project={geoProject({}, viewer ? { access: { roles: ['viewer'], abilities: ['read'], owner: false } } : {})} data={data} onSaved={vi.fn()} /><Address /></MemoryRouter>); }
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); identity.fetchWebMe.mockResolvedValue({ user: { id: 'u1' }, tenant: { id: 't1' } }); Object.values(client).forEach(fn => fn.mockReset()); client.getGeoDiagnosisProgress.mockResolvedValue(progress()); client.startGeoDiagnosis.mockResolvedValue({ roundId: 'r1', setVersion: 3 }); client.recoverGeoDiagnosis.mockResolvedValue({ roundId: 'r2', setVersion: 3 }); });
it('opens import on an empty set, preserves quoted CSV duplicates and saves only after preview', async () => {
  show();
  await userEvent.click(screen.getByRole('button', { name: '导入问句' }));
  const csv = new File(['ID,Question\n001,"  A, B\nC  "\n0,"  A, B\nC  "'], 'actual130.csv', { type: 'text/csv' });
  // jsdom File has no text/arrayBuffer; the fixture supplies original bytes.
  Object.defineProperty(csv, 'arrayBuffer', { configurable: true, value: async () => new TextEncoder().encode('ID,Question\n001,"  A, B\nC  "\n0,"  A, B\nC  "').buffer });
  await userEvent.upload(screen.getByLabelText(/选择 Excel/), csv);
  await screen.findByRole('combobox', { name: '工作表' });
  await userEvent.selectOptions(screen.getByLabelText('原题文本'), '1');
  await userEvent.selectOptions(screen.getByLabelText('原编号'), '0');
  await userEvent.click(screen.getByRole('button', { name: '读取映射行' }));
  expect(await screen.findByText(/实际 2 题/)).toBeVisible();
  client.previewGeoQuestions.mockImplementation(async (_id, input) => ({ ...input, actualRows: 2, measuredRows: 2, plannedCalls: 10, duplicateCandidates: [{ rowIndexes: [0, 1] }] }));
  await userEvent.click(screen.getByRole('button', { name: '核对导入预览' }));
  expect(await screen.findByText(/疑似重复 1 组/)).toBeVisible();
  expect(client.startGeoDiagnosis).not.toHaveBeenCalled();
  client.importGeoQuestions.mockResolvedValue({ version: 4 });
  await userEvent.click(screen.getByRole('button', { name: '保存为新版本' }));
  await waitFor(() => expect(client.importGeoQuestions).toHaveBeenCalled());
  const input = client.importGeoQuestions.mock.calls[0][1];
  expect(input.rows.map((row: { originalId: string }) => row.originalId)).toEqual(['001', '0']);
  expect(input.rows[0].text).toBe('  A, B\nC  ');
  expect(input.requestKey).toBeTruthy();
  expect(await screen.findByRole('button', { name: '启动第 4 版诊断' })).toBeVisible();
});
it('reuses a diagnosis request key across network retry and remount, without silently resampling', async () => {
  client.startGeoDiagnosis.mockRejectedValueOnce(new Error('network'));
  const rendered = show();
  await userEvent.click(screen.getByRole('button', { name: '启动第 3 版诊断' }));
  await screen.findByRole('alert');
  const first = client.startGeoDiagnosis.mock.calls[0][2]; rendered.unmount(); show();
  await userEvent.click(screen.getByRole('button', { name: '启动第 3 版诊断' }));
  await screen.findByText(/总任务 102/);
  expect(client.startGeoDiagnosis.mock.calls[1]).toEqual(['g1', 3, first]);
  expect(screen.getByRole('status')).toHaveTextContent('diagnosisRound=r1');
});
it('uses global counts, pages progress and only restores explicitly selected unknown failures with acknowledgement', async () => {
  show('/questions?diagnosisRound=r1');
  await screen.findByText(/总任务 102/);
  expect(screen.queryByRole('checkbox', { name: /Successful original/ })).toBeNull();
  expect(screen.getByRole('link', { name: '查看回答' })).toHaveAttribute('href', expect.stringContaining('s1'));
  await userEvent.click(screen.getByRole('checkbox', { name: /恢复 0/ }));
  await userEvent.click(screen.getByRole('button', { name: '仅恢复所选 1 项' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('可能已有计费'); expect(client.recoverGeoDiagnosis).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('checkbox', { name: /我确认/ }));
  await userEvent.click(screen.getByRole('button', { name: '仅恢复所选 1 项' }));
  await waitFor(() => expect(client.recoverGeoDiagnosis).toHaveBeenCalledWith('g1', 'r1', expect.objectContaining({ jobIds: ['unknown'], acknowledgeUnknown: true })));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('diagnosisRound=r2'));
});
it('keeps diagnosis on refresh and hides writes for viewers', async () => {
  sessionStorage.setItem('geo-question-import:t1:u1:prj_geo_1:g1:diagnosis', 'r1'); show('/questions', true);
  await screen.findByText(/总任务 102/);
  expect(client.startGeoDiagnosis).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '导入问句' })).toBeNull();
  expect(screen.queryByRole('button', { name: /启动第/ })).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(client.getGeoDiagnosisProgress).toHaveBeenCalledWith('g1', 'r1', 100));
});
it('saves edits as a new version, keeps original order across groups and reuses an ambiguous save payload', async () => {
  const row = (id: string, originalRowIndex: number) => ({ id, originalId: id, originalRowIndex, text: `Original ${id}`, kind: 'client' as const, platform: null, sourceUrl: null, isMeasured: true });
  const group = (id: string, questions: ReturnType<typeof row>[]) => ({ id, pool: null, name: id, typicalQuestion: '', journeyStage: null, audience: null, weight: null, isControl: false, signal: null, questions });
  const original: GeoQuestions = { ...data, groups: [group('B', [row('0', 1)]), group('A', [row('001', 0)])] };
  const onSaved = vi.fn();
  const mounted = render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={original} onSaved={onSaved} /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: '编辑为新版本' }));
  expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Original 001');
  client.previewGeoQuestions.mockImplementation(async (_id, input) => ({ ...input, actualRows: 2, measuredRows: 2, plannedCalls: 10, duplicateCandidates: [] }));
  await userEvent.click(screen.getByRole('button', { name: '核对导入预览' }));
  const save = await screen.findByRole('button', { name: '保存为新版本' });
  client.importGeoQuestions.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ version: 4 });
  await userEvent.click(save); await screen.findByRole('alert');
  expect(localStorage.getItem('geo-question-import:t1:u1:prj_geo_1:g1')).toContain('requestKey');
  mounted.unmount();
  render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={original} onSaved={onSaved} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: '保存为新版本' })); await waitFor(() => expect(onSaved).toHaveBeenCalledWith(4));
  expect(client.importGeoQuestions.mock.calls[1][1]).toEqual(client.importGeoQuestions.mock.calls[0][1]);
  expect(localStorage.getItem('geo-question-import:t1:u1:prj_geo_1:g1')).toBeNull();
  expect(original.version).toBe(3); expect(original.groups[0].questions[0].originalId).toBe('0');
  expect(client.startGeoDiagnosis).not.toHaveBeenCalled();
});
it('retries an ambiguous selected recovery after remount using the identical request and new round', async () => {
  client.recoverGeoDiagnosis.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ roundId: 'r2' });
  const initial = show('/questions?diagnosisRound=r1'); await screen.findByText(/总任务 102/);
  await userEvent.click(screen.getByRole('checkbox', { name: /恢复 0/ }));
  await userEvent.click(screen.getByRole('checkbox', { name: /我确认/ }));
  await userEvent.click(screen.getByRole('button', { name: '仅恢复所选 1 项' }));
  await screen.findByRole('alert'); const request = client.recoverGeoDiagnosis.mock.calls[0][2];
  initial.unmount();
  client.getGeoDiagnosisProgress.mockResolvedValue(progress({ cells: progress().cells.map(cell => ({ ...cell, recoverable: false })) }));
  show('/questions?diagnosisRound=r1'); await screen.findByText(/总任务 102/);
  await userEvent.click(screen.getByRole('button', { name: '仅恢复所选 1 项' }));
  await waitFor(() => expect(client.recoverGeoDiagnosis.mock.calls[1][2]).toEqual(request));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('diagnosisRound=r2'));
});

it('does not ask about unknown charges for known failed jobs', async () => {
  client.getGeoDiagnosisProgress.mockResolvedValue(progress({ cells: progress().cells.map(cell => ({ ...cell, deliveryUnknown: false })) }));
  show('/questions?diagnosisRound=r1'); await screen.findByText(/总任务 102/);
  await userEvent.click(screen.getByRole('checkbox', { name: /恢复 0/ }));
  expect(screen.queryByRole('checkbox', { name: /我确认/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '仅恢复所选 1 项' }));
  await waitFor(() => expect(client.recoverGeoDiagnosis).toHaveBeenCalled());
  expect(client.recoverGeoDiagnosis.mock.calls[0][2]).not.toHaveProperty('acknowledgeUnknown');
});
it('keeps native question sets out of the lossful imported-row editor', async () => {
  render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={{ ...data, contract: null }} onSaved={vi.fn()} /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: '调整口径' })).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑为新版本' })).toBeNull();
  expect(screen.queryByRole('button', { name: /启动第/ })).toBeNull();
  expect(screen.getByRole('button', { name: '导入问句' })).toBeVisible();
});
it('does not reveal another account pending question import', async () => {
  const input = { rows: [{ text: 'Private prior account text' }], contract, requestKey: 'held-key' };
  localStorage.setItem('geo-question-import:t1:u1:prj_geo_1:g1', JSON.stringify({ input, preview: { ...input, actualRows: 1, measuredRows: 1, plannedCalls: 1, duplicateCandidates: [] } }));
  identity.fetchWebMe.mockResolvedValue({ user: { id: 'u2' }, tenant: { id: 't1' } });
  show(); await waitFor(() => expect(identity.fetchWebMe).toHaveBeenCalled());
  expect(screen.queryByDisplayValue('Private prior account text')).toBeNull();
  expect(screen.queryByRole('button', { name: '保存为新版本' })).toBeNull();
});
