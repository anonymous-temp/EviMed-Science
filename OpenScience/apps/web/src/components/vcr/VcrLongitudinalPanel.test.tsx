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
