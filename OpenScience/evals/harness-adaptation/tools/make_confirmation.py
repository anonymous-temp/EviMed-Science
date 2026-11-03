#!/usr/bin/env python3
"""Lane requests for the sealed confirmation of one family: the prompts of exactly the rows its registration names, for the baseline
image and for the candidate image, `repeats.confirmation` times each. Nothing is submitted.

  make_confirmation.py --registration rsi/round1/medcalc/registration.json --out-dir rsi/round1/medcalc \\
                       [--prefix cf] [--base-tag base --base-image base] [--candidate-tag cstar --candidate-image cand-cstar] \\
                       [--bench-root DIR] [--ppc FILE] [--exclude-opened FILE ...] [--exclude-ids FILE ...] [--allow-public-fetch] [--force]

Writes DIR/requests.<tag>.jsonl for each arm: one line per (row, repeat), rid `<prefix>.<family>.<row>.<tag>.r<k>` (k from 0, as the
development runs and export_harness_arms.py count), the registered image of the arm, the bench-driver queue line of the baseline form
(`families.Task.queue_line()`: the same line a development row gets, `timeBudgetMinutes` included for every family but medcalc) and an
empty probe. Only a size per file is printed, never a prompt.

A family whose tasks carry input files (BixBench, ResearchClawBench) also gets DIR/fetch.json: the public-data manifest `brokerctl.py submit --fetch`
attaches to the requests that name those files (`families.fetch_entries`: the pinned upstream URLs, sizes and sha256 of the registered rows only).
`--allow-public-fetch` lets the builders read the public task statement and file listing of a row that is not cached (ResearchClawBench's `task_info.json`
and the Hugging Face tree of the pinned revision, never its checklist); without it a row whose statement is not on the box stops the call.
`--exclude-opened` and `--exclude-ids` are the files the registration was made with (it re-derives its rows from them).

Why a tool of its own. `families.Family.tasks()` refuses any id outside the development list, on purpose: the development code reads
no confirmation row. A confirmation request needs the prompt of the registered confirmation rows and nothing else, so this tool calls
the same per-family builders (`families.BUILDERS`: they project the few columns a solver is given, at the moment they read a file)
for exactly the ids of the registration, and for no other id. It names no gold, rubric, criteria or reference column or file, and
it never opens one; a row's answer is not an input to anything here and is not in any output.

Guards that stay: the registration must verify (its digest, its hash order, and, when the pools and the ppc file are at hand, a fresh
re-derivation of its rows); every request passes the broker's own validation (`lab/broker.py`: a key that names an answer, a rubric or
a score, at any depth, refuses it) and its item keys are the closed set of a queue line; a registered row without raw data, or one the
hosted runtime cannot run, stops the call (a registered row is never dropped silently). Nothing is written until every request has
been built. An existing file is never replaced without --force, except by identical bytes.

Python 3.10 compatible; run with `python3 -I`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent  # evals/harness-adaptation
sys.path.insert(0, str(PACKAGE))
sys.path.insert(0, str(PACKAGE / "lab"))
sys.path.insert(0, str(PACKAGE.parent / "public-benchmarks" / "tools"))

import broker  # noqa: E402  (lab/broker.py: the validation the host applies to every request)
import register_round  # noqa: E402
from evimed_h2 import config, families  # noqa: E402

ITEM_KEYS = frozenset({"key", "bench", "id", "group", "prompt", "line", "timeoutMin", "files", "deleteGroupAfter", "collect", "settleSeconds", "timeBudgetMinutes"})


class ConfirmationRefused(Exception):
    """A request set that cannot be built; the message says why. Nothing was written."""


def read_registration(path: Path, *, bench_root: Path, ppc_file: Path | None, exclude_opened=(), exclude_ids=()) -> dict:
    """The registration, verified. With the pools file (and the ppc file the registration records) the rows are re-derived as well."""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    family = document.get("family")
    if family not in families.POOL_FILES:
        raise ConfirmationRefused(f"family {family!r} is not one of {', '.join(families.POOL_FILES)}")
    pool_file, pool_name = families.POOL_FILES[family]
    pools = bench_root / "pools" / pool_file
    ppc = None
    recorded = (document.get("excluded") or {}).get("ppcFileSha256")
    if recorded:
        if ppc_file is None or not Path(ppc_file).is_file():
            raise ConfirmationRefused("the registration excluded ppc tasks: give --ppc, the file it recorded")
        if hashlib.sha256(Path(ppc_file).read_bytes()).hexdigest() != recorded:
            raise ConfirmationRefused("the ppc file is not the one the registration recorded (sha256 differs)")
        ppc = ppc_file
    problems = register_round.check(str(path), str(pools) if pools.is_file() else None, pool_name, str(ppc) if ppc else None, [str(f) for f in exclude_opened], [str(f) for f in exclude_ids])
    if problems:
        raise ConfirmationRefused("the registration does not verify: " + "; ".join(problems))
    rows = [str(i) for i in (document.get("rows") or {}).get("confirmation") or []]
    repeats = (document.get("repeats") or {}).get("confirmation")
    if not rows or len(set(rows)) != len(rows) or not isinstance(repeats, int) or not 1 <= repeats <= 10:
        raise ConfirmationRefused("the registration has no usable confirmation rows or repeats")
    return document


def build_requests(document: dict, arms: list[dict], *, bench_root: Path, prefix: str = "cf", fetcher: families.Fetcher | None = None) -> dict[str, list[dict]]:
    """{tag: [request, ...]} for the registered confirmation rows; arms are [{tag, image}]. Raises ConfirmationRefused."""
    family, ids = document["family"], [str(i) for i in document["rows"]["confirmation"]]
    repeats = document["repeats"]["confirmation"]
    fetcher = fetcher or families.Fetcher(enabled=False)  # raw files only; nothing is downloaded here
    try:
        built = families.BUILDERS[family](bench_root, ids, fetcher)
    except families.DataUnavailable as error:
        raise ConfirmationRefused(str(error))
    lost = [i for i in ids if i not in built]
    if lost:
        raise ConfirmationRefused(f"{family}: no raw data for {len(lost)} registered row(s) ({', '.join(lost[:5])})")
    unfit = [i for i in ids if not families.feasible(built[i])]
    if unfit:
        raise ConfirmationRefused(f"{family}: {len(unfit)} registered row(s) cannot run in the hosted runtime ({', '.join(unfit[:5])})")
    out: dict[str, list[dict]] = {arm["tag"]: [] for arm in arms}
    for arm in arms:
        for row in ids:
            for repeat in range(repeats):
                item = built[row].queue_line()
                odd = sorted(set(item) - ITEM_KEYS)
                if odd:
                    raise ConfirmationRefused(f"{family}/{row}: the queue line carries keys outside the closed set ({', '.join(odd)})")
                rid = f"{prefix}.{family}.{row}.{arm['tag']}.r{repeat}".replace("/", "_")
                request = {"rid": rid, "image": arm["image"], "item": item, "probe": {"preamble": None, "line": None}}
                try:
                    broker.validate_request(request)
                except ValueError as error:
                    raise ConfirmationRefused(f"{rid}: the broker would refuse this request ({error})")
                out[arm["tag"]].append(request)
    return out


def build_fetch(document: dict, *, bench_root: Path, fetcher: families.Fetcher | None = None) -> list[dict]:
    """The public-data manifest of the registered rows (empty for a family whose tasks carry no input file)."""
    ids = [str(i) for i in document["rows"]["confirmation"]]
    try:
        return families.fetch_entries(document["family"], ids, root=bench_root, fetcher=fetcher or families.Fetcher(enabled=False))
    except families.DataUnavailable as error:
        raise ConfirmationRefused(str(error))


def serialise(requests: list[dict]) -> bytes:
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests).encode("utf-8")


def write_all(out_dir: Path, built: dict[str, list[dict]], *, force: bool, fetch: list[dict] | None = None) -> dict[str, Path]:
    payloads = {tag: serialise(requests) for tag, requests in built.items()}
    paths = {tag: out_dir / f"requests.{tag}.jsonl" for tag in payloads}
    if fetch:
        payloads["fetch"] = json.dumps(fetch).encode("utf-8")
        paths["fetch"] = out_dir / "fetch.json"
    for tag, path in paths.items():
        if path.exists() and not force and path.read_bytes() != payloads[tag]:
            raise ConfirmationRefused(f"{path} exists with other content; it is never replaced without --force")
    out_dir.mkdir(parents=True, exist_ok=True)
    for tag, path in paths.items():
        path.write_bytes(payloads[tag])
    return paths


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--registration", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--prefix", default="cf")
    parser.add_argument("--base-tag", default="base")
    parser.add_argument("--base-image", default="base")
    parser.add_argument("--candidate-tag", default="cstar")
    parser.add_argument("--candidate-image", default="cand-cstar")
    parser.add_argument("--bench-root", default=str(config.BENCH_ROOT))
    parser.add_argument("--ppc", default=str(config.PPC_TASKS_FILE))
    parser.add_argument("--exclude-opened", action="append", default=[])
    parser.add_argument("--exclude-ids", action="append", default=[])
    parser.add_argument("--allow-public-fetch", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    arms = [{"tag": args.base_tag, "image": args.base_image}, {"tag": args.candidate_tag, "image": args.candidate_image}]
    try:
        if len({a["tag"] for a in arms}) != 2:
            raise ConfirmationRefused("the two arms need two tags")
        root = Path(args.bench_root)
        document = read_registration(Path(args.registration), bench_root=root, ppc_file=Path(args.ppc) if args.ppc else None,
                                     exclude_opened=args.exclude_opened, exclude_ids=args.exclude_ids)
        fetcher = families.Fetcher(enabled=args.allow_public_fetch)
        built = build_requests(document, arms, bench_root=root, prefix=args.prefix, fetcher=fetcher)
        fetch = build_fetch(document, bench_root=root, fetcher=fetcher)
        paths = write_all(Path(args.out_dir), built, force=args.force, fetch=fetch)
    except (ConfirmationRefused, register_round.RegistrationError, OSError, ValueError) as error:
        print(f"make_confirmation: {error}", file=sys.stderr)
        return 2
    rows, repeats = len(document["rows"]["confirmation"]), document["repeats"]["confirmation"]
    for tag, path in paths.items():
        if tag == "fetch":
            print(f"{path} {path.stat().st_size} bytes, {len(fetch)} public-data entries")
        else:
            print(f"{path} {path.stat().st_size} bytes, {len(built[tag])} requests ({rows} rows x {repeats} repeats), image {next(a['image'] for a in arms if a['tag'] == tag)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
