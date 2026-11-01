/** Route families only: no document ids, search terms or account data enter telemetry.
 * @param {string} pathname
 */
export function webVitalRoute(pathname) {
  const area = /^\/app(?:\/([a-z-]+))?(?:\/|$)/.exec(String(pathname).split('?')[0])?.[1] ?? '';
  return ['chat', 'files', 'autopilot', 'frontier', 'geo', 'virtual-research', 'account', 'inbox', 'memory', 'capabilities', 'extensions', 'runs'].includes(area)
    ? `/app/${area}` : /^\/app(?:\/|$)/.test(pathname) ? '/app' : null;
}

/** `OPEN_COLD` / `OPEN_WARM`: milliseconds from a conversation surface starting to open to its conversation being on screen, with
 * the runtime down or up when it began. The browser observers cannot see inside the frame, so the shell reports this one itself.
 * @param {any} input */
export function validWebVital(input) {
  return input && typeof input === 'object' && ['LCP', 'INP', 'CLS', 'OPEN_COLD', 'OPEN_WARM'].includes(input.name)
    && ['desktop', 'mobile'].includes(input.device) && typeof input.route === 'string' && webVitalRoute(input.route) === input.route
    && typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(input.id)
    && Number.isFinite(input.value) && input.value >= 0 && input.value <= (input.name === 'CLS' ? 100 : 600_000);
}
