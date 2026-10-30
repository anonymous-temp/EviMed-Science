import { VCR_FOLLOWUP_KIND_LABELS_ZH } from '@evimed/domain';

/** Original trial treatment/outcomes remain opaque. A post-exit observation needs its own timestamp beyond the opaque window. */
const TRIAL_FIELDS = new Set(['treatment', 'outcome', 'randomization_arm', 'progression_date', 'last_dose_date']);
const instant = value => value == null ? NaN : Date.parse(String(value));
const endInstant = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? instant(value) + 86400000 - 1 : instant(value);

/** Human-only projection of preserved scientific observations. Never infers treatment or outcomes from exit text.
 * @param {any} episode */
export function presentFollowupHistory(episode) {
  const restricted = episode.restricted ?? {};
  const windows = episode.trialWindows ?? [];
  const hidden = field => Object.hasOwn(restricted, field) && restricted[field]?.visible !== true;
  const measurements = (Array.isArray(episode.observations) ? episode.observations : []).flatMap(observation => {
    const field = String(observation?.variable ?? '');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(field) || hidden(field)) return [];
    const at = instant(observation.at);
    if (TRIAL_FIELDS.has(field) && (episode.kind === 'study_specific' || !Number.isFinite(at)
      || windows.some(window => (!Number.isFinite(instant(window.start)) || at >= instant(window.start))
        && (!Number.isFinite(endInstant(window.end)) || at <= endInstant(window.end))))) return [];
    if (!['string', 'number', 'boolean'].includes(typeof observation.value) && observation.value !== null) return [];
    return [{ field, label: field, value: observation.value, unit: typeof observation.unit === 'string' ? observation.unit : null,
      at: typeof observation.at === 'string' ? observation.at : null }];
  });
  return { id: episode.id, subjectKey: episode.subjectKey, kind: episode.kind,
    label: VCR_FOLLOWUP_KIND_LABELS_ZH[episode.kind] ?? '历史观察', windowStart: episode.windowStart ?? null,
    windowEnd: episode.windowEnd ?? null, state: 'read_only', exitDate: hidden('exitDate') || hidden('exit_date') ? null : episode.exitDate ?? null,
    exitReason: hidden('exitReason') || hidden('exit_reason') ? null : episode.exitReason ?? null, measurements };
}

/** Export exactly the authorized page, including verbatim exit text. Formula prefixes are escaped in spreadsheet readers.
 * @param {any[]} episodes */
export function followupHistoryCsv(episodes) {
  const cell = value => { const raw = String(value ?? ''); return `"${(/^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""')}"`; };
  const rows = [['subject', 'kind', 'window_start', 'window_end', 'exit_date', 'exit_reason', 'field', 'value', 'unit', 'observed_at']];
  for (const episode of episodes) for (const measurement of episode.measurements.length ? episode.measurements : [{}]) {
    rows.push([episode.subjectKey, episode.label, episode.windowStart, episode.windowEnd, episode.exitDate, episode.exitReason,
      measurement.field, measurement.value, measurement.unit, measurement.at]);
  }
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
