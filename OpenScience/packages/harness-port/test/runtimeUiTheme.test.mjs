// The frame's palette: what it must guarantee a reader, and how it rides the
// kernel's theme runtime.
//
// The contrast checks are computed, not asserted from a table someone typed:
// WCAG 2.1 relative luminance, the same formula the review's appendix D §7.5
// used. The pairings are the ones the pinned 0.1.5-rc.2 stylesheets actually
// draw (which token is text, which is the ground under it) — read off the
// client packages, listed beside each check.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, BODY, evimedThemeTokens, THEME_LAYER_SOURCE } from '../src/runtimeUiTheme.mjs';
import { fakeCtx, fakeTarget, kitFor } from './helpers/frameFakes.mjs';

/** @param {string} hex */
function luminance(hex) {
  const value = hex.replace('#', '');
  assert.match(value, /^[0-9a-f]{6}$/i, `${hex} is not a six-digit hex colour; the contrast check cannot read it`);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** @param {string} a @param {string} b */
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const tokens = evimedThemeTokens();
const schemes = /** @type {const} */ (['light', 'dark']);
/** @param {string} name @param {'light' | 'dark'} scheme */
const value = (name, scheme) => {
  assert.ok(tokens[name], `${name} is not in the layer`);
  return tokens[name][scheme];
};

test('the send button carries its white glyph at AA in both schemes', () => {
  // `ui-conversation` .primary: background var(--dsw-alias-button-info-fill);
  // color: #fff — the glyph colour is not a token, so the fill must carry it.
  for (const scheme of schemes) {
    for (const fill of ['--dsw-alias-button-info-fill', '--dsw-alias-button-info-hover']) {
      const ratio = contrast('#ffffff', value(fill, scheme));
      assert.ok(ratio >= 4.5, `white on ${fill} (${scheme}) is ${ratio.toFixed(2)}:1, below 4.5:1`);
    }
  }
});

test('reading text clears AA on every surface it is drawn on', () => {
  const surfaces = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-module-platform', '--dsw-specific-bubble', '--dsw-specific-input-major', '--dsw-specific-menu'];
  const text = ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-link',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-success-primary'];
  let checked = 0;
  for (const scheme of schemes) {
    for (const fg of text) {
      for (const bg of surfaces) {
        const ratio = contrast(value(fg, scheme), value(bg, scheme));
        assert.ok(ratio >= 4.5, `${fg} on ${bg} (${scheme}) is ${ratio.toFixed(2)}:1, below 4.5:1`);
        checked++;
      }
    }
  }
  assert.equal(checked, 2 * 7 * 8);
});

test('the small chips the kernel draws read at AA', () => {
  for (const scheme of schemes) {
    // `ui-user-questions` .badge (「推荐」): the send button's fill as text on
    // the sidebar accent.
    const recommended = contrast(value('--dsw-alias-button-info-fill', scheme), value('--dsw-specific-sidebar-nav-item-active-accent', scheme));
    assert.ok(recommended >= 4.5, `the recommended badge (${scheme}) is ${recommended.toFixed(2)}:1`);
    // `ui-plan` .chip: warn label on warn tertiary.
    const plan = contrast(value('--dsw-alias-state-warn-label', scheme), value('--dsw-alias-state-warn-tertiary', scheme));
    assert.ok(plan >= 4.5, `the plan chip (${scheme}) is ${plan.toFixed(2)}:1`);
    // `ui-user-questions` .number: secondary text on the overlay ground.
    const number = contrast(value('--dsw-alias-label-secondary', scheme), value('--dsw-alias-bg-overlay', scheme));
    assert.ok(number >= 4.5, `the option number (${scheme}) is ${number.toFixed(2)}:1`);
  }
});

test('focus rings, control edges and the running dot clear the 3:1 of graphics', () => {
  for (const scheme of schemes) {
    for (const ground of ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1']) {
      const focus = contrast(value('--dsw-alias-state-business-primary', scheme), value(ground, scheme));
      assert.ok(focus >= 3, `the focus colour on ${ground} (${scheme}) is ${focus.toFixed(2)}:1`);
      // `dsh-client-ui-primitives` StateDot: --dsh-state-ongoing is the 450 step.
      const running = contrast(value('--dsw-static-deepseek-450', scheme), value(ground, scheme));
      assert.ok(running >= 3, `the running dot on ${ground} (${scheme}) is ${running.toFixed(2)}:1`);
    }
    // Inputs and elevated strokes are l4 against the canvas (§7.5, 1.4.11).
    const edge = contrast(value('--dsw-alias-border-l4', scheme), value('--dsw-alias-bg-base', scheme));
    assert.ok(edge >= 3, `the control edge (${scheme}) is ${edge.toFixed(2)}:1`);
  }
});

test('the working line is a lightness shimmer with no hue, readable as text', () => {
  // `ui-chat` .turnStatus: linear-gradient(500 0%, 500 40%, 200 50%, 500 60%,
  // 500 100%) clipped to the text. Both steps are the frame's own text
  // colours, so the line reads as type, not as a coloured effect (§6.3).
  for (const scheme of schemes) {
    assert.equal(value('--dsw-static-deepseek-500', scheme), value('--dsw-alias-label-tertiary', scheme));
    assert.equal(value('--dsw-static-deepseek-200', scheme), value('--dsw-alias-label-primary', scheme));
    const base = contrast(value('--dsw-static-deepseek-500', scheme), value('--dsw-alias-bg-base', scheme));
    assert.ok(base >= 4.5, `the working line (${scheme}) is ${base.toFixed(2)}:1`);
  }
});

test('the layer is well-formed and leaves the neutral brand-primary alone', () => {
  const names = Object.keys(tokens);
  assert.ok(names.length >= 50, `only ${names.length} tokens; the table was not read`);
  for (const [name, pair] of Object.entries(tokens)) {
    assert.match(name, /^--dsw-[a-z0-9-]+$/);
    // The runtime's own shape check: a { light, dark } pair of strings.
    assert.equal(typeof pair.light, 'string', name);
    assert.equal(typeof pair.dark, 'string', name);
    assert.ok(pair.light.length > 0 && pair.dark.length > 0, name);
  }
  // A neutral upstream, behind primary buttons with white text; a hue there
  // loses their contrast.
  assert.ok(!names.some((name) => name.startsWith('--dsw-alias-brand-primary')));
  // The six ramp steps the review names are all set.
  for (const step of [50, 100, 200, 400, 450, 500]) assert.ok(tokens[`--dsw-static-deepseek-${step}`], `ramp step ${step} is not set`);
  assert.match(value('--dsw-font-family', 'light'), /PingFang SC/);
  assert.match(value('--dsw-font-markdown-base', 'light'), /\* 1\.75\)/);
});

/**
 * The pinned theme runtime's observable contract: one layer per source,
 * stacked by call order, a bare string refused, `theme/change` emitted with the
 * composed snapshot on every change, `setTheme` refusing unknown ids.
 * @param {any} ctx
 */
function themeRuntime(ctx) {
  /** @type {Map<string, { seq: number, tokens: Record<string, { light: string, dark: string }> }>} */
  const layers = new Map();
  let seq = 0;
  const state = { preference: 'system', scheme: /** @type {'light' | 'dark'} */ ('light') };
  /** @type {string[]} */
  const writes = [];
  const snapshot = () => {
    /** @type {Record<string, string>} */
    const composed = {};
    for (const layer of [...layers.values()].sort((a, b) => a.seq - b.seq)) {
      for (const [name, modes] of Object.entries(layer.tokens)) composed[name] = modes[state.scheme];
    }
    return { preference: state.preference, active: { id: state.scheme, colorScheme: state.scheme, tokens: composed } };
  };
  const publish = () => ctx.emit('theme/change', snapshot());
  return {
    layers,
    writes,
    state,
    publish,
    /** @param {string} source @param {Record<string, any>} tokens */
    overrideTokens(source, tokens) {
      for (const [name, pair] of Object.entries(tokens)) {
        if (typeof pair === 'string') throw new TypeError(`theme override "${name}" is a bare string`);
        if (typeof pair?.light !== 'string' || typeof pair?.dark !== 'string') throw new TypeError(`theme override "${name}" must be a pair`);
      }
      const layer = { seq: seq++, tokens };
      layers.set(source, layer);
      publish();
      return () => {
        if (layers.get(source) !== layer) return;
        layers.delete(source);
        publish();
      };
    },
    /** @param {string} id */
    setTheme(id) {
      if (!['light', 'dark', 'system'].includes(id)) throw new Error(`theme "${id}" is not registered`);
      writes.push(id);
      state.preference = id;
      if (id !== 'system') state.scheme = /** @type {'light' | 'dark'} */ (id);
      publish();
    },
  };
}

test('the body lays its layer once, under its own name, and takes it away on unload', () => {
  const ctx = fakeCtx();
  ctx.theme = themeRuntime(ctx);
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.deepEqual([...ctx.theme.layers.keys()], [THEME_LAYER_SOURCE]);
  assert.equal(THEME_LAYER_SOURCE, '@evimed/dsh-socket');
  assert.equal(ctx.theme.layers.get(THEME_LAYER_SOURCE).tokens['--dsw-alias-button-info-fill'].light, '#00756b');
  let changes = 0;
  ctx.on('theme/change', () => { changes++; });
  ctx.dispose();
  assert.equal(ctx.theme.layers.size, 0, 'the layer outlived the body');
  assert.equal(changes, 1, 'releasing the layer must not be answered by putting it back');
});

test('a change that arrives without the layer puts it back, a bounded number of times', () => {
  const ctx = fakeCtx();
  ctx.theme = themeRuntime(ctx);
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  // A scheme flip with the layer present changes nothing.
  ctx.theme.state.scheme = 'dark';
  ctx.theme.publish();
  assert.equal(ctx.theme.layers.get(THEME_LAYER_SOURCE).seq, 0);
  // Something else claimed the ramp on top: the layer is restacked above it.
  ctx.theme.overrideTokens('someone-else', { '--dsw-static-deepseek-500': { light: '#123456', dark: '#123456' } });
  assert.ok(ctx.theme.layers.get(THEME_LAYER_SOURCE).seq > ctx.theme.layers.get('someone-else').seq);
  // And an insistent one wins after five rounds instead of looping forever.
  for (let round = 0; round < 10; round++) ctx.theme.overrideTokens('someone-else', { '--dsw-static-deepseek-500': { light: '#123456', dark: '#123456' } });
  assert.ok(ctx.theme.layers.get('someone-else').seq > ctx.theme.layers.get(THEME_LAYER_SOURCE).seq);
});

test("the shell's light/dark/system choice reaches setTheme, and nothing else does", () => {
  const ctx = fakeCtx();
  ctx.theme = themeRuntime(ctx);
  const target = fakeTarget();
  const kit = kitFor(ctx, target);
  // A preference the shell sent before the body started is applied at start.
  kit.hub.deliver('theme', { preference: 'dark', resolved: 'dark' });
  apply(ctx, {}, target, undefined, kit);
  assert.deepEqual(ctx.theme.writes, ['dark']);
  kit.hub.deliver('theme', { preference: 'system', resolved: 'light' });
  kit.hub.deliver('theme', { preference: 'sepia', resolved: 'light' });
  kit.hub.deliver('theme', null);
  assert.deepEqual(ctx.theme.writes, ['dark', 'system']);
  ctx.dispose();
  kit.hub.deliver('theme', { preference: 'light', resolved: 'light' });
  assert.deepEqual(ctx.theme.writes, ['dark', 'system'], 'an unloaded body still followed the shell');
});

test('a refused preference is logged, not thrown into the bridge', () => {
  const ctx = fakeCtx();
  ctx.theme = { ...themeRuntime(ctx), setTheme() { throw new Error('theme "dark" is not registered'); } };
  const target = fakeTarget();
  const kit = kitFor(ctx, target);
  apply(ctx, {}, target, undefined, kit);
  kit.hub.deliver('theme', { preference: 'dark', resolved: 'dark' });
  assert.ok(target.warnings.some((/** @type {any[]} */ entry) => String(entry[0]).includes('preference not applied')));
});

test('outside a frame, or without a theme service, the body does nothing', () => {
  const plain = fakeCtx();
  plain.theme = themeRuntime(plain);
  const outside = fakeTarget({ framed: false });
  apply(plain, {}, outside, undefined, kitFor(plain, outside));
  assert.equal(plain.theme.layers.size, 0);
  const bare = fakeCtx();
  const target = fakeTarget();
  assert.doesNotThrow(() => apply(bare, {}, target, undefined, kitFor(bare, target)));
  assert.equal(BODY.name, 'theme');
  assert.deepEqual([...BODY.inject], [], 'the theme service is optional; requiring it would park the whole plugin');
});
