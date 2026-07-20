"""Frozen, report-level FAERS data sources for reproducible analyses."""

from .frozen import (
    ContingencyCounts,
    DrugEntry,
    DrugScope,
    FrozenFAERSSnapshot,
    SnapshotProvenance,
)
from .sqlite import SQLiteFAERSSnapshot, write_sqlite_snapshot


def load_faers_snapshot(path):
    """Load JSON regression fixtures or indexed SQLite production snapshots."""
    from pathlib import Path

    source = Path(path)
    if source.suffix.casefold() in {".sqlite", ".sqlite3", ".db"}:
        return SQLiteFAERSSnapshot.from_path(source)
    if source.stat().st_size > 10 * 1024 * 1024:
        raise ValueError(
            "JSON FAERS snapshots are fixture-only; use an indexed SQLite snapshot"
        )
    return FrozenFAERSSnapshot.from_path(source)

__all__ = [
    "ContingencyCounts",
    "DrugEntry",
    "DrugScope",
    "FrozenFAERSSnapshot",
    "SnapshotProvenance",
    "SQLiteFAERSSnapshot",
    "load_faers_snapshot",
    "write_sqlite_snapshot",
]
