#!/usr/bin/env python3
"""Render a bounded Slurm batch artifact without contacting a cluster."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


JOB_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TIME_LIMIT = re.compile(r"^(?:\d+-)?\d{1,2}:\d{2}:\d{2}$")
RESOURCE = re.compile(r"^[A-Za-z0-9._:+/-]{1,128}$")


def bounded(value: str, label: str, maximum: int = 4096) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > maximum or "\0" in normalized or "\r" in normalized:
        raise ValueError("%s is invalid" % label)
    return normalized


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-name", required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--time", default="01:00:00")
    parser.add_argument("--partition")
    parser.add_argument("--cpus-per-task", type=int)
    parser.add_argument("--mem")
    parser.add_argument("--gres")
    parser.add_argument("--module", action="append", default=[])
    args = parser.parse_args()

    if not JOB_NAME.fullmatch(args.job_name):
        parser.error("--job-name must be a bounded Slurm-safe identifier")
    if not TIME_LIMIT.fullmatch(args.time):
        parser.error("--time must use [days-]HH:MM:SS")
    if args.cpus_per_task is not None and not 1 <= args.cpus_per_task <= 1024:
        parser.error("--cpus-per-task must be between 1 and 1024")
    for label, value in (("partition", args.partition), ("mem", args.mem), ("gres", args.gres)):
        if value is not None and not RESOURCE.fullmatch(value):
            parser.error("--%s contains unsupported characters" % label)
    if len(args.module) > 32 or any(not RESOURCE.fullmatch(value) for value in args.module):
        parser.error("--module values must be bounded module identifiers")
    try:
        command = bounded(args.command, "command")
    except ValueError as error:
        parser.error(str(error))

    directives = [
        "#SBATCH --job-name=%s" % args.job_name,
        "#SBATCH --output=slurm-%j.out",
        "#SBATCH --error=slurm-%j.err",
        "#SBATCH --time=%s" % args.time,
    ]
    for name, value in (
        ("partition", args.partition),
        ("cpus-per-task", args.cpus_per_task),
        ("mem", args.mem),
        ("gres", args.gres),
    ):
        if value is not None:
            directives.append("#SBATCH --%s=%s" % (name, value))
    lines = ["#!/bin/bash", *directives, "", "set -euo pipefail", 'cd "$SLURM_SUBMIT_DIR"']
    lines.extend("module load %s" % module for module in args.module)
    lines.append(command)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
