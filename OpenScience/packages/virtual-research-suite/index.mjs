import { sharedEvidenceMethods } from '@evimed/research-plugin-runtime/catalogue'

/** Compose only the plugins the host has installed and authorized.
 * @param {{listMethods: () => string[], start: (request: Record<string, any>) => Promise<any>}[]} plugins
 */
export function createSuite(plugins) {
  /** @type {Map<string, {listMethods: () => string[], start: (request: Record<string, any>) => Promise<any>}>} */
  const owners = new Map()
  for (const plugin of plugins) {
    for (const method of plugin.listMethods()) {
      if (owners.has(method)) {
        if (!sharedEvidenceMethods.includes(method)) throw new Error(`duplicate_method: ${method}`)
      } else owners.set(method, plugin)
    }
  }
  return Object.freeze({
    listMethods: () => [...owners.keys()],
    /** @param {Record<string, any>} request */
    start(request) {
      const plugin = owners.get(request?.method)
      if (!plugin) throw new Error('unsupported_method')
      return plugin.start(request)
    },
  })
}
