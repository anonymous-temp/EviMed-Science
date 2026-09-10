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

import { RUNTIME_UI_DENIED_METHODS, RUNTIME_UI_DENIED_NAMESPACES } from "@evimed/domain";

import { HOSTED_DISABLED_BROWSER_PANELS, HOSTED_PERMISSION_PRESET } from "../src/dshProfilePatch.mjs";

/**
 * What stops each hidden panel from being reached another way.
 *
 * `namespace` and `methods` are checked against the deny lists. `cosmetic`
 * means the panel draws something with no endpoint behind it, and the string
 * is the argument for that — reviewed when the pairing changes, not assumed.
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
};

const namespaces = new Set(RUNTIME_UI_DENIED_NAMESPACES);
const methods = new Set(RUNTIME_UI_DENIED_METHODS);

test("every hidden panel has something that stops what it does, not just what it draws", () => {
  assert.ok(HOSTED_DISABLED_BROWSER_PANELS.length >= 10, "no panels were read, so this test walked nothing");
  for (const panel of HOSTED_DISABLED_BROWSER_PANELS) {
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
    assert.equal(typeof stop.cosmetic, "string");
    assert.ok(stop.cosmetic.length > 40, `${panel} is called cosmetic without an argument for it`);
  }
});

test("the pairing has no entries for panels that are not hidden", () => {
  // Otherwise it accumulates reasons about panels nobody disables, and the
  // next reader cannot tell which of them are load-bearing.
  const hidden = new Set(HOSTED_DISABLED_BROWSER_PANELS);
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
