import { HttpError } from './security.mjs';

const LAYERS = ['profile', 'listings', 'projectCard', 'standingPreferences', 'index', 'safetyNotes', 'capsules', 'mostUsed'];
const SWITCHES = { standingPreferences: 'memoryStandingInstructionsEnabled', index: 'memoryOpeningIndexEnabled', safetyNotes: 'memorySafetyNotesEnabled', mostUsed: 'memoryOpeningByUseEnabled' };

/** Compose existing producer results. No history search, session delivery acknowledgement or use event occurs here. */
export async function contextForAgent({ config, native, admission, resident, opening, sourceDeletion }, { user, project }) {
  if (!native?.memoryContexts || !admission || !resident || !opening) throw new HttpError(503, 'memory_engine_unavailable', 'Opening memory is unavailable.');
  const context = await native.memoryContexts.forProject(project);
  if (context.kind !== 'owned') throw new HttpError(403, 'memory_scope_denied', 'Shared namespaces are not available here.');
  await native.memoryContexts.assertLive(context);
  const decision = await admission.admit({ user, project, allowRunningFallback: false });
  const omitted = reason => ({ projectId: project.id, platformText: '', layers: LAYERS.map(name => ({ name, present: false, reason })) });
  if (!decision.recall) return omitted(decision.recallReason ?? 'memory_off');
  const version = sourceDeletion ? await sourceDeletion.version(user.id) : null;
  const platform = await resident.forDispatch(user.id, { projectId: project.id, sessionId: null, attended: true, peek: true });
  const parts = await opening({ userId: user.id, projectId: project.id });
  await native.memoryContexts.assertLive(context);
  if (sourceDeletion && await sourceDeletion.version(user.id) !== version) throw new HttpError(503, 'memory_gateway_source_changed', 'The source privacy state changed during this request.');
  const latest = await admission.admit({ user, project, allowRunningFallback: false });
  if (!latest.recall) return omitted(latest.recallReason ?? 'memory_off');
  const profile = parts.find(part => part.name === 'profile');
  const listings = Object.fromEntries(parts.filter(part => part.name !== 'profile').map(part => [part.name, part.value ?? []]));
  const texts = { ...platform.layers, profile: profile?.value ?? '', listings: Object.values(listings).some(rows => Array.isArray(rows) && rows.length) ? JSON.stringify(listings) : '' };
  const layers = LAYERS.map(name => {
    const text = texts[name] ?? '';
    if (text) return { name, present: true, text, ...(name === 'profile' && profile?.elided ? { omissionReason: 'elided' } : {}) };
    const flag = SWITCHES[name];
    return { name, present: false, reason: name === 'profile' && profile?.elided ? 'budget' : flag && config[flag] !== true ? 'switch_off'
      : platform.reason === 'paused' ? 'paused' : platform.omitted > 0 && ['capsules', 'mostUsed'].includes(name) ? 'budget' : 'empty_or_filtered' };
  });
  return { projectId: project.id, platformText: platform.text, layers, omittedEntries: platform.omitted };
}
