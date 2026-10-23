import { createWebRuntimeSession } from '@/lib/apiClient';

/** Resolve the actual ordinary native session before staging project-bound input. */
export async function ensureGeoConversationSession(projectId: string, sessionId?: string | null): Promise<string> {
  if (sessionId) return sessionId;
  const created = await createWebRuntimeSession(projectId);
  if (!created.id || !/^[A-Za-z0-9_-]{1,160}$/.test(created.id)) throw new Error('The native conversation could not be created.');
  return created.id;
}
