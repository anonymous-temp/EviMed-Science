#!/usr/bin/env python3
"""Build the pinned, read-only SIDER 4.1 query index shipped with EviMed."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
import sqlite3
import tempfile
import urllib.request
from pathlib import Path


SOURCES = {
    "drug_names.tsv": {
        "url": "https://sideeffects.embl.de/media/download/drug_names.tsv",
        "bytes": 34_759,
        "sha256": "6427a3e3202c71a81dff97092957aacf0700b9c01f34b07e452a1ec47c92b007",
    },
    "meddra_all_se.tsv.gz": {
        "url": "https://sideeffects.embl.de/media/download/meddra_all_se.tsv.gz",
        "bytes": 2_381_171,
        "sha256": "119b2f5319a9398da83e5fe3419889010dbacf8d3eef590251b00c025e2b3f99",
    },
}
MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024
MAX_EXPANDED_BYTES = 32 * 1024 * 1024


def download(spec: dict[str, object]) -> bytes:
    request = urllib.request.Request(
        str(spec["url"]),
        headers={"user-agent": "EviMed-SIDER-cache-builder/1.0"},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = response.read(MAX_DOWNLOAD_BYTES + 1)
    digest = hashlib.sha256(payload).hexdigest()
    if len(payload) != spec["bytes"] or digest != spec["sha256"]:
        raise SystemExit(
            "SIDER input changed: expected %s bytes / %s, received %s bytes / %s"
            % (spec["bytes"], spec["sha256"], len(payload), digest)
        )
    return payload


def build(output: Path) -> None:
    names_raw = download(SOURCES["drug_names.tsv"])
    effects_compressed = download(SOURCES["meddra_all_se.tsv.gz"])
    with gzip.GzipFile(fileobj=io.BytesIO(effects_compressed), mode="rb") as handle:
        effects_raw = handle.read(MAX_EXPANDED_BYTES + 1)
    if len(effects_raw) > MAX_EXPANDED_BYTES:
        raise SystemExit("expanded SIDER input exceeded 32 MiB")
    try:
        names_text = names_raw.decode("utf-8")
        effects_text = effects_raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SystemExit("SIDER input is not valid UTF-8: %s" % error) from error

    names = sorted({
        (fields[0].strip(), fields[1].strip(), fields[1].strip().casefold())
        for line in names_text.splitlines()
        if len(fields := line.split("\t", 1)) == 2 and fields[0].strip() and fields[1].strip()
    })
    effects = sorted({
        (fields[0].strip(), fields[4].strip(), fields[5].strip())
        for line in effects_text.splitlines()
        if len(fields := line.split("\t")) >= 6
        and fields[0].strip() and fields[4].strip() and fields[5].strip()
    })

    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".sider-4.1-", suffix=".sqlite", dir=output.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        connection = sqlite3.connect(temporary)
        try:
            connection.executescript("""
                PRAGMA journal_mode = OFF;
                PRAGMA synchronous = OFF;
                PRAGMA temp_store = MEMORY;
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
                CREATE TABLE drug_names (
                    compound_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL,
                    PRIMARY KEY (compound_id, name)
                ) WITHOUT ROWID;
                CREATE INDEX drug_names_normalized ON drug_names(normalized_name, compound_id);
                CREATE TABLE side_effects (
                    compound_id TEXT NOT NULL,
                    concept_id TEXT NOT NULL,
                    effect_name TEXT NOT NULL,
                    PRIMARY KEY (compound_id, concept_id, effect_name)
                ) WITHOUT ROWID;
            """)
            connection.executemany("INSERT INTO drug_names VALUES (?, ?, ?)", names)
            connection.executemany("INSERT INTO side_effects VALUES (?, ?, ?)", effects)
            connection.executemany("INSERT INTO metadata VALUES (?, ?)", [
                ("release", "SIDER 4.1 (2015-10-21)"),
                ("license", "CC BY-SA 4.0 / research-use disclaimer"),
                ("drugNamesSha256", str(SOURCES["drug_names.tsv"]["sha256"])),
                ("sideEffectsSha256", str(SOURCES["meddra_all_se.tsv.gz"]["sha256"])),
                ("drugNameRows", str(len(names))),
                ("sideEffectRows", str(len(effects))),
            ])
            connection.commit()
            result = connection.execute("PRAGMA integrity_check").fetchone()
            if result != ("ok",):
                raise SystemExit("generated SIDER SQLite integrity check failed")
        finally:
            connection.close()
        os.chmod(temporary, 0o444)
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print("built %s: %s drugs, %s effects, %s bytes, sha256=%s" % (
        output, len(names), len(effects), output.stat().st_size, digest,
    ))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "data" / "sider-4.1.sqlite",
    )
    arguments = parser.parse_args()
    build(arguments.output.resolve())


if __name__ == "__main__":
    main()
