import { createTopicsHandler, validateConfig, TOPICS_PATH } from './src/topics.mjs'

export const name = 'evimed-search-topics'
export const inject = ['webServer']

/**
 * @typedef {{
 *   effect: (acquire: () => (() => void)) => unknown,
 *   webServer: { register: (route: {
 *     kind: 'exact', path: string,
 *     handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
 *   }) => (() => void) }
 * }} TopicsContext
 */

/** Mount on the native carrier; its scoped effect owns route disposal. No kernel imports. */
export function apply(/** @type {TopicsContext} */ ctx, /** @type {unknown} */ config) {
  const settings = validateConfig(config)
  const handler = createTopicsHandler(settings)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: TOPICS_PATH, handler }))
}
