import { randomUUID } from 'node:crypto';

/** Deliver the GoalBar's actual user intent to a busy model without waking an idle one.
 * A stopped goal alone gives the model no explanation of who stopped it.
 *
 * The note carries a producer-owned source kind, as every message the platform
 * writes does (`pluginSource` in index.mjs): the kernel's chat renders a
 * `user` kind as the researcher's own bubble and queues it as their steering,
 * and every reader that asks what the researcher said (memory extraction, the
 * run ledger's first question) selects `kind === 'user'`. The researcher
 * pressed Pause; they did not type this sentence.
 * @param {any} agent @returns {boolean} Whether the current turn received the context.
 */
export function explainLoopxPause(agent) {
  if (agent?.status !== 'running') return false;
  try {
    const id = randomUUID();
    agent.inject({ id, role: 'user', source: { kind: 'plugin:evimed-loopx-pause' },
      content: [{ type: 'text', text: 'The user just pressed Pause in the goal bar. Keep the goal paused and finish this turn after the current checkpoint. This is an intentional user action; no diagnosis or repair of the stopped state is needed. A later explicit Start or user request may resume it.' }],
    });
    return true;
  } catch {
    // The goal is already paused; a turn closing concurrently must not undo it.
    return false;
  }
}
