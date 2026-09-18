/**
 * Browser source entry. Prepack emits the native module-loader registration.
 *
 * The frame layer is several self-contained bodies — the navigation bridge,
 * the language pack, the brand and layout shell, and the feature bodies —
 * composed into one loader entry around a shared kit. Each body is a list of
 * named functions the build serializes with `toString()`; the composition and
 * its text live in the port (`runtime-ui-frame`), so the port's own tests
 * evaluate exactly what ships.
 */
export { FRAME_BODIES, FRAME_SWITCHABLE_BODIES, FRAME_VOCABULARY, renderFrameClient } from '@evimed/harness-port/runtime-ui-frame';
export { apply as bridge, inject as bridgeInject } from '@evimed/harness-port/runtime-ui-bridge';
export { apply as shell, inject as shellInject } from '@evimed/harness-port/runtime-ui-shell';
