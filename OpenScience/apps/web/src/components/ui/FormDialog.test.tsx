import {fireEvent,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {FormDialog} from './FormDialog';

describe('centered form dialog',()=>{
 it('focuses a field, traps focus, dismisses with Escape and restores the opening control',async()=>{
  const close=vi.fn();const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
  const view=render(<FormDialog title="新建任务" onClose={close}><input aria-label="名称"/><button>保存</button></FormDialog>);
  expect(screen.getByLabelText('名称')).toHaveFocus();const panel=screen.getByRole('dialog',{name:'新建任务'});expect(panel).toHaveAttribute('aria-modal','true');expect(panel).not.toHaveClass('h-full');
  const save=screen.getByRole('button',{name:'保存'});save.focus();await userEvent.keyboard('{Tab}');expect(screen.getByRole('button',{name:'关闭'})).toHaveFocus();
  await userEvent.keyboard('{Escape}');expect(close).not.toHaveBeenCalled();expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await userEvent.keyboard('{Escape}');expect(close).toHaveBeenCalledOnce();view.unmount();expect(trigger).toHaveFocus();trigger.remove();
 });
 it('keeps the dialog through a pending write and calls the latest close callback after settling',async()=>{
  const close=vi.fn(),latest=vi.fn();const view=render(<FormDialog title="编辑任务" busy onClose={close}><input aria-label="名称"/></FormDialog>);
  await userEvent.keyboard('{Escape}');fireEvent.click(screen.getByRole('dialog').parentElement!);expect(close).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'关闭'})).toBeDisabled();
  view.rerender(<FormDialog title="编辑任务" onClose={latest}><input aria-label="名称"/></FormDialog>);await userEvent.keyboard('{Escape}');expect(latest).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
 });
 it('takes focus on the panel when it has no field, so the corner 关闭 shows no tooltip and the first Escape closes it',async()=>{
  const close=vi.fn();render(<FormDialog title="成员" onClose={close}><p>只读内容</p></FormDialog>);
  const panel=screen.getByRole('dialog',{name:'成员'});expect(panel).toHaveFocus();expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await userEvent.keyboard('{Escape}');expect(close).toHaveBeenCalledOnce();
 });
});
