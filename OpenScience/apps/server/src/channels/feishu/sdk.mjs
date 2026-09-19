/**
 * The one module that loads the Feishu SDK.
 *
 * Loaded on first use rather than at import: the SDK is a 100k-line bundle
 * (axios, protobufjs, ws), and a deployment with the IM module off — the
 * default — should not pay for parsing it at every start. Tests hand the
 * service a fake with the same members instead.
 *
 * @module channels/feishu/sdk
 */

/**
 * @typedef {object} FeishuSdk
 * @property {(options: Record<string, any>) => Promise<any>} registerApp
 * @property {new (options: Record<string, any>) => any} Client
 * @property {new (options: Record<string, any>) => any} WSClient
 * @property {new (options: Record<string, any>) => any} EventDispatcher
 * @property {Record<string, any>} Domain
 * @property {Record<string, any>} LoggerLevel
 * @property {any} [defaultHttpInstance]
 */

/** @type {Promise<FeishuSdk> | null} */
let loading = null;

/** @returns {Promise<FeishuSdk>} */
export function loadFeishuSdk() {
  if (!loading) {
    loading = import("@larksuiteoapi/node-sdk").then((module) => {
      const sdk = /** @type {any} */ (module.default && !module.registerApp ? module.default : module);
      return {
        registerApp: sdk.registerApp,
        Client: sdk.Client,
        WSClient: sdk.WSClient,
        EventDispatcher: sdk.EventDispatcher,
        Domain: sdk.Domain,
        LoggerLevel: sdk.LoggerLevel,
        defaultHttpInstance: sdk.defaultHttpInstance,
      };
    }).catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}
