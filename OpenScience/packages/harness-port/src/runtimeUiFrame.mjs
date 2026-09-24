/**
 * The frame layer as one bundle: which bodies it is made of, in what order,
 * and the text the kernel's browser loader receives.
 *
 * Hidden knowledge, and the reason this module exists at all: the frame's
 * code reaches the browser as source text built from `Function#toString()`,
 * not as a module graph. The kernel's loader registers one factory per package
 * and hands it a `require` for the modules it already serves (React among
 * them); there is no bundler step and there must not be one that pulls a
 * second copy of anything. So each body is a list of named functions that
 * reference only each other, their parameters and browser globals — and the
 * kit arrives as a parameter instead of an import. Growing the layer from one
 * 340-line function into several bodies is what this shape allows without
 * giving that rule up.
 *
 * Every body is individually switchable. The control plane lists the switched
 * off ones in the frame's bootstrap object (`off`), from
 * `OPEN_SCIENCE_RUNTIME_UI_FRAME_OFF`, and the composed plugin skips them; a
 * body that throws while starting is logged and skipped the same way. With
 * every body off the kernel's own conversation still works — that is the
 * control every body is measured against (principle 11). The bridge alone is
 * not switchable: it is the channel the shell navigates through, not a
 * feature, and without it the shell cannot open a session at all.
 *
 * @module @evimed/harness-port/runtime-ui-frame
 */

import { kernelThemeTokens } from '@evimed/domain/design-tokens';

import {
  CONTRACT_KIND_LABELS,
  EVIDENCE_SOURCE_TYPE_LABELS_ZH,
  EVIDENCE_SOURCE_TYPES,
  KNOWLEDGE_DIR,
  RUN_ACTIVITY_PHASE_LABELS_ZH,
  RUN_ACTIVITY_PHASES,
  SOCKET_TOOL_NAMES,
} from '@evimed/domain';

import { BODY as BRIDGE } from './runtimeUiBridge.mjs';
import { BODY as COMMANDS } from './runtimeUiCommands.mjs';
import { KIT_PARTS } from './runtimeUiKit.mjs';
import { BODY as LOCALE } from './runtimeUiLocale.mjs';
import { BODY as PANELS } from './runtimeUiPanels.mjs';
import { BODY as REPLY_CHECKS } from './runtimeUiReplyChecks.mjs';
import { BODY as SHELL } from './runtimeUiShell.mjs';
import { RUNTIME_UI_KERNEL_PIN, RUNTIME_UI_SLOTS } from './runtimeUiSlots.mjs';
import { BODY as THEME } from './runtimeUiTheme.mjs';
import { BODY as TOOLVIEWS } from './runtimeUiToolviews.mjs';
import { BODY as TRANSCRIPT } from './runtimeUiTranscript.mjs';

/**
 * @typedef {object} FrameBody
 * @property {string} name the switch name (`OPEN_SCIENCE_RUNTIME_UI_FRAME_OFF`)
 * @property {readonly string[]} inject services the body requires outright
 * @property {readonly Function[]} parts named functions, `apply` last
 */

/**
 * The bodies, in the order they start. The bridge first, because the others
 * reach the shell through the hub it attaches; the language and the palette
 * before anything that renders. (The composer's queue/steer hint was a body of
 * its own, `controls`, until 2026-09-23; it is the send button's tooltip now,
 * in the language pack.)
 * @type {readonly FrameBody[]}
 */
export const FRAME_BODIES = Object.freeze([BRIDGE, LOCALE, THEME, SHELL, TRANSCRIPT, REPLY_CHECKS, TOOLVIEWS, PANELS, COMMANDS]);

/** The switch names an operator may list; the bridge is not one of them. */
export const FRAME_SWITCHABLE_BODIES = Object.freeze(FRAME_BODIES.map((body) => body.name).filter((name) => name !== 'bridge'));

/**
 * The data every body shares, inlined into the bundle at build time from the
 * one place each fact is defined — so the frame's progress labels are the
 * domain's phase labels and not a copy that drifts.
 */
export const FRAME_VOCABULARY = Object.freeze({
  kernelPin: RUNTIME_UI_KERNEL_PIN,
  slots: RUNTIME_UI_SLOTS,
  // The product's palette and type, from the one token module the shell's own
  // stylesheet and Tailwind theme are generated from. Inlined here at build
  // time because a frame body may import nothing: the frame reaches the browser
  // as serialized functions, so the only way a value crosses is as data in this
  // table. Two hand-kept copies of a palette is how the shell and the frame
  // came to disagree about the sidebar's grey.
  themeTokens: kernelThemeTokens(),
  phases: RUN_ACTIVITY_PHASES,
  phaseLabels: RUN_ACTIVITY_PHASE_LABELS_ZH,
  sourceTypes: EVIDENCE_SOURCE_TYPES,
  sourceTypeLabels: EVIDENCE_SOURCE_TYPE_LABELS_ZH,
  contractKindLabels: CONTRACT_KIND_LABELS,
  // Where the researcher's knowledge base is synced in the workspace: the
  // `@` reference tells the model where a cited source's text is.
  knowledgeDir: KNOWLEDGE_DIR,
  // The socket tools whose calls the frame draws. The names are contractual
  // (C6/C7 of the 2026-09-18 plan); the domain's table is preferred where it
  // already lists one, so a rename there reaches the frame.
  tools: Object.freeze({
    plan: SOCKET_TOOL_NAMES.plan,
    delegate: SOCKET_TOOL_NAMES.delegate,
    submit: SOCKET_TOOL_NAMES.submitDeliverable,
    await: /** @type {Record<string, string>} */ (SOCKET_TOOL_NAMES).await ?? 'evimed_await',
    packageCheck: /** @type {Record<string, string>} */ (SOCKET_TOOL_NAMES).packageCheck ?? 'evimed_package_check',
    claimUpsert: /** @type {Record<string, string>} */ (SOCKET_TOOL_NAMES).claimUpsert ?? 'evimed_claim_upsert',
  }),
  bodies: Object.freeze(FRAME_BODIES.map((body) => body.name)),
});

/**
 * The source of one closure that declares `parts` and returns `entry`.
 * @param {readonly Function[]} parts @param {string} entry
 * @returns {string}
 */
export function partsSource(parts, entry) {
  for (const part of parts) {
    if (typeof part !== 'function' || !part.name) throw new Error('evimed-frame: every part must be a named function');
    if (!/^(?:async\s+)?function\b/.test(part.toString())) {
      throw new Error(`evimed-frame: part ${part.name} must be a function declaration; an arrow loses its name in toString()`);
    }
  }
  if (!parts.some((part) => part.name === entry)) throw new Error(`evimed-frame: the parts declare no ${entry}`);
  return `(() => {\n${parts.map((part) => part.toString()).join('\n')}\nreturn ${entry};\n})()`;
}

/**
 * The client bundle the kernel's loader receives, as text.
 *
 * One factory for the whole layer. The kit is built once and handed to every
 * body; a body the control plane switched off is skipped, and one that throws
 * while starting is logged and skipped too — the rest of the page keeps
 * working.
 *
 * @param {{ bodies?: readonly FrameBody[], vocabulary?: any }} [options]
 * @returns {string}
 */
export function renderFrameClient({ bodies = FRAME_BODIES, vocabulary = FRAME_VOCABULARY } = {}) {
  const inject = [...new Set(bodies.flatMap((body) => [...body.inject]))];
  return [
    'globalThis.__ModuleLoader__.load({',
    "  id: '@evimed/dsh-socket',",
    '  factory: (require) => {',
    `    const vocabulary = ${JSON.stringify(vocabulary)};`,
    `    const createKit = ${partsSource(KIT_PARTS, 'createFrameKit')};`,
    '    const bodies = [',
    ...bodies.map((body) => `      [${JSON.stringify(body.name)}, ${partsSource(body.parts, 'apply')}],`),
    '    ];',
    `    return { inject: ${JSON.stringify(inject)}, apply: (ctx, config) => {`,
    '      const kit = createKit(ctx, globalThis, require, vocabulary);',
    '      for (const [name, body] of bodies) {',
    "        if (name !== 'bridge' && kit.isOff(name)) continue;",
    '        try { body(ctx, config, globalThis, require, kit); }',
    '        catch (error) { globalThis.console?.error?.(`[evimed-frame] ${name} did not start:`, error); }',
    '      }',
    '    } };',
    '  }',
    '});',
    '',
  ].join('\n');
}
