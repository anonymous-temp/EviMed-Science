"""A local stand-in for the Tokyo node: a TLS forward proxy that speaks CONNECT with Basic auth.

The real node (squid on 443, an IP certificate, the Beijing host as its only client) cannot be
reached from a development box, so the relay code path is proven against this rig: a throwaway CA
signs the proxy's certificate (SAN IP 127.0.0.1, like the node's IP certificate) and a target's
certificate (SAN DNS ``target.test``); the proxy maps test host names to local ports, so a request
for ``https://target.test/`` travels plugin → TLS to the proxy → CONNECT tunnel → TLS to the
target, end to end, exactly the shape of production. Nothing here is a secret.
"""

from __future__ import annotations

import asyncio
import base64
import ssl
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


def make_certificates(directory: Path) -> dict[str, Path]:
    """A CA, a proxy certificate for IP 127.0.0.1 and a target certificate for target.test."""
    d = directory
    run = lambda *args: subprocess.run(args, check=True, capture_output=True)  # noqa: E731
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=relay-rig-test-ca",
        "-keyout", str(d / "ca.key"), "-out", str(d / "ca.pem"))
    for name, san in (("proxy", "IP:127.0.0.1"), ("target", "DNS:target.test")):
        run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN={name}", "-keyout", str(d / f"{name}.key"),
            "-out", str(d / f"{name}.csr"))
        (d / f"{name}.ext").write_text(f"subjectAltName={san}\n")
        run("openssl", "x509", "-req", "-in", str(d / f"{name}.csr"), "-CA", str(d / "ca.pem"), "-CAkey", str(d / "ca.key"),
            "-CAcreateserial", "-days", "2", "-extfile", str(d / f"{name}.ext"), "-out", str(d / f"{name}.pem"))
    return {"ca": d / "ca.pem", "proxy_cert": d / "proxy.pem", "proxy_key": d / "proxy.key",
            "target_cert": d / "target.pem", "target_key": d / "target.key"}


def server_context(cert: Path, key: Path) -> ssl.SSLContext:
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(str(cert), str(key))
    return context


@dataclass
class Seen:
    method: str
    target: str
    authorized: bool


@dataclass
class ConnectProxy:
    """TLS on the listening side; CONNECT tunnels to mapped hosts; absolute-form HTTP forwarded."""

    context: ssl.SSLContext
    credentials: str
    routes: dict[str, tuple[str, int]]
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
            await self.server.wait_closed()

    def _authorized(self, headers: dict[str, str]) -> bool:
        expected = "Basic " + base64.b64encode(self.credentials.encode()).decode()
        return headers.get("proxy-authorization") == expected

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            writer.close()
            return
        lines = head.decode("latin1").split("\r\n")
        method, target, _ = (lines[0].split(" ") + ["", "", ""])[:3]
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
        authorized = self._authorized(headers)
        self.seen.append(Seen(method, target, authorized))
        if not authorized:
            writer.write(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"rig\"\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            route = self.routes.get(host)
            if route is None:
                writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                writer.close()
                return
            up_reader, up_writer = await asyncio.open_connection(*route)
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer), return_exceptions=True)
            return
        writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except RuntimeError:
            pass


@dataclass
class Target:
    """A TLS HTTP/1.1 server answering every request with a fixed body and the Host it was asked for."""

    context: ssl.SSLContext
    body: bytes = b"<rss><channel><item><title>through the relay</title></item></channel></rss>"
    requests: list[dict] = field(default_factory=list)
    server: asyncio.base_events.Server | None = None
    port: int = 0

    async def start(self) -> "Target":
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0, ssl=self.context)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def close(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            writer.close()
            return
        lines = head.decode("latin1").split("\r\n")
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
        self.requests.append({"line": lines[0], "headers": headers})
        body = self.body
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nETag: \"rig-1\"\r\n"
                     + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
