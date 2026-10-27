import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PageHeader } from './PageHeader';
const plan = { primary: { id: 'p', label: '继续', onSelect() {} }, secondary: [{ id: 'r', label: '周报', onSelect() {} }, { id: 't', label: '对话', onSelect() {} }] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function geometry(initialWidth: number, titleWidth = 80, actionWidth = 240) {
  let width = initialWidth;
  const callbacks = new Set<() => void>();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-header-actions') ? actionWidth : this.tagName === 'H1' ? titleWidth : width; });
  vi.stubGlobal('ResizeObserver', class { callback: () => void; constructor(callback: () => void) { this.callback = callback; callbacks.add(callback); } observe() {} disconnect() { callbacks.delete(this.callback); } });
  return (next: number) => act(() => { width = next; [...callbacks].forEach(callback => callback()); });
}
it.each([992, 1152])('keeps common desktop actions visible at actual %ipx column width', width => {
  geometry(width);
  render(<PageHeader title="当前研究" documentTitle={false} actionPlan={plan} />);
  expect(screen.getByRole('button', { name: '周报' })).toBeVisible();
  expect(screen.getByRole('button', { name: '对话' })).toBeVisible();
});
it('does not force a short title and fitting short actions into compact mode at 390px', () => {
  geometry(390, 64, 240);
  const { container } = render(<PageHeader title="康舒宁" documentTitle={false} actionPlan={plan} />);
  expect(screen.getByRole('button', { name: '周报' })).toBeVisible();
  expect(screen.getByRole('heading').parentElement).toHaveClass('basis-auto');
  expect(screen.getByRole('heading').parentElement).not.toHaveClass('basis-48');
  expect(container.querySelector('[data-header-actions]')).toHaveAttribute('data-action-density', 'full');
});
it.each([[300, 240], [80, 600]])('collapses real insufficient title/action room (%i/%i), restores on expansion and tolerates repeated resize', (title, actions) => {
  const resize = geometry(390, title, actions);
  const { container } = render(<PageHeader title="很长的身份标题与研究名称" documentTitle={false} actionPlan={plan} />);
  expect(container.querySelector('[data-header-actions]')).toHaveAttribute('data-action-density', 'compact');
  expect(screen.getByRole('heading')).not.toHaveClass('line-clamp-2');
  resize(1152);
  expect(screen.getByRole('button', { name: '周报' })).toBeVisible();
  resize(390); resize(1152); resize(390);
  expect(container.querySelector('[data-header-actions]')).toHaveAttribute('data-action-density', 'compact');
});
it('keeps the focused busy action in place until focus leaves during a resize', async () => {
  const resize = geometry(1152, 300, 600);
  const { rerender } = render(<PageHeader title="研究" documentTitle={false} actionPlan={plan} />);
  const report = screen.getByRole('button', { name: '周报' });
  report.focus();
  resize(390);
  rerender(<PageHeader title="研究" documentTitle={false} actionPlan={{ ...plan, secondary: [{ ...plan.secondary[0], loading: true }, plan.secondary[1]] }} />);
  expect(report).toHaveFocus();
  expect(report).toHaveAttribute('aria-busy', 'true');
  fireEvent.blur(report);
  report.blur();
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('button', { name: '周报' })).toBeNull();
});
