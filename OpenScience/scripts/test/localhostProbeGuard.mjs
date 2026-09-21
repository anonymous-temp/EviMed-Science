/**
 * Loaded before every node test file in the repository (`--import` in each
 * package's test script; `apps/server/test/localhostProbeGuard.test.mjs` holds
 * them to it).
 *
 * Hidden knowledge: a test's fake server is not alone on its port. On
 * 2026-09-21 the suite failed about one full run in three — a fake kernel
 * counting five requests where it expected four, a fake DeepSeek parsing an
 * empty body — and every failing file passed on its own. A preload that logged
 * both ends of every loopback connection found the extra requests came from
 * no test at all: the development machine's own tooling (t3code's preview
 * `PortScanner`) lists every listening TCP port with `lsof` every three
 * seconds and sends each new one `GET /` to see whether it is a dev server
 * worth previewing. VS Code-style tools do the same. A fixture that counts
 * what reaches it, or parses every body, then fails on a request its test never
 * made — nondeterministically, because it depends on whether the scan landed
 * inside the test's few hundred milliseconds.
 *
 * Those probes address the port as `localhost` — the scanner builds
 * `http://localhost:<port>` — and no test here ever does: every fixture URL is
 * `127.0.0.1` (`listen(0, "127.0.0.1")`). So a `GET /` whose Host is
 * `localhost` is answered 404 here and never reaches the fixture. Narrow on
 * purpose: nothing else is filtered, and a test that genuinely needs to call a
 * fixture as `localhost` must use a path other than `/`.
 */
import http from "node:http";

const LOCALHOST_HOST = /^localhost(?::\d+)?$/i;

/** @param {http.IncomingMessage} request */
export function isLocalhostProbe(request) {
  return request.method === "GET" && request.url === "/" && LOCALHOST_HOST.test(String(request.headers.host ?? ""));
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function guardedEmit(event, ...args) {
  if (event === "request" && isLocalhostProbe(args[0])) {
    const response = /** @type {http.ServerResponse} */ (args[1]);
    response.writeHead(404, { connection: "close", "content-length": "0" });
    response.end();
    return true;
  }
  return emit.call(this, event, ...args);
};
