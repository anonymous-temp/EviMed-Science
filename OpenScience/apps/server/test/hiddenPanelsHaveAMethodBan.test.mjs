/**
 * A panel the hosted browser does not show, and the method behind it.
 *
 * Hiding a panel hides a button, not a method: the kernel's application talks
 * to its own endpoints, and a page that is not drawn can still be reached by a
 * client that constructs the request. That lesson was learned twice. First on
 * the directory picker, which is why the method deny list exists at all. Then
 * again on 2026-09-09, on the composer's access-mode chip: it renders one row
 * per permission preset and switches by sending `/permission <id>` on the
 * prompt path, so no method rule sees it, and `danger-full-access` was one menu
 * item away from any browser until the hosted permission table was narrowed to
 * a single row.
 *
 * The two lists never referred to each other. This is the pairing, written
 * down: every disabled panel either has a namespace or method that stops what
 * it does, or is named here as cosmetic with the reason it cannot be reached
 * another way. A panel added to the disabled list without a decision fails
 * here, which is the only moment anyone is going to make that decision.
 *
 * What a panel reaches is not written here. It used to be: the plugin
 * inventory's panel was paired with our own `evimedPlugins` namespace while its
 * client calls `pluginInventory/*`, which nothing denied, and the test passed
 * because it only asked whether the paired namespace was on the list, never
 * whether it was the panel's (2026-10-14). The namespaces a panel's client
 * reaches are read from its bundle (`packages/contracts/dsh/panel-remotes.json`,
 * recorded from the pinned closure and compared with a fresh install by
 * `verify-harness-seams.mjs`), and every one of them must be denied, shared
 * with the conversation itself, or covered by named methods.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RUNTIME_UI_DENIED_HOST_ROUTES, RUNTIME_UI_DENIED_METHODS, RUNTIME_UI_DENIED_NAMESPACES, runtimeUiMethodFromPath } from "@evimed/domain";

import { reachedNamespaces, rowPackages } from "../../../packages/contracts/dsh/panelRemotes.mjs";
import { HOSTED_DISABLED_BROWSER_PANELS, HOSTED_PERMISSION_PRESET, OPERATOR_ONLY_BROWSER_PANELS } from "../src/dshProfilePatch.mjs";

/**
 * What stops each hidden panel from being reached another way.
 *
 * `namespace` and `methods` are checked against the deny lists. `hostRoute`
 * is the third kind, and 0.1.5 is what made it necessary: a panel whose backing
 * endpoint is not an `/api/` method at all but a route on the kernel's web
 * server, stopped by path rather than by name. `nonMethodApiRoute` is its
 * sibling under `/api/`: a route there whose name is not `<namespace>/<name>`,
 * which the proxy refuses before any method rule is asked. `cosmetic` means the
 * panel draws something with no endpoint behind it, and the string is the
 * argument for that — reviewed when the pairing changes, not assumed.
 */
const WHAT_STOPS_IT = {
  "ui-settings-general": { namespace: "settings" },
  "ui-settings-models": { namespace: "llm" },
  "ui-settings-shell": { namespace: "settings" },
  "ui-settings-agent-loop": { namespace: "settings" },
  "ui-settings-subagent": { namespace: "settings" },
  "ui-settings-web-search": { namespace: "settings" },
  "ui-settings-plugin-inventory": { namespace: "pluginInventory" },
  // A shell: it owns the navigation entry and the tab row and calls no host method of its own; every tab in it is
  // registered by another plugin, and the one that ships (the inventory) is its own hidden panel above.
  "ui-settings-plugins": { cosmetic: "the section shell calls no host method; its tabs are other plugins' panels, each paired on its own row, and nothing draws it with the panel behind it hidden." },
  // 0.2.0: a general-settings item over the `session-log-deepseek` configuration form, which the generic settings
  // form service reads and writes through the `settings` namespace.
  "ui-settings-session-log": { namespace: "settings" },
  // Model selection is visible for the approved thinking controls; the
  // runtime proxy still validates the configured provider/model selection.
  "ui-agent-preset": { methods: ["agentPresets/select", "agentPresets/copy", "agentPresets/deletePreset"], namespace: null },
  "ui-message-feedback": { namespace: "messageFeedback" },
  "ui-goal": { namespace: "goals" },
  // Paired with `cordis` by hand until the namespaces were read from the bundle: the panel's client calls
  // `dynamicCordisRunner/*`, the namespace the proxy denies wholesale.
  "ui-cordis": { namespace: "dynamicCordisRunner" },
  "ui-brand-official": {
    cosmetic: "a brand mark; it registers into slots and calls no endpoint. The hosted shell occupies the same slots below it.",
  },
  // The one that was not stopped by a method at all. The chip is drawn by
  // ui-conversation from the profile's own permission table and switches by
  // sending a prompt, which is the product's main path and cannot be denied.
  // What bounds it is the table: one row, so every choice it offers is the
  // same sandbox. Since 2026-09-19 the hosted `permission` row also mounts
  // without the command registry, so the `/permission` it would send does not
  // exist there. Both are asserted below and in dshProfilePatch.test.mjs.
  "ui-permission": {
    cosmetic: "the access-mode chip switches by sending /permission on the prompt path, which no method rule can see; "
      + "the hosted permission table is narrowed to one preset and the hosted permission row registers no /permission "
      + "command at all; those two are what bound it.",
  },
  // 0.1.5. The split button posts to /open-in-app/open, which is a web-server
  // route and not a method — so the pairing is the path, and the hosted profile
  // also disables the row that mounts it.
  "ui-open-in-app": { hostRoute: "/open-in-app/" },
  // `ui-sidebar-files` and `ui-sidebar-documentpreview` were paired with the
  // `workspaceFiles` namespace until 2026-09-22. They are mounted again — the
  // kernel's own file tree and previews — and what bounds them is not a ban
  // but the proxy's path check (`runtimeUiWorkspacePathRefusal`), asserted in
  // runtimeUiPolicy.test.mjs.
  // The browser half of dynamic Cordis packages: every call it makes is a
  // `dynamicCordisRunner/*` method, refused wholesale. Unmounted so it stops
  // syncing a manifest into two 403s per session open.
  "cordis-client-runner": { namespace: "dynamicCordisRunner", noClientBundle: true },
  // The owner of `/feedback`. Its only Remote is `sessionFeedback/record`,
  // refused wholesale; the command's text form reached nothing that reads it.
  "command-feedback": { namespace: "sessionFeedback", noClientBundle: true },
  // The owner of `/export` and the header's download item. Neither is a method:
  // both fetch the ZIP from a kernel route whose name has no `/`, and the proxy
  // answers 400 to every `/api/` path that is not `<namespace>/<name>` (see
  // "encoded or malformed native API paths ..." and "the session-log ZIP route
  // ..." in runtimeUiPolicy.test.mjs).
  "session-log-download": { nonMethodApiRoute: "/api/session.export", noClientBundle: true },
  // `ui-trajectory` was operator-only here until 2026-09-22, with the honest
  // note that hiding it removed the affordance and not the data (the kernel
  // streams the frames over the session socket whether or not a tab draws
  // them). It is mounted for everyone now, as the product's 运行 tab.
};

const namespaces = new Set(RUNTIME_UI_DENIED_NAMESPACES);
const methods = new Set(RUNTIME_UI_DENIED_METHODS);
const hostRoutes = new Set(RUNTIME_UI_DENIED_HOST_ROUTES);

/**
 * Namespaces a hidden panel may reach without the namespace being denied, because the conversation itself lives there.
 * Deliberately short; a panel reaching anything else must have it denied or its methods named.
 */
const SHARED_NAMESPACES = Object.freeze({
  session: "the conversation's own namespace: no page can open, read or prompt a session without it",
});

const recorded = JSON.parse(await readFile(new URL("../../../packages/contracts/dsh/panel-remotes.json", import.meta.url), "utf8"));
const pins = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));
const packageOf = rowPackages(await readFile(new URL("../../../deploy/runtime-dsh/dump-config.baseline.json", import.meta.url), "utf8"));

test("the recorded panel namespaces are of the pinned kernel and of every package a hidden panel mounts", () => {
  assert.equal(recorded.pin, pins.dsh.version, "panel-remotes.json is recorded from another kernel; run packages/contracts/dsh/record-panel-remotes.mjs");
  assert.ok(Object.keys(recorded.packages).length >= 40, "the recording names almost no packages, so it walked nothing");
  for (const panel of [...HOSTED_DISABLED_BROWSER_PANELS, ...OPERATOR_ONLY_BROWSER_PANELS]) {
    const pkg = packageOf.get(panel);
    assert.ok(pkg, `${panel} is on the hidden list but is not a row of the recorded composition`);
    const stop = /** @type {any} */ (WHAT_STOPS_IT)[panel];
    assert.equal(Boolean(recorded.packages[pkg]), !stop?.noClientBundle,
      stop?.noClientBundle ? `${panel} is marked as having no client bundle, but ${pkg} has one on record: its namespaces are derived now`
        : `${panel} (${pkg}) has no client bundle on record, so what it reaches was never read`);
  }
});

test("every namespace a hidden panel's client reaches is denied, shared with the conversation, or covered by named methods", () => {
  for (const panel of [...HOSTED_DISABLED_BROWSER_PANELS, ...OPERATOR_ONLY_BROWSER_PANELS]) {
    const pkg = packageOf.get(panel);
    const entry = pkg ? recorded.packages[pkg] : undefined;
    if (!entry) continue; // named, with its reason, in the first test
    const stop = /** @type {any} */ (WHAT_STOPS_IT)[panel];
    const reached = reachedNamespaces(entry);
    for (const namespace of reached) {
      if (namespaces.has(namespace) || Object.hasOwn(SHARED_NAMESPACES, namespace)) continue;
      // The namespace is open on the proxy as a whole (a preset list is read by the page itself); what the panel
      // changes through it is the named methods, and every one of those must be denied.
      assert.ok(stop?.methods?.length, `${panel} reaches the ${namespace} namespace, which is neither denied nor shared with the conversation, and no methods are named for it`);
      assert.ok(stop.methods.some((method) => method.startsWith(`${namespace}/`)), `${panel} reaches ${namespace}, and none of its named methods is in that namespace`);
    }
    // A pairing that names a namespace the panel does not reach is the defect this test exists for.
    if (stop?.namespace) {
      assert.ok(reached.includes(stop.namespace),
        `${panel} is paired with the ${stop.namespace} namespace, but its client reaches ${reached.join(", ") || "no host namespace"}`);
    }
  }
});

test("every hidden panel has something that stops what it does, not just what it draws", () => {
  assert.ok(HOSTED_DISABLED_BROWSER_PANELS.length >= 10, "no panels were read, so this test walked nothing");
  for (const panel of [...HOSTED_DISABLED_BROWSER_PANELS, ...OPERATOR_ONLY_BROWSER_PANELS]) {
    const stop = WHAT_STOPS_IT[panel];
    assert.ok(stop, `${panel} is hidden and nothing here says what stops it being reached; hiding a panel hides a button`);
    if (stop.namespace) {
      assert.ok(namespaces.has(stop.namespace), `${panel} is paired with the ${stop.namespace} namespace, which is not denied`);
      continue;
    }
    if (stop.methods) {
      for (const method of stop.methods) {
        assert.ok(methods.has(method), `${panel} is paired with ${method}, which is not denied`);
      }
      continue;
    }
    if (stop.hostRoute) {
      assert.ok(hostRoutes.has(stop.hostRoute), `${panel} is paired with the ${stop.hostRoute} route, which is not denied`);
      continue;
    }
    if (stop.nonMethodApiRoute) {
      assert.ok(stop.nonMethodApiRoute.startsWith("/api/"), `${panel} is paired with ${stop.nonMethodApiRoute}, which is not under /api/`);
      assert.equal(runtimeUiMethodFromPath(stop.nonMethodApiRoute), null,
        `${panel} is paired with ${stop.nonMethodApiRoute}, which now reads as a method, so the proxy would forward it`);
      continue;
    }
    assert.equal(typeof stop.cosmetic, "string");
    assert.ok(stop.cosmetic.length > 40, `${panel} is called cosmetic without an argument for it`);
  }
});

test("the pairing has no entries for panels that are not hidden", () => {
  // Otherwise it accumulates reasons about panels nobody disables, and the
  // next reader cannot tell which of them are load-bearing.
  const hidden = new Set([...HOSTED_DISABLED_BROWSER_PANELS, ...OPERATOR_ONLY_BROWSER_PANELS]);
  for (const panel of Object.keys(WHAT_STOPS_IT)) {
    assert.ok(hidden.has(panel), `${panel} is paired here but is not on the disabled list`);
  }
});

test("the access-mode chip can only offer one sandbox, because nothing else can bound it", () => {
  // The chip renders every row of the hosted profile's permission table. A
  // second row is a second sandbox a browser can select by sending a prompt.
  assert.equal(typeof HOSTED_PERMISSION_PRESET, "string");
  assert.ok(HOSTED_PERMISSION_PRESET.length > 0);
});
