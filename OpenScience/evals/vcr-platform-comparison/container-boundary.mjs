import { isIPv4 } from 'node:net';

const closedCorpusRoutes = new Set(['/internal/sources/v1/fetch', '/internal/search/v1/query']);
const runtimeGateways = new Set([
  '/internal/model/v1/chat/completions', '/internal/model/v1/messages', '/internal/model/v1/files',
  '/internal/vcr/v1/read', '/internal/vcr/v1/write', '/internal/vcr/v1/simulate', '/internal/vcr/v1/digitize',
  '/internal/revisions/v1/authorize',
]);
const runtimePrefixes = ['/internal/results/v1/', '/internal/memory/v1/', '/internal/capsules/v1/', '/internal/semantics/v1/'];
const ipv4 = value => value.split('.').reduce((number, part) => (number << 8) | Number(part), 0);
export const closedCorpusCode = 'benchmark_closed_corpus';

export function closedCorpusFetch(upstream = globalThis.fetch, onBlocked = () => {}) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.origin !== 'https://api.deepseek.com' || url.pathname !== '/chat/completions' || method !== 'POST'
        || url.username || url.password || url.search || url.hash) {
      onBlocked();
      return Response.json({ code: closedCorpusCode }, { status: 403 });
    }
    return upstream(input, { ...init, redirect: 'error' });
  };
}

export function runtimeSocketFence(cidr) {
  const [base, prefix, ...rest] = String(cidr).split('/');
  const size = Number(prefix);
  if (!isIPv4(base) || !/^\d+$/.test(prefix ?? '') || !Number.isInteger(size) || size < 1 || size > 32 || rest.length) {
    throw new Error('Invalid runtime network IPv4 subnet');
  }
  const mask = -1 << (32 - size);
  const subnet = ipv4(base) & mask;
  const onRuntimeNetwork = raw => {
    const address = String(raw ?? '').replace(/^::ffff:/, '');
    return isIPv4(address) && (ipv4(address) & mask) === subnet;
  };
  // Checking both addresses also fences the internal listener interface even
  // if a packet traverses a forwarder before the socket sees it.
  return socket => onRuntimeNetwork(socket.remoteAddress) || onRuntimeNetwork(socket.localAddress);
}

export function installClosedCorpusFence(server, { onRuntimeNetwork, instance, ui = false }) {
  const requests = server.listeners('request');
  if (requests.length !== 1) throw new Error('Unexpected benchmark HTTP listener composition');
  const [handle] = requests;
  server.removeListener('request', handle);
  server.on('request', function (req, res) {
    res.setHeader('x-evimed-benchmark-instance', instance);
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'http://benchmark.invalid').pathname; }
    catch { res.writeHead(400, { connection: 'close' }).end(); return; }
    const allowedGateway = runtimeGateways.has(pathname) || runtimePrefixes.some(prefix => pathname.startsWith(prefix));
    const refusal = closedCorpusRoutes.has(pathname) ? closedCorpusCode
      : onRuntimeNetwork(req.socket) && (ui || !allowedGateway) ? 'benchmark_runtime_route_forbidden' : null;
    if (!refusal) return handle.call(this, req, res);
    res.writeHead(403, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ code: refusal, message: 'The benchmark limits runtime access to its frozen collection and authorized gateways.' }));
  });
  const upgrades = server.listeners('upgrade');
  for (const listener of upgrades) server.removeListener('upgrade', listener);
  if (upgrades.length) server.on('upgrade', function (req, socket, head) {
    if (onRuntimeNetwork(req.socket)) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    for (const listener of upgrades) listener.call(this, req, socket, head);
  });
}
