# [IN] GWAS Catalog REST API v2 + harmonised summary-statistics files on EBI FTP
# [OUT] instrument/outcome rows and their provenance for the local MR path
# [POS] mr_agent/tools/open_sumstats.py - token-free open GWAS data
"""Two-sample MR inputs from open GWAS Catalog summary statistics, without OpenGWAS.

OpenGWAS has required a 14-day JWT since 1 May 2024 and only an account owner
can issue one, so a deployment without a fresh token could not run a single
remote MR analysis. The NHGRI-EBI GWAS Catalog publishes full summary
statistics openly (terms: per-study licence, usually CC0/CC BY): study metadata
through its REST API v2, and harmonised files (GRCh38, alleles aligned) on its
FTP site. This module turns two catalogue studies into the two standard CSVs
the engine's existing local path already analyses, and records exactly what it
read so the report can name its sources.

Two ways to read a study's file, chosen by what the catalogue publishes:

* a bgzip file with a tabix index (every study harmonised since 2023): single
  variants are read with HTTP Range requests (about 70 KB each), so a 1.3 GB
  file is never downloaded;
* any other harmonised file: read once and filtered as it is parsed, keeping
  only the rows asked for; a byte ceiling bounds it. When the server states the
  file's size and serves byte ranges, the file is fetched as parallel ranges
  into a spool file first (``read_whole_file``); otherwise it is streamed.

Instrument selection for the exposure: every variant at p < 5e-8 (a genome scan
of a streamed file; for a tabix file, the study's curated lead associations in
the catalogue re-read from the file), then clumped — by PLINK against a local
LD reference when one is configured, otherwise by distance, keeping the most
significant variant per window. Which one ran is recorded; nothing here claims
LD independence it did not check.

No statistics are computed here beyond reading and filtering what the files
say. Identifiers come only from the catalogue: a study the catalogue does not
return, or a file it does not list, is an error, never a guess.

EBI can be read through the platform's edge proxy (``EVIMED_MR_OPEN_PROXY_URL``
and ``EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE``, see ``_Egress``); the source
record says which way every request went.
"""

from __future__ import annotations

import base64
import bisect
import contextlib
import csv
import errno
import gzip
import hashlib
import io
import json
import logging
import math
import os
import re
import shutil
import socket
import ssl
import stat
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from http import client as http_client
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

import yaml

try:
    import fcntl
except ImportError:  # not POSIX: files are streamed, never spooled (see _Spool)
    fcntl = None  # type: ignore[assignment]

CATALOG_API = os.getenv("EVIMED_GWAS_CATALOG_API", "https://www.ebi.ac.uk/gwas/rest/api/v2").rstrip("/")
FTP_ROOT = os.getenv(
    "EVIMED_GWAS_CATALOG_FTP", "https://ftp.ebi.ac.uk/pub/databases/gwas/summary_statistics"
).rstrip("/")
USER_AGENT = "EviMed-MR/1.0 (+https://www.ebi.ac.uk/gwas/docs/methods/summary-statistics; open summary statistics)"
GENOME_WIDE_P = 5e-8
#: Clumping window when no LD reference is configured, and the window PLINK
#: clumps within when one is (TwoSampleMR's default clump_kb).
CLUMP_WINDOW_KB = 10_000
CLUMP_R2 = 0.001
_ACCESSION = re.compile(r"^GCST\d{6,9}$")
_PUBMED = re.compile(r"^\d{1,9}$")
_RSID = re.compile(r"^rs\d+$")
_ALLELE = re.compile(r"^[ACGT]+$")
_BGZF_MAX_BLOCK = 65536


class OpenSourceError(RuntimeError):
    """A stable, reportable failure of the open-data path.

    ``status`` is the HTTP status a server answered with, when one did: it is
    what tells a missing directory (404, a fact about the study) from an outage.
    """

    def __init__(self, code: str, message: str, *, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


def _sleep(seconds: float) -> None:
    """A wait between node retries (patched out in tests)."""
    time.sleep(seconds)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default
    return value if value > 0 else default


#: Largest summary-statistics file streamed whole (EVIMED_MR_OPEN_STREAM_MAX_BYTES).
#: Locke 2015 BMI is 89 MB and Nikpay 2015 CAD 369 MB; a larger file is refused
#: by name instead of tying a job up for an hour on a slow link.
def _stream_limit() -> int:
    return _int_env("EVIMED_MR_OPEN_STREAM_MAX_BYTES", 512 * 1024 * 1024)


def _timeout() -> int:
    return _int_env("EVIMED_MR_OPEN_HTTP_TIMEOUT_SECONDS", 60)


#: Bounds of the parallel ranged fetch (see "Whole files" below): at most 16
#: connections per file, and chunks between one tabix-sized read and 64 MiB.
_FETCH_WORKERS_MAX = 16
_FETCH_CHUNK_MIN, _FETCH_CHUNK_MAX = 64 * 1024, 64 * 1024 * 1024


def _fetch_workers() -> int:
    """Range requests in flight per file (EVIMED_MR_OPEN_FETCH_WORKERS, 1-16, default 6)."""
    return min(_int_env("EVIMED_MR_OPEN_FETCH_WORKERS", 6), _FETCH_WORKERS_MAX)


def _fetch_chunk_bytes() -> int:
    """Bytes per range request (EVIMED_MR_OPEN_FETCH_CHUNK_BYTES, 64 KiB-64 MiB, default 8 MiB)."""
    chunk = _int_env("EVIMED_MR_OPEN_FETCH_CHUNK_BYTES", 8 * 1024 * 1024)
    return max(_FETCH_CHUNK_MIN, min(chunk, _FETCH_CHUNK_MAX))


def _spool_wait_seconds() -> int:
    """How long a job waits for another job's download of the same file (EVIMED_MR_OPEN_SPOOL_WAIT_SECONDS)."""
    return _int_env("EVIMED_MR_OPEN_SPOOL_WAIT_SECONDS", 3600)


# --- Reuse across jobs ------------------------------------------------------------
#
# Measured from the Beijing production host on 2026-09-28: www.ebi.ac.uk answers
# an API call in 1.4 s, but ftp.ebi.ac.uk delivers 38-58 KB/s, so the one
# genome-wide scan of an 89 MB exposure file takes about 40 minutes, and a
# 1.8 MB tabix index 30 s. What a scan keeps is small (Locke 2015 BMI: 2,042
# variants at p < 5e-8), so it is kept, keyed by the file's URL and byte size,
# in EVIMED_MR_OPEN_CACHE_DIR when that is set: the next job on the same study
# reads it in no time, and the provenance says it was reused and when it was read.


def _cache_dir() -> Path | None:
    raw = os.getenv("EVIMED_MR_OPEN_CACHE_DIR", "").strip()
    if not raw or not os.path.isabs(raw):
        return None
    path = Path(raw)
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError:
        return None
    return path if path.is_dir() and not path.is_symlink() else None


def _cache_key(*parts: Any) -> str:
    return hashlib.sha256("\x1f".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def _cache_read(key: str, suffix: str) -> bytes | None:
    directory = _cache_dir()
    if directory is None:
        return None
    target = directory / f"{key}{suffix}"
    try:
        if target.is_symlink() or not target.is_file():
            return None
        return target.read_bytes()
    except OSError:
        return None


def _cache_write(key: str, suffix: str, content: bytes) -> None:
    directory = _cache_dir()
    if directory is None:
        return
    target = directory / f"{key}{suffix}"
    temporary = directory / f".{key}{suffix}.{os.getpid()}.tmp"
    try:
        temporary.write_bytes(content)
        os.replace(temporary, target)
    except OSError:
        try:
            temporary.unlink()
        except OSError:
            pass


# --- Egress: EBI through the edge proxy -----------------------------------------
#
# Measured from the Beijing production host on 2026-09-28: one download from
# ftp.ebi.ac.uk ran at ~19 KB/s direct and ~358 KB/s through the platform's
# Tokyo edge node — a squid TLS forward proxy on 443 with basic credentials,
# the same node the control plane uses (apps/server/src/edgeProxy.mjs). With
# EVIMED_MR_OPEN_PROXY_URL (https://<node>) and
# EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE (``user:password``) set, a request to an
# EBI host goes TLS to the node (its certificate verified), CONNECT, then TLS to
# EBI inside that tunnel, so the node sees a host name and nothing else and
# EBI's certificate is verified here. Every other host goes direct.
#
# A node that fails — unreachable, a TLS failure, a refused tunnel (407 wrong
# credentials, 403 destination), a timeout — costs that request its shortcut,
# not its answer: it goes direct. A refusal that a retry cannot change turns
# the node off for the rest of the job at once. Any other failure is tried
# through the node again after a short wait before the request goes direct,
# and turns the node off only after several in a row: from Beijing, direct is
# about nineteen times slower, and on 2026-09-28 three passing failures sent a
# 450 MB job direct for hours. The source record's ``http.egress`` says how many requests went each
# way and why the node failed, and each read says which way it went. The
# credentials are sent to the node in the CONNECT request and nowhere else:
# never logged, never recorded, never in an error message.
#
# "In a row" with parallel requests: a whole file is fetched by several range
# requests at once, so one passing outage of the node is met by every request in
# flight, and counting each as a failure in a row would turn the node off after
# one blip. A failure therefore counts toward the run only when its attempt began
# after the last counted failure: attempts that were already under way when the
# node was seen failing are the same observation, not new evidence. With one
# request at a time (tabix reads, the catalogue API) this is exactly the old
# count; with N workers each retry round counts once, so the node goes off after
# about as long a failing stretch as before. A refusal a retry cannot change
# (403/407/certificate) still turns it off at once.
#
# Requests that read their whole answer (``_Http.read``: the catalogue API,
# listings, tabix index and the ~70 KB tabix ranges) keep their tunnel open for
# the next request to the same host, one idle tunnel per host and thread, when
# the answer was read to its last byte and EBI did not say ``Connection: close``:
# a tabix outcome is dozens of small reads, and each new tunnel is TLS to the
# node, CONNECT and TLS to EBI across the Beijing-Tokyo link. A kept tunnel that
# EBI has closed in the meantime is replaced by a fresh one without counting as
# a node failure (GET is idempotent), and a tunnel idle longer than
# ``_KEEP_ALIVE_IDLE_SECONDS`` is not reused. Range requests of a whole-file
# fetch use a fresh tunnel each: fresh flows are the point of that fetch.

EDGE_PROXY_DOMAIN = "ebi.ac.uk"
ROUTE_PROXY = "edge_proxy"
ROUTE_DIRECT = "direct"
#: The node's own connect budget, as the control plane's (OPEN_SCIENCE_EDGE_PROXY_CONNECT_TIMEOUT_MS).
_PROXY_CONNECT_SECONDS = 10
#: Transient node failures in a row (no success between, parallel attempts counted once) that turn it off.
_PROXY_FAILURES_BEFORE_OFF = 6
#: A kept tunnel idle longer than this is closed rather than reused.
_KEEP_ALIVE_IDLE_SECONDS = 15
#: Waits before trying the node again for the same request after a transient failure.
_PROXY_RETRY_WAITS = (2, 5, 12)
_PROXY_FAILURES_RECORDED = 20
_CONNECT_HEAD_LIMIT = 16 * 1024
_CREDENTIALS_LIMIT = 8 * 1024
_REDIRECTS = 5
_LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class EdgeProxy:
    """Where the node is, and the Basic credentials for it (kept out of ``repr``)."""

    host: str
    port: int
    authorization: str = field(repr=False)


class _ProxyFailure(Exception):
    """The node, or the tunnel through it, failed before an answer arrived."""

    def __init__(self, code: str, status: int | None = None):
        super().__init__(code)
        self.code, self.status = code, status

    @property
    def final(self) -> bool:
        """A refusal a retry cannot change: the credentials, the node's policy, a certificate."""
        return self.status in (403, 407) or self.code.endswith("_certificate_rejected")


def read_proxy_credentials(path: str) -> tuple[str | None, str | None]:
    """``(user:password, None)``, or ``(None, issue)``; ``(None, None)`` when there is none.

    The control plane's reader (config.mjs ``readSecretFile``, ``allowGroupRead``)
    decides the same way on the same host file: no symlink, a regular file (the
    ``/dev/null`` compose binds where a deployment has no node reads as none), at
    most 8 KiB, readable by its group (root:10002 0440, shared with the knowledge
    plugin) but never writable by it and never readable by others.
    """
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as error:
        symlink = error.errno == errno.ELOOP
        return None, "edge_proxy_credentials_symlink" if symlink else "edge_proxy_credentials_unavailable"
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return None, None
        if info.st_size > _CREDENTIALS_LIMIT + 2:
            return None, "edge_proxy_credentials_too_large"
        if info.st_mode & 0o037:
            return None, "edge_proxy_credentials_permissions"
        raw = os.read(descriptor, _CREDENTIALS_LIMIT + 3)
    except OSError:
        return None, "edge_proxy_credentials_unavailable"
    finally:
        os.close(descriptor)
    value = raw.decode("utf-8", "replace")
    value = value[:-2] if value.endswith("\r\n") else value[:-1] if value.endswith("\n") else value
    if not re.fullmatch(r"[^:\s]+:\S+", value):
        return None, "edge_proxy_credentials_invalid"
    return value, None


def _trust() -> ssl.SSLContext:
    """The system's roots, and certifi's where it is installed (requests ships it)."""
    context = ssl.create_default_context()
    try:
        import certifi

        context.load_verify_locations(cafile=certifi.where())
    except (ImportError, OSError, ssl.SSLError):
        pass
    return context


class _TunnelConnection(http_client.HTTPConnection):
    """HTTP/1.1 over a tunnel that is already open; ``http.client`` still checks the request line."""

    default_port = 443

    def __init__(self, host: str, port: int, transport: Any, timeout: float):
        super().__init__(host, port, timeout=timeout)
        self._transport = transport

    def connect(self) -> None:
        self.sock = self._transport


class _KeptResponse:
    """An answer on a tunnel that may carry the next request once this one is read to its last byte."""

    def __init__(self, response: http_client.HTTPResponse, release: Callable[[bool], None]):
        self._response = response
        self._release: Callable[[bool], None] | None = release

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)

    def read(self, *args: Any) -> bytes:
        return self._response.read(*args)

    def close(self) -> None:
        release, self._release = self._release, None
        if release is None:
            return
        # length reaches 0 only when the body (Content-Length) was read to its end;
        # anything else leaves bytes in the tunnel and it is closed, never reused.
        whole = self._response.length == 0 and not self._response.will_close
        self._response.close()
        release(whole)

    def __enter__(self) -> "_KeptResponse":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class _Egress:
    """Which way each request goes; what the source record says about it."""

    def __init__(
        self,
        proxy: EdgeProxy | None = None,
        *,
        state: str = "not_configured",
        issue: str | None = None,
        ssl_context: ssl.SSLContext | None = None,
    ):
        self.proxy, self.state, self.issue = proxy, state, issue
        self._context = ssl_context
        self.failures: list[dict[str, Any]] = []
        self.failure_count = 0
        self.consecutive_failures = 0
        self.off = False
        self.tunnels_reused = self.tunnels_found_closed = 0
        self._lock = threading.Lock()
        self._counted_at = float("-inf")
        self._idle = threading.local()

    @classmethod
    def _unusable(cls, issue: str) -> "_Egress":
        _LOG.warning("EVIMED_MR_OPEN_PROXY_URL is set but the edge proxy is unusable (%s); EBI is read direct.", issue)
        return cls(state="unusable", issue=issue)

    @classmethod
    def from_env(cls, *, ssl_context: ssl.SSLContext | None = None) -> "_Egress":
        raw = os.getenv("EVIMED_MR_OPEN_PROXY_URL", "").strip()
        if not raw:
            return cls()
        try:
            parts = urllib.parse.urlsplit(raw)
            port = parts.port or 443
        except ValueError:
            return cls._unusable("edge_proxy_url_invalid")
        if (
            parts.scheme != "https" or not parts.hostname or parts.username or parts.password
            or parts.path not in ("", "/") or parts.query or parts.fragment
        ):
            # https only: the credentials must never cross the wire in the clear.
            return cls._unusable("edge_proxy_url_invalid")
        path = os.getenv("EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE", "").strip()
        credentials, issue = read_proxy_credentials(path) if path else (None, None)
        if credentials is None:
            return cls._unusable(issue or "edge_proxy_credentials_missing")
        try:
            from urllib3.util.ssltransport import SSLTransport  # noqa: F401  (TLS inside TLS)
        except ImportError:
            return cls._unusable("edge_proxy_tls_in_tls_unavailable")
        authorization = "Basic " + base64.b64encode(credentials.encode("utf-8")).decode("ascii")
        return cls(EdgeProxy(parts.hostname, port, authorization), state="configured", ssl_context=ssl_context)

    def routes(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        return (
            self.proxy is not None and not self.off and parts.scheme == "https"
            and (host == EDGE_PROXY_DOMAIN or host.endswith("." + EDGE_PROXY_DOMAIN))
        )

    def failed(self, failure: _ProxyFailure, host: str, started: float | None = None) -> None:
        """Count a node failure; ``started`` is when the failed attempt began (``time.monotonic``)."""
        with self._lock:
            self.failure_count += 1
            if len(self.failures) < _PROXY_FAILURES_RECORDED:
                self.failures.append({"code": failure.code, "httpStatus": failure.status, "host": host, "at": _now()})
            # An attempt already under way when the last counted failure was seen
            # met the same outage: it is not another failure in a row.
            if started is None or started >= self._counted_at:
                self.consecutive_failures += 1
                self._counted_at = time.monotonic()
            turned_off = not self.off and (
                failure.final or self.consecutive_failures >= _PROXY_FAILURES_BEFORE_OFF
            )
            if turned_off:
                self.off = True
        _LOG.warning(
            "The edge proxy failed for %s (%s%s); the request goes direct.",
            host, failure.code, f", HTTP {failure.status}" if failure.status else "",
        )
        if turned_off:
            _LOG.warning("The edge proxy is off for the rest of this job after %d failure(s).", self.failure_count)

    def succeeded(self) -> None:
        with self._lock:
            self.consecutive_failures = 0

    def open(
        self, url: str, headers: dict[str, str], timeout: float, *, keep_alive: bool = False,
    ) -> http_client.HTTPResponse | _KeptResponse:
        """One GET through the node; the answer whatever its status, or ``_ProxyFailure``.

        With ``keep_alive`` the tunnel may be one kept from an earlier request to
        the same host, and is kept for the next one when this answer is read whole.
        """
        parts = urllib.parse.urlsplit(url)
        host, port = parts.hostname or "", parts.port or 443
        target = urllib.parse.urlunsplit(("", "", parts.path or "/", parts.query, ""))
        if keep_alive:
            kept = self._take_idle((host, port))
            if kept is not None:
                try:
                    kept.request("GET", target, headers=headers)
                    response = kept.getresponse()
                except (OSError, http_client.HTTPException):
                    kept.close()  # EBI closed the idle tunnel: a fresh one, not a node failure
                    with self._lock:
                        self.tunnels_found_closed += 1
                else:
                    with self._lock:
                        self.tunnels_reused += 1
                    return self._kept(kept, response, (host, port))
        transport = self._tunnel(host, port, timeout)
        connection = _TunnelConnection(host, port, transport, timeout)
        try:
            connection.request("GET", target, headers=headers if keep_alive else {**headers, "Connection": "close"})
            response = connection.getresponse()
        except (OSError, http_client.HTTPException):
            transport.close()
            raise _ProxyFailure("edge_proxy_upstream_failed") from None
        if keep_alive:
            return self._kept(connection, response, (host, port))
        # The response's file now holds the tunnel open until it is read or closed.
        connection.sock = None
        transport.close()
        return response

    def _kept(
        self, connection: _TunnelConnection, response: http_client.HTTPResponse, key: tuple[str, int],
    ) -> http_client.HTTPResponse | _KeptResponse:
        if response.will_close:
            return response  # http.client has already handed the tunnel to the response

        def release(whole: bool) -> None:
            if whole:
                self._put_idle(key, connection)
            else:
                connection.close()

        return _KeptResponse(response, release)

    def _pool(self) -> dict[tuple[str, int], tuple[_TunnelConnection, float]]:
        pool = getattr(self._idle, "pool", None)
        if pool is None:
            pool = self._idle.pool = {}
        return pool

    def _take_idle(self, key: tuple[str, int]) -> _TunnelConnection | None:
        entry = self._pool().pop(key, None)
        if entry is None:
            return None
        connection, since = entry
        if time.monotonic() - since > _KEEP_ALIVE_IDLE_SECONDS:
            connection.close()
            return None
        return connection

    def _put_idle(self, key: tuple[str, int], connection: _TunnelConnection) -> None:
        previous = self._pool().pop(key, None)
        if previous is not None:
            previous[0].close()
        self._pool()[key] = (connection, time.monotonic())

    def close_idle(self) -> None:
        """Close this thread's kept tunnels."""
        pool = self._pool()
        while pool:
            _, (connection, _since) = pool.popitem()
            connection.close()

    def _tunnel(self, host: str, port: int, timeout: float) -> Any:
        """TLS to the node, CONNECT, then TLS to ``host`` inside it."""
        from urllib3.util.ssltransport import SSLTransport

        assert self.proxy is not None
        context = self._context or _trust()
        try:
            raw = socket.create_connection(
                (self.proxy.host, self.proxy.port), timeout=min(_PROXY_CONNECT_SECONDS, timeout)
            )
        except OSError:
            raise _ProxyFailure("edge_proxy_unreachable") from None
        leg: Any = raw
        try:
            try:
                leg = context.wrap_socket(raw, server_hostname=self.proxy.host)
            except ssl.SSLCertVerificationError:
                raise _ProxyFailure("edge_proxy_certificate_rejected") from None
            except (ssl.SSLError, OSError):
                raise _ProxyFailure("edge_proxy_tls_failed") from None
            authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
            try:
                leg.sendall(
                    f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"
                    f"Proxy-Authorization: {self.proxy.authorization}\r\n\r\n".encode("latin-1")
                )
                status = self._connect_status(leg)
            except TimeoutError:
                raise _ProxyFailure("edge_proxy_timeout") from None
            except OSError:
                raise _ProxyFailure("edge_proxy_unreachable") from None
            if status != 200:
                raise _ProxyFailure("edge_proxy_refused", status or None)
            try:
                transport = SSLTransport(leg, context, server_hostname=host)
            except ssl.SSLCertVerificationError:
                raise _ProxyFailure("edge_proxy_upstream_certificate_rejected") from None
            except (ssl.SSLError, OSError):
                raise _ProxyFailure("edge_proxy_upstream_tls_failed") from None
            leg.settimeout(timeout)
            return transport
        except BaseException:
            leg.close()
            raise

    @staticmethod
    def _connect_status(leg: Any) -> int:
        """The status of the node's answer to CONNECT, read to its blank line and no further."""
        head = bytearray()
        while not head.endswith(b"\r\n\r\n"):
            byte = leg.recv(1)
            if not byte:
                raise _ProxyFailure("edge_proxy_unreachable")
            head += byte
            if len(head) > _CONNECT_HEAD_LIMIT:
                raise _ProxyFailure("edge_proxy_protocol")
        match = re.match(rb"HTTP/1\.[01] (\d{3})", bytes(head))
        return int(match.group(1)) if match else 0

    def record(self, requests: dict[str, int]) -> dict[str, Any]:
        """``http.egress`` in the source record: no address, no credential."""
        return {
            "proxy": self.state,
            **({"proxyIssue": self.issue} if self.issue else {}),
            "proxiedHosts": f"*.{EDGE_PROXY_DOMAIN}" if self.proxy else None,
            "requests": {route: count for route, count in requests.items() if count},
            "proxyFailureCount": self.failure_count,
            "proxyFailures": list(self.failures),
            "proxyTurnedOff": self.off,
            **({"tunnelsReused": self.tunnels_reused} if self.tunnels_reused else {}),
            **({"keptTunnelsFoundClosed": self.tunnels_found_closed} if self.tunnels_found_closed else {}),
        }


class _Http:
    """Every request this module makes, counted by the way it went, with bounded retries."""

    def __init__(self, opener: Callable[..., Any] | None = None, *, egress: _Egress | None = None):
        self._open = opener or urllib.request.urlopen
        self.egress = egress if egress is not None else _Egress.from_env()
        self.requests = 0
        self.bytes = 0
        self.routes = {ROUTE_PROXY: 0, ROUTE_DIRECT: 0}
        self.last_route: str | None = None
        # Range requests of one file run on several threads: counters under a
        # lock, and the way each thread's last request went kept per thread.
        self._lock = threading.Lock()
        self._local = threading.local()

    def routes_since(self, mark: dict[str, int]) -> dict[str, int]:
        """Requests per route since ``mark`` (a copy of ``routes`` taken earlier)."""
        return {
            route: count - mark.get(route, 0) for route, count in self.routes.items() if count > mark.get(route, 0)
        }

    def add_bytes(self, count: int) -> None:
        with self._lock:
            self.bytes += count

    def _went(self, route: str) -> None:
        with self._lock:
            self.routes[route] += 1
            self.last_route = route
        self._local.route = route

    def _send(self, url: str, headers: dict[str, str], keep_alive: bool = False):
        """Through the node when it carries this host, else (or when it fails) direct."""
        for _ in range(_REDIRECTS + 1):
            if not self.egress.routes(url):
                break
            response = None
            for attempt in range(len(_PROXY_RETRY_WAITS) + 1):
                started = time.monotonic()
                try:
                    response = self.egress.open(url, headers, _timeout(), keep_alive=keep_alive)
                except _ProxyFailure as failure:
                    self.egress.failed(failure, urllib.parse.urlsplit(url).hostname or "", started)
                    if failure.final or self.egress.off or attempt == len(_PROXY_RETRY_WAITS):
                        break
                    _sleep(_PROXY_RETRY_WAITS[attempt])
                    continue
                self.egress.succeeded()
                break
            if response is None:
                break
            self._went(ROUTE_PROXY)
            location = response.headers.get("Location")
            if response.status in (301, 302, 303, 307, 308) and location:
                response.close()
                url = urllib.parse.urljoin(url, location)
                continue
            if not 200 <= response.status < 300:
                status, reason, response_headers = response.status, response.reason, response.headers
                response.close()
                raise urllib.error.HTTPError(url, status, reason, response_headers, None)
            return response
        else:
            raise OpenSourceError(
                "mr_open_source_unavailable",
                f"{urllib.parse.urlsplit(url).netloc} redirected more than {_REDIRECTS} times.",
            )
        self._went(ROUTE_DIRECT)
        return self._open(urllib.request.Request(url, headers=headers), timeout=_timeout())

    def open(
        self, url: str, *, headers: dict[str, str] | None = None, attempts: int = 3, keep_alive: bool = False,
    ):
        merged = {"User-Agent": USER_AGENT, **(headers or {})}
        for attempt in range(attempts):
            with self._lock:
                self.requests += 1
            try:
                return self._send(url, merged, keep_alive)
            except urllib.error.HTTPError as error:
                if error.code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                    time.sleep(2 ** attempt)
                    continue
                raise OpenSourceError(
                    "mr_open_source_unavailable",
                    f"{urllib.parse.urlsplit(url).netloc} answered HTTP {error.code} for {url} ({self._way()}).",
                    status=error.code,
                ) from None
            except (urllib.error.URLError, TimeoutError, OSError, http_client.HTTPException) as error:
                if attempt < attempts - 1:
                    time.sleep(2 ** attempt)
                    continue
                raise OpenSourceError(
                    "mr_open_source_unavailable",
                    f"{urllib.parse.urlsplit(url).netloc} could not be reached ({type(error).__name__}, {self._way()}).",
                ) from None
        raise AssertionError("unreachable")

    def _way(self) -> str:
        route = getattr(self._local, "route", None) or self.last_route
        return "through the edge proxy" if route == ROUTE_PROXY else "direct"

    def read(self, url: str, *, headers: dict[str, str] | None = None, limit: int = 64 * 1024 * 1024) -> bytes:
        """A whole (bounded) answer; its tunnel, when it went through the node, may carry the next request."""
        with self.open(url, headers=headers, keep_alive=True) as response:
            body = response.read(limit + 1)
        if len(body) > limit:
            raise OpenSourceError("mr_open_source_too_large", f"{url} exceeded {limit} bytes.")
        self.add_bytes(len(body))
        return body

    def json(self, url: str) -> Any:
        try:
            return json.loads(self.read(url, headers={"Accept": "application/json"}, limit=16 * 1024 * 1024))
        except ValueError:
            raise OpenSourceError("mr_open_source_unavailable", f"{url} did not return JSON.") from None


# --- Studies ------------------------------------------------------------------


@dataclass
class CatalogStudy:
    accession: str
    trait: str
    pubmed_id: str
    ancestry: list[str]
    initial_sample_size: str
    efo_traits: list[str]
    summary_stats_url: str
    licence: str
    harmonised_url: str = ""
    index_url: str = ""
    harmonised_bytes: int | None = None
    metadata_url: str = ""
    samples: dict[str, Any] = field(default_factory=dict)

    def record(self) -> dict[str, Any]:
        return {
            "repository": "NHGRI-EBI GWAS Catalog",
            "accession": self.accession,
            "studyUrl": f"https://www.ebi.ac.uk/gwas/studies/{self.accession}",
            "trait": self.trait,
            "pubmedId": self.pubmed_id,
            "discoveryAncestry": self.ancestry,
            "initialSampleSize": self.initial_sample_size,
            "efoTraits": self.efo_traits,
            "licence": self.licence,
            "summaryStatisticsUrl": self.summary_stats_url,
            "harmonisedFile": self.harmonised_url,
            "harmonisedBytes": self.harmonised_bytes,
            "tabixIndex": self.index_url or None,
            "sampleMetadata": self.samples or None,
        }


def _study_from_payload(payload: dict[str, Any]) -> CatalogStudy:
    ancestry = payload.get("discovery_ancestry") or []
    efo = payload.get("efo_traits") or []
    return CatalogStudy(
        accession=str(payload.get("accession_id") or ""),
        trait=str(payload.get("disease_trait") or ""),
        pubmed_id=str(payload.get("pubmed_id") or ""),
        ancestry=[str(item) for item in ancestry] if isinstance(ancestry, list) else [str(ancestry)],
        initial_sample_size=str(payload.get("initial_sample_size") or ""),
        efo_traits=[
            str(item.get("efo_trait") if isinstance(item, dict) else item) for item in efo
        ] if isinstance(efo, list) else [],
        summary_stats_url=str(payload.get("full_summary_stats") or ""),
        licence=str(payload.get("terms_of_license") or ""),
    )


def resolve_study(source: dict[str, Any], http: _Http) -> CatalogStudy:
    """The catalogue's own record for an accession, or the one study a PubMed id names."""
    accession = str(source.get("accession") or "").strip().upper()
    pubmed_id = str(source.get("pubmedId") or "").strip()
    if accession:
        if not _ACCESSION.fullmatch(accession):
            raise OpenSourceError("mr_open_source_invalid", f"{accession} is not a GWAS Catalog accession.")
        payload = http.json(f"{CATALOG_API}/studies/{accession}")
        studies = (
            [_study_from_payload(payload)]
            if isinstance(payload, dict) and payload.get("full_summary_stats_available") is not False
            else []
        )
    elif _PUBMED.fullmatch(pubmed_id):
        payload = http.json(f"{CATALOG_API}/studies?pubmed_id={pubmed_id}&size=100")
        rows = ((payload or {}).get("_embedded") or {}).get("studies") or []
        studies = [
            _study_from_payload(row) for row in rows
            if isinstance(row, dict) and row.get("full_summary_stats_available")
        ]
        if len(studies) > 1:
            listed = "; ".join(
                f"{study.accession} ({study.trait}; {study.initial_sample_size})" for study in studies[:12]
            )
            raise OpenSourceError(
                "mr_open_source_ambiguous",
                f"PubMed {pubmed_id} has {len(studies)} GWAS Catalog studies with full summary statistics: "
                f"{listed}. Choose one and give its accession.",
            )
    else:
        raise OpenSourceError("mr_open_source_invalid", "A GWAS Catalog source needs an accession or a PubMed id.")
    if not studies or not studies[0].accession:
        raise OpenSourceError(
            "mr_open_source_not_found",
            f"The GWAS Catalog has no study with full summary statistics for {accession or 'PubMed ' + pubmed_id}.",
        )
    study = studies[0]
    if accession and study.accession != accession:
        raise OpenSourceError("mr_open_source_not_found", f"The GWAS Catalog did not return {accession}.")
    return study


def _ftp_directory(accession: str) -> str:
    number = int(accession[4:])
    low = (number - 1) // 1000 * 1000 + 1
    width = max(6, len(accession) - 4)
    return f"{FTP_ROOT}/GCST{low:0{width}d}-GCST{low + 999:0{width}d}/{accession}"


def locate_harmonised_file(study: CatalogStudy, http: _Http) -> CatalogStudy:
    """The study's harmonised file, and its tabix index when the catalogue has one."""
    directory = study.summary_stats_url.rstrip("/") if study.summary_stats_url.startswith("http") else ""
    directory = directory.replace("http://", "https://") or _ftp_directory(study.accession)
    try:
        listing = http.read(f"{directory}/harmonised/", limit=2 * 1024 * 1024).decode("utf-8", "replace")
    except OpenSourceError as error:
        if error.status != 404:
            raise
        # The catalogue says the study has full summary statistics, but EBI has
        # no harmonised directory for them (GCST006900, Yengo 2018 BMI, on
        # 2026-09-28). That is a fact about the study, not an outage: the run
        # chooses another study instead of retrying this one.
        raise OpenSourceError(
            "mr_open_source_unharmonised",
            f"{study.accession} has no harmonised summary-statistics directory at EBI "
            f"({directory}/harmonised/ answered HTTP 404); only a study with exactly one harmonised "
            "(GRCh38, allele-aligned) file is read. Choose another study of the same trait.",
        ) from None
    names = sorted(set(re.findall(r'href="([^"?/]+\.h\.tsv\.gz(?:\.tbi|-meta\.yaml)?)"', listing)))
    data = [name for name in names if name.endswith(".h.tsv.gz")]
    if len(data) != 1:
        raise OpenSourceError(
            "mr_open_source_unharmonised",
            f"{study.accession} has {len(data) or 'no'} harmonised summary-statistics file(s) in the catalogue; "
            "only a study with exactly one harmonised (GRCh38, allele-aligned) file is read.",
        )
    study.harmonised_url = f"{directory}/harmonised/{data[0]}"
    if f"{data[0]}.tbi" in names:
        study.index_url = f"{study.harmonised_url}.tbi"
    if f"{data[0]}-meta.yaml" in names:
        study.metadata_url = f"{study.harmonised_url}-meta.yaml"
    try:
        with http.open(study.harmonised_url, headers={"Range": "bytes=0-0"}) as response:
            total = response.headers.get("Content-Range", "").rsplit("/", 1)[-1]
            study.harmonised_bytes = int(total) if total.isdigit() else None
    except OpenSourceError:
        study.harmonised_bytes = None
    return study


def _sample_total(samples: list[Any], key: str) -> int | None:
    values = [sample.get(key) if isinstance(sample, dict) else None for sample in samples]
    if not values or not all(type(value) is int and value >= 0 for value in values):
        return None
    return sum(values)


def read_sample_metadata(study: CatalogStudy, http: _Http) -> dict[str, Any]:
    """The study's sample size and design, from the metadata beside its harmonised file.

    The catalogue's study record states sample size only as prose ("42,096
    European ancestry cases, ..."); the GWAS-SSF metadata file published with
    the harmonised summary statistics states it as numbers (`samples[]`:
    `sample_size`, `case_control_study`, `case_count`, `control_count`). A
    total is stated only when every sample gives it.
    """
    if not study.metadata_url:
        return {"source": None, "reason": "the catalogue publishes no metadata file beside the harmonised file"}
    try:
        payload = yaml.safe_load(http.read(study.metadata_url, limit=1024 * 1024))
    except OpenSourceError as error:
        return {"source": study.metadata_url, "reason": f"the metadata file could not be read ({error.code})"}
    except (yaml.YAMLError, UnicodeDecodeError):
        return {"source": study.metadata_url, "reason": "the metadata file is not readable YAML"}
    samples = payload.get("samples") if isinstance(payload, dict) else None
    if not isinstance(samples, list) or not samples:
        return {"source": study.metadata_url, "reason": "the metadata file lists no samples"}
    designs = {sample.get("case_control_study") if isinstance(sample, dict) else None for sample in samples}
    record = {
        "source": study.metadata_url,
        "samples": len(samples),
        "sampleSize": _sample_total(samples, "sample_size"),
        "caseControlStudy": designs.pop() if len(designs) == 1 and designs <= {True, False} else None,
        "caseCount": _sample_total(samples, "case_count"),
        "controlCount": _sample_total(samples, "control_count"),
    }
    if record["sampleSize"] is None:
        record["reason"] = "not every sample in the metadata file states its sample_size"
    return record


def with_study_sample_size(rows: list["Variant"], samples: dict[str, Any]) -> tuple[list["Variant"], dict[str, Any]]:
    """Rows without their own n take the study's total sample size.

    The per-variant sample size is what the Steiger test reads; a file without
    an n column left it empty, and the test failed. Filling a study-level value
    into each row is what TwoSampleMR's add_metadata() does for OpenGWAS.
    """
    total = samples.get("sampleSize")
    own = sum(1 for row in rows if row.n is not None)
    filled = [
        row if row.n is not None or total is None else replace(row, n=float(total))
        for row in rows
    ]
    return filled, {
        "rowsWithOwnSampleSize": own,
        "rowsGivenStudySampleSize": 0 if total is None else len(rows) - own,
        "studySampleSize": total,
    }


# --- Rows ---------------------------------------------------------------------


@dataclass(frozen=True)
class Variant:
    snp: str
    chrom: str
    pos: int
    effect_allele: str
    other_allele: str
    beta: float
    se: float
    pval: float
    eaf: float | None
    n: float | None

    def row(self) -> dict[str, Any]:
        return {
            "SNP": self.snp, "beta": repr(self.beta), "se": repr(self.se),
            "effect_allele": self.effect_allele, "other_allele": self.other_allele,
            "eaf": "NA" if self.eaf is None else repr(self.eaf),
            "pval": repr(self.pval), "samplesize": "NA" if self.n is None else repr(self.n),
            "chr": self.chrom, "pos": str(self.pos),
        }


CSV_COLUMNS = ("SNP", "beta", "se", "effect_allele", "other_allele", "eaf", "pval", "samplesize", "chr", "pos")


def _number(value: Any) -> float | None:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


class _Columns:
    """Reads either catalogue layout: pre-2023 ``hm_*`` harmonised or GWAS-SSF."""

    def __init__(self, header: list[str]):
        index = {name.strip().lower(): position for position, name in enumerate(header)}
        self.legacy = "hm_rsid" in index

        def pick(*names: str) -> int | None:
            return next((index[name] for name in names if name in index), None)

        if self.legacy:
            self.snp, self.chrom, self.pos = pick("hm_rsid"), pick("hm_chrom"), pick("hm_pos")
            self.ea, self.oa = pick("hm_effect_allele"), pick("hm_other_allele")
            self.beta, self.odds = pick("hm_beta"), pick("hm_odds_ratio")
            self.ci_low, self.ci_high = pick("hm_ci_lower"), pick("hm_ci_upper")
            self.eaf = pick("hm_effect_allele_frequency")
        else:
            self.snp, self.chrom, self.pos = pick("rsid", "hm_rsid"), pick("chromosome"), pick("base_pair_location")
            self.ea, self.oa = pick("effect_allele"), pick("other_allele")
            self.beta, self.odds = pick("beta"), pick("odds_ratio")
            self.ci_low, self.ci_high = pick("ci_lower"), pick("ci_upper")
            self.eaf = pick("effect_allele_frequency")
        self.se = pick("standard_error")
        self.p = pick("p_value")
        self.mlog10p = pick("neg_log_10_p_value")
        self.n = pick("n")
        missing = [
            name for name, position in (
                ("rsid", self.snp), ("chromosome", self.chrom), ("position", self.pos),
                ("effect allele", self.ea), ("other allele", self.oa),
                ("beta or odds ratio", self.beta if self.beta is not None else self.odds),
                ("p-value", self.p if self.p is not None else self.mlog10p),
            ) if position is None
        ]
        if missing:
            raise OpenSourceError(
                "mr_open_source_format", f"The summary-statistics file has no {', '.join(missing)} column."
            )

    def variant(self, fields: list[str]) -> Variant | None:
        def cell(position: int | None) -> str:
            return fields[position].strip() if position is not None and position < len(fields) else ""

        snp = cell(self.snp)
        ea, oa = cell(self.ea).upper(), cell(self.oa).upper()
        if not _RSID.fullmatch(snp) or not _ALLELE.fullmatch(ea) or not _ALLELE.fullmatch(oa):
            return None
        pos = _number(cell(self.pos))
        chrom = cell(self.chrom).removeprefix("chr")
        if pos is None or not chrom:
            return None
        beta = _number(cell(self.beta))
        if beta is None:
            odds = _number(cell(self.odds))
            beta = math.log(odds) if odds is not None and odds > 0 else None
        se = _number(cell(self.se))
        if se is None:
            low, high = _number(cell(self.ci_low)), _number(cell(self.ci_high))
            if low is not None and high is not None and beta is not None and high > low:
                on_ratio = self.beta is None or _number(cell(self.beta)) is None
                if on_ratio and low > 0:
                    low, high = math.log(low), math.log(high)
                se = (high - low) / (2 * 1.959963984540054)
        p = _number(cell(self.p))
        if p is None:
            mlog = _number(cell(self.mlog10p))
            p = 10 ** (-mlog) if mlog is not None else None
        if beta is None or se is None or se <= 0 or p is None or not 0 <= p <= 1:
            return None
        eaf = _number(cell(self.eaf))
        return Variant(
            snp=snp, chrom=chrom, pos=int(pos), effect_allele=ea, other_allele=oa,
            beta=beta, se=se, pval=p, eaf=eaf if eaf is not None and 0 <= eaf <= 1 else None,
            n=_number(cell(self.n)),
        )


class _CountingReader(io.RawIOBase):
    def __init__(self, response: Any, limit: int, url: str):
        self._response, self._limit, self._url = response, limit, url
        self.count = 0

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        data = self._response.read(len(buffer))
        self.count += len(data)
        if self.count > self._limit:
            raise OpenSourceError(
                "mr_open_source_too_large",
                f"{self._url} is larger than the {self._limit}-byte stream limit (EVIMED_MR_OPEN_STREAM_MAX_BYTES).",
            )
        buffer[: len(data)] = data
        return len(data)


def stream_variants(
    url: str, http: _Http, keep: Callable[[Variant], bool], *, source: Any = None,
) -> tuple[list[Variant], dict[str, Any]]:
    """Read a whole gzip file once, keeping the rows ``keep`` accepts.

    ``source`` is a complete local copy of ``url`` (a spool file from
    ``read_whole_file``) to parse instead of streaming ``url``.
    """
    started = time.monotonic()
    kept: list[Variant] = []
    rows = unreadable = 0
    digest = hashlib.sha256()
    mark = dict(http.routes)
    with contextlib.nullcontext(source) if source is not None else http.open(url) as response:
        counter = _CountingReader(response, _stream_limit(), url)

        class _Hashing(io.RawIOBase):
            def readable(self) -> bool:
                return True

            def readinto(self, buffer: Any) -> int:
                size = counter.readinto(buffer)
                digest.update(memoryview(buffer)[:size])
                return size

        try:
            with gzip.GzipFile(fileobj=io.BufferedReader(_Hashing(), 1 << 20)) as unzipped:
                lines = io.TextIOWrapper(unzipped, encoding="utf-8", errors="replace", newline="")
                header = next(lines).rstrip("\r\n").split("\t")
                columns = _Columns(header)
                for line in lines:
                    rows += 1
                    variant = columns.variant(line.rstrip("\r\n").split("\t"))
                    if variant is None:
                        unreadable += 1
                    elif keep(variant):
                        kept.append(variant)
        except (OSError, EOFError, zlib.error, http_client.HTTPException) as error:
            # A connection that drops mid-file, or a file that is not gzip: named, with
            # the way it was read, rather than escaping as a bare socket error.
            way = "its local copy" if source is not None else http._way()
            raise OpenSourceError(
                "mr_open_source_unavailable",
                f"Reading {url} stopped after {counter.count} bytes ({type(error).__name__}, {way}).",
            ) from None
    if source is None:
        http.add_bytes(counter.count)
    return kept, {
        "mode": "streamed",
        "url": url,
        "bytes": counter.count,
        "sha256": digest.hexdigest(),
        "rows": rows,
        "rowsUnreadable": unreadable,
        "seconds": round(time.monotonic() - started, 1),
        "egress": http.routes_since(mark),
    }


# --- Whole files: parallel byte ranges ----------------------------------------------
#
# Measured on the Beijing production host on 2026-09-28, in the China evening: one
# long stream of GCST005195's 388 MB harmonised file through the Tokyo node fell to
# ~30 KB/s -- on a lossy link a long-lived TCP flow's window collapses and stays
# small -- while a fresh 4 MB range through the same node moved 150-350 KB/s here
# (710 KB/s with curl), and direct to EBI gave 14-25 KB/s: hours streamed, minutes
# as parallel ranges. So a file whose size the server stated
# (``locate_harmonised_file`` probes ``bytes=0-0``) and that spans more than one
# chunk is fetched as byte ranges, each on a fresh connection, by a few workers,
# into a spool file, and then parsed by ``stream_variants`` as if it were the
# stream. Each range goes the way any request goes (``_Http``: the node, its
# retries, direct) and is retried on its own; every answer must be exactly the
# range asked for, of a file of the size first stated. A range that cannot be
# read fails the read with the stream's error codes: a partial file is never
# parsed as whole. The spool goes on the scan cache's volume when there is one
# (production: a named volume; the container's /tmp is a 512 MB tmpfs), else in
# the temp directory, and only where all of it fits; with no room, or a server
# that answers a range with anything but that range, the file is streamed as
# before, and the read record says why (``rangedSkipped``). The spool is deleted
# after the scan: what the scan found is what the cache keeps.

_SPAN_ATTEMPTS = 3
_SPAN_READ = 1024 * 1024
_SPOOL_HEADROOM = 64 * 1024 * 1024
_SPOOL_POLL_SECONDS = 0.2
_RETRY_STATUSES = (429, 500, 502, 503, 504)
_CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)")
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class _SpoolUnusable(Exception):
    """The ranged fetch cannot be used for this file; ``reason`` says why, and the file is streamed."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class _Stopped(Exception):
    """Another range of the same file failed; this one stops."""


class _Tally:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests = self.retries = self.bytes = 0

    def add(self, *, requests: int = 0, retries: int = 0, count: int = 0) -> None:
        with self._lock:
            self.requests += requests
            self.retries += retries
            self.bytes += count


def _check_span(response: Any, first: int, last: int, total: int, url: str) -> None:
    stated = _CONTENT_RANGE.fullmatch(str(response.headers.get("Content-Range") or "").strip())
    if stated is None:
        raise _SpoolUnusable("range_not_honoured")  # the whole file, or no statement of the range
    if int(stated.group(3)) != total:
        raise OpenSourceError(
            "mr_open_source_unavailable",
            f"{url} is {stated.group(3)} bytes by its range answer, not the {total} first stated: "
            "it changed while being read, or its size was misreported. Nothing of it was used.",
        )
    if (int(stated.group(1)), int(stated.group(2))) != (first, last):
        raise _SpoolUnusable("range_not_honoured")


def _write_at(descriptor: int, data: bytes, offset: int) -> None:
    view = memoryview(data)
    while view:
        try:
            written = os.pwrite(descriptor, view, offset)
        except OSError as error:
            full = error.errno in (errno.ENOSPC, errno.EDQUOT)
            raise _SpoolUnusable("no_room" if full else "spool_write_failed") from None
        view, offset = view[written:], offset + written


def _fetch_span(
    http: _Http, url: str, first: int, last: int, total: int, descriptor: int, stop: threading.Event, tally: _Tally,
) -> None:
    """Bytes ``first``..``last`` of ``url`` into the spool at the same offset, retried on their own."""
    want = last - first + 1
    for attempt in range(_SPAN_ATTEMPTS):
        if stop.is_set():
            raise _Stopped()
        tally.add(requests=1, retries=1 if attempt else 0)
        written = 0
        try:
            with http.open(url, headers={"Range": f"bytes={first}-{last}"}, attempts=1) as response:
                _check_span(response, first, last, total, url)
                while written < want:
                    if stop.is_set():
                        raise _Stopped()
                    data = response.read(min(_SPAN_READ, want - written))
                    if not data:
                        raise http_client.IncompleteRead(b"", want - written)
                    _write_at(descriptor, data, first + written)
                    written += len(data)
            http.add_bytes(want)
            tally.add(count=want)
            return
        except OpenSourceError as error:
            # http.open with one attempt: retried when a retry can change the answer, or there was none.
            if error.status not in (None, *_RETRY_STATUSES) or attempt == _SPAN_ATTEMPTS - 1:
                raise
        except (OSError, http_client.HTTPException) as error:
            if attempt == _SPAN_ATTEMPTS - 1:
                raise OpenSourceError(
                    "mr_open_source_unavailable",
                    f"Bytes {first}-{last} of {url} could not be read in {_SPAN_ATTEMPTS} attempts "
                    f"({type(error).__name__} after {written} of {want} bytes, {http._way()}).",
                ) from None
        _sleep(2 ** attempt)
    raise AssertionError("unreachable")


def _fetch_ranges(url: str, size: int, http: _Http, descriptor: int, chunk: int, workers: int) -> dict[str, Any]:
    """All of ``url`` into ``descriptor`` as parallel ranges, or an exception and nothing to use."""
    started = time.monotonic()
    spans = [(start, min(start + chunk, size) - 1) for start in range(0, size, chunk)]
    workers = min(workers, len(spans))
    stop, tally = threading.Event(), _Tally()
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="evimed-mr-range")
    try:
        futures = [pool.submit(_fetch_span, http, url, a, b, size, descriptor, stop, tally) for a, b in spans]
        for future in as_completed(futures):
            future.result()
    except BaseException:
        stop.set()  # the first failure is the one reported; the others stop at their next read
        raise
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    if tally.bytes != size or os.fstat(descriptor).st_size != size:
        raise OpenSourceError(
            "mr_open_source_unavailable",
            f"{url}: {tally.bytes} bytes were assembled, not the {size} stated. Nothing of it was used.",
        )
    return {
        "workers": workers, "chunkBytes": chunk, "chunks": len(spans),
        "rangeRequests": tally.requests, "rangeRetries": tally.retries,
        "bytesFetched": tally.bytes, "fetchSeconds": round(time.monotonic() - started, 1),
    }


def _free_bytes(directory: Path) -> int:
    try:
        return shutil.disk_usage(directory).free
    except OSError:
        return 0


def _flock(path: Path, wait: float) -> int | None:
    """An exclusive flock on ``path`` within ``wait`` seconds: its descriptor, or None."""
    assert fcntl is not None
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | _NOFOLLOW, 0o600)
    deadline = time.monotonic() + wait
    while True:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return descriptor
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(descriptor)
                return None
            time.sleep(_SPOOL_POLL_SECONDS)


class _Spool:
    """A complete local copy of one remote file, shared by the jobs that read it at the same time.

    In the spool directory, keyed by URL and size: ``<key>.spool`` is a complete
    copy (renamed into place only after every byte was checked);
    ``.<key>.*.part`` one being written; ``<key>.spool.lock`` is held (flock,
    exclusive) while the copy is looked for, written or deleted, so a job that
    finds another one downloading waits for it (at most
    EVIMED_MR_OPEN_SPOOL_WAIT_SECONDS, then streams) and reads its copy;
    ``<key>.spool.users`` is held shared by every job that wants the copy, from
    before it waits, so only the last one out deletes it. flock locks die with
    their process: a crashed job never leaves one held, its part file is removed
    by the next writer, and a complete copy it left is read and deleted by the
    next job on the same file.
    """

    def __init__(self, file: Any, users: int, directory: Path, key: str, record: dict[str, Any]):
        self.file, self.record = file, record
        self._users, self._directory, self._key = users, directory, key

    @staticmethod
    def _place(key: str, size: int) -> tuple[str, Path] | None:
        """The cache volume, else the temp directory: the first that has the copy, its writer, or room."""
        places: list[tuple[str, Path]] = []
        cache = _cache_dir()
        if cache is not None:
            places.append(("cache_volume", cache))
        places.append(("temp_dir", Path(tempfile.gettempdir())))
        for label, directory in places:
            if not os.access(directory, os.W_OK | os.X_OK):
                continue
            if (directory / f"{key}.spool").is_file() or _Spool._busy(directory / f"{key}.spool.lock"):
                return label, directory
            if _free_bytes(directory) >= size + _SPOOL_HEADROOM:
                return label, directory
        return None

    @staticmethod
    def _busy(lock: Path) -> bool:
        assert fcntl is not None
        try:
            descriptor = os.open(lock, os.O_RDWR | _NOFOLLOW)
        except OSError:
            return False
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return False
        except BlockingIOError:
            return True
        finally:
            os.close(descriptor)

    @staticmethod
    def _complete(final: Path, size: int) -> Any:
        try:
            descriptor = os.open(final, os.O_RDONLY | _NOFOLLOW)
        except OSError:
            return None
        info = os.fstat(descriptor)
        if stat.S_ISREG(info.st_mode) and info.st_size == size:
            return os.fdopen(descriptor, "rb")
        os.close(descriptor)
        return None

    @classmethod
    def fetch(cls, url: str, size: int, http: _Http, *, chunk: int, workers: int) -> "_Spool | str":
        """The copy (fetched now, or completed by another job), or why there is none."""
        if fcntl is None:
            return "spool_unavailable"
        key = _cache_key("spool", url, size)
        place = cls._place(key, size)
        if place is None:
            return "no_room"
        label, directory = place
        final = directory / f"{key}.spool"
        try:
            users = os.open(directory / f"{key}.spool.users", os.O_RDWR | os.O_CREAT | _NOFOLLOW, 0o600)
        except OSError:
            return "spool_unavailable"
        try:
            fcntl.flock(users, fcntl.LOCK_SH)
            lock = _flock(directory / f"{key}.spool.lock", _spool_wait_seconds())
        except OSError:
            os.close(users)
            return "spool_unavailable"
        if lock is None:
            os.close(users)
            return "spool_busy"
        try:
            file = cls._complete(final, size)
            if file is not None:
                record: dict[str, Any] = {"spool": label, "spoolReused": True, "bytesFetched": 0}
            else:
                for stale in directory.glob(f".{key}.*.part"):
                    stale.unlink(missing_ok=True)
                if _free_bytes(directory) < size + _SPOOL_HEADROOM:
                    raise _SpoolUnusable("no_room")
                part = directory / f".{key}.{os.getpid()}.{threading.get_ident()}.part"
                descriptor = os.open(part, os.O_RDWR | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
                try:
                    try:
                        os.posix_fallocate(descriptor, 0, size)  # the room, taken now
                    except AttributeError:
                        pass
                    except OSError as error:
                        if error.errno in (errno.ENOSPC, errno.EDQUOT):
                            raise _SpoolUnusable("no_room") from None
                        # A file system that cannot reserve space: the free-space check stands.
                    record = {"spool": label, "spoolReused": False,
                              **_fetch_ranges(url, size, http, descriptor, chunk, workers)}
                    os.replace(part, final)
                except BaseException:
                    part.unlink(missing_ok=True)
                    raise
                finally:
                    os.close(descriptor)
                file = cls._complete(final, size)
                if file is None:
                    raise _SpoolUnusable("spool_write_failed")
        except _SpoolUnusable as unusable:
            os.close(users)
            return unusable.reason
        except BaseException:
            os.close(users)
            raise
        finally:
            os.close(lock)  # releases it
        return cls(file, users, directory, key, record)

    def close(self) -> None:
        """Stop reading; the last job reading this copy deletes it."""
        assert fcntl is not None
        inode = os.fstat(self.file.fileno()).st_ino
        self.file.close()
        final = self._directory / f"{self._key}.spool"
        try:
            lock = _flock(self._directory / f"{self._key}.spool.lock", 60)
        except OSError:
            lock = None
        try:
            fcntl.flock(self._users, fcntl.LOCK_UN)
            try:
                fcntl.flock(self._users, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return  # another job reads or waits for this copy; the last one deletes it
            try:
                if os.stat(final, follow_symlinks=False).st_ino == inode:
                    final.unlink()
            except FileNotFoundError:
                pass
        finally:
            os.close(self._users)
            if lock is not None:
                os.close(lock)


def read_whole_file(
    url: str, http: _Http, keep: Callable[[Variant], bool], *, size: int | None = None,
) -> tuple[list[Variant], dict[str, Any]]:
    """A whole harmonised file, keeping the rows ``keep`` accepts: parallel ranges into a
    spool when the server stated its ``size`` and serves ranges, else one stream."""
    limit = _stream_limit()
    if size is not None and size > limit:
        raise OpenSourceError(
            "mr_open_source_too_large",
            f"{url} is {size} bytes, larger than the {limit}-byte limit (EVIMED_MR_OPEN_STREAM_MAX_BYTES).",
        )
    chunk, workers = _fetch_chunk_bytes(), _fetch_workers()
    if not size:
        skipped = "size_unknown"
    elif size <= chunk:
        skipped = "single_chunk"
    else:
        started, mark = time.monotonic(), dict(http.routes)
        spool = _Spool.fetch(url, size, http, chunk=chunk, workers=workers)
        if isinstance(spool, _Spool):
            try:
                kept, read = stream_variants(url, http, keep, source=spool.file)
            finally:
                spool.close()
            read.update(
                mode="ranged", seconds=round(time.monotonic() - started, 1),
                egress=http.routes_since(mark), ranged=spool.record,
            )
            return kept, read
        skipped = spool
        _LOG.info("%s is streamed, not fetched by ranges (%s).", url, skipped)
    kept, read = stream_variants(url, http, keep)
    read["rangedSkipped"] = skipped
    return kept, read


# --- Remote tabix ---------------------------------------------------------------


def _bgzf_blocks(data: bytes) -> Iterator[tuple[int, bytes]]:
    """(offset within ``data``, inflated bytes) for each complete BGZF block."""
    position = 0
    while position + 18 <= len(data):
        if data[position:position + 4] != b"\x1f\x8b\x08\x04":
            raise OpenSourceError("mr_open_source_format", "The summary-statistics file is not BGZF.")
        size = struct.unpack_from("<H", data, position + 16)[0] + 1
        if position + size > len(data):
            return
        yield position, zlib.decompress(data[position + 18:position + size - 8], -15)
        position += size


def _reg2bins(begin: int, end: int) -> list[int]:
    bins = [0]
    end -= 1
    for shift, offset in ((26, 1), (23, 9), (20, 73), (17, 585), (14, 4681)):
        bins.extend(range(offset + (begin >> shift), offset + (end >> shift) + 1))
    return bins


class TabixIndex:
    """A parsed .tbi: which compressed byte ranges can hold a region."""

    def __init__(self, raw: bytes):
        data = gzip.decompress(raw)
        if data[:4] != b"TBI\x01":
            raise OpenSourceError("mr_open_source_format", "The tabix index is not a TBI file.")
        (n_ref, _fmt, col_seq, col_beg, col_end, meta, skip, l_nm) = struct.unpack_from("<8i", data, 4)
        self.col_seq, self.col_beg, self.skip, self.meta = col_seq - 1, col_beg - 1, skip, chr(meta)
        names = data[36:36 + l_nm].split(b"\0")[:n_ref]
        self.names = [name.decode() for name in names]
        position = 36 + l_nm
        self.refs: list[tuple[dict[int, list[tuple[int, int]]], list[int]]] = []
        for _ in range(n_ref):
            (n_bin,) = struct.unpack_from("<i", data, position)
            position += 4
            bins: dict[int, list[tuple[int, int]]] = {}
            for _ in range(n_bin):
                bin_id, n_chunk = struct.unpack_from("<Ii", data, position)
                position += 8
                chunks = list(struct.iter_unpack("<QQ", data[position:position + 16 * n_chunk]))
                position += 16 * n_chunk
                bins[bin_id] = chunks
            (n_intv,) = struct.unpack_from("<i", data, position)
            position += 4
            linear = [value for (value,) in struct.iter_unpack("<Q", data[position:position + 8 * n_intv])]
            position += 8 * n_intv
            self.refs.append((bins, linear))

    def chunks(self, chrom: str, begin: int, end: int) -> list[tuple[int, int]]:
        name = next((n for n in (chrom, f"chr{chrom}", chrom.removeprefix("chr")) if n in self.names), None)
        if name is None:
            return []
        bins, linear = self.refs[self.names.index(name)]
        minimum = linear[min(begin >> 14, len(linear) - 1)] if linear else 0
        found = sorted(
            (start, stop) for bin_id in _reg2bins(begin, end) for start, stop in bins.get(bin_id, [])
            if stop > minimum
        )
        merged: list[tuple[int, int]] = []
        for start, stop in found:
            start = max(start, minimum)
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], stop))
            else:
                merged.append((start, stop))
        return merged


class RemoteTabix:
    """Single-position reads of a bgzip + tabix file over HTTP Range requests."""

    def __init__(self, url: str, index_url: str, http: _Http, *, data_bytes: int | None = None):
        self.url, self.http = url, http
        key = _cache_key("tbi", index_url, data_bytes) if data_bytes else None
        raw = _cache_read(key, ".tbi") if key else None
        self.index_cached = raw is not None
        if raw is None:
            raw = http.read(index_url, limit=64 * 1024 * 1024)
        self.index = TabixIndex(raw)
        if key and not self.index_cached:
            _cache_write(key, ".tbi", raw)
        self.header: list[str] | None = None
        self.columns: _Columns | None = None
        self.ranges = 0
        self._count = threading.Lock()

    def _read_header(self) -> None:
        data = self.http.read(self.url, headers={"Range": f"bytes=0-{_BGZF_MAX_BLOCK * 2}"}, limit=_BGZF_MAX_BLOCK * 3)
        text = b"".join(block for _, block in _bgzf_blocks(data)).decode("utf-8", "replace")
        first = text.split("\n", 1)[0].rstrip("\r")
        self.header = first.split("\t")
        self.columns = _Columns(self.header)

    def fetch(self, chrom: str, pos: int) -> list[Variant]:
        if self.columns is None:
            self._read_header()
        assert self.columns is not None
        found: list[Variant] = []
        for start, stop in self.index.chunks(chrom, pos - 1, pos):
            first, last = start >> 16, stop >> 16
            data = self.http.read(
                self.url,
                headers={"Range": f"bytes={first}-{last + _BGZF_MAX_BLOCK}"},
                limit=last - first + 2 * _BGZF_MAX_BLOCK,
            )
            with self._count:
                self.ranges += 1
            pieces = []
            for offset, block in _bgzf_blocks(data):
                absolute = first + offset
                if absolute > last:
                    break
                begin = (start & 0xFFFF) if absolute == first else 0
                stop_at = (stop & 0xFFFF) if absolute == last else len(block)
                pieces.append(block[begin:stop_at])
            for line in b"".join(pieces).decode("utf-8", "replace").split("\n"):
                fields = line.rstrip("\r").split("\t")
                if len(fields) <= max(self.index.col_seq, self.index.col_beg) or line.startswith(self.index.meta):
                    continue
                if fields[self.index.col_seq].removeprefix("chr") != chrom.removeprefix("chr"):
                    continue
                try:
                    if int(fields[self.index.col_beg]) != pos:
                        continue
                except ValueError:
                    continue
                variant = self.columns.variant(fields)
                if variant is not None:
                    found.append(variant)
        return found


# --- Instrument selection -------------------------------------------------------


def distance_clump(variants: list[Variant], window_kb: int = CLUMP_WINDOW_KB) -> list[Variant]:
    """Most significant first; drop any variant within ``window_kb`` of one kept."""
    kept: list[Variant] = []
    by_chrom: dict[str, list[int]] = {}
    for variant in sorted(variants, key=lambda item: (item.pval, -abs(item.beta / item.se), item.snp)):
        positions = by_chrom.setdefault(variant.chrom, [])
        at = bisect.bisect_left(positions, variant.pos)
        window = window_kb * 1000
        near = (at < len(positions) and positions[at] - variant.pos <= window) or (
            at > 0 and variant.pos - positions[at - 1] <= window
        )
        if near:
            continue
        positions.insert(at, variant.pos)
        kept.append(variant)
    return kept


def ld_reference() -> tuple[str, str] | None:
    """(plink binary, bfile prefix) when a local LD reference is configured."""
    bfile = os.getenv("EVIMED_MR_LD_BFILE", "").strip()
    plink = os.getenv("EVIMED_MR_PLINK_BIN", "").strip() or (shutil.which("plink") or "")
    if not bfile or not plink or not Path(f"{bfile}.bed").is_file() or not os.access(plink, os.X_OK):
        return None
    return plink, bfile


def plink_clump(variants: list[Variant], plink: str, bfile: str) -> tuple[list[Variant], int]:
    """PLINK 1.9 clumping (r2 < 0.001 within 10 Mb); returns (index variants, variants absent from the panel)."""
    with tempfile.TemporaryDirectory(prefix="evimed-mr-clump-") as scratch:
        assoc = Path(scratch) / "assoc.txt"
        assoc.write_text(
            "SNP\tP\n" + "".join(f"{variant.snp}\t{variant.pval!r}\n" for variant in variants), encoding="utf-8"
        )
        completed = subprocess.run(
            [plink, "--bfile", bfile, "--clump", str(assoc), "--clump-p1", "1", "--clump-p2", "1",
             "--clump-r2", str(CLUMP_R2), "--clump-kb", str(CLUMP_WINDOW_KB), "--out", str(Path(scratch) / "out")],
            capture_output=True, text=True, timeout=600, check=False,
        )
        result = Path(scratch) / "out.clumped"
        if completed.returncode != 0 or not result.is_file():
            raise OpenSourceError("mr_open_clumping_failed", "PLINK clumping against the LD reference failed.")
        index = set()
        for line in result.read_text(encoding="utf-8").splitlines()[1:]:
            fields = line.split()
            if len(fields) > 2:
                index.add(fields[2])
        with open(f"{bfile}.bim", encoding="utf-8") as bim:
            wanted = {variant.snp for variant in variants}
            present = {fields[1] for fields in (line.split() for line in bim) if len(fields) > 1 and fields[1] in wanted}
    return [variant for variant in variants if variant.snp in index], len(wanted - present)


def curated_leads(accession: str, http: _Http) -> list[tuple[str, str, int]]:
    """(rsid, chromosome, GRCh38 position) of the study's curated associations."""
    leads: dict[str, tuple[str, str, int]] = {}
    page, pages = 0, 1
    while page < pages and page < 20:
        payload = http.json(f"{CATALOG_API}/associations?accession_id={accession}&size=1000&page={page}")
        pages = int(((payload or {}).get("page") or {}).get("totalPages") or 1)
        for row in ((payload or {}).get("_embedded") or {}).get("associations") or []:
            alleles = row.get("snp_allele") or []
            locations = row.get("locations") or []
            for allele in alleles if isinstance(alleles, list) else []:
                rsid = str((allele or {}).get("rs_id") or "")
                if not _RSID.fullmatch(rsid):
                    continue
                for location in locations if isinstance(locations, list) else []:
                    chrom, _, pos = str(location).partition(":")
                    if pos.isdigit():
                        leads.setdefault(rsid, (rsid, chrom, int(pos)))
        page += 1
    return list(leads.values())


# --- The pair -------------------------------------------------------------------


@dataclass
class OpenPair:
    exposure_rows: list[Variant]
    outcome_rows: list[Variant]
    record: dict[str, Any] = field(default_factory=dict)


def _scan_significant(
    study: CatalogStudy, http: _Http, p_threshold: float
) -> tuple[list[Variant], dict[str, Any]]:
    """Every variant under ``p_threshold`` in a streamed file, reused when already read."""
    key = (
        _cache_key("scan", study.harmonised_url, study.harmonised_bytes, repr(p_threshold))
        if study.harmonised_bytes else None
    )
    cached = _cache_read(key, ".json") if key else None
    if cached is not None:
        try:
            stored = json.loads(cached)
            variants = [Variant(**row) for row in stored["variants"]]
            return variants, {**stored["read"], "reusedFromCache": True}
        except (ValueError, TypeError, KeyError):
            pass
    variants, read = read_whole_file(
        study.harmonised_url, http, lambda variant: variant.pval < p_threshold, size=study.harmonised_bytes,
    )
    read["candidateSource"] = "genome-wide scan of the harmonised file"
    read["readAt"] = _now()
    if key:
        _cache_write(key, ".json", json.dumps({
            "read": read, "variants": [variant.__dict__ for variant in variants],
        }).encode("utf-8"))
    return variants, read


def _fetch_many(reader: RemoteTabix, wanted: Iterable[tuple[str, str, int]]) -> dict[str, Variant]:
    """Each wanted position read from the tabix file, several at a time.

    One position is one ~70 KB Range request, and on the Beijing-Tokyo link a
    request took about 20 s (2026-09-28, production): read one after another,
    a study with a few hundred lead variants took hours while the connection
    sat idle between answers. The reads are independent, so they run on the
    same worker bound as a whole-file fetch; each worker keeps its own tunnel
    (`_Egress` pools idle tunnels per thread). The answer does not depend on
    the order the reads finish in: results are collected in the order asked.
    """
    items = list(wanted)
    if not items:
        return {}
    if reader.columns is None:
        reader._read_header()  # once, before the workers share the reader

    def one(item: tuple[str, str, int]) -> tuple[str, Variant | None]:
        rsid, chrom, pos = item
        for variant in reader.fetch(chrom, pos):
            if variant.snp == rsid:
                return rsid, variant
        return rsid, None

    workers = min(_fetch_workers(), len(items))
    if workers <= 1:
        results = [one(item) for item in items]
    else:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="evimed-mr-tabix") as pool:
            results = list(pool.map(one, items))
    found: dict[str, Variant] = {}
    for rsid, variant in results:
        if variant is not None and rsid not in found:
            found[rsid] = variant
    return found


def build_pair(
    exposure_source: dict[str, Any],
    outcome_source: dict[str, Any],
    *,
    http: _Http | None = None,
    p_threshold: float = GENOME_WIDE_P,
) -> OpenPair:
    """Exposure instruments and their outcome rows, read from two catalogue studies."""
    http = http or _Http()
    try:
        return _build_pair(exposure_source, outcome_source, http, p_threshold)
    finally:
        http.egress.close_idle()


def _build_pair(
    exposure_source: dict[str, Any], outcome_source: dict[str, Any], http: _Http, p_threshold: float,
) -> OpenPair:
    started = time.monotonic()
    exposure = locate_harmonised_file(resolve_study(exposure_source, http), http)
    outcome = locate_harmonised_file(resolve_study(outcome_source, http), http)
    if exposure.accession == outcome.accession:
        raise OpenSourceError("mr_open_source_invalid", "Exposure and outcome are the same GWAS Catalog study.")

    if exposure.index_url:
        mark = dict(http.routes)
        reader = RemoteTabix(exposure.harmonised_url, exposure.index_url, http, data_bytes=exposure.harmonised_bytes)
        leads = curated_leads(exposure.accession, http)
        candidates = [variant for variant in _fetch_many(reader, leads).values() if variant.pval < p_threshold]
        exposure_read = {
            "mode": "tabix", "url": exposure.harmonised_url, "index": exposure.index_url,
            "candidateSource": "GWAS Catalog curated associations for the study, re-read from its harmonised file",
            "candidatesListed": len(leads), "rangeRequests": reader.ranges, "egress": http.routes_since(mark),
        }
    else:
        candidates, exposure_read = _scan_significant(exposure, http, p_threshold)
    # One row per rsid: a duplicated rsid keeps its most significant row.
    unique: dict[str, Variant] = {}
    for variant in sorted(candidates, key=lambda item: item.pval):
        unique.setdefault(variant.snp, variant)
    candidates = list(unique.values())
    if len(candidates) < 3:
        raise OpenSourceError(
            "mr_open_no_instruments",
            f"{exposure.accession} has {len(candidates)} variant(s) at p < {p_threshold:g}; at least 3 are needed.",
        )

    reference = ld_reference()
    if reference is not None:
        instruments, absent = plink_clump(candidates, *reference)
        clumping = {
            "method": "plink_ld_clumping", "r2": CLUMP_R2, "windowKb": CLUMP_WINDOW_KB,
            "reference": Path(reference[1]).name, "variantsAbsentFromReference": absent,
            "ldChecked": True,
        }
    else:
        instruments = distance_clump(candidates)
        clumping = {
            "method": "distance_pruning", "windowKb": CLUMP_WINDOW_KB, "ldChecked": False,
            "note": "No LD reference was configured: the most significant variant per 10,000 kb window was "
                    "kept. This is stricter than r2 < 0.001 clumping within 10,000 kb and does not measure LD.",
        }
    if len(instruments) < 3:
        raise OpenSourceError(
            "mr_open_no_instruments", f"{len(instruments)} instrument(s) remained after clumping; at least 3 are needed."
        )

    wanted = [(variant.snp, variant.chrom, variant.pos) for variant in instruments]
    if outcome.index_url:
        mark = dict(http.routes)
        reader = RemoteTabix(outcome.harmonised_url, outcome.index_url, http, data_bytes=outcome.harmonised_bytes)
        matches = _fetch_many(reader, wanted)
        outcome_read = {"mode": "tabix", "url": outcome.harmonised_url, "index": outcome.index_url,
                        "rangeRequests": reader.ranges, "egress": http.routes_since(mark)}
    else:
        names = {variant.snp for variant in instruments}
        rows, outcome_read = read_whole_file(
            outcome.harmonised_url, http, lambda variant: variant.snp in names, size=outcome.harmonised_bytes,
        )
        matches = {}
        for variant in rows:
            matches.setdefault(variant.snp, variant)
    outcome_rows = [matches[variant.snp] for variant in instruments if variant.snp in matches]
    missing = [variant.snp for variant in instruments if variant.snp not in matches]
    exposure.samples = read_sample_metadata(exposure, http)
    outcome.samples = read_sample_metadata(outcome, http)
    instruments, exposure_sizes = with_study_sample_size(instruments, exposure.samples)
    outcome_rows, outcome_sizes = with_study_sample_size(outcome_rows, outcome.samples)

    record = {
        "schemaVersion": 1,
        "dataSource": "gwas_catalog",
        "retrievedAt": _now(),
        "exposure": {**exposure.record(), "read": exposure_read, "sampleSize": exposure_sizes},
        "outcome": {**outcome.record(), "read": outcome_read, "sampleSize": outcome_sizes},
        "instrumentSelection": {
            "pThreshold": p_threshold,
            "genomeWideSignificantVariants": len(candidates),
            "afterClumping": len(instruments),
            **clumping,
        },
        "outcomeLookup": {
            "instrumentsFound": len(outcome_rows),
            "instrumentsUnavailableInOutcome": len(missing),
            "unavailableVariants": missing[:500],
            "proxies": "none — a variant absent from the outcome file is dropped, not replaced",
        },
        "http": {
            "requests": http.requests, "bytes": http.bytes, "seconds": round(time.monotonic() - started, 1),
            "egress": http.egress.record(http.routes),
        },
    }
    return OpenPair(exposure_rows=instruments, outcome_rows=outcome_rows, record=record)


def csv_bytes(variants: list[Variant]) -> bytes:
    """The standard columns the engine's local path reads, one row per variant."""
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_COLUMNS, lineterminator="\n")
    writer.writeheader()
    for variant in variants:
        writer.writerow(variant.row())
    return buffer.getvalue().encode("utf-8")


def selection_record(record: dict[str, Any]) -> dict[str, Any]:
    """What instrument-selection.json says for an open-data run."""
    selection = record["instrumentSelection"]
    return {
        "mode": "gwas_catalog",
        "source": record["exposure"]["accession"],
        "provenance": provenance_sentence(record),
        "ld_rechecked": False,
        **{key: selection[key] for key in (
            "method", "pThreshold", "genomeWideSignificantVariants", "afterClumping", "windowKb", "ldChecked",
        ) if key in selection},
        **({"r2": selection["r2"], "reference": selection["reference"]}
           if selection.get("method") == "plink_ld_clumping" else {}),
    }


def provenance_sentence(record: dict[str, Any]) -> str:
    """The clumping provenance the local engine records with preclumped instruments."""
    exposure = record["exposure"]
    selection = record["instrumentSelection"]
    if selection["method"] == "plink_ld_clumping":
        how = (f"PLINK clumping r2<{selection['r2']} within {selection['windowKb']} kb against the "
               f"{selection['reference']} LD reference")
    else:
        how = f"distance pruning, one variant per {selection['windowKb']} kb window, no LD reference"
    return (
        f"GWAS Catalog {exposure['accession']} (PMID {exposure['pubmedId']}), harmonised file "
        f"{exposure['harmonisedFile']}; variants at p<{selection['pThreshold']:g} "
        f"({selection['genomeWideSignificantVariants']}) selected by {how} "
        f"({selection['afterClumping']} kept); read {record['retrievedAt']}."
    )
