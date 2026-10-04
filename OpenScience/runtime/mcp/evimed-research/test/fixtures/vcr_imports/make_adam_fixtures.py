#!/usr/bin/env python3
"""A SAS transport (XPORT V5) writer, and the ADaM fixtures built with it.

The import's tests need transport files in two places: committed samples that are real ADaM
datasets, and hostile or unusual files (a date format, a short numeric, a special missing, a
second dataset, a version it does not read) built byte by byte. R's ``foreign`` package can read
this format but not write it, so the writer is here, and ``foreign::read.xport`` -- an
independent decoder -- is what the fixtures' expected values are read back with.

    Rscript export_pharmaverseadam.R <pharmaverseadam>/data <csv directory>
    python3 make_adam_fixtures.py <csv directory> .

writes ``adsl.xpt`` (ADSL), ``adae.xpt`` (ADAE) and ``adtte.xpt`` (ADTTE, from pharmaverseadam's
``adtte_onco``). Dates are numbers of days since 1960-01-01, as SAS writes them; the writer takes
the data as it is and attaches no format, so a date is recognised by ADaM's own *DT naming.
"""
import csv
import math
import struct
import sys
from pathlib import Path

RECORD = 80
STAMP = "04OCT26:12:00:00"


def _pad(text: bytes | str, width: int) -> bytes:
    raw = text.encode("ascii") if isinstance(text, str) else text
    return raw[:width].ljust(width, b" ")


def float_to_ibm(value: float, length: int = 8) -> bytes:
    """An IEEE double as IBM-370 floating point, truncated to `length` bytes (SAS stores a short numeric by truncation)."""
    if value == 0:
        return b"\x00" * length
    sign = 0x80 if value < 0 else 0
    magnitude = abs(value)
    exponent = math.ceil(math.frexp(magnitude)[1] / 4)
    fraction = round(magnitude / 16.0 ** exponent * (1 << 56))
    if fraction >= 1 << 56:
        exponent += 1
        fraction >>= 4
    return bytes([sign | (exponent + 64)]) + fraction.to_bytes(7, "big")[: length - 1]


def missing(code: str = ".", length: int = 8) -> bytes:
    return code.encode("ascii") + b"\x00" * (length - 1)


def write_xpt(path, datasets, *, header=None, namestr_length=140):
    """Write datasets to `path`. A dataset is ``{"name", "label", "variables": [{"name", "label", "numeric", "length", "format"}], "rows": [[...]]}``.

    A numeric cell is a float, None (missing `.`), or a one-letter string (`"A"` for `.A`); a character cell is text, or bytes written as they are. ``header`` replaces the
    library header record (to build a file that is not V5), ``namestr_length`` the length the member header declares.
    """
    out = bytearray()
    out += _pad(header if header is not None else "HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!000000000000000000000000000000  ", RECORD)
    out += _pad("SAS     SAS     SASLIB  9.4     X64_7PRO" + " " * 24 + STAMP, RECORD)
    out += _pad(STAMP, RECORD)
    for dataset in datasets:
        variables = dataset["variables"]
        out += _pad(f"HEADER RECORD*******MEMBER  HEADER RECORD!!!!!!!000000000000000001600000000{namestr_length:03d}  ", RECORD)
        out += _pad("HEADER RECORD*******DSCRPTR HEADER RECORD!!!!!!!000000000000000000000000000000  ", RECORD)
        out += _pad("SAS     " + dataset["name"].ljust(8)[:8] + "SASDATA 9.4     X64_7PRO" + " " * 24 + STAMP, RECORD)
        out += _pad(STAMP + " " * 16 + dataset.get("label", "").ljust(40)[:40], RECORD)
        out += _pad(f"HEADER RECORD*******NAMESTR HEADER RECORD!!!!!!!000000{len(variables):04d}00000000000000000000  ", RECORD)
        position = 0
        namestrs = bytearray()
        for number, variable in enumerate(variables, start=1):
            length = variable["length"]
            namestrs += struct.pack(">hhhh8s40s8shhh2s8shhl52s", 1 if variable["numeric"] else 2, 0, length, number, _pad(variable["name"], 8), _pad(variable.get("label", ""), 40),
                                    _pad(variable.get("format", ""), 8), 0, 0, 0, b"  ", _pad("", 8), 0, 0, position, b" " * 52)
            position += length
        out += namestrs + b" " * (-len(namestrs) % RECORD)
        out += _pad("HEADER RECORD*******OBS     HEADER RECORD!!!!!!!000000000000000000000000000000  ", RECORD)
        body = bytearray()
        for row in dataset["rows"]:
            for variable, value in zip(variables, row):
                if variable["numeric"]:
                    if value is None:
                        body += missing(".", variable["length"])
                    elif isinstance(value, str):
                        body += missing(value, variable["length"])
                    else:
                        body += float_to_ibm(float(value), variable["length"])
                else:
                    body += _pad(value if isinstance(value, bytes) else (value or ""), variable["length"])
        out += body + b" " * (-len(body) % RECORD)
    Path(path).write_bytes(bytes(out))


def from_csv(name, label, path):
    """A dataset from a CSV export: numeric columns are the ones whose every non-empty cell parses as a number."""
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        names = next(reader)
        rows = list(reader)
    variables = []
    for index, column in enumerate(names):
        cells = [row[index] for row in rows]
        try:
            [float(cell) for cell in cells if cell != ""]
            numeric = True
        except ValueError:
            numeric = False
        variables.append({"name": column, "label": column, "numeric": numeric,
                          "length": 8 if numeric else max([1] + [len(cell.encode("ascii", "replace")) for cell in cells])})
    converted = []
    for row in rows:
        converted.append([(None if cell == "" else float(cell)) if variable["numeric"] else cell.encode("ascii", "replace").decode("ascii")
                          for variable, cell in zip(variables, row)])
    return {"name": name, "label": label, "variables": variables, "rows": converted}


if __name__ == "__main__":
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    for member, label, file in (("ADSL", "Subject-Level Analysis Dataset", "adsl.xpt"), ("ADAE", "Adverse Events Analysis Dataset", "adae.xpt"),
                                ("ADTTE", "Time-to-Event Analysis Dataset", "adtte.xpt")):
        write_xpt(target / file, [from_csv(member, label, source / f"{member}.csv")])
