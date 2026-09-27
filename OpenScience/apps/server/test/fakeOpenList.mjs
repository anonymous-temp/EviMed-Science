import { createServer } from "node:http";

/**
 * An OpenList double that answers `fs/list` the way the pinned image does.
 *
 * Recorded from `openlistteam/openlist:v4.2.6` (the pin's digest) on 2026-09-27,
 * with an admin token and a Local storage mounted and unmounted:
 *   - every refusal is HTTP 200 with a JSON `code`; the HTTP status says nothing
 *   - no storage covers the path: `{"code":500,"message":"failed get storage:
 *     storage not found; rawPath: /tenants","data":null}` (`please add a storage
 *     first` in place of the raw path when the path is `/`)
 *   - a token it does not accept: `{"code":401,"message":"token is invalidated"}`
 *   - a mount's parent lists its mount points as virtual directories, and
 *     `total` counts all of them whatever `per_page` asked for
 *   - a path inside a mount that does not exist: `code: 500`, "failed get objs:
 *     … object not found"
 *   - `/ping` answers `pong` whatever is mounted and with no credential, which is
 *     why readiness stopped asking it
 *
 * `mounts` maps a mount path to the file names under it. Requests off the
 * contract paths are answered 404 and not recorded: node --test runs files in
 * parallel and the dev box's port scanner probes listening sockets, so a stray
 * GET must not read as a call this client made.
 * @param {import("node:test").TestContext} t
 * @param {{ token?: string, mounts?: Record<string, string[]> }} options
 */
export async function startFakeOpenList(t, { token = "test-only-openlist-token", mounts = {} } = {}) {
  /** @type {Record<string, string[]>} */
  const state = { ...mounts };
  /** @type {{ path: string, page: number, perPage: number, authorization: string | undefined }[]} */
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = String(req.url ?? "");
    if (url === "/ping" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
      return;
    }
    if (url !== "/api/fs/list" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const target = String(payload.path ?? "/");
    const page = Number(payload.page ?? 1);
    const perPage = Number(payload.per_page ?? 100);
    requests.push({ path: target, page, perPage, authorization: req.headers.authorization });
    const reply = (/** @type {any} */ value) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== token) return reply({ code: 401, message: "token is invalidated", data: null });
    const mount = Object.keys(state).find((root) => target === root || target.startsWith(`${root}/`));
    let content;
    if (mount) {
      if (target !== mount) return reply({ code: 500, message: "failed get objs: failed get dir: failed to get obj: object not found", data: null });
      content = state[mount].map((name) => ({ name, size: 6, is_dir: false, modified: "2026-09-27T01:01:24.665187869Z",
        type: 4, hashinfo: "null", hash_info: { sha256: "a".repeat(64) } }));
    } else {
      const prefix = target === "/" ? "/" : `${target}/`;
      const children = [...new Set(Object.keys(state).filter((root) => root.startsWith(prefix))
        .map((root) => root.slice(prefix.length).split("/")[0]))];
      if (children.length === 0) {
        return reply({ code: 500, data: null, message: target === "/"
          ? "failed get storage: storage not found; please add a storage first"
          : `failed get storage: storage not found; rawPath: ${target}` });
      }
      content = children.map((name) => ({ name, size: 0, is_dir: true, modified: "2026-09-27T01:01:24.673093681Z",
        type: 1, hashinfo: "null", hash_info: null }));
    }
    reply({ code: 200, message: "success", data: {
      content: content.slice((page - 1) * perPage, page * perPage), total: content.length,
      readme: "", header: "", write: true, provider: "unknown",
    } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    /** @param {string} root @param {string[]} files */
    mount(root, files) { state[root] = files; },
  };
}
