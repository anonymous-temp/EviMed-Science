/**
 * Every slot the frame layer occupies is declared by a row this deployment
 * mounts.
 *
 * A slot is declared by the `register()` call of the entry that owns its
 * parent seat, and a composition row that is disabled registers nothing — so
 * an occupant of a slot whose declarer is disabled waits forever and renders
 * nothing, without an error anywhere. That cost a shipped release once
 * (`conversation.hero.agentPreset`, 2026-09-15). The disabled list lives here
 * (`dshProfilePatch.mjs`) and the occupants live in the port, so this test
 * holds the two against each other and against the image's recorded
 * composition: add an occupant whose declarer the hosted profile turns off, or
 * turn off a row a body depends on, and this fails.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

import { FRAME_BODIES, FRAME_VOCABULARY } from "@evimed/harness-port/runtime-ui-frame";
import { createFrameKit } from "@evimed/harness-port/runtime-ui-kit";
import { RUNTIME_UI_OPTIONAL_SERVICES, RUNTIME_UI_REQUIRED_SERVICES, RUNTIME_UI_SLOTS } from "@evimed/harness-port/runtime-ui-slots";

import { HOSTED_DISABLED_BROWSER_PANELS, OPERATOR_ONLY_BROWSER_PANELS } from "../src/dshProfilePatch.mjs";

const React = createRequire(new URL("../../web/package.json", import.meta.url))("react");

/** The composition rows the image records, with whether each is disabled there. */
async function composedRows() {
  const text = await readFile(new URL("../../../deploy/runtime-dsh/dump-config.baseline.json", import.meta.url), "utf8");
  /** @type {Map<string, { name: string, disabled: boolean }>} */
  const rows = new Map();
  for (const block of text.split(/\n(?=- id: )/)) {
    const id = /^- id: (\S+)/m.exec(block)?.[1];
    if (!id) continue;
    rows.set(id, { name: /^\s+name: '?([^'\n]+)'?/m.exec(block)?.[1] ?? "", disabled: /^\s+disabled: true\s*$/m.test(block) });
  }
  return rows;
}

/** Apply every body against a kernel that has declared every slot, recording what each asks for. */
function occupiedAndInjected() {
  /** @type {{ body: string, slot: string }[]} */
  const occupied = [];
  /** @type {{ body: string, service: string }[]} */
  const services = [];
  for (const body of FRAME_BODIES) {
    const generation = {};
    /** @type {any} */
    const ctx = {
      slots: {
        inject: (/** @type {string} */ _name, /** @type {() => any} */ setup) => setup(),
        register: (/** @type {any} */ options) => { occupied.push({ body: body.name, slot: options.name }); return () => {}; },
      },
      locale: { addLanguage: () => () => {}, register: () => () => {}, setLocale() {}, subscribe: () => () => {} },
      sessions: { refresh: async () => {}, list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }, scope: () => ({}) },
      conversation: { input: { for: () => ({ setDraft() {}, notify() {} }) } },
      connection: { generation: { getSnapshot: () => generation, subscribe: () => () => {} } },
      workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
      loader: { await: async () => {} },
      effect: () => {},
      on: () => () => {},
      /** Record the optional services a body reaches for; hand it a stand-in for each. */
      inject: (/** @type {string[]} */ names, /** @type {(scope: any) => void} */ callback) => {
        for (const name of names) services.push({ body: body.name, service: name });
        const scope = { ...ctx };
        for (const name of names) scope[name] ??= new Proxy({}, { get: () => () => () => {} });
        try { callback(scope); } catch { /* the registrations made before a stand-in fell short are what is counted */ }
      },
    };
    ctx.get = (/** @type {string} */ name) => ctx[name];
    const target = {
      __EVIMED_FRAME__: { version: 1, frameId: "f", projectId: "p", shellOrigin: "https://app.example", cwd: "/workspace",
        capabilities: [{ id: "meta-analysis", title: "自动化 Meta 分析", category: "证据综合", brief: "b", summary: "s", minutes: [30, 120] }] },
      parent: { postMessage() {} },
      addEventListener() {}, removeEventListener() {},
      document: { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {} }), querySelector: () => null, documentElement: {} },
      console: { warn() {}, error() {} },
    };
    const kit = createFrameKit(ctx, target, (/** @type {string} */ id) => (id === "react" ? React : undefined), FRAME_VOCABULARY);
    body.parts.at(-1)(ctx, {}, target, (/** @type {string} */ id) => (id === "react" ? React : undefined), kit);
  }
  return { occupied, services };
}

test("every slot a frame body occupies is declared by a row the hosted composition mounts", async () => {
  const rows = await composedRows();
  assert.ok(rows.size > 100, `the composition baseline yielded ${rows.size} rows; the parse walked nothing`);
  assert.ok(rows.has("ui-conversation") && rows.has("ui-chat"), "the baseline no longer names the conversation rows");
  const { occupied } = occupiedAndInjected();
  assert.ok(occupied.length >= 5, `only ${occupied.length} occupants were recorded; the bodies did not run`);
  assert.ok(occupied.some((entry) => entry.slot === "sidebar"), "the shell's left-column occupant was not recorded");

  const hostedOff = new Set([...HOSTED_DISABLED_BROWSER_PANELS, ...OPERATOR_ONLY_BROWSER_PANELS]);
  for (const { body, slot } of occupied) {
    const contract = /** @type {any} */ (RUNTIME_UI_SLOTS)[slot];
    assert.ok(contract, `${body} occupies "${slot}", which the pinned slot table does not describe`);
    const row = rows.get(contract.declaredBy);
    assert.ok(row, `"${slot}" is declared by row "${contract.declaredBy}", which the composition does not have`);
    assert.ok(!row.disabled, `"${slot}" is declared by row "${contract.declaredBy}", which the image composes disabled`);
    assert.ok(!hostedOff.has(contract.declaredBy), `"${slot}" is declared by row "${contract.declaredBy}", which the hosted profile disables — the occupant would wait forever`);
  }
});

test("every service a frame body uses is provided by a mounted row and named for the loader", async () => {
  const rows = await composedRows();
  const hostedOff = new Set([...HOSTED_DISABLED_BROWSER_PANELS, ...OPERATOR_ONLY_BROWSER_PANELS]);
  const socket = JSON.parse(await readFile(new URL("../../../packages/socket/package.json", import.meta.url), "utf8"));
  const loaderInject = new Set(socket.dsh.client.inject);
  const { services } = occupiedAndInjected();
  /** @type {Record<string, { row: string, package: string }>} */
  const known = { ...RUNTIME_UI_OPTIONAL_SERVICES, ...RUNTIME_UI_REQUIRED_SERVICES };
  const required = new Set(FRAME_BODIES.flatMap((body) => [...body.inject]));
  for (const service of [...required, ...services.map((entry) => entry.service)]) {
    const provider = known[service];
    assert.ok(provider, `a frame body uses "${service}", which the port's service table does not name a provider for`);
    const row = rows.get(provider.row);
    assert.ok(row && !row.disabled && !hostedOff.has(provider.row), `"${service}" comes from row "${provider.row}", which this deployment does not mount`);
    assert.equal(row.name, provider.package, `row "${provider.row}" loads ${row.name}, not ${provider.package}`);
    assert.ok(loaderInject.has(provider.package), `${provider.package} provides "${service}" and must be listed under dsh.client.inject, or the bundle races it`);
  }
  // Optional services never park the whole plugin: none of them is required
  // at plugin level.
  for (const service of Object.keys(RUNTIME_UI_OPTIONAL_SERVICES)) {
    assert.ok(!required.has(service), `"${service}" is optional and must be reached through ctx.inject, not required at plugin level`);
  }
});
