#!/usr/bin/env python3
"""Build a bounded, read-only SQLite index from curated pharmacy CSV tables."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sqlite3
import stat
import tempfile
from pathlib import Path


RELEASE = "evimed-pharmacy-reference-v1"
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_ROWS = 250_000
MAX_COLUMNS = 128
MAX_CELL_CHARS = 20_000

DATASETS = {
    "drug-name-map": "西药中成药HIS通用名商品名成分分类映射表_20260627.csv",
    "high-risk-dose": "西药中成药高风险剂量频次疗程重点规则表_20260627.csv",
    "high-risk-scope": "西药高风险频次剂量途径临床状态补充规则表.csv",
    "special-populations": "西药中成药特殊人群禁慎用重点规则表_20260627.csv",
    "interactions": "西药中成药高风险相互作用同类互斥规则表_20260627.csv",
    "current-new-conflicts": "当前用药新处方冲突同类互斥表.csv",
    "monitoring": "西药中成药肾肝电解质QT凝血监测重点规则表_20260627.csv",
    "laboratory-thresholds": "实验室肾肝功能电解质阈值风险表.csv",
    "allergy-skin-test": "西药中成药过敏皮试交叉过敏规则表_20260627.csv",
    "controlled-high-alert": "西药中成药管制药品高警示药品监管映射表_20260627.csv",
    "antimicrobial-aware": "西药中成药抗菌药物分级与AWaRe映射表_甲方HIS_20260627.csv",
    "route-frequency-dictionary": "HIS给药途径频次煎服方法标准化字典.csv",
    "clinical-negation-dictionary": "临床状态词典_否定时态过滤表.csv",
    "tcm-name-map": "中药饮片标准名别名炮制品映射表.csv",
    "tcm-dose": "中药饮片剂量范围_中国药典2020一部_药材和饮片.csv",
    "tcm-route-dose": "中药饮片分途径剂量规则表.csv",
    "tcm-contraindication-toxicity": "中药饮片配伍禁忌与毒性_中国药典2020一部_药材和饮片.csv",
    "tcm-eighteen-nineteen": "中药饮片十八反十九畏规则矩阵.csv",
    "tcm-special-populations": "中药饮片特殊人群禁慎用_全量规则表.csv",
    "tcm-decoction": "中药饮片煎服方式审查_中国药典2020一部_药材和饮片.csv",
    "tcm-processing": "中药饮片炮制临方加工要求表.csv",
    "tcm-legal-toxicity": "法定毒性中药与高风险监管目录映射表.csv",
}

DDL = """
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE datasets(
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  headers_json TEXT NOT NULL
);
CREATE TABLE records(
  id INTEGER PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  row_number INTEGER NOT NULL CHECK(row_number > 0),
  content_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  UNIQUE(dataset_id, row_number)
);
CREATE VIRTUAL TABLE records_fts USING fts5(
  search_text,
  content='records',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE INDEX records_dataset_idx ON records(dataset_id, row_number);
"""


def _source_file(root: Path, file_name: str) -> Path:
    path = root / file_name
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"source is not a regular file: {file_name}")
    if metadata.st_size <= 0 or metadata.st_size > MAX_SOURCE_BYTES:
        raise ValueError(f"source size is invalid: {file_name}")
    return path


def _decode(path: Path) -> str:
    payload = path.read_bytes()
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"source encoding is unsupported: {path.name}")


def _search_text(values: list[str]) -> str:
    text = " ".join(value.casefold() for value in values if value)
    bigrams = []
    for run in re.findall(r"[\u3400-\u9fff]{2,}", text):
        bigrams.extend(run[index:index + 2] for index in range(len(run) - 1))
    return " ".join((text, *bigrams))


def build(source_root: Path, output: Path) -> dict:
    if source_root.is_symlink():
        raise ValueError("source root must be a non-symlink directory")
    source_root = source_root.resolve(strict=True)
    if not source_root.is_dir():
        raise ValueError("source root must be a non-symlink directory")
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"refusing to overwrite existing database: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix="pharmacy-reference-", suffix=".sqlite", dir=output.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    total_rows = 0
    source_manifest = []
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(DDL)
        connection.execute("PRAGMA foreign_keys = ON")
        for dataset_id, file_name in sorted(DATASETS.items()):
            path = _source_file(source_root, file_name)
            payload = path.read_bytes()
            reader = csv.DictReader(_decode(path).splitlines())
            headers = [str(value or "").strip() for value in (reader.fieldnames or [])]
            if not headers or len(headers) > MAX_COLUMNS or any(not header for header in headers):
                raise ValueError(f"CSV headers are invalid: {file_name}")
            rows = []
            for row_number, row in enumerate(reader, start=2):
                values = {}
                for header in headers:
                    value = str(row.get(header) or "").strip()
                    if len(value) > MAX_CELL_CHARS:
                        raise ValueError(f"cell is too large: {file_name}:{row_number}")
                    if value:
                        values[header] = value
                if not values:
                    continue
                rows.append((dataset_id, row_number, json.dumps(values, ensure_ascii=False, sort_keys=True), _search_text(list(values.values()))))
                total_rows += 1
                if total_rows > MAX_ROWS:
                    raise ValueError("selected pharmacy sources exceed the row limit")
            digest = hashlib.sha256(payload).hexdigest()
            connection.execute(
                "INSERT INTO datasets VALUES (?, ?, ?, ?, ?)",
                (dataset_id, file_name, digest, len(rows), json.dumps(headers, ensure_ascii=False)),
            )
            connection.executemany(
                "INSERT INTO records(dataset_id, row_number, content_json, search_text) VALUES (?, ?, ?, ?)",
                rows,
            )
            source_manifest.append({"id": dataset_id, "file": file_name, "sha256": digest, "rows": len(rows)})
        manifest_json = json.dumps(source_manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        connection.executemany(
            "INSERT INTO metadata VALUES (?, ?)",
            (
                ("release", RELEASE),
                ("source_manifest_sha256", hashlib.sha256(manifest_json.encode("utf-8")).hexdigest()),
                ("dataset_count", str(len(source_manifest))),
                ("row_count", str(total_rows)),
                ("scope", "private-curated-reference-not-current-clinical-authority"),
            ),
        )
        connection.execute("INSERT INTO records_fts(records_fts) VALUES ('rebuild')")
        if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("generated SQLite integrity check failed")
        connection.execute("PRAGMA optimize")
        connection.commit()
    except Exception:
        connection.close()
        temporary.unlink(missing_ok=True)
        raise
    finally:
        try:
            connection.close()
        except sqlite3.Error:
            pass
    os.replace(temporary, output)
    if os.name != "nt":
        output.chmod(0o444)
    return {"release": RELEASE, "datasets": len(source_manifest), "rows": total_rows, "path": str(output)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.source_root, args.output), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
