import { createHash } from 'node:crypto';
import { canonicalJson, claimFromRow } from './geoStore.mjs';
import { geoReadPage } from './geoReadScope.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const unavailable = () => new HttpError(404, 'geo_plan_context_not_found', 'The selected signal input is unavailable.');

/** Read only the immutable versions selected by this bound native input. Long text is paged, never silently cut. */
export class GeoSignalInputs {
  constructor({ contexts, service, store, articles = null }) { this.contexts = contexts; this.service = service; this.store = store; this.articles = articles; }
  async read(project, input) {
    if (Object.keys(input).some(key => !['planContextRef', 'targetKey', 'limit', 'offset'].includes(key)) || !/^gpc_[a-f0-9]{64}$/.test(input.planContextRef ?? '')) throw unavailable();
    const row = await this.contexts.documents.get(project.userId, 'geo-plan-context', input.planContextRef), context = row?.payload;
    if (row?.projectId !== project.projectId || context?.geoId !== project.id || context.mode !== 'signal' || context.state !== 'bound'
      || context.basisDigest !== hash(context.basis)) throw unavailable();
    await this.service.requireProject({ id: context.actorId }, project.id);
    const { limit, offset } = geoReadPage(input), targets = context.basis.event.targets ?? [];
    if (input.targetKey == null) return { signal: context.basis.signal, basisDigest: context.basisDigest, event: { ...context.basis.event, targets: undefined },
      items: targets.slice(offset, offset + limit), total: targets.length, more: offset + limit < targets.length, nextOffset: offset + limit < targets.length ? offset + limit : null };
    const target = targets.find(candidate => candidate.key === input.targetKey && context.basis.focusRefs.includes(candidate.key));
    if (!target) throw unavailable();
    let text = null, format = 'json', material = null;
    if (target.type === 'finding' && Number.isSafeInteger(context.basis.event.profileVersionAtDetection)) {
      const profile = await this.store.latestValue(project.id, context.basis.event.profileVersionAtDetection);
      const finding = (profile.data?.findings ?? []).find(candidate => candidate.id === target.id);
      if (finding && hash(finding) === target.digest) material = finding;
    } else if (target.type === 'claim') {
      const saved = (await this.store.query('SELECT * FROM evimed_geo.claims WHERE geo_project_id=$1 AND user_id=$2 AND id=$3 AND version=$4', [project.id, project.userId, target.id, target.version])).rows[0];
      const claim = saved ? claimFromRow(saved) : null;
      if (claim && hash(claim) === target.digest) material = claim;
    } else if (target.type === 'article' && this.articles && typeof target.version === 'string') {
      const preserved = await this.articles.readVersion({ userId: project.userId, id: project.projectId }, target.version);
      if (preserved.version.digest === target.digest) { text = preserved.text; format = 'text'; }
    }
    if (material) text = JSON.stringify(material);
    if (typeof text !== 'string') return { target, availability: 'unknown', reason: 'preserved_material_unavailable', items: [], total: null, more: false, nextOffset: null };
    // Offset and limit count 4,000-character parts, so one long article can be
    // read completely within the tool's normal bounded response size.
    const total = Math.ceil(text.length / 4000), items = [];
    for (let index = offset; index < Math.min(offset + limit, total); index++) items.push({ part: index, text: text.slice(index * 4000, (index + 1) * 4000) });
    return { target, availability: 'preserved', format, textDigest: hash(text), items, total, more: offset + limit < total, nextOffset: offset + limit < total ? offset + limit : null };
  }
}
