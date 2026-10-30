import { openGeoConversation } from '@/lib/geoNativeClient';

/**
 * Resolve the owner-controlled module conversation before staging input. An addressed conversation is opened exactly; the project's
 * own (none named, or the one `primarySessionId` names) is opened as the primary, which the server repairs for its owner when the
 * kernel no longer lists it, so the session returned may differ from the one the page held.
 */
export async function ensureGeoConversationSession(geoId: string, projectId: string, sessionId?: string | null, primarySessionId?: string | null): Promise<string> {
  const exact = sessionId && sessionId !== primarySessionId ? sessionId : null;
  const descriptor = await openGeoConversation(geoId, exact ? { kind: 'session', sessionId: exact } : { kind: 'primary' });
  if (descriptor.projectId !== projectId || descriptor.scope.kind !== 'geo' || descriptor.scope.geoProjectId !== geoId
    || descriptor.scope.sessionId !== descriptor.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.sessionId)
    || exact && descriptor.sessionId !== exact) throw new Error('The selected GEO conversation changed.');
  return descriptor.sessionId;
}
