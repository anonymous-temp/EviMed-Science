#!/usr/bin/env python3
"""Reduce OHDSI Eunomia's GiBleed_5.3 sample to its first 150 persons, deterministically.

The full sample (2,694 persons, 6.8 MB zipped) is Apache-2.0; this keeps every row of the
first 150 PERSON rows (file order) in the seven tables the OMOP import reads, two tables it
does not (PROCEDURE_OCCURRENCE, DRUG_ERA: so the "not read" coverage has something to name),
the whole CONCEPT shard and CDM_SOURCE. Rows are kept as the original lines, byte for byte;
the zip is written with fixed timestamps so the result is reproducible from the download:

    python3 trim_gibleed.py GiBleed_5.3.zip gibleed-5.3-first150.zip

``provenance.json`` records the SHA-256 of both the download and the reduced file.
"""
import csv
import io
import sys
import zipfile

KEEP_WHOLE = ("CONCEPT.csv", "CDM_SOURCE.csv", "DEATH.csv")
FILTERED = ("PERSON.csv", "OBSERVATION_PERIOD.csv", "VISIT_OCCURRENCE.csv", "CONDITION_OCCURRENCE.csv", "DRUG_EXPOSURE.csv", "MEASUREMENT.csv",
            "PROCEDURE_OCCURRENCE.csv", "DRUG_ERA.csv")
PERSONS = 150


def main(source: str, target: str) -> None:
    with zipfile.ZipFile(source) as original:
        body = lambda name: original.read(f"GiBleed_5.3/{name}").decode("utf-8")  # noqa: E731
        header, *person_lines = body("PERSON.csv").splitlines(keepends=True)
        ids = {next(csv.reader([line]))[0] for line in person_lines[:PERSONS]}
        out = {}
        for name in FILTERED:
            first, *lines = body(name).splitlines(keepends=True)
            column = next(csv.reader([first])).index("PERSON_ID")
            out[name] = first + "".join(line for line in lines if next(csv.reader([line]))[column] in ids)
        for name in KEEP_WHOLE:
            out[name] = body(name)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(out):
            info = zipfile.ZipInfo(f"GiBleed_5.3/{name}", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, out[name].encode("utf-8"))


if __name__ == "__main__":
    main(*sys.argv[1:3])
