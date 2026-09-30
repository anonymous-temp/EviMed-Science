#!/usr/bin/env python3
"""Convert one Parquet file to CSV so the R engine can read it.

Hidden knowledge: the R `arrow` package is not in the pinned library and
adding it for a single file format would be a very large dependency for a
very small job, while `pyarrow` is already present for the data plane. This
bridge converts and nothing else -- it must never compute, filter or
aggregate, because then there would be two places where a number can come
from and only one of them is version-pinned into the manifest.

Usage: parquet_bridge.py <input.parquet> <output.csv>
"""
import sys

import pyarrow.csv as pacsv
import pyarrow.parquet as pq


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("usage: parquet_bridge.py <input.parquet> <output.csv>\n")
        return 2
    table = pq.read_table(argv[1])
    pacsv.write_csv(table, argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
