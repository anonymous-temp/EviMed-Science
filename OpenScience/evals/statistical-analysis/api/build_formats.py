"""Generate equivalent public heart-failure tables for format/duplicate-cohort acceptance."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path

import pandas as pd


def build(source: Path, out: Path):
    data = pd.read_csv(source)
    out.mkdir(parents=True, exist_ok=True)
    data.to_parquet(out / "heart-failure.parquet", index=False)
    data.to_json(out / "heart-failure.json", orient="table", index=False, double_precision=15)
    with pd.ExcelWriter(out / "heart-failure.xlsx", engine="xlsxwriter") as writer:
        writer.book.set_properties({"created": datetime(2026, 11, 2)})
        data.to_excel(writer, index=False, sheet_name="cohort")
    files = []
    for filename, loaded in [
        ("heart-failure.parquet", pd.read_parquet(out / "heart-failure.parquet")),
        ("heart-failure.json", pd.read_json(out / "heart-failure.json", orient="table")),
        ("heart-failure.xlsx", pd.read_excel(out / "heart-failure.xlsx")),
    ]:
        pd.testing.assert_frame_equal(data, loaded, check_dtype=False, atol=1e-10, rtol=1e-12)
        raw = (out / filename).read_bytes()
        files.append({"path": filename, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    return {"schemaVersion": 1, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "transformation": "same rows/columns serialized as Parquet, table-oriented JSON and Excel; not additional participants",
            "rows": len(data), "pandasVersion": pd.__version__, "files": files}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = build(args.source, args.out)
    (args.out / "format-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"rows": manifest["rows"], "formats": len(manifest["files"])}))
