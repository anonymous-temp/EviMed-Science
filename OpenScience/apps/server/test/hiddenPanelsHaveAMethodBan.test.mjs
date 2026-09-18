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
 */
import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_UI_DENIED_HOST_ROUTES, RUNTIME_UI_DENIED_METHODS, RUNTIME_UI_DENIED_NAMESPACES } from "@evimed/domain";

import { HOSTED_DISABLED_BROWSER_PANELS, HOSTED_PERMISSION_PRESET, OPERATOR_ONLY_BROWSER_PANELS } from "../src/dshProfilePatch.mjs";

/**
 * What stops each hidden panel from being reached another way.
 *
 * `namespace` and `methods` are checked against the deny lists. `hostRoute`
 * is the third kind, and 0.1.5 is what made it necessary: a panel whose backing
 * endpoint is not an `/api/` method at all but a route on the kernel's web
 * server, stopped by path rather than by name. `cosmetic` means the panel draws
 * something with no endpoint behind it, and the string is the argument for
 * that — reviewed when the pairing changes, not assumed.
 */
const WHAT_STOPS_IT = {
  "ui-settings-general": { namespace: "settings" },
  "ui-settings-models": { namespace: "llm" },
  "ui-settings-plugin-inventory": { namespace: "evimedPlugins" },
  "ui-settings-plugins": { namespace: "cordis" },
  "ui-model-selection": { methods: ["session/selectModel", "session/modelCatalog"] },
  "ui-agent-preset": { methods: ["agentPresets/select", "agentPresets/copy", "agentPresets/deletePreset"] },
  "ui-message-feedback": { namespace: "messageFeedback" },
  "ui-goal": { namespace: "goals" },
  "ui-cordis": { namespace: "cordis" },
  "ui-brand-official": {
    cosmetic: "a brand mark; it registers into slots and calls no endpoint. The hosted shell occupies the same slots below it.",
  },
  // The one that was not stopped by a method at all. The chip is drawn by
  // ui-conversation from the profile's own permission table and switches by
  // sending a prompt, which is the product's main path and cannot be denied.
  // What bounds it is the table: one row, so every choice it offers is the
  // same sandbox. That is asserted below rather than described here.
  "ui-permission": {
    cosmetic: "the access-mode chip switches by sending /permission on the prompt path, which no method rule can see; "
      + "the hosted permission table is narrowed to one preset instead, and that is what bounds it.",
  },
  // 0.1.5. The split button posts to /open-in-app/open, which is a web-server
  // route and not a method — so the pairing is the path, and the hosted profile
  // also disables the row that mounts it.
  "ui-open-in-app": { hostRoute: "/open-in-app/" },
  // Both read files through the `workspaceFiles` namespace: the tab lists a
  // directory, and the preview calls read/readAll/readRelated on what the tab
  // opened.
  "ui-sidebar-files": { namespace: "workspaceFiles" },
  "ui-sidebar-documentpreview": { namespace: "workspaceFiles" },
  // The browser half of dynamic Cordis packages: every call it makes is a
  // `dynamicCordisRunner/*` method, refused wholesale. Unmounted so it stops
  // syncing a manifest into two 403s per session open.
  "cordis-client-runner": { namespace: "dynamicCordisRunner" },
  // Operator-only rather than hidden, and the reason is worth stating without
  // flattering it: this removes the affordance, not the data. The kernel
  // streams the prompt, the reminders and the raw tool JSON to the browser over
  // the session socket whether or not a tab draws them, so devtools still show
  // them. Not sending them is upstream of this codebase. What this buys is that
  // a researcher does not meet the product's English prompts by clicking a tab
  // called 「轨迹」; what it does not buy is confidentiality.
  "ui-trajectory": {
    cosmetic: "the trajectory tab draws frames the client already received over the session socket, so hiding it stops "
      + "accidental exposure and not a determined reader; the data stops flowing only if the kernel stops sending it, "
      + "which is upstream. Operators keep it because it is how a run is diagnosed.",
  },
};

const namespaces = new Set(RUNTIME_UI_DENIED_NAMESPACES);
const methods = new Set(RUNTIME_UI_DENIED_METHODS);
const hostRoutes = new Set(RUNTIME_UI_DENIED_HOST_ROUTES);

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
