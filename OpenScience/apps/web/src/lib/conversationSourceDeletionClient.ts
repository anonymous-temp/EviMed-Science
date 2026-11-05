import { productRequest } from './productClient';

export interface ConversationSourceDeletionStatus {
  id: string;
  sessionId: string;
  sourceRemoved: boolean;
  cleanup: 'pending' | 'complete';
  reason: string | null;
}
const sourcePath = (projectId: string, sessionId: string) => `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(sessionId)}/source`;
export const deleteConversationSource = (projectId: string, sessionId: string) => productRequest<ConversationSourceDeletionStatus>(sourcePath(projectId, sessionId), 'DELETE');
export const conversationSourceStatus = (projectId: string, sessionId: string) => productRequest<ConversationSourceDeletionStatus>(sourcePath(projectId, sessionId));
