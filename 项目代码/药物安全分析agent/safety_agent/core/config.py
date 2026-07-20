"""Runtime configuration loaded from environment variables / .env.

Secret fields (API keys, OSS credentials) are never logged or serialized
into outputs; they default to empty strings so the data + statistics
layers work without any secret material.
"""

from __future__ import annotations

from datetime import date
from functools import lru_cache
import os
from pathlib import Path
import stat

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root = the directory that contains the ``safety_agent`` package.
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Environment-driven settings; every key maps 1:1 to .env.example."""

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # LLM (used from P4 on for text interpretation only, never for statistics)
    deepseek_api_key: SecretStr = SecretStr("")
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_flash_model: str = "deepseek-chat"
    deepseek_pro_model: str = "deepseek-reasoner"

    # openFDA
    openfda_base_url: str = "https://api.fda.gov"
    openfda_api_key: SecretStr = SecretStr("")

    # Optional frozen, report-level FAERS snapshot. When configured, all
    # overview and signal counts use exact same-drug-object ROLE_COD binding.
    faers_snapshot_path: Path | None = None
    faers_drug_aliases: str = ""
    faers_suspect_roles: str = "PS"
    faers_administration_routes: str = ""
    faers_study_date_from: date | None = None
    faers_study_date_to: date | None = None
    faers_background_date_from: date | None = None
    faers_background_date_to: date | None = None
    gps_prior_artifact_path: Path | None = None

    # Two-level response cache
    cache_dir: Path = Path(".cache/openfda")
    cache_ttl_hours: float = Field(default=24.0, ge=0.0)
    cache_max_memory_entries: int = Field(default=2048, ge=1, le=100_000)

    # Java WebSocket backend (P5)
    java_ws_url: str = ""
    java_token_url: str = ""

    # OSS report upload (P5)
    oss_access_key_id: SecretStr = SecretStr("")
    oss_access_key_secret: SecretStr = SecretStr("")
    oss_endpoint: str = "https://oss-cn-beijing.aliyuncs.com"
    oss_bucket_name: str = ""
    oss_public_base_url: str = ""

    # EviMed evidence retrieval API (P4, optional)
    evimed_evidence_search_url: str = ""
    evimed_evidence_search_key: SecretStr = SecretStr("")
    evimed_evidence_search_key_file: Path | None = None

    # Service
    service_port: int = Field(default=6010, ge=1, le=65535)
    log_level: str = "INFO"
    max_concurrent_sessions: int = Field(default=8, ge=1, le=64)

    @property
    def resolved_cache_dir(self) -> Path:
        """Absolute cache directory, relative paths anchor at project root."""
        if self.cache_dir.is_absolute():
            return self.cache_dir
        return PROJECT_ROOT / self.cache_dir

    @property
    def resolved_faers_snapshot_path(self) -> Path | None:
        if self.faers_snapshot_path is None:
            return None
        if self.faers_snapshot_path.is_absolute():
            return self.faers_snapshot_path
        return PROJECT_ROOT / self.faers_snapshot_path

    @property
    def resolved_gps_prior_artifact_path(self) -> Path | None:
        if self.gps_prior_artifact_path is None:
            return None
        if self.gps_prior_artifact_path.is_absolute():
            return self.gps_prior_artifact_path
        return PROJECT_ROOT / self.gps_prior_artifact_path

    @property
    def parsed_faers_drug_aliases(self) -> tuple[str, ...]:
        return _csv_values(self.faers_drug_aliases)

    @property
    def parsed_faers_suspect_roles(self) -> frozenset[str]:
        values = _csv_values(self.faers_suspect_roles)
        return frozenset(value.upper() for value in values or ("PS",))

    @property
    def parsed_faers_administration_routes(self) -> tuple[str, ...]:
        return _csv_values(self.faers_administration_routes)

    @property
    def cache_ttl_seconds(self) -> float:
        return self.cache_ttl_hours * 3600.0

    @property
    def resolved_evimed_evidence_search_key(self) -> SecretStr:
        """Load the evidence credential without placing it in source or .env."""
        configured = self.evimed_evidence_search_key.get_secret_value().strip()
        if configured:
            return SecretStr(configured)
        if self.evimed_evidence_search_key_file is None:
            return SecretStr("")
        return SecretStr(_read_private_secret(self.evimed_evidence_search_key_file))


def _read_private_secret(path: Path, *, max_bytes: int = 4096) -> str:
    """Read one owner-only credential from a regular, non-symlink file."""
    candidate = path.expanduser()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(candidate, flags)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("EviMed evidence API key file must be a regular file")
        if metadata.st_size <= 0 or metadata.st_size > max_bytes:
            raise ValueError("EviMed evidence API key file has an invalid size")
        if os.name != "nt" and metadata.st_mode & 0o077:
            raise ValueError("EviMed evidence API key file must use owner-only permissions")
        payload = os.read(descriptor, max_bytes + 1)
    except OSError as error:
        raise ValueError("EviMed evidence API key file is unavailable") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if len(payload) > max_bytes:
        raise ValueError("EviMed evidence API key file has an invalid size")
    try:
        value = payload.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise ValueError("EviMed evidence API key file must be UTF-8") from error
    if not value or any(character.isspace() for character in value):
        raise ValueError("EviMed evidence API key file must contain one credential")
    return value


def _csv_values(value: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(item.strip() for item in value.split(",") if item.strip()))


@lru_cache
def get_settings() -> Settings:
    """Process-wide cached settings instance."""
    return Settings()
