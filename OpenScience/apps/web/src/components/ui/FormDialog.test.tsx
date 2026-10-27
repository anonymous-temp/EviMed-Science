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

it('keeps a linked persistent summary and guards dirty Escape and backdrop exits',async()=>{
 const close=vi.fn();render(<FormDialog title="Edit" dirty onClose={close} errors={[{message:'Name required',fieldId:'edit-name'}]} footer={<button>Save</button>}><input id="edit-name" aria-label="Name"/></FormDialog>);
 await userEvent.click(screen.getByRole('link',{name:'Name required'}));expect(screen.getByLabelText('Name')).toHaveFocus();
 await userEvent.keyboard('{Escape}');expect(close).not.toHaveBeenCalled();expect(screen.getByRole('alertdialog')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'取消'}));expect(close).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('dialog').parentElement!);await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));expect(close).toHaveBeenCalledOnce();
});
it('does not pin all busy Tab presses to the panel',async()=>{
 render(<FormDialog title="Edit" busy onClose={()=>{}}><input aria-label="A"/><input aria-label="B"/></FormDialog>);
 expect(screen.getByLabelText('A')).toHaveFocus();await userEvent.tab();expect(screen.getByLabelText('B')).toHaveFocus();
});

it('prioritizes an explicitly marked eligible control over the first form field', () => {
 render(<FormDialog title="Upload" onClose={() => {}}><input aria-label="Destination" /><button data-autofocus>Choose file</button></FormDialog>);
 expect(screen.getByRole('button', { name: 'Choose file' })).toHaveFocus();
});
it('ignores disabled explicit focus targets and retains the ordinary first-field fallback', () => {
 render(<FormDialog title="Fallback" onClose={() => {}}><input aria-label="First field" /><button data-autofocus disabled>Unavailable</button></FormDialog>);
 expect(screen.getByLabelText('First field')).toHaveFocus();
});
