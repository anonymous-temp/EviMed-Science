import { Plus } from "lucide-react";
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, it, vi } from 'vitest';
import { HeaderActions } from './HeaderActions';
it('keeps primary and two common actions visible, with labeled overflow and real destinations', () => {
  const run = vi.fn();
  render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'start', label: '开始', onSelect: run, loading: true }, secondary: [{ id: 'one', label: '查看', to: '/view' }, { id: 'two', label: '保存', onSelect: run }, { id: 'three', label: '历史', to: '/history' }] }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '开始' }));
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: '查看' })).toHaveAttribute('href', '/view');
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  expect(screen.getByRole('menuitem', { name: '历史' })).toHaveAttribute('href', '/history');
});

it('moves common secondaries into the same overflow below 1024px, keeping primary and scoped preference outside', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  try {
    render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'p', label: '开始研究', onSelect: vi.fn() }, secondary: [{ id: 's', label: '查看结果', to: '/result' }], overflow: [{ id: 'o', label: '归档', onSelect: vi.fn() }], preference: { label: '记忆偏好', control: <button type="button">即时偏好</button> } }} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: '开始研究' })).toBeVisible();
    expect(screen.getByRole('button', { name: '即时偏好' })).toBeVisible();
    expect(screen.queryByRole('link', { name: '查看结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: '查看结果' })).toHaveAttribute('href', '/result');
    expect(screen.getByRole('menuitem', { name: '归档' })).toBeVisible();
  } finally { vi.unstubAllGlobals(); }
});
it('preserves busy and destructive link presentation in direct and overflow paths', () => {
  render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'p', label: '正在打开', to: '/busy', loading: true, destructive: true }, overflow: [{ id: 'o', label: '正在归档', to: '/archive', loading: true, destructive: true }] }} /></MemoryRouter>);
  const direct = screen.getByRole('link', { name: '正在打开' });
  expect(direct).toHaveAttribute('aria-busy', 'true');
  expect(direct).toHaveClass('text-error-fg', 'bg-error');
  expect(direct.querySelector('.animate-spin')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  const overflow = screen.getByRole('menuitem', { name: '正在归档' });
  expect(overflow).toHaveAttribute('aria-busy', 'true');
  expect(overflow).toHaveAttribute('aria-disabled', 'true');
  expect(overflow).toHaveClass('text-danger');
  expect(overflow.querySelector('.animate-spin')).not.toBeNull();
});


it('collapses secondaries when a wide viewport contains a 500px action group', () => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
  try {
    render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'p', label: '开始', onSelect() {} }, secondary: [{ id: 's', label: '查看', to: '/view' }] }} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: '查看' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: '查看' })).toHaveAttribute('href', '/view');
  } finally { width.mockRestore(); }
});
it('cancels auxiliary activation only for inert links', () => {
  render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'p', label: '忙碌链接', to: '/busy', loading: true }, secondary: [{ id: 's', label: '普通链接', to: '/ok' }], overflow: [{ id: 'o', label: '忙碌菜单链接', to: '/menu', loading: true }] }} /></MemoryRouter>);
  expect(fireEvent(screen.getByRole('link', { name: '忙碌链接' }), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(false);
  expect(fireEvent(screen.getByRole('link', { name: '普通链接' }), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  expect(fireEvent(screen.getByRole('menuitem', { name: '忙碌菜单链接' }), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(false);
});

it('allows an explicit parent density without an action-child measurement feedback loop', () => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  try {
    render(<MemoryRouter><HeaderActions density="full" plan={{ secondary: [{ id: 's', label: '查看', to: '/view' }] }} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '查看' })).toBeVisible();
  } finally { width.mockRestore(); }
});

it('removes every destination while busy without replacing the focused anchor', () => {
  const { rerender } = render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'p', label: '查看', to: '/result' } }} /></MemoryRouter>);
  const link = screen.getByRole('link', { name: '查看' });
  link.focus();
  rerender(<MemoryRouter><HeaderActions plan={{ primary: { id: 'p', label: '查看', to: '/result', loading: true }, overflow: [{ label: '菜单查看', to: '/other', loading: true, onSelect() {} }] }} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: '查看' })).toBe(link);
  expect(link).toHaveFocus();
  expect(link).not.toHaveAttribute('href');
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  expect(screen.getByRole('menuitem', { name: '菜单查看' })).not.toHaveAttribute('href');
});
it('retains primary menu and original grouped controlled overflow entries', () => {
  const choose = vi.fn();
  render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'add', label: '添加', items: [{ label: '上传文件', onSelect: choose }, { label: '网盘', onSelect: choose }] }, overflow: [{ heading: '设置' }, { label: '自动记忆', checked: true, toggle: true, onSelect: choose }, 'separator', { label: '删除', destructive: true, disabled: true, onSelect: choose }] }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '添加' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
  expect(choose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  expect(screen.getByText('设置')).toBeVisible();
  expect(screen.getByRole('menuitemcheckbox', { name: '自动记忆' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('separator')).toBeVisible();
  expect(screen.getByRole('menuitem', { name: '删除' })).toBeDisabled();
});


it('passes declared router state through a real link destination', () => {
  function Location() { const location = useLocation(); return <output>{location.pathname}:{JSON.stringify(location.state)}</output>; }
  render(<MemoryRouter><HeaderActions plan={{ primary: { id: 'p', label: '证据', to: '/evidence', state: { returnTo: '/frontier/topic' } } }} /><Location /></MemoryRouter>);
  fireEvent.click(screen.getByRole('link', { name: '证据' }));
  expect(screen.getByRole('status')).toHaveTextContent('/evidence:{"returnTo":"/frontier/topic"}');
});


it('renders direct action icons decoratively and visibly marks a primary menu', () => {
  const { rerender } = render(<HeaderActions plan={{ primary: { id: 'p', label: '新建', icon: Plus, onSelect() {} }, secondary: [{ id: 's', label: '添加资料', icon: Plus, onSelect() {} }] }} density="full" />);
  expect(screen.getByRole('button', { name: '新建' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByRole('button', { name: '添加资料' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  rerender(<HeaderActions plan={{ primary: { id: 'p', label: '添加', items: [{ label: '上传', onSelect() {} }] } }} />);
  expect(screen.getByRole('button', { name: '添加' })).toHaveAttribute('aria-haspopup', 'menu');
  expect(screen.getByRole('button', { name: '添加' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
});
