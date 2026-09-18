// Recording fakes of the kernel client services the frame bodies use.
//
// The slot registry refuses exactly what the pinned SlotCore refuses
// (`@deepseek-ai/dsh-client-ui-slots@0.1.5-rc.2`, `SlotCore.register`): a list
// slot without `id`, a keyed slot without `key`, a chain slot without
// `select`, and a second entry at an occupied priority (per key for keyed, per
// id for list). A fake that accepted what the kernel refuses is how an
// occupant once "registered" in every test and rendered nothing in the page.
import { createRequire } from 'node:module';
import { createFrameKit } from '../../src/runtimeUiKit.mjs';
import { FRAME_VOCABULARY } from '../../src/runtimeUiFrame.mjs';

/**
 * @param {Record<string, { kind: string }>} declared slot name → contract, as the kernel would have declared them
 */
export function fakeSlots(declared) {
  /** @type {{ name: string, options: Record<string, any>, component: any }[]} */
  const registrations = [];
  /** @type {string[]} */
  const injected = [];
  const slots = {
    registrations,
    injected,
    /** @param {string} name @param {() => any} setup */
    inject(name, setup) {
      injected.push(name);
      if (!declared[name]) return () => {};
      const result = setup();
      if (result && typeof result[Symbol.iterator] === 'function' && typeof result !== 'function') {
        for (const _ of result) { /* drain the registration set */ }
      }
      return () => {};
    },
    /** @param {Record<string, any>} options @param {any} component */
    register(options, component) {
      const contract = declared[options.name];
      if (!contract) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
      const priority = options.priority ?? 0;
      const existing = registrations.filter((entry) => entry.name === options.name);
      if (contract.kind === 'single' && existing.some((entry) => (entry.options.priority ?? 0) === priority)) {
        throw new Error(`single slot "${options.name}" already has a registration at priority ${priority}`);
      }
      if (contract.kind === 'keyed') {
        if (options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`);
        if (existing.some((entry) => entry.options.key === options.key && (entry.options.priority ?? 0) === priority)) {
          throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}"`);
        }
      }
      if (contract.kind === 'list') {
        if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`);
        if (existing.some((entry) => entry.options.id === options.id && (entry.options.priority ?? 0) === priority)) {
          throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`);
        }
      }
      if (contract.kind === 'chain' && options.select === undefined) throw new Error(`chain slot "${options.name}" requires options.select`);
      registrations.push({ name: options.name, options, component });
      return () => {};
    },
    /**
     * The ledger's inspection view, lowest priority first as the kernel keeps
     * it: entries carry their component and options.
     * @param {string} name
     */
    entries(name) {
      return registrations.filter((entry) => entry.name === name)
        .map((entry) => ({ component: entry.component, options: entry.options }))
        .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
    },
  };
  return slots;
}

/**
 * A kernel that has declared every slot in the pinned table, with the shipped
 * entries of the keyed ones already registered at priority 0 — so a takeover
 * that forgets to go below them fails here as it would in the page.
 */
export function kernelSlots() {
  const slots = fakeSlots(FRAME_VOCABULARY.slots);
  for (const [name, contract] of Object.entries(FRAME_VOCABULARY.slots)) {
    for (const key of /** @type {any} */ (contract).shippedKeys ?? []) slots.registrations.push({ name, options: { name, key }, component: 'shipped' });
  }
  return slots;
}

/** A document just rich enough for the bodies: head, elements, a root element. */
export function fakeDocument() {
  /** @type {any[]} */
  const head = [];
  const documentElement = { lang: 'zh-x-evimed', style: {} };
  const document = {
    title: 'DeepSeek Harness',
    head: { children: head, appendChild: (/** @type {any} */ node) => { head.push(node); node.parentNode = document.head; return node; } },
    documentElement,
    querySelector: () => null,
    /** @param {string} tag */
    createElement(tag) {
      /** @type {any} */
      const node = {
        tag,
        attributes: {},
        textContent: '',
        parentNode: null,
        /** @param {string} key @param {string} value */
        setAttribute(key, value) { node.attributes[key] = value; },
        remove() {
          const index = head.indexOf(node);
          if (index >= 0) head.splice(index, 1);
          node.parentNode = null;
        },
      };
      return node;
    },
  };
  return document;
}

/**
 * @param {{ framed?: boolean, frame?: Record<string, any>, embedded?: boolean }} [options]
 */
export function fakeTarget({ framed = true, frame = {}, embedded = true } = {}) {
  /** @type {any[]} */
  const warnings = [];
  /** @type {any[]} */
  const posted = [];
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {any} */
  const target = {
    __EVIMED_FRAME__: framed ? { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example', cwd: '/workspace', capabilities: [], ...frame } : undefined,
    document: fakeDocument(),
    console: { warn: (/** @type {any[]} */ ...args) => warnings.push(args), error: (/** @type {any[]} */ ...args) => warnings.push(args) },
    warnings,
    posted,
    listeners,
    setTimeout,
    clearTimeout,
    /** @param {string} type @param {Function} listener */
    addEventListener(type, listener) { listeners.set(type, listener); },
    /** @param {string} type */
    removeEventListener(type) { listeners.delete(type); },
  };
  target.parent = embedded ? { postMessage: (/** @type {any} */ message, /** @type {string} */ origin) => posted.push({ message, origin }) } : target;
  return target;
}

/**
 * A native client context with the services named, recording effects and
 * event listeners; `inject` hands the callback the context itself when every
 * named service exists, as cordis does once they are provided.
 * @param {Record<string, any>} services
 */
export function fakeCtx(services = {}) {
  /** @type {{ label: string, dispose: any }[]} */
  const effects = [];
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  /** @type {any} */
  const ctx = {
    ...services,
    effects,
    listeners,
    /** @param {() => any} setup @param {string} label */
    effect(setup, label) { const dispose = setup(); effects.push({ label, dispose }); return dispose; },
    /** @param {string[]} names @param {(scope: any) => void} callback */
    inject(names, callback) { if (names.every((name) => ctx[name] !== undefined)) callback(ctx); return () => {}; },
    /** @param {string} name @param {Function} listener */
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    /** @param {string} name @param {any[]} args */
    emit(name, ...args) { for (const listener of [...(listeners.get(name) ?? [])]) listener(...args); },
    /** @param {string} name */
    get(name) { return ctx[name]; },
    dispose() { for (const effect of [...effects].reverse()) if (typeof effect.dispose === 'function') effect.dispose(); },
  };
  return ctx;
}

const webRequire = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));

/** The shell's React, which the node suite can render with. */
export function realReact() {
  return { React: webRequire('react'), server: webRequire('react-dom/server') };
}

/**
 * A kit over a fake context, the way the composed plugin builds one.
 * @param {any} ctx @param {any} target @param {{ react?: boolean }} [options]
 */
export function kitFor(ctx, target, { react = true } = {}) {
  const require = react ? (/** @type {string} */ id) => (id === 'react' ? realReact().React : undefined) : undefined;
  return createFrameKit(ctx, target, require, FRAME_VOCABULARY);
}

/**
 * Render a component to static markup with the shell's React.
 * @param {any} Component @param {Record<string, any>} [props]
 */
export function renderStatic(Component, props = {}) {
  const { React, server } = realReact();
  return server.renderToStaticMarkup(React.createElement(Component, props));
}
