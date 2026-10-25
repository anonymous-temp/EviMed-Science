import { openGeoConversation } from '@/lib/geoNativeClient';

/** Resolve the exact owner-controlled module conversation before staging input. */
export async function ensureGeoConversationSession(geoId: string, projectId: string, sessionId?: string | null): Promise<string> {
  const descriptor = await openGeoConversation(geoId, sessionId ? { kind: 'session', sessionId } : { kind: 'primary' });
  if (descriptor.projectId !== projectId || descriptor.scope.kind !== 'geo' || descriptor.scope.geoProjectId !== geoId
    || descriptor.scope.sessionId !== descriptor.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.sessionId)
    || sessionId && descriptor.sessionId !== sessionId) throw new Error('The selected GEO conversation changed.');
  return descriptor.sessionId;
}
