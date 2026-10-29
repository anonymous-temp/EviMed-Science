import { beforeEach, expect, it, vi } from 'vitest';
import { ensureGeoConversationSession } from './geoConversationSession';
const open=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/geoNativeClient',()=>({openGeoConversation:open}));
const descriptor=(sessionId='native-root')=>({projectId:'owner-control',sessionId,scope:{kind:'geo',geoProjectId:'geo-exact',sessionId}});
beforeEach(()=>{open.mockReset().mockImplementation(async(_geo,target)=>descriptor(target.sessionId??'native-root'));});
it('opens the exact module primary before staging without an actor-owned session factory',async()=>{
 expect(await ensureGeoConversationSession('geo-exact','owner-control',null)).toBe('native-root');
 expect(open).toHaveBeenCalledWith('geo-exact',{kind:'primary'});
});
it('validates an explicit historical target through the module without a fallback',async()=>{
 expect(await ensureGeoConversationSession('geo-exact','owner-control','historical')).toBe('historical');
 expect(open).toHaveBeenCalledWith('geo-exact',{kind:'session',sessionId:'historical'});
});
it('opens the project\'s own conversation as the primary, so one the kernel lost is repaired, and returns the session that stands',async()=>{
 open.mockResolvedValue(descriptor('replacement'));
 expect(await ensureGeoConversationSession('geo-exact','owner-control','dead-root','dead-root')).toBe('replacement');
 expect(open).toHaveBeenCalledWith('geo-exact',{kind:'primary'});
});
it('keeps an addressed conversation exact beside the primary',async()=>{
 expect(await ensureGeoConversationSession('geo-exact','owner-control','historical','native-root')).toBe('historical');
 expect(open).toHaveBeenCalledWith('geo-exact',{kind:'session',sessionId:'historical'});
});
it.each([{projectId:'actor-control'},{sessionId:'other'},{scope:{kind:'geo',geoProjectId:'other',sessionId:'historical'}}])('rejects an exact descriptor mismatch %j',async mismatch=>{
 open.mockResolvedValue({...descriptor('historical'),...mismatch});
 await expect(ensureGeoConversationSession('geo-exact','owner-control','historical')).rejects.toThrow();
 expect(open).toHaveBeenCalledTimes(1);
});
it('preserves a failed exact target and never asks for a new primary',async()=>{
 open.mockRejectedValue(new Error('Target unavailable'));
 await expect(ensureGeoConversationSession('geo-exact','owner-control','historical')).rejects.toThrow('Target unavailable');
 expect(open).toHaveBeenCalledTimes(1);
});
