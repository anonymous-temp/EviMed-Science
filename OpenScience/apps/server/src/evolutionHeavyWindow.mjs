import { parseWindow, withinWindow } from './learningWorker.mjs';

/**
 * The hours the heavy, model-intensive evolution work waits for.
 *
 * Confirmation runs, the fresh-paper sets they are confirmed on, the audits and the weekly self-research that writes mechanism cards are the
 * module's bulk model spend, and nothing a researcher waits on: they run between 22:00 and 07:00 China time by default, which is 14:00 to 23:00
 * UTC. DeepSeek bills a half price outside its peak (weekdays 01:00-04:00 and 06:00-10:00 UTC; every other hour, and weekends, are off-peak), so the
 * window sits wholly inside the cheap hours and halves the cost of this work; it also leaves the daytime to researchers. Collection (the
 * plugin's, the signals', the events') and the light jobs (the plan, the decisions, the digest, maintenance, self-checks that wake a researcher's
 * agenda) run at any time. Written in China time, like every other schedule of this module (the digest hour, the Monday plan, the budget day).
 *
 * `OPEN_SCIENCE_EVOLUTION_HEAVY_WINDOW` is `HH:MM-HH:MM` (wrapping midnight), or `always`. Like the learning window, a value that cannot be read is no
 * window rather than a refusal: a typo costs the half price, not the feature. Absent from a hand-made config it is no window too.
 *
 * @module evolutionHeavyWindow
 */
export const EVOLUTION_HEAVY_WINDOW_DEFAULT = '22:00-07:00';
export const EVOLUTION_HEAVY_WINDOW_ZONE = 'Asia/Shanghai';
/** The job kinds that wait for the window: the ones whose work is model calls by the hundred. */
export const EVOLUTION_HEAVY_WINDOW_KINDS = Object.freeze(['evolution-scout', 'evolution-build', 'evolution-evaluate', 'evolution-mission', 'evolution-mission-heavy', 'evolution-meta', 'evolution-research', 'evolution-audit']);

/** @param {unknown} value @returns {{ startMinutes: number, endMinutes: number } | null} null: no window, always open */
export function parseEvolutionHeavyWindow(value) {
  const text = String(value ?? '').trim();
  return !text || /^always$/i.test(text) ? null : parseWindow(text);
}
/** Whether the heavy work may start now. @param {{ evolutionHeavyWindow?: unknown } | null | undefined} config @param {Date} now */
export function evolutionHeavyWindowOpen(config, now) {
  return withinWindow(parseEvolutionHeavyWindow(config?.evolutionHeavyWindow), now, EVOLUTION_HEAVY_WINDOW_ZONE);
}
