import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { GeoQuestionWorkbench } from './GeoQuestionWorkbench';
import { geoProject } from './__fixtures__/geoTabs';
import type { GeoQuestions } from '@/lib/geoClient';
import type { GeoDiagnosisProgress } from '@/lib/geoQuestionWorkbenchClient';
const originals=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),getGeoQuestions:originals}));
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
beforeEach(() => { originals.mockReset(); sessionStorage.clear(); localStorage.clear(); identity.fetchWebMe.mockReset(); identity.fetchWebMe.mockResolvedValue({ user: { id: 'u1' }, tenant: { id: 't1' } }); Object.values(client).forEach(fn => fn.mockReset()); client.getGeoDiagnosisProgress.mockResolvedValue(progress()); client.startGeoDiagnosis.mockResolvedValue({ roundId: 'r1', setVersion: 3 }); client.recoverGeoDiagnosis.mockResolvedValue({ roundId: 'r2', setVersion: 3 }); });
it('opens import on an empty set, preserves quoted CSV duplicates and saves only after preview', async () => {
  show();
  // The step's actions are its block's, not the page's primary (the header's, DESIGN.md T3; the fixture walk of b559d4b7e).
  expect(screen.getByRole('button', { name: '导入问句' })).not.toHaveClass('bg-accent');
  expect(screen.getByRole('button', { name: '启动第 3 版诊断' })).not.toHaveClass('bg-accent');
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

it('keeps a downgraded viewer pending import private while retaining the account recovery record and readable progress', async () => {
  const input = { rows: [{ text: 'Held editor-only question text' }], contract, requestKey: 'held-editor-key' };
  const held = JSON.stringify({ input, preview: { ...input, actualRows: 1, measuredRows: 1, plannedCalls: 1, duplicateCandidates: [] } });
  const storageKey = 'geo-question-import:t1:u1:prj_geo_1:g1'; localStorage.setItem(storageKey, held);
  show('/questions?diagnosisRound=r1', true); await screen.findByText(/总任务 102/);
  expect(screen.queryByDisplayValue('Held editor-only question text')).toBeNull();
  expect(screen.queryByRole('button', { name: '保存为新版本' })).toBeNull();
  expect(screen.queryByRole('button', { name: '导入问句' })).toBeNull();
  expect(screen.getByRole('link', { name: '查看回答' })).toBeVisible();
  expect(client.importGeoQuestions).not.toHaveBeenCalled(); expect(localStorage.getItem(storageKey)).toBe(held);
});
it('does not restore an editor request when permissions are revoked during the identity read', async () => {
  const input = { rows: [{ text: 'Delayed private editor question' }], contract, requestKey: 'held-key' };
  localStorage.setItem('geo-question-import:t1:u1:prj_geo_1:g1', JSON.stringify({ input, preview: { ...input, actualRows: 1, measuredRows: 1, plannedCalls: 1, duplicateCandidates: [] } }));
  let resolveIdentity!: (value: { user: { id: string }; tenant: { id: string } }) => void;
  identity.fetchWebMe.mockImplementationOnce(() => new Promise(resolve => { resolveIdentity = resolve; }));
  const props = { geoId: 'g1', data, onSaved: vi.fn() };
  const mounted = render(<MemoryRouter><GeoQuestionWorkbench {...props} project={geoProject()} /></MemoryRouter>);
  mounted.rerender(<MemoryRouter><GeoQuestionWorkbench {...props} project={geoProject({}, { access: { roles: ['viewer'], abilities: ['read'], owner: false } })} /></MemoryRouter>);
  await act(async () => { resolveIdentity({ user: { id: 'u1' }, tenant: { id: 't1' } }); });
  await waitFor(() => expect(identity.fetchWebMe).toHaveBeenCalledTimes(2));
  expect(screen.queryByDisplayValue('Delayed private editor question')).toBeNull();
  expect(screen.queryByRole('button', { name: '保存为新版本' })).toBeNull();
  expect(client.importGeoQuestions).not.toHaveBeenCalled();
});
it('never sends start or recovery mutations while durable storage repeatedly fails', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  show();
  const start = await screen.findByRole('button', { name: '启动第 3 版诊断' });
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start); await screen.findByRole('alert');
  await userEvent.click(start); expect(client.startGeoDiagnosis).not.toHaveBeenCalled();
  storage.mockRestore();
});
it('continues account initialization after quarantining a corrupt pending record', async () => {
  localStorage.setItem('geo-question-import:t1:u1:prj_geo_1:g1', '{broken');
  show();
  await waitFor(() => expect(screen.getByRole('button', { name: '启动第 3 版诊断' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: '保存为新版本' })).toBeNull();
});
it('does not send selected recovery after repeated storage quota errors', async () => {
  show('/questions?diagnosisRound=r1'); await screen.findByText(/总任务 102/);
  await userEvent.click(screen.getByRole('checkbox', { name: /恢复 0/ })); await userEvent.click(screen.getByRole('checkbox', { name: /我确认/ }));
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  try {
    await userEvent.click(screen.getByRole('button', { name: '仅恢复所选 1 项' })); await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: '仅恢复所选 1 项' })); await screen.findByRole('alert');
    expect(client.recoverGeoDiagnosis).not.toHaveBeenCalled();
  } finally { storage.mockRestore(); }
});
it('keeps every editing entry disabled while a preview is pending', async () => {
  const original: GeoQuestions = { ...data, groups: [{ id: 'g', name: 'G', pool: null, typicalQuestion: '', journeyStage: null, audience: null, weight: null, isControl: false, signal: null, questions: [{ id: 'q', text: 'One original', kind: 'client', platform: null, sourceUrl: null, isMeasured: true }] }] };
  render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={original} onSaved={vi.fn()} /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: '编辑为新版本' }));
  let complete!: (value: unknown) => void;
  client.previewGeoQuestions.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await userEvent.click(screen.getByRole('button', { name: '核对导入预览' }));
  for (const name of ['编辑为新版本', '导入问句']) expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.getByLabelText('第 1 题文本')).toBeDisabled();
  await act(async () => { complete({ rows: [], contract, actualRows: 1, measuredRows: 1, plannedCalls: 1, duplicateCandidates: [] }); });
  expect(await screen.findByRole('button', { name: '保存为新版本' })).toBeEnabled();
  expect(screen.getByLabelText('第 1 题文本')).toHaveValue('One original');
});

it('does not navigate after a pending save resolves on an unmounted workbench', async () => {
  const scope = 'geo-question-import:t1:u1:prj_geo_1:g1';
  const input = { rows: [{ text: 'Retained original', kind: 'client', isMeasured: true }], contract, requestKey: 'retained-after-leaving' };
  localStorage.setItem(scope, JSON.stringify({ input }));
  let complete!: (value: { version: number }) => void;
  client.importGeoQuestions.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const onSaved = vi.fn();
  const shown = render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={data} onSaved={onSaved} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: '保存为新版本' }));
  await waitFor(() => expect(client.importGeoQuestions).toHaveBeenCalledTimes(1));
  shown.unmount();
  await act(async () => { complete({ version: 4 }); });
  expect(onSaved).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(scope)!).input).toEqual(input);
});

it('draws a long imported set fifty rows at a time and edits a row in place, keeping every row for the preview', async () => {
  const question = (index: number) => ({ id: `q${index}`, originalId: `${index}`, originalRowIndex: index, text: `Original ${index}`, kind: 'client' as const, platform: null, sourceUrl: null, isMeasured: true });
  const original: GeoQuestions = { ...data, groups: [{ id: 'g', name: 'G', pool: null, typicalQuestion: '', journeyStage: null, audience: null, weight: null, isControl: false, signal: null, questions: Array.from({ length: 60 }, (_, index) => question(index)) }] };
  render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={original} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByText('编辑为新版本'));
  // A table of a dozen controls a row is read straight from the DOM and driven by plain events: label and role queries and simulated
  // typing over it cost minutes in jsdom.
  const texts = () => [...document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label$=" 题文本"]')];
  await waitFor(() => expect(texts()).toHaveLength(50));
  expect(texts()[49].value).toBe('Original 49');
  fireEvent.click(screen.getByText('显示更多 · 还有 10 题'));
  await waitFor(() => expect(texts()).toHaveLength(60));
  const second = texts()[1];
  fireEvent.change(texts()[0], { target: { value: 'Original 0 x' } });
  // The other rows are the same elements: an edit is one row's.
  expect(texts()[1]).toBe(second);
  expect(texts()[0].value).toBe('Original 0 x');
  client.previewGeoQuestions.mockImplementation(async (_id, input) => ({ ...input, actualRows: 60, measuredRows: 60, plannedCalls: 60, duplicateCandidates: [] }));
  fireEvent.click(screen.getByText('核对导入预览'));
  await waitFor(() => expect(client.previewGeoQuestions).toHaveBeenCalled());
  const rows = client.previewGeoQuestions.mock.calls[0][1].rows;
  expect(rows).toHaveLength(60);
  expect(rows[0].text).toBe('Original 0 x');
  expect(rows[59].text).toBe('Original 59');
}, 60_000);

it('says why a job failed in a sentence, never by its code', async () => {
  client.getGeoDiagnosisProgress.mockResolvedValue(progress());
  show('/questions?diagnosisRound=r1'); await screen.findByText(/总任务 102/);
  expect(screen.queryByText(/delivery_unknown_no_automatic_retry/)).toBeNull();
  expect(screen.getByText(/请求可能已经送达，但没有收到回答/)).toBeInTheDocument();
});

async function importUnsavedRows() {
  await userEvent.click(screen.getByRole('button',{name:'导入问句'}));
  const csv=new File(['ID,Question\n001,Original imported row'],'draft.csv',{type:'text/csv'});
  Object.defineProperty(csv,'arrayBuffer',{value:async()=>new TextEncoder().encode('ID,Question\n001,Original imported row').buffer});
  await userEvent.upload(screen.getByLabelText(/选择 Excel/),csv);
  await userEvent.selectOptions(await screen.findByLabelText('原题文本'),'1');
  await userEvent.selectOptions(screen.getByLabelText('原编号'),'0');
  await userEvent.click(screen.getByRole('button',{name:'读取映射行'}));
  await screen.findByLabelText('第 1 题文本');
}

it('retains imported rows and mapping on continue, then clears them on confirmed discard and reload',async()=>{
  const mounted=show();await importUnsavedRows();
  await userEvent.clear(screen.getByLabelText('第 1 题文本'));
  await userEvent.type(screen.getByLabelText('第 1 题文本'),'Edited unsaved original');
  await userEvent.click(screen.getByRole('button',{name:'返回问题列表'}));
  await userEvent.click(screen.getByRole('button',{name:'取消'}));
  expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Edited unsaved original');
  expect(screen.getByLabelText('原编号')).toHaveValue('0');
  expect(screen.getByRole('button',{name:'返回问题列表'})).toHaveFocus();
  await userEvent.click(screen.getByRole('button',{name:'返回问题列表'}));
  await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));
  await userEvent.click(screen.getByRole('button',{name:'导入问句'}));
  expect(screen.queryByLabelText('第 1 题文本')).toBeNull();
  expect(screen.queryByLabelText('原编号')).toBeNull();
  expect(screen.queryByRole('button',{name:'保存为新版本'})).toBeNull();
  mounted.unmount();show();await userEvent.click(screen.getByRole('button',{name:'导入问句'}));
  expect(screen.queryByLabelText('第 1 题文本')).toBeNull();expect(data.version).toBe(3);
});

it('discards current editing changes while keeping the saved original version authoritative on reopen',async()=>{
  const original:GeoQuestions={...data,groups:[{id:'g',name:'G',pool:null,typicalQuestion:'',journeyStage:null,audience:null,weight:null,isControl:false,signal:null,questions:[{id:'q1',originalId:'001',text:'Saved original',kind:'client',platform:null,sourceUrl:null,isMeasured:true}]}]};
  render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={original} onSaved={vi.fn()}/></MemoryRouter>);
  await userEvent.click(screen.getByRole('button',{name:'编辑为新版本'}));
  fireEvent.change(screen.getByLabelText('第 1 题文本'),{target:{value:'Unsaved edit'}});
  await userEvent.click(screen.getByRole('button',{name:'返回问题列表'}));
  await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));
  await userEvent.click(screen.getByRole('button',{name:'编辑为新版本'}));
  expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Saved original');
  expect(original.version).toBe(3);expect(original.groups[0].questions[0].originalId).toBe('001');
});

it('retains the exact submitted-but-unknown operation when its displayed draft is discarded',async()=>{
  const input={rows:[{text:'Awaiting server reconciliation',originalId:'001'}],contract,requestKey:'do-not-resubmit-as-new'};
  const storageKey='geo-question-import:t1:u1:prj_geo_1:g1';localStorage.setItem(storageKey,JSON.stringify({input}));
  const mounted=show();await screen.findByDisplayValue('Awaiting server reconciliation');
  await userEvent.click(screen.getByRole('button',{name:'返回问题列表'}));
  await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));
  expect(JSON.parse(localStorage.getItem(storageKey)!).input).toEqual(input);
  mounted.unmount();show();
  await userEvent.click(await screen.findByRole('button',{name:'继续核查上次保存'}));
  expect(await screen.findByDisplayValue('Awaiting server reconciliation')).toBeVisible();
  expect(JSON.parse(localStorage.getItem(storageKey)!).input.requestKey).toBe(input.requestKey);
  expect(client.importGeoQuestions).not.toHaveBeenCalled();
});

it('recovers an unknown-result save in the same mount using the exact original payload and key',async()=>{
  show();await importUnsavedRows();
  client.previewGeoQuestions.mockImplementation(async (_id,input)=>({...input,actualRows:1,measuredRows:1,plannedCalls:1,duplicateCandidates:[]}));
  client.importGeoQuestions.mockRejectedValueOnce(new Error('Response unknown')).mockResolvedValueOnce({version:4});
  await userEvent.click(screen.getByRole('button',{name:'核对导入预览'}));
  await userEvent.click(await screen.findByRole('button',{name:'保存为新版本'}));await screen.findByRole('alert');
  const original=client.importGeoQuestions.mock.calls[0][1];
  await userEvent.click(screen.getByRole('button',{name:'返回问题列表'}));
  await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));
  await userEvent.click(screen.getByRole('button',{name:'继续核查上次保存'}));
  expect(screen.getByLabelText('第 1 题文本')).toHaveValue(original.rows[0].text);
  expect(screen.getByRole('button',{name:'保存为新版本'})).toBeVisible();
  expect(client.previewGeoQuestions).toHaveBeenCalledTimes(1);expect(client.importGeoQuestions).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem('geo-question-import:t1:u1:prj_geo_1:g1')!).input).toEqual(original);
  await userEvent.click(screen.getByRole('button',{name:'保存为新版本'}));
  await waitFor(()=>expect(client.importGeoQuestions).toHaveBeenCalledTimes(2));expect(client.importGeoQuestions.mock.calls[1][1]).toEqual(original);
});


const savedOriginals = ():GeoQuestions => ({...data,groups:[{id:'g',name:'Saved group',pool:null,typicalQuestion:'',journeyStage:null,audience:null,weight:null,isControl:false,signal:null,questions:[{id:'saved-q',originalId:'original-001',text:'Authoritative saved question',kind:'client',platform:null,sourceUrl:null,isMeasured:true}]}]});
it('cannot replace an imported draft from the same editor mode and keeps raw mapping intact on cancel',async()=>{
 render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={savedOriginals()} onSaved={vi.fn()}/></MemoryRouter>);
 await importUnsavedRows();
 expect(screen.queryByRole('button',{name:'编辑为新版本'})).toBeNull();expect(screen.queryByRole('button',{name:'导入问句'})).toBeNull();
 expect(screen.getByLabelText('原编号')).toHaveValue('0');
 await userEvent.click(screen.getByRole('button',{name:'返回问题列表'}));await userEvent.click(screen.getByRole('button',{name:'取消'}));
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Original imported row');expect(screen.getByLabelText('原编号')).toHaveValue('0');
 expect(originals).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'返回问题列表'}));await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));
 await userEvent.click(screen.getByRole('button',{name:'编辑为新版本'}));
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Authoritative saved question');
});

it('ignores an old full-version replacement after its editor unmounts and another import is in progress',async()=>{
 let finish!:(value:GeoQuestions)=>void;originals.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const selected={...savedOriginals(),selection:{reference:'gsel_selected'}} as GeoQuestions;
 const mounted=render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={selected} onSaved={vi.fn()}/></MemoryRouter>);
 await userEvent.click(screen.getByRole('button',{name:'编辑为新版本'}));
 await waitFor(()=>expect(originals).toHaveBeenCalledWith('g1',3));
 expect(screen.queryByRole('button',{name:'编辑为新版本'})).toBeNull();expect(screen.getByRole('button',{name:'返回问题列表'})).toBeDisabled();
 mounted.unmount();show();await importUnsavedRows();
 await act(async()=>{finish(savedOriginals());});
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Original imported row');expect(screen.getByLabelText('原编号')).toHaveValue('0');
});

it.each(['import','edit'] as const)('does not replace a current %s draft when slow account recovery discovers an older pending operation',async mode=>{
 let finishIdentity!:(value:unknown)=>void;identity.fetchWebMe.mockImplementationOnce(()=>new Promise(resolve=>{finishIdentity=resolve;}));
 const oldInput={rows:[{text:'Older submitted original',originalId:'old-001'}],contract,requestKey:'original-unknown-operation'};
 const scope='geo-question-import:t1:u1:prj_geo_1:g1';localStorage.setItem(scope,JSON.stringify({input:oldInput}));
 client.previewGeoQuestions.mockImplementation(async (_id,input)=>({...input,actualRows:1,measuredRows:1,plannedCalls:1,duplicateCandidates:[]}));
 if(mode==='import'){show();await importUnsavedRows();}
 else {render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={savedOriginals()} onSaved={vi.fn()}/></MemoryRouter>);await userEvent.click(screen.getByRole('button',{name:'编辑为新版本'}));}
 fireEvent.change(screen.getByLabelText('第 1 题文本'),{target:{value:'Current fresh draft'}});
 await userEvent.click(screen.getByRole('button',{name:'核对导入预览'}));
 await act(async()=>{finishIdentity({user:{id:'u1'},tenant:{id:'t1'}});});
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Current fresh draft');expect(screen.getByLabelText('第 1 题文本')).toBeEnabled();
 if(mode==='import')expect(screen.getByLabelText('原编号')).toHaveValue('0');
 expect(screen.getByRole('button',{name:'保存为新版本'})).toBeDisabled();expect(JSON.parse(localStorage.getItem(scope)!).input).toEqual(oldInput);
 await userEvent.click(screen.getByRole('button',{name:'继续核查上次保存'}));await userEvent.click(screen.getByRole('button',{name:'取消'}));
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Current fresh draft');
 if(mode==='import')expect(screen.getByLabelText('原编号')).toHaveValue('0');
 await userEvent.click(screen.getByRole('button',{name:'继续核查上次保存'}));await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue('Older submitted original');
 expect(client.importGeoQuestions).not.toHaveBeenCalled();expect(JSON.parse(localStorage.getItem(scope)!).input).toEqual(oldInput);
 client.importGeoQuestions.mockResolvedValueOnce({version:4});await userEvent.click(screen.getByRole('button',{name:'保存为新版本'}));
 await waitFor(()=>expect(client.importGeoQuestions).toHaveBeenCalledWith('g1',oldInput));
});


// A version being written is not the version that gets measured: starting is offered where its terms are, not in the middle of an edit.
it('offers no 启动诊断 while a set is being imported or edited — it would start the old saved version', async () => {
  const user = userEvent.setup();
  show();
  await waitFor(() => expect(screen.getByRole('button', { name: '启动第 3 版诊断' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '导入问句' }));
  expect(screen.queryByRole('button', { name: /启动第 \d+ 版诊断/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: '返回问题列表' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '启动第 3 版诊断' })).toBeEnabled());
  expect(client.startGeoDiagnosis).not.toHaveBeenCalled();
});

it('offers no 启动诊断 on a deep link into the mode either', () => {
  show('/questions?questionMode=edit');
  expect(screen.queryByRole('button', { name: /启动第 \d+ 版诊断/ })).toBeNull();
  expect(client.startGeoDiagnosis).not.toHaveBeenCalled();
});

it('moves focus to the mode heading when 导入问句 or 编辑为新版本 opens it, and back to the control used when the list returns', async () => {
  const user = userEvent.setup();
  const original: GeoQuestions = { ...data, groups: [{ id: 'g', name: 'G', pool: null, typicalQuestion: '', journeyStage: null, audience: null, weight: null, isControl: false, signal: null, questions: [{ id: 'q', text: 'One original', kind: 'client', platform: null, sourceUrl: null, isMeasured: true, originalId: '1', originalGroup: null, clientTags: [], collectedAt: null, classificationStatus: 'unclassified', originalRowIndex: 0 }] }] } as unknown as GeoQuestions;
  render(<MemoryRouter><GeoQuestionWorkbench geoId="g1" project={geoProject()} data={original} onSaved={vi.fn()} /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '导入问句' }));
  expect(await screen.findByRole('heading', { name: '导入与编辑问句' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: '返回问题列表' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '导入问句' })).toHaveFocus());
  await user.click(screen.getByRole('button', { name: '编辑为新版本' }));
  expect(await screen.findByRole('heading', { name: '导入与编辑问句' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: '返回问题列表' }));
  // The loaded rows are an edit in progress: leaving them is asked about once, and the answer returns to the list.
  await user.click(await screen.findByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '编辑为新版本' })).toHaveFocus());
});

it('does not take focus when the page opens already in the mode', async () => {
  show('/questions?questionMode=import');
  await screen.findByRole('heading', { name: '导入与编辑问句' });
  expect(screen.getByRole('heading', { name: '导入与编辑问句' })).not.toHaveFocus();
});

it('shows a view-only member the list, not the mode, for a copied ?questionMode= address', () => {
  show('/questions?questionMode=import', true);
  expect(screen.getByRole('heading', { name: '问句整理与诊断' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '导入与编辑问句' })).toBeNull();
  expect(screen.queryByLabelText(/选择 Excel/)).toBeNull();
});
