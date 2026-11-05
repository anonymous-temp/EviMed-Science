import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceConversationDelete } from './SourceConversationDelete';
const api=vi.hoisted(()=>({deleteConversationSource:vi.fn(),conversationSourceStatus:vi.fn()}));
vi.mock('@/lib/conversationSourceDeletionClient',()=>api);
afterEach(()=>{cleanup();vi.clearAllMocks();});

it('requires the irreversible source choice and keeps pending cleanup distinct from successful removal',async()=>{
  api.deleteConversationSource.mockResolvedValue({sourceRemoved:false,cleanup:'pending'});
  api.conversationSourceStatus.mockResolvedValue({sourceRemoved:true,cleanup:'complete'});
  const changed=vi.fn(),user=userEvent.setup();
  render(<SourceConversationDelete projectId="p" sessionId="a" onChanged={changed}/>);
  await user.click(screen.getByRole('button',{name:'删除来源对话'}));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('无法恢复');
  expect(api.deleteConversationSource).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'永久删除'}));
  await waitFor(()=>expect(api.deleteConversationSource).toHaveBeenCalledWith('p','a'));
  expect(screen.getByRole('status')).toHaveTextContent('等待当前工作结束后清除');
  expect(screen.queryByText('来源对话已删除')).toBeNull();
  await user.click(screen.getByRole('button',{name:'查看删除进度'}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('来源对话已删除'));
});


it('keeps removed original bytes distinct from pending native memory cleanup',async()=>{
  api.deleteConversationSource.mockResolvedValue({sourceRemoved:true,cleanup:'pending',reason:'native_lineage_unverified'});
  const user=userEvent.setup();render(<SourceConversationDelete projectId="p" sessionId="a" onChanged={()=>{}}/>);
  await user.click(screen.getByRole('button',{name:'删除来源对话'}));await user.click(screen.getByRole('button',{name:'永久删除'}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('对话原文已删除，相关记忆尚未清除。'));
  expect(screen.queryByText('来源对话已删除')).toBeNull();
});
