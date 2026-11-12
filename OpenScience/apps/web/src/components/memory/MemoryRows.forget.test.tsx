import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PendingMemoryRows } from './MemoryRows';
const api = { resolveForgetRequest: vi.fn() };
const item = { id: 'request', text: 'Forget that.', at: '2026-11-11T00:00:00Z', state: 'confirmation' as const,
  choices: [{ index: 0, text: 'Old project title.' }, { index: 1, text: 'Independent preference.' }] };
beforeEach(() => { api.resolveForgetRequest.mockReset(); });
it('requires an explicit choice, submits it once, and refreshes after confirmation', async () => {
  const reload = vi.fn(); let done!: (value: unknown) => void;
  api.resolveForgetRequest.mockImplementation(() => new Promise(resolve => { done = resolve; }));
  render(<PendingMemoryRows onResolve={api.resolveForgetRequest} items={[item]} slow={false} onResolved={reload} />);
  const confirm = screen.getByRole('button', { name: '忘记选中的内容' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Old project title.' }));
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(api.resolveForgetRequest).toHaveBeenCalledTimes(1);
  expect(api.resolveForgetRequest).toHaveBeenCalledWith('request', 'confirm', [0]);
  await act(async () => done({ resolved: true }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.getByText('已处理')).toBeInTheDocument();
});
it('retains the selection on error and allows retry or dismissal', async () => {
  api.resolveForgetRequest.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ resolved: true });
  render(<PendingMemoryRows onResolve={api.resolveForgetRequest} items={[item]} slow={false} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Old project title.' }));
  fireEvent.click(screen.getByRole('button', { name: '忘记选中的内容' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('checkbox', { name: 'Old project title.' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '保留记忆，关闭此项' }));
  await waitFor(() => expect(api.resolveForgetRequest).toHaveBeenCalledWith('request', 'dismiss', [0]));
});
it('an unresolved reference is not mislabeled as a slow write', () => {
  render(<PendingMemoryRows onResolve={api.resolveForgetRequest} items={[{ ...item, choices: [] }]} slow stalled />);
  expect(screen.queryByText('还没写完，可以稍后再看')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '忘记选中的内容' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保留记忆，关闭此项' })).toBeEnabled();
});
