/**
 * A request that carries the runtime's workload token, asked once more when the
 * token it carried was superseded in flight.
 *
 * Hidden knowledge: the control plane accepts only the token currently in the
 * runtime's token file — a valid, signed, unexpired token is refused the moment
 * the file is rewritten — and rewrites it every half lifetime (150 s). A
 * presenter reads the file, sends, and the answer is decided a moment later
 * against the file as it is then, so a request that straddles a rewrite is
 * refused with 401 `evimed_workload_token_invalid` although the token it carried
 * was good when it left. The review poller asks every three seconds for up to
 * sixteen minutes and ended its whole review on the first such answer (「审查没有完成
 * （evimed_workload_token_invalid）」); 53 refusals in the week from 2026-09-28.
 *
 * The control plane's rule is unchanged — authentication is exactly as strict as
 * it was. The presenter asks again with what the file holds now, once, and only
 * when the file does hold another token: a refusal of the token the file still
 * holds is a real one and is returned as it came.
 *
 * Deletable when the control plane accepts the token it replaced for the rest of
 * its own lifetime, as the AgentBay provider already does.
 *
 * @module workloadRequest
 */

/** The code the control plane refuses a workload token with. */
export const WORKLOAD_TOKEN_REFUSAL = 'evimed_workload_token_invalid'

/**
 * Whether a response is the control plane refusing the workload token as
 * invalid. Reads a clone, so the caller can still read the body.
 * @param {any} response
 * @returns {Promise<boolean>}
 */
export async function refusedWorkloadToken(response) {
  if (response?.status !== 401) return false
  try {
    const body = await (typeof response.clone === 'function' ? response.clone() : response).json()
    return (body?.code ?? body?.error?.code ?? body?.data?.code) === WORKLOAD_TOKEN_REFUSAL
  } catch {
    return false
  }
}

/**
 * Send with the token read a moment ago; if the control plane refuses it as
 * invalid and the file now holds a different token, send once more with that.
 * @template T
 * @param {{ token: string, readToken: () => Promise<string | null | undefined>, send: (token: string) => Promise<T> }} request
 *   `send` is called with a token, and may be called a second time with another
 * @returns {Promise<T>}
 */
export async function sendWithFreshWorkloadToken({ token, readToken, send }) {
  const response = await send(token)
  if (!(await refusedWorkloadToken(response))) return response
  const fresh = String((await readToken()) ?? '').trim()
  if (!fresh || fresh === token) return response
  await /** @type {any} */ (response)?.body?.cancel?.().catch(() => {})
  return send(fresh)
}
