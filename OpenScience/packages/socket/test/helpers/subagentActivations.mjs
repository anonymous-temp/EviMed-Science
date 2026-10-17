/**
 * The kernel's `ctx.subagents` from 0.2.1, over a test's one-shot `start(provider, options)` double.
 *
 * 0.2.1 replaced `start` with `startActivation({ provider, label, childId, delivery, signal, request })` and took the
 * child's tool mask and persona out of the request (the port installs them at the child's creation, keyed by the id it
 * reserved). The doubles here were written against the old call and assert on what a child is handed, so this hands them
 * the same options — the request's fields plus the composition the port reserved for that id — and turns the run they
 * return into an activation receipt.
 */
import { reservedChildComposition } from '@evimed/harness-port'

/**
 * @param {(provider: any, options: any) => any} start
 * @returns {{ startActivation: (spec: any) => Promise<any> }}
 */
export function activationsOver(start) {
  return {
    startActivation: async (spec) => {
      const composition = reservedChildComposition(spec.childId) ?? { toolFilter: {} }
      const run = await start(spec.provider, {
        label: spec.label,
        prompt: spec.request.prompt,
        parent: spec.request.parent,
        signal: spec.signal,
        outputSchema: spec.request.outputSchema,
        ...(spec.request.maxDepth === undefined ? {} : { maxDepth: spec.request.maxDepth }),
        toolFilter: composition.toolFilter,
        persona: composition.persona,
      })
      return {
        childId: run?.id ?? spec.childId,
        messageId: 'message-1',
        result: run?.result,
        dispose: typeof run?.dispose === 'function' ? () => run.dispose() : async () => {},
      }
    },
  }
}
