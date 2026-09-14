import http from "node:http";

/**
 * An OpenViking server, as far as the four routes this product uses are
 * concerned.
 *
 * It exists because the one thing an in-process object double cannot check is
 * the thing a command-line tool most often gets wrong: that the process builds
 * its client from the real configuration and actually reaches a server. The
 * wire shapes here are the recorded ones — `result` is a bare list on `ls`,
 * `DELETE /api/v1/fs` reads its arguments from the query string, and an error
 * arrives as `{status:"error",error:{code,message}}`.
 *
 * Files are held in one map keyed by URI; directories are whatever prefixes
 * that map implies, which is also how the real server behaves for a tree it
 * created through `write`.
 */
/**
 * @param {{apiKey?:string,refuse?:((call:{method:string,path:string,uri:string}) =>
 *   {status:number,code:string}|null)}} [options] `refuse` answers a call with an
 *   upstream error instead of serving it, which is how a failure confined to one
 *   subtree — one account's writes, one capsule — is reproduced without taking
 *   the whole index down.
 */
export async function startOpenVikingServer({ apiKey = "test-index-key", refuse = null } = {}) {
  /** @type {Map<string,string>} */
  const files = new Map();
  /** @type {{method:string,path:string,uri:string}[]} */
  const calls = [];

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };
  const failure = (res, status, code, message) =>
    send(res, status, { status: "error", error: { code, message } });

  /** Direct children of a directory, as `ls` reports them. */
  const children = (uri) => {
    const prefix = `${uri.replace(/\/+$/, "")}/`;
    /** @type {Map<string,{uri:string,isDir:boolean,size:number}>} */
    const entries = new Map();
    for (const [name, content] of files) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const cut = rest.indexOf("/");
      const child = cut === -1 ? prefix + rest : prefix + rest.slice(0, cut);
      entries.set(child, { uri: child, isDir: cut !== -1, size: cut === -1 ? content.length : 0 });
    }
    return [...entries.values()].sort((left, right) => left.uri.localeCompare(right.uri));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://index.internal");
    const uri = url.searchParams.get("uri") ?? "";
    calls.push({ method: req.method ?? "GET", path: url.pathname, uri });
    if (url.pathname === "/health") return send(res, 200, { status: "ok", version: "0.4.19" });
    if (req.headers["x-api-key"] !== apiKey) return failure(res, 401, "unauthorized", "A key is required.");

    if (url.pathname === "/api/v1/content/write" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const refusal = refuse?.({ method: "POST", path: url.pathname, uri: String(body.uri ?? "") });
        if (refusal) return failure(res, refusal.status, refusal.code, "The index refused this write.");
        files.set(String(body.uri), String(body.content ?? ""));
        return send(res, 200, { status: "ok", result: { uri: body.uri, root_uri: body.uri } });
      });
      return undefined;
    }
    if (url.pathname === "/api/v1/fs" && req.method === "DELETE") {
      const recursive = url.searchParams.get("recursive") === "true";
      const prefix = `${uri.replace(/\/+$/, "")}/`;
      const removed = [...files.keys()].filter((name) => name === uri || (recursive && name.startsWith(prefix)));
      if (removed.length === 0) return failure(res, 404, "not_found", "No such node.");
      for (const name of removed) files.delete(name);
      return send(res, 200, { status: "ok", result: { removed: removed.length } });
    }
    if (url.pathname === "/api/v1/fs/ls" && req.method === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const entries = children(uri);
      if (entries.length === 0 && offset === 0) return failure(res, 404, "not_found", "No such directory.");
      return send(res, 200, { status: "ok", result: entries.slice(offset) });
    }
    if (url.pathname === "/api/v1/search/find" && req.method === "POST") {
      return send(res, 200, { status: "ok", result: [] });
    }
    return failure(res, 404, "not_found", "Unknown route.");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    files,
    calls,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
