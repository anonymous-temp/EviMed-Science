"""Frozen, report-level FAERS data sources for reproducible analyses."""

from .frozen import (
    ComparativeContingencyCounts,
    ContingencyCounts,
    DrugEntry,
    DrugScope,
    FrozenFAERSSnapshot,
    ReportRecord,
    SnapshotProvenance,
    TherapyStrataCounts,
    TimeToOnsetData,
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
    "ComparativeContingencyCounts",
    "ContingencyCounts",
    "DrugEntry",
    "DrugScope",
    "FrozenFAERSSnapshot",
    "ReportRecord",
    "SnapshotProvenance",
    "SQLiteFAERSSnapshot",
    "TherapyStrataCounts",
    "TimeToOnsetData",
    "load_faers_snapshot",
    "write_sqlite_snapshot",
]
