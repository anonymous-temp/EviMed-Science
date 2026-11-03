/** Retry transport loss only when the caller can repeat the exact operation safely. */
export async function fetchWithRetry(url, options = {}, { fetchImpl = fetch, timeoutMs = 30_000, retryable = options.method == null || options.method === 'GET', onRetry = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) {
      if (!retryable || attempt >= 2 || !['TypeError', 'AbortError', 'TimeoutError'].includes(error.name)) throw error;
      onRetry({ attempt: attempt + 1, code: error.cause?.code ?? error.name });
      await pause(250 * (attempt + 1));
    }
  }
}
