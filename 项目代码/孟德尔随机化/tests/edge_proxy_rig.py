"""A local stand-in for the Tokyo edge node, for the engine's EBI egress.

The real node (squid on 443 with a Let's Encrypt IP certificate, basic
credentials, the Beijing host as its only client) cannot be reached from a
development box, so the proxied path is proven against this rig: a throwaway CA
signs the proxy's certificate (SAN IP 127.0.0.1, like the node's IP
certificate) and one for EBI's two host names; the proxy maps those names to a
local HTTPS server holding the catalogue's files. A request for
``https://ftp.ebi.ac.uk/...`` then travels engine -> TLS to the proxy -> CONNECT
-> TLS to "EBI" inside the tunnel, the shape of production. The servers run on
an asyncio loop in a background thread because the engine's HTTP layer is
synchronous. Nothing here is a secret.
"""

from __future__ import annotations

import asyncio
import base64
import ssl
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path

EBI_HOSTS = ("www.ebi.ac.uk", "ftp.ebi.ac.uk")


def make_certificates(directory: Path) -> dict[str, Path]:
    """A CA, a proxy certificate for IP 127.0.0.1 and one certificate for both EBI names."""
    def run(*args: str) -> None:
        subprocess.run(args, check=True, capture_output=True)

    key = ("-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes")
    run("openssl", "req", "-x509", *key, "-days", "2", "-subj", "/CN=mr-edge-rig-test-ca",
        "-keyout", str(directory / "ca.key"), "-out", str(directory / "ca.pem"))
    for name, san in (("proxy", "IP:127.0.0.1"), ("ebi", ",".join(f"DNS:{host}" for host in EBI_HOSTS))):
        run("openssl", "req", *key, "-subj", f"/CN={name}", "-keyout", str(directory / f"{name}.key"),
            "-out", str(directory / f"{name}.csr"))
        (directory / f"{name}.ext").write_text(f"subjectAltName={san}\n")
        run("openssl", "x509", "-req", "-in", str(directory / f"{name}.csr"), "-CA", str(directory / "ca.pem"),
            "-CAkey", str(directory / "ca.key"), "-CAcreateserial", "-days", "2",
            "-extfile", str(directory / f"{name}.ext"), "-out", str(directory / f"{name}.pem"))
    return {"ca": directory / "ca.pem", "proxy_cert": directory / "proxy.pem", "proxy_key": directory / "proxy.key",
            "ebi_cert": directory / "ebi.pem", "ebi_key": directory / "ebi.key"}


def server_context(cert: Path, key: Path) -> ssl.SSLContext:
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(str(cert), str(key))
    return context


async def _head(reader: asyncio.StreamReader) -> tuple[str, dict[str, str]] | None:
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError, ssl.SSLError):
        return None
    lines = raw.decode("latin-1").split("\r\n")
    headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
    return lines[0], headers


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, ssl.SSLError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except RuntimeError:
            pass


@dataclass
class Seen:
    method: str
    target: str
    authorized: bool
    headers: dict[str, str]


@dataclass
class ConnectProxy:
    """TLS on the listening side, Basic credentials, CONNECT to mapped hosts only (squid's shape)."""

    context: ssl.SSLContext
    credentials: str
    routes: dict[str, tuple[str, int]]
    #: When set, every authorized CONNECT is answered with this status (a node that cannot reach EBI).
    answer_status: int | None = None
    seen: list[Seen] = field(default_factory=list)
    server: asyncio.base_events.Server | None = None
    port: int = 0

    async def start(self) -> "ConnectProxy":
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0, ssl=self.context)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def close(self) -> None:
        if self.server:
            self.server.close()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await _head(reader)
        if head is None:
            writer.close()
            return
        line, headers = head
        method, target = (line.split(" ") + ["", ""])[:2]
        expected = "Basic " + base64.b64encode(self.credentials.encode()).decode()
        authorized = headers.get("proxy-authorization") == expected
        self.seen.append(Seen(method, target, authorized, headers))
        host = target.rpartition(":")[0]
        if not authorized:
            status = b"407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"rig\""
        elif method != "CONNECT":
            status = b"400 Bad Request"
        elif self.answer_status is not None:
            status = f"{self.answer_status} Rig".encode()
        elif host not in self.routes:
            status = b"403 Forbidden"
        else:
            up_reader, up_writer = await asyncio.open_connection(*self.routes[host])
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer), return_exceptions=True)
            return
        writer.write(b"HTTP/1.1 " + status + b"\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()


@dataclass(frozen=True)
class Redirect:
    location: str


@dataclass
class Origin:
    """HTTPS for both EBI names: a file by its full URL, byte ranges, 404 for anything else."""

    context: ssl.SSLContext
    files: dict[str, bytes | Redirect] = field(default_factory=dict)
    requests: list[dict] = field(default_factory=list)
    #: Answer more than one request per connection unless the client says ``Connection: close``.
    keep_alive: bool = False
    #: With ``keep_alive``: promise the connection, then close it anyway (an idle timeout on EBI's side).
    drop_kept: bool = False
    server: asyncio.base_events.Server | None = None
    port: int = 0

    async def start(self) -> "Origin":
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0, ssl=self.context)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def close(self) -> None:
        if self.server:
            self.server.close()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            head = await _head(reader)
            if head is None:
                break
            line, headers = head
            path = line.split(" ")[1]
            url = f"https://{headers.get('host', '')}{path}"
            self.requests.append({"url": url, "line": line, "headers": headers})
            body = self.files.get(url)
            extra = b""
            if isinstance(body, Redirect):
                status, content, extra = b"302 Found", b"", f"Location: {body.location}\r\n".encode()
            elif body is None:
                status, content = b"404 Not Found", b"no such file"
            elif headers.get("range", "").startswith("bytes="):
                first, _, last = headers["range"].removeprefix("bytes=").partition("-")
                content = body[int(first):int(last) + 1]
                status = b"206 Partial Content"
                extra = f"Content-Range: bytes {first}-{int(first) + len(content) - 1}/{len(body)}\r\n".encode()
            else:
                status, content = b"200 OK", body
            keep = self.keep_alive and headers.get("connection", "").lower() != "close"
            writer.write(b"HTTP/1.1 " + status + b"\r\n" + extra + f"Content-Length: {len(content)}\r\n".encode()
                         + (b"" if keep else b"Connection: close\r\n") + b"\r\n" + content)
            try:
                await writer.drain()
            except ConnectionError:
                break
            if not keep or self.drop_kept:
                break
        writer.close()


class Rig:
    """The proxy and the origin on a background loop; ``trust`` is the client's view of the CA."""

    def __init__(self, directory: Path, credentials: str):
        certs = make_certificates(directory)
        self.trust = ssl.create_default_context(cafile=str(certs["ca"]))
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()
        self.origin = self._run(Origin(server_context(certs["ebi_cert"], certs["ebi_key"])).start())
        routes = {host: ("127.0.0.1", self.origin.port) for host in EBI_HOSTS}
        self.proxy = self._run(
            ConnectProxy(server_context(certs["proxy_cert"], certs["proxy_key"]), credentials, routes).start()
        )

    def _run(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result(15)

    def close(self) -> None:
        self._run(self.proxy.close())
        self._run(self.origin.close())
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(5)
