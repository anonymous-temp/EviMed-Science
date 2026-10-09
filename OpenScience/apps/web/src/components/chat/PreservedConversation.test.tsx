import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PreservedConversation } from './PreservedConversation';

vi.mock('@/lib/apiClient', () => ({ getWebConversationHistory: vi.fn(async () => ({ sessionId: 's', partial: true, capturedAt: null,
  messages: [{ seq: 1, role: 'user', text: 'Original question' }, { seq: 2, role: 'assistant', text: 'Saved answer' }] })) }));
vi.mock('@/components/markdown-viewer/MarkdownViewer', () => ({ MarkdownViewer: ({ children }: { children: string }) => <p>{children}</p> }));

it('keeps saved prose readable during a runtime refusal with no composer or send action', async () => {
  render(<PreservedConversation projectId="p" sessionId="s" />);
  expect(await screen.findByText('Saved answer')).toBeInTheDocument();
  expect(screen.getByText(/部分内容尚未保存/)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
