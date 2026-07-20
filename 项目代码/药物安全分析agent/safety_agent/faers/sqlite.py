"""Indexed SQLite backend for production-scale frozen FAERS snapshots."""

from __future__ import annotations

import hashlib
import os
import sqlite3
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import quote

from safety_agent.analysis.models import CaseOverview, CountBucket

from .frozen import (
    ContingencyCounts,
    DrugScope,
    ReportRecord,
    SnapshotProvenance,
    _term,
)

_SCHEMA_VERSION = "1"
_DDL = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE reports (
    primary_id TEXT PRIMARY KEY CHECK (length(trim(primary_id)) > 0),
    case_id TEXT NOT NULL UNIQUE CHECK (length(trim(case_id)) > 0),
    case_version INTEGER NOT NULL CHECK (case_version >= 1),
    received_date TEXT NOT NULL CHECK (length(received_date) = 10),
    sex TEXT CHECK (sex IS NULL OR length(trim(sex)) > 0),
    age_years REAL CHECK (age_years IS NULL OR age_years >= 0),
    country TEXT CHECK (country IS NULL OR length(trim(country)) > 0)
);
CREATE TABLE drugs (
    report_id TEXT NOT NULL REFERENCES reports(primary_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    medicinal_product TEXT NOT NULL CHECK (length(trim(medicinal_product)) > 0),
    role_code TEXT NOT NULL CHECK (role_code IN ('PS', 'SS', 'C', 'I')),
    indication TEXT CHECK (indication IS NULL OR length(trim(indication)) > 0),
    PRIMARY KEY (report_id, ordinal)
);
CREATE TABLE drug_names (
    report_id TEXT NOT NULL,
    drug_ordinal INTEGER NOT NULL,
    normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
    PRIMARY KEY (report_id, drug_ordinal, normalized_name),
    FOREIGN KEY (report_id, drug_ordinal) REFERENCES drugs(report_id, ordinal)
        ON DELETE CASCADE
);
CREATE TABLE reactions (
    report_id TEXT NOT NULL REFERENCES reports(primary_id) ON DELETE CASCADE,
    term TEXT NOT NULL CHECK (length(trim(term)) > 0),
    PRIMARY KEY (report_id, term)
);
CREATE TABLE outcomes (
    report_id TEXT NOT NULL REFERENCES reports(primary_id) ON DELETE CASCADE,
    term TEXT NOT NULL CHECK (length(trim(term)) > 0),
    PRIMARY KEY (report_id, term)
);
CREATE INDEX reports_received_date_idx ON reports(received_date);
CREATE INDEX drugs_role_idx ON drugs(role_code, report_id);
CREATE INDEX drug_names_name_idx ON drug_names(normalized_name, report_id, drug_ordinal);
CREATE INDEX reactions_term_idx ON reactions(term, report_id);
CREATE INDEX outcomes_term_idx ON outcomes(term, report_id);
"""


class SQLiteFAERSSnapshot:
    """Read-only indexed snapshot; aggregate queries do not materialize reports."""

    def __init__(
        self,
        path: Path,
        provenance: SnapshotProvenance,
        file_identity: tuple[int, int, int, int, int],
    ) -> None:
        self.path = path
        self.provenance = provenance
        self._file_identity = file_identity

    @classmethod
    def from_path(cls, path: str | Path) -> "SQLiteFAERSSnapshot":
        unresolved = Path(path)
        if unresolved.is_symlink():
            raise ValueError("frozen FAERS SQLite snapshot must not be a symlink")
        source = unresolved.resolve()
        if not source.is_file():
            raise ValueError(f"frozen FAERS SQLite snapshot does not exist: {source}")
        if os.name != "nt" and source.stat().st_mode & 0o222:
            raise ValueError("frozen FAERS SQLite snapshot must be read-only")
        identity = _file_identity(source)
        sha256 = _file_sha256(source)
        with _connect_readonly(source) as connection:
            try:
                metadata = dict(connection.execute("SELECT key, value FROM metadata"))
            except sqlite3.DatabaseError as error:
                raise ValueError("invalid frozen FAERS SQLite snapshot") from error
            if metadata.get("schema_version") != _SCHEMA_VERSION:
                raise ValueError("unsupported frozen FAERS SQLite schema")
            if metadata.get("deduplication") != "latest_case_version":
                raise ValueError("unsupported frozen FAERS deduplication")
            required = ("snapshot_id", "source", "extracted_at", "deduplication")
            if any(not metadata.get(key) for key in required):
                raise ValueError("frozen FAERS SQLite snapshot needs provenance metadata")
            _validate_schema(connection)
        if _file_identity(source) != identity:
            raise ValueError("frozen FAERS SQLite snapshot changed during validation")
        return cls(
            source,
            SnapshotProvenance(
                snapshot_id=metadata["snapshot_id"],
                source=metadata["source"],
                extracted_at=metadata["extracted_at"],
                deduplication=metadata["deduplication"],
                sha256=sha256,
            ),
            identity,
        )

    def _connect(self) -> sqlite3.Connection:
        if _file_identity(self.path) != self._file_identity:
            raise ValueError("frozen FAERS SQLite snapshot changed after validation")
        return _connect_readonly(self.path)

    def contingency(self, scope: DrugScope, reaction: str) -> ContingencyCounts:
        target_sql, target_params = _target_report_predicate(scope)
        date_sql, date_params = _date_predicate(scope)
        event_sql = "EXISTS (SELECT 1 FROM reactions rx WHERE rx.report_id = r.primary_id AND rx.term = ?)"
        reaction_term = _term(reaction)
        with self._connect() as connection:
            grand_total = _count(connection, date_sql, date_params)
            drug_total = _count(
                connection,
                _and(date_sql, target_sql),
                (*date_params, *target_params),
            )
            event_total = _count(
                connection,
                _and(date_sql, event_sql),
                (*date_params, reaction_term),
            )
            joint = _count(
                connection,
                _and(date_sql, target_sql, event_sql),
                (*date_params, *target_params, reaction_term),
            )
        return ContingencyCounts(joint, drug_total, event_total, grand_total)

    def top_reactions(self, scope: DrugScope, *, limit: int = 10) -> list[CountBucket]:
        target_sql, target_params = _target_report_predicate(scope)
        date_sql, date_params = _date_predicate(scope)
        query = f"""
            SELECT rx.term, COUNT(*) AS frequency
            FROM reports r JOIN reactions rx ON rx.report_id = r.primary_id
            WHERE {_and(date_sql, target_sql)}
            GROUP BY rx.term
            ORDER BY frequency DESC, rx.term ASC
            LIMIT ?
        """
        with self._connect() as connection:
            rows = connection.execute(
                query, (*date_params, *target_params, limit)
            ).fetchall()
        return [CountBucket(term=row[0], count=row[1]) for row in rows]

    def overview(self, scope: DrugScope) -> CaseOverview:
        target_sql, target_params = _target_report_predicate(scope)
        date_sql, date_params = _date_predicate(scope)
        where = _and(date_sql, target_sql)
        params = (*date_params, *target_params)
        with self._connect() as connection:
            total = _count(connection, where, params)
            yearly = _group_reports(
                connection,
                "substr(r.received_date, 1, 4)",
                where,
                params,
                chronological=True,
            )
            sex = _group_reports(connection, "r.sex", where, params)
            age = _group_reports(
                connection,
                "CASE WHEN r.age_years < 18 THEN '<18' "
                "WHEN r.age_years < 45 THEN '18-44' "
                "WHEN r.age_years < 65 THEN '45-64' "
                "WHEN r.age_years < 75 THEN '65-74' ELSE '75+' END",
                _and(where, "r.age_years IS NOT NULL"),
                params,
            )
            countries = _group_reports(connection, "r.country", where, params, limit=10)
            outcomes = _group_joined(
                connection, "outcomes", "o", where, params, limit=None
            )
            concomitant = _concomitant_buckets(
                connection, scope, date_sql, date_params, target_sql, target_params
            )
            indications = _indication_buckets(connection, scope, date_sql, date_params)
        return CaseOverview(
            total_reports=total,
            yearly=yearly,
            sex=sex,
            age_buckets=age,
            outcomes=outcomes,
            countries=countries,
            concomitant_drugs=concomitant,
            indications=indications,
        )


def write_sqlite_snapshot(
    reports: Iterable[ReportRecord],
    provenance: SnapshotProvenance,
    path: str | Path,
) -> Path:
    """Stream reports into an indexed snapshot, retaining latest case versions."""
    if provenance.deduplication != "latest_case_version":
        raise ValueError("SQLite snapshot writer supports latest_case_version only")
    target = Path(path)
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"refusing to overwrite existing snapshot: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(target)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(_DDL)
        connection.executemany(
            "INSERT INTO metadata(key, value) VALUES (?, ?)",
            (
                ("schema_version", _SCHEMA_VERSION),
                ("snapshot_id", provenance.snapshot_id),
                ("source", provenance.source),
                ("extracted_at", provenance.extracted_at),
                ("deduplication", provenance.deduplication),
            ),
        )
        for report in reports:
            current = connection.execute(
                "SELECT primary_id, case_version, received_date FROM reports WHERE case_id = ?",
                (report.case_id,),
            ).fetchone()
            candidate_key = (
                report.case_version,
                report.received_date.isoformat(),
                report.primary_id,
            )
            if current is not None:
                current_key = (int(current[1]), str(current[2]), str(current[0]))
                if candidate_key <= current_key:
                    continue
                connection.execute("DELETE FROM reports WHERE primary_id = ?", (current[0],))
            _insert_report(connection, report)
        connection.commit()
        connection.execute("PRAGMA optimize")
    except Exception:
        connection.close()
        target.unlink(missing_ok=True)
        raise
    finally:
        if connection:
            connection.close()
    if os.name != "nt":
        try:
            target.chmod(0o444)
        except OSError:
            target.unlink(missing_ok=True)
            raise
    return target


def _insert_report(connection: sqlite3.Connection, report: ReportRecord) -> None:
    connection.execute(
        "INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            report.primary_id,
            report.case_id,
            report.case_version,
            report.received_date.isoformat(),
            report.sex,
            report.age_years,
            report.country,
        ),
    )
    for ordinal, drug in enumerate(report.drugs):
        connection.execute(
            "INSERT INTO drugs VALUES (?, ?, ?, ?, ?)",
            (report.primary_id, ordinal, drug.medicinal_product, drug.role_code, drug.indication),
        )
        names = {_term(drug.medicinal_product), *(_term(name) for name in drug.normalized_names)}
        connection.executemany(
            "INSERT INTO drug_names VALUES (?, ?, ?)",
            ((report.primary_id, ordinal, name) for name in sorted(names) if name),
        )
    connection.executemany(
        "INSERT INTO reactions VALUES (?, ?)",
        ((report.primary_id, term) for term in sorted({_term(v) for v in report.reactions})),
    )
    connection.executemany(
        "INSERT INTO outcomes VALUES (?, ?)",
        ((report.primary_id, term) for term in sorted(set(report.outcomes))),
    )


def _target_report_predicate(scope: DrugScope) -> tuple[str, tuple[object, ...]]:
    drug_sql, params = _target_drug_predicate(scope, "d")
    return (
        f"EXISTS (SELECT 1 FROM drugs d WHERE d.report_id = r.primary_id AND {drug_sql})",
        params,
    )


def _target_drug_predicate(
    scope: DrugScope, alias: str
) -> tuple[str, tuple[object, ...]]:
    roles = sorted(scope.role_codes)
    role_marks = ",".join("?" for _ in roles)
    name_sql, name_params = _drug_name_predicate(scope, alias)
    return f"{alias}.role_code IN ({role_marks}) AND {name_sql}", (*roles, *name_params)


def _drug_name_predicate(
    scope: DrugScope, alias: str
) -> tuple[str, tuple[object, ...]]:
    names = sorted(scope.name_set)
    name_marks = ",".join("?" for _ in names)
    sql = (
        "EXISTS ("
        "SELECT 1 FROM drug_names dn "
        f"WHERE dn.report_id = {alias}.report_id AND dn.drug_ordinal = {alias}.ordinal "
        f"AND dn.normalized_name IN ({name_marks}))"
    )
    return sql, tuple(names)


def _date_predicate(scope: DrugScope) -> tuple[str, tuple[object, ...]]:
    clauses: list[str] = []
    params: list[object] = []
    if scope.date_from is not None:
        clauses.append("r.received_date >= ?")
        params.append(scope.date_from.isoformat())
    if scope.date_to is not None:
        clauses.append("r.received_date <= ?")
        params.append(scope.date_to.isoformat())
    return _and(*clauses), tuple(params)


def _count(connection: sqlite3.Connection, where: str, params: tuple[object, ...]) -> int:
    return int(connection.execute(f"SELECT COUNT(*) FROM reports r WHERE {where}", params).fetchone()[0])


def _group_reports(
    connection: sqlite3.Connection,
    expression: str,
    where: str,
    params: tuple[object, ...],
    *,
    limit: int | None = None,
    chronological: bool = False,
) -> list[CountBucket]:
    order = "term ASC" if chronological else "frequency DESC, term ASC"
    query = (
        f"SELECT {expression} AS term, COUNT(*) AS frequency FROM reports r "
        f"WHERE {where} AND {expression} IS NOT NULL GROUP BY term ORDER BY {order}"
    )
    query_params: tuple[object, ...] = params
    if limit is not None:
        query += " LIMIT ?"
        query_params = (*params, limit)
    return [CountBucket(term=row[0], count=row[1]) for row in connection.execute(query, query_params)]


def _group_joined(
    connection: sqlite3.Connection,
    table: str,
    alias: str,
    where: str,
    params: tuple[object, ...],
    *,
    limit: int | None,
) -> list[CountBucket]:
    query = (
        f"SELECT {alias}.term, COUNT(*) AS frequency FROM reports r "
        f"JOIN {table} {alias} ON {alias}.report_id = r.primary_id "
        f"WHERE {where} GROUP BY {alias}.term ORDER BY frequency DESC, {alias}.term ASC"
    )
    query_params = params
    if limit is not None:
        query += " LIMIT ?"
        query_params = (*params, limit)
    return [CountBucket(term=row[0], count=row[1]) for row in connection.execute(query, query_params)]


def _concomitant_buckets(
    connection: sqlite3.Connection,
    scope: DrugScope,
    date_sql: str,
    date_params: tuple[object, ...],
    target_sql: str,
    target_params: tuple[object, ...],
) -> list[CountBucket]:
    target_name_sql, target_name_params = _drug_name_predicate(scope, "d")
    query = f"""
        SELECT d.medicinal_product, COUNT(DISTINCT r.primary_id) AS frequency
        FROM reports r JOIN drugs d ON d.report_id = r.primary_id
        WHERE {_and(date_sql, target_sql, "d.role_code = 'C'", f"NOT ({target_name_sql})")}
        GROUP BY d.medicinal_product
        ORDER BY frequency DESC, d.medicinal_product ASC LIMIT 10
    """
    return [
        CountBucket(term=row[0], count=row[1])
        for row in connection.execute(
            query, (*date_params, *target_params, *target_name_params)
        )
    ]


def _indication_buckets(
    connection: sqlite3.Connection,
    scope: DrugScope,
    date_sql: str,
    date_params: tuple[object, ...],
) -> list[CountBucket]:
    drug_sql, drug_params = _target_drug_predicate(scope, "d")
    query = f"""
        SELECT d.indication, COUNT(DISTINCT r.primary_id) AS frequency
        FROM reports r JOIN drugs d ON d.report_id = r.primary_id
        WHERE {_and(date_sql, drug_sql, "d.indication IS NOT NULL")}
        GROUP BY d.indication
        ORDER BY frequency DESC, d.indication ASC LIMIT 10
    """
    return [
        CountBucket(term=row[0], count=row[1])
        for row in connection.execute(query, (*date_params, *drug_params))
    ]


def _and(*clauses: str) -> str:
    present = [f"({clause})" for clause in clauses if clause]
    return " AND ".join(present) if present else "1 = 1"


def _connect_readonly(path: Path) -> sqlite3.Connection:
    uri = f"file:{quote(str(path), safe='/')}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _validate_schema(connection: sqlite3.Connection) -> None:
    expected_columns = {
        "metadata": {"key", "value"},
        "reports": {
            "primary_id", "case_id", "case_version", "received_date",
            "sex", "age_years", "country",
        },
        "drugs": {
            "report_id", "ordinal", "medicinal_product", "role_code", "indication",
        },
        "drug_names": {"report_id", "drug_ordinal", "normalized_name"},
        "reactions": {"report_id", "term"},
        "outcomes": {"report_id", "term"},
    }
    actual = {
        row[0]
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    if not expected_columns.keys() <= actual:
        raise ValueError("frozen FAERS SQLite snapshot schema is incomplete")
    for table, expected in expected_columns.items():
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        if columns != expected:
            raise ValueError("frozen FAERS SQLite snapshot schema is incompatible")
    quick_check = connection.execute("PRAGMA quick_check(1)").fetchone()
    if quick_check is None or quick_check[0] != "ok":
        raise ValueError("frozen FAERS SQLite snapshot failed integrity check")
    semantic_error = connection.execute(
        """
        SELECT 1 FROM reports r
        WHERE trim(r.primary_id) = '' OR trim(r.case_id) = ''
           OR r.case_version < 1 OR date(r.received_date) IS NULL
           OR r.age_years < 0
           OR NOT EXISTS (SELECT 1 FROM drugs d WHERE d.report_id = r.primary_id)
           OR NOT EXISTS (SELECT 1 FROM reactions rx WHERE rx.report_id = r.primary_id)
        UNION ALL
        SELECT 1 FROM drugs d
        WHERE trim(d.medicinal_product) = '' OR d.role_code NOT IN ('PS', 'SS', 'C', 'I')
           OR (d.indication IS NOT NULL AND trim(d.indication) = '')
        UNION ALL
        SELECT 1 FROM drug_names WHERE trim(normalized_name) = ''
        UNION ALL
        SELECT 1 FROM reactions WHERE trim(term) = ''
        UNION ALL
        SELECT 1 FROM outcomes WHERE trim(term) = ''
        LIMIT 1
        """
    ).fetchone()
    foreign_key_error = connection.execute("PRAGMA foreign_key_check").fetchone()
    if semantic_error is not None or foreign_key_error is not None:
        raise ValueError("frozen FAERS SQLite snapshot failed semantic validation")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_identity(path: Path) -> tuple[int, int, int, int, int]:
    metadata = path.stat()
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_mode,
    )
