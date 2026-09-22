"""Runtime settings, read once from the environment; secrets are read from files, by path, on use.

Every knob is a ``KNOWLEDGE_PLUGIN_*`` variable with a validated range. Secrets never sit in a
``Settings`` field that could be printed: the object holds file *paths*, and ``secret()`` reads a
file when it is needed (cached by mtime, so a rotated key is picked up without a restart). An
absent file, an unset path and an empty file (``/dev/null`` is how compose says "no key") all mean
"not configured".

The contact address that goes into the crawler's User-Agent is the one exception to "paths only":
production passes the existing Unpaywall address as a plain value (``KNOWLEDGE_PLUGIN_CONTACT_EMAIL``)
while local runs point at a file (``KNOWLEDGE_PLUGIN_CONTACT_EMAIL_FILE``); the file wins when both
are set. Either way it is held outside ``repr`` and never logged.

Container facts this module respects (deployment, 2026-09-22): the image runs as uid 10002 with a
read-only root filesystem and a tmpfs ``/tmp``, so nothing here writes to disk.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from . import __version__

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent


class SettingsError(ValueError):
    """A ``KNOWLEDGE_PLUGIN_*`` value is missing or out of range; the message names the variable."""


@dataclass(frozen=True)
class EnrichmentEndpoints:
    """The public APIs `/text` enrichment reads (plan 10.3.4). They were rows of the probe list
    (PubMed esummary, Europe PMC by DOI, Unpaywall) and moved here: they are tools, not sources."""

    pubmed_esearch: str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    pubmed_efetch: str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    pubmed_esummary: str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
    europepmc_search: str = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
    crossref_works: str = "https://api.crossref.org/works"
    unpaywall: str = "https://api.unpaywall.org/v2"
    ctgov_studies: str = "https://clinicaltrials.gov/api/v2/studies"


def _int(env: dict, name: str, default: int, low: int, high: int) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        raise SettingsError(f"{name} must be an integer") from None
    if not low <= value <= high:
        raise SettingsError(f"{name} must be between {low} and {high}")
    return value


def _float(env: dict, name: str, default: float, low: float, high: float) -> float:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw.strip())
    except ValueError:
        raise SettingsError(f"{name} must be a number") from None
    if not low <= value <= high:
        raise SettingsError(f"{name} must be between {low} and {high}")
    return value


def _bool(env: dict, name: str, default: bool) -> bool:
    raw = (env.get(name) or "").strip().lower()
    if raw == "":
        return default
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise SettingsError(f"{name} must be 1/0 or true/false")


def _path(env: dict, name: str) -> str | None:
    raw = (env.get(name) or "").strip()
    return raw or None


@dataclass(frozen=True)
class Settings:
    database_url: str
    database_password_file: str | None = None
    token_file: str | None = None
    contact_email_file: str | None = None
    contact_email_value: str | None = field(default=None, repr=False)
    ncbi_key_file: str | None = None
    openfda_key_file: str | None = None
    evimed_api_key_file: str | None = None           # batch 3 (lookups); reserved
    edge_proxy_credentials_file: str | None = None   # relay egress: "user:password", by path
    edge_proxy_url: str | None = None                # relay egress: https://<Tokyo node> (http: for tests)
    browser_cdp_url: str | None = None               # browser egress: http://frontier-browser:9222
    crawl_enabled: bool = True
    host: str = "0.0.0.0"
    port: int = 8080
    registry_path: str = str(PROJECT_ROOT / "registry" / "sources.json")
    concurrency: int = 4
    text_concurrency: int = 2
    tick_s: float = 5.0
    lease_s: int = 600
    pool_max: int = 8
    request_timeout_s: float = 35.0
    browser_timeout_s: float = 60.0
    edge_proxy_connect_timeout_s: float = 10.0
    max_body_bytes: int = 16 * 1024 * 1024
    max_redirects: int = 5
    robots_ttl_s: int = 3600
    worker_id: str = field(default_factory=lambda: f"{socket.gethostname()}:{os.getpid()}")
    build: str = "dev"
    version: str = __version__
    log_level: str = "INFO"
    enrichment: EnrichmentEndpoints = field(default_factory=EnrichmentEndpoints)

    @classmethod
    def from_env(cls, environ: dict | None = None) -> "Settings":
        env = dict(os.environ if environ is None else environ)
        database_url = (env.get("KNOWLEDGE_PLUGIN_DATABASE_URL") or "").strip()
        if not database_url:
            raise SettingsError("KNOWLEDGE_PLUGIN_DATABASE_URL is required")
        log_level = (env.get("KNOWLEDGE_PLUGIN_LOG_LEVEL") or "INFO").strip().upper()
        if log_level not in ("DEBUG", "INFO", "WARNING", "ERROR"):
            raise SettingsError("KNOWLEDGE_PLUGIN_LOG_LEVEL must be DEBUG, INFO, WARNING or ERROR")
        build = (env.get("KNOWLEDGE_PLUGIN_BUILD") or "dev").strip() or "dev"
        if len(build) > 100:
            raise SettingsError("KNOWLEDGE_PLUGIN_BUILD must be at most 100 characters")
        registry_path = _path(env, "KNOWLEDGE_PLUGIN_REGISTRY") or str(PROJECT_ROOT / "registry" / "sources.json")
        worker_id = (env.get("KNOWLEDGE_PLUGIN_WORKER_ID") or "").strip() or f"{socket.gethostname()}:{os.getpid()}"
        return cls(
            database_url=database_url,
            database_password_file=_path(env, "KNOWLEDGE_PLUGIN_DATABASE_PASSWORD_FILE"),
            token_file=_path(env, "KNOWLEDGE_PLUGIN_TOKEN_FILE"),
            contact_email_file=_path(env, "KNOWLEDGE_PLUGIN_CONTACT_EMAIL_FILE"),
            contact_email_value=(env.get("KNOWLEDGE_PLUGIN_CONTACT_EMAIL") or "").strip() or None,
            ncbi_key_file=_path(env, "KNOWLEDGE_PLUGIN_NCBI_KEY_FILE"),
            openfda_key_file=_path(env, "KNOWLEDGE_PLUGIN_OPENFDA_KEY_FILE"),
            evimed_api_key_file=_path(env, "KNOWLEDGE_PLUGIN_EVIMED_API_KEY_FILE"),
            edge_proxy_credentials_file=_path(env, "KNOWLEDGE_PLUGIN_EDGE_PROXY_CREDENTIALS_FILE"),
            edge_proxy_url=_path(env, "KNOWLEDGE_PLUGIN_EDGE_PROXY_URL"),
            browser_cdp_url=_path(env, "KNOWLEDGE_PLUGIN_BROWSER_CDP_URL"),
            browser_timeout_s=_float(env, "KNOWLEDGE_PLUGIN_BROWSER_TIMEOUT_S", 60.0, 10.0, 300.0),
            crawl_enabled=_bool(env, "KNOWLEDGE_PLUGIN_CRAWL", True),
            host=(env.get("KNOWLEDGE_PLUGIN_HOST") or "0.0.0.0").strip(),
            port=_int(env, "KNOWLEDGE_PLUGIN_PORT", 8080, 1, 65535),
            registry_path=registry_path,
            concurrency=_int(env, "KNOWLEDGE_PLUGIN_CONCURRENCY", 4, 1, 16),
            text_concurrency=_int(env, "KNOWLEDGE_PLUGIN_TEXT_CONCURRENCY", 2, 0, 8),
            tick_s=_float(env, "KNOWLEDGE_PLUGIN_TICK_S", 5.0, 0.5, 60.0),
            lease_s=_int(env, "KNOWLEDGE_PLUGIN_LEASE_S", 600, 60, 3600),
            pool_max=_int(env, "KNOWLEDGE_PLUGIN_DB_POOL_MAX", 8, 2, 32),
            request_timeout_s=_float(env, "KNOWLEDGE_PLUGIN_REQUEST_TIMEOUT_S", 35.0, 5.0, 120.0),
            worker_id=worker_id[:100],
            build=build,
            log_level=log_level,
        )

    # ------------------------------------------------------------------ secrets, by path, on use

    def secret(self, name: str) -> str | None:
        """The stripped content of a secret file, or ``None`` when not configured."""
        path = {
            "database_password": self.database_password_file,
            "token": self.token_file,
            "contact_email": self.contact_email_file,
            "ncbi_key": self.ncbi_key_file,
            "openfda_key": self.openfda_key_file,
            "evimed_api_key": self.evimed_api_key_file,
            "edge_proxy_credentials": self.edge_proxy_credentials_file,
        }[name]
        return read_secret_file(path)

    def contact_email(self) -> str | None:
        """The crawler's contact address: the file when set and non-empty, else the plain value."""
        return self.secret("contact_email") or self.contact_email_value

    def edge_proxy(self) -> "EdgeProxy | None":
        """The Tokyo TLS forward proxy, or ``None`` when this deployment has none (or it is misconfigured:
        a URL with credentials, a path or a query, or a credentials file that is not ``user:password``)."""
        return edge_proxy_from(self.edge_proxy_url, self.secret("edge_proxy_credentials"),
                               connect_timeout_s=self.edge_proxy_connect_timeout_s)

    def has_ncbi_key(self) -> bool:
        return bool(self.secret("ncbi_key"))

    def has_openfda_key(self) -> bool:
        return bool(self.secret("openfda_key"))


_SECRET_CACHE: dict[str, tuple[tuple[int, int, int], str | None]] = {}


def read_secret_file(path: str | None) -> str | None:
    """Read a secret file; unset, missing and empty all mean ``None``. Cached by (inode, mtime, size)."""
    if not path:
        return None
    try:
        stat = os.stat(path)
    except OSError:
        return None
    stamp = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
    cached = _SECRET_CACHE.get(path)
    if cached and cached[0] == stamp:
        return cached[1]
    try:
        with open(path, encoding="utf-8") as handle:
            value = handle.read().strip() or None
    except OSError:
        value = None
    _SECRET_CACHE[path] = (stamp, value)
    return value


@dataclass(frozen=True)
class EdgeProxy:
    """A validated relay: where the proxy is, and the Basic credentials (kept out of ``repr``)."""

    url: str                      # scheme://host[:port], no path, no credentials
    username: str = field(repr=False)
    password: str = field(repr=False)
    connect_timeout_s: float = 10.0


def edge_proxy_from(url: str | None, credentials: str | None, *, connect_timeout_s: float = 10.0) -> EdgeProxy | None:
    """Parse the relay configuration the way the platform's ``edgeProxy.mjs`` does: an ``https:``
    proxy URL (``http:`` accepted for tests) with no userinfo, path or query, and credentials
    ``user:password`` from a file. Anything else is "no relay" — refused by name, never guessed."""
    if not url or not credentials:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme not in ("https", "http") or not parts.hostname:
        return None
    if parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
        return None
    user, sep, password = credentials.partition(":")
    if not sep or not user or not password or any(ch.isspace() for ch in user + password):
        return None
    base = f"{parts.scheme}://{parts.netloc}"
    return EdgeProxy(url=base, username=user, password=password, connect_timeout_s=connect_timeout_s)
