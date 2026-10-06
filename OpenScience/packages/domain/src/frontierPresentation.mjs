/** Closed public destinations for frontier notices, shared by inbox and channels.
 * @param {{id?:unknown,type?:unknown}|null|undefined} source */
export function frontierNoticeTarget(source) {
    if (!source || typeof source.id !== 'string')
        return null;
    const dated = source.type === 'digest' && /^frontier-(daily|weekly):(\d{4}-\d{2}-\d{2})$/.exec(source.id);
    if (dated) {
        const parsed = new Date(`${dated[2]}T00:00:00Z`);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dated[2])
            return null;
        if (dated[1] === 'weekly' && parsed.getUTCDay() !== 1)
            return null;
        return { kind: dated[1], key: dated[2], switch: dated[1] === 'weekly' ? 'frontierWeekly' : 'frontier' };
    }
    const safety = source.type === 'system' && /^frontier-safety:([A-Za-z0-9_-]{1,160})$/.exec(source.id);
    if (safety)
        return { kind: 'safety', key: safety[1], switch: 'frontierSafety' };
    // A card published or revised in a zone the reader follows (flywheel F10, 2026-10-05): `<zoneId>:<cardId>`, under
    // the daily's own switch — the plan reuses the frontier notification switch rather than adding one.
    const zone = source.type === 'system' && /^frontier-zone:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,80})$/.exec(source.id);
    return zone ? { kind: 'zone', key: `${zone[1]}:${zone[2]}`, switch: 'frontier' } : null;
}
/** @param {{id?:unknown,type?:unknown}|null|undefined} source */
export function frontierNoticeHref(source) {
    const target = frontierNoticeTarget(source);
    if (!target)
        return null;
    if (target.kind === 'zone') {
        const [zoneId, cardId] = target.key.split(':');
        return `/app/frontier/zones/${encodeURIComponent(zoneId)}/evidence/${encodeURIComponent(cardId)}`;
    }
    return target.kind === 'safety' ? `/app/frontier?item=${encodeURIComponent(target.key)}`
        : `/app/frontier?view=${target.kind}&${target.kind === 'weekly' ? 'week' : 'day'}=${target.key}`;
}
