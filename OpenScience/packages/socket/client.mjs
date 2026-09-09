/**
 * Browser source entry. Prepack emits the native module-loader registration.
 *
 * Two plugin bodies ride in one bundle: the navigation bridge, which binds the
 * kernel's sessions to the control plane's project, and the hosted shell,
 * which occupies the brand slots, selects the product's language and
 * withdraws the surfaces the deployment does not offer. Each body is
 * self-contained; the build serializes them by `toString()`.
 */
export { apply as bridge, inject as bridgeInject } from '@evimed/harness-port/runtime-ui-bridge';
export { apply as shell, inject as shellInject } from '@evimed/harness-port/runtime-ui-shell';
