// The kernel's RPC surface as the seam check reads it from a generated `typert.host.js`.
//
// 0.2.1-rc.1 changed the generator's output: the per-endpoint `id: '<package>#<namespace>/<method>'`
// lines are gone and one `createTypertRemoteInfo({ package, methods: { … } })` object carries the
// surface. The reader that only knew the first shape found 0 methods in all 29 host packages of the
// closure recorded at the next pin, and the check said so ("0 RPC methods declared") — it did not
// pass, but only because a floor of 40 stood behind it. Both shapes below are cut from the real files
// of `@deepseek-ai/dsh-command-feedback`: the first as 0.2.0-rc.2 shipped it, the second as recorded
// from the closure that replaced it.
import assert from "node:assert/strict";
import test from "node:test";
import { typertHostMethods } from "../wire-surface.mjs";

const OLD_SHAPE = `export const TYPERT = {
  package: '@deepseek-ai/dsh-command-feedback',
  invocations: [
    {
      id: '@deepseek-ai/dsh-command-feedback#sessionFeedback/record',
      service: 'sessionFeedback',
    },
  ],
}`;

const NEW_SHAPE = `const $remote = createTypertRemoteInfo({
  package: '@deepseek-ai/dsh-command-feedback',
  methods: {
    'sessionFeedback/record': {
      service: 'sessionFeedback',
      description: 'Record one remark on a live Session.',
      parameters: [
        {
          name: 'request',
          codec: {
            typeSymbol: '@deepseek-ai/dsh-command-feedback/types#SessionFeedbackRecordRequest',
            jsonSchema: {"type":"object","properties":{"sessionId":{"type":"string"}}},
          },
        },
      ],
      result: {
        typeSymbol: '@deepseek-ai/dsh-command-feedback/types#SessionFeedbackRecordResult',
        description: 'the recorded postcondition, or \`session-not-found\` when no live Session carries the id.',
      },
      sourceLocation: {"file":"packages/feedback/command-feedback/src/index.ts","line":102,"column":3},
    },
    'sessionFeedback/list': {
      service: 'sessionFeedback',
      description: 'A key that looks like a method inside a description: \\'image/png\\': {',
    },
  },
}, z)

export const TYPERT = {
  package: '@deepseek-ai/dsh-command-feedback',
  model: { "services": [{ "key": "after/theObject" }] },
}`;

test("the endpoint ids of the 0.2.0 generator are read", () => {
  assert.deepEqual(typertHostMethods(OLD_SHAPE), ["sessionFeedback/record"]);
});

test("the remote-info object of the 0.2.1 generator is read, its keys and nothing else", () => {
  // Not a type symbol's `#`, not a description that quotes a key, not anything after the object closes.
  assert.deepEqual(typertHostMethods(NEW_SHAPE), ["sessionFeedback/record", "sessionFeedback/list"]);
});

test("a file with neither shape declares nothing", () => {
  assert.deepEqual(typertHostMethods("export const TYPERT = { package: 'x', invocations: [] }"), []);
});
