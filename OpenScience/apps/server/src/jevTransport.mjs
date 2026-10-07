/** Pooled HTTPS transport. The third connection failure replaces the pool. */
import https from "node:https";
import { Readable } from "node:stream";
export function createJevTransport() {
  let agent = new https.Agent({
      keepAlive: true,
      maxSockets: 8,
      maxFreeSockets: 4,
      timeout: 30000,
    }),
    failures = 0;
  const reset = () => {
    agent.destroy();
    agent = new https.Agent({
      keepAlive: true,
      maxSockets: 8,
      maxFreeSockets: 4,
      timeout: 30000,
    });
    failures = 0;
  };
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    // Recorded contract servers use loopback HTTP; remote provider traffic stays HTTPS.
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return globalThis.fetch(input, init);
    if (url.protocol !== "https:") throw Error("jev_transport_https_required");
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: init.method ?? "GET",
          headers: /** @type {any} */ (init.headers),
          agent,
          signal: init.signal,
        },
        (response) => {
          failures = 0;
          resolve(
            new Response(/** @type {any} */ (Readable.toWeb(response)), {
              status: response.statusCode ?? 502,
              headers: /** @type {any} */ (response.headers),
            }),
          );
        },
      );
      request.once("error", (error) => {
        if (!init.signal?.aborted && ++failures >= 3) reset();
        reject(error);
      });
      request.end(init.body ?? undefined);
    });
  };
  return { fetch: fetchImpl, close: () => agent.destroy() };
}
export const jevTransport = createJevTransport();
