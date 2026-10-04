/**
 * What a driver does when the product itself would wait.
 *
 * For the seconds after a release in which a project's runtime settings are
 * being applied, a start or a prompt can be refused with 423
 * `plugin_apply_in_progress` (`PluginService.withAdmission`). The control plane
 * waits for the apply itself before it refuses, and the web shell opens the
 * conversation again by itself and says 「正在准备运行环境」; a script that calls
 * the same routes must not be the one client that fails on it. On 2026-10-04 the
 * smoke, the stream acceptance, the hosted end-to-end, the revision acceptance
 * and the 虚拟临研 acceptance each failed their first call after a release.
 *
 * One helper, one bounded retry: the refusals listed here and no other, never a
 * body-less 423 (a 423 that is a hold the product does not lift by waiting, such
 * as `runtime_reserved_for_autopilot`, is the answer, not a reason to wait), and
 * the last refusal is returned unchanged once the wait is spent, so the driver
 * fails with the code the product gave.
 *
 * Only calls the control plane refused before it did anything are retried: the
 * admission takes its lock before the operation runs, so the refused call had no
 * effect and sending it again is not a duplicate.
 *
 * @module transient-refusal
 */

/** The refusals that clear by themselves, by code, with the status they carry. */
export const TRANSIENT_REFUSALS = Object.freeze({ plugin_apply_in_progress: 423 });

/** How long a driver waits in all, and how it spaces its asks. Longer than the
 *  control plane's own wait (20 s) so a driver outlasts one apply that began
 *  just before its call. */
export const TRANSIENT_WAIT_MS = 45_000;
export const TRANSIENT_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000]);

/**
 * The transient refusal an answer is, or null.
 * @param {number} status @param {unknown} body the parsed JSON body, when it parsed
 * @returns {string | null} the code
 */
export function transientRefusalCode(status, body) {
  const record = body && typeof body === "object" ? /** @type {any} */ (body) : null;
  const code = record?.code ?? record?.data?.code ?? record?.error?.code;
  return typeof code === "string" && TRANSIENT_REFUSALS[/** @type {keyof typeof TRANSIENT_REFUSALS} */ (code)] === status ? code : null;
}

/**
 * Read the code off a response of either client a driver uses: `fetch`'s
 * (`status` is a number, the body is read from a clone so the caller still can)
 * or Playwright's (`status()` is a function, `json()` can be read again).
 * @param {any} response @returns {Promise<string | null>}
 */
export async function refusalCodeOf(response) {
  const status = typeof response?.status === "function" ? response.status() : response?.status;
  if (!Object.values(TRANSIENT_REFUSALS).includes(status)) return null;
  try {
    const body = typeof response.clone === "function" ? await response.clone().json() : await response.json();
    return transientRefusalCode(status, body);
  } catch {
    return null;
  }
}

/**
 * Send, and send again while the answer is a refusal that clears.
 * @template T
 * @param {() => Promise<T>} send one attempt; called again after a transient refusal
 * @param {{ classify?: (answer: T) => Promise<string | null> | string | null, waitMs?: number,
 *   delaysMs?: readonly number[], sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   discard?: (answer: T) => Promise<void> | void }} [options]
 * @returns {Promise<T>} the first answer that is not a transient refusal, or the last one once the wait is spent
 */
export async function sendThroughApply(send, {
  classify = refusalCodeOf, waitMs = TRANSIENT_WAIT_MS, delaysMs = TRANSIENT_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, discard = releaseAnswer,
} = {}) {
  const deadline = now() + waitMs;
  for (let asked = 0; ; asked++) {
    const answer = await send();
    if (!(await classify(answer))) return answer;
    const remaining = deadline - now();
    if (remaining <= 0) return answer;
    await Promise.resolve(discard(answer)).catch(() => {});
    await sleep(Math.min(remaining, delaysMs[Math.min(asked, delaysMs.length - 1)] ?? 0));
  }
}

/** Let go of an answer that will not be read: a `fetch` body or a Playwright response. @param {any} answer */
async function releaseAnswer(answer) {
  if (typeof answer?.dispose === "function") await answer.dispose();
  else await answer?.body?.cancel?.();
}

/**
 * `fetch`, patient with the refusals that clear. The same arguments and the same
 * `Response`; the body of a refused answer that is asked again is dropped.
 * @param {string | URL} url @param {RequestInit} [init]
 * @param {Parameters<typeof sendThroughApply>[1] & { fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Response>}
 */
export function patientFetch(url, init, { fetchImpl = globalThis.fetch, ...options } = {}) {
  return sendThroughApply(() => fetchImpl(url, init), options);
}
