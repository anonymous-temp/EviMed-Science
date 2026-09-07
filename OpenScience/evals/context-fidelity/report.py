#!/usr/bin/env python3
"""Weekly measurement of what compaction actually does to a run.

Plan: docs/superpowers/plans/2026-09-07-self-evolving-agent-loop.md §6.5, first
step ("第一步 · 测量"), which this file is the whole of.

  NO COMPACTION POLICY MAY CHANGE BEFORE THIS REPORT HAS A REAL DISTRIBUTION.

Not a style rule. Today the control plane declares a 1,000,000-token context
window against a 400,000-token run budget, so pressure compaction is unreachable
inside the budget and the honest expected value of every column below is zero.
A threshold grid ({32K, 64K, 128K} x retainRatio) picked against no observed
distribution is a guess dressed as a decision — §6.5 pre-registers that the grid
is chosen from this measurement and the cost curve, not copied from the paper.
`distribution.sufficient` in the output is that gate: while it is false, the
report is evidence that the measurement is not there yet, not evidence about
compaction.

Input is the run ledger itself (`<project>/.openscience/runs.jsonl`), because
that is where WP0 put the receipt: `learning` events carry the cumulative
`compaction` array written by `dshEventPump`'s `compaction/end` decode, plus
`methodsLoaded`, `repairRounds` and the transcript receipt.

Per ISO week it reports: compactions per run, tokensBefore -> tokensAfter, the
success rate of runs that were compacted against runs that were not, the
context-overflow error counts, and the summariser's cost.

Two honest gaps this report names rather than papers over:

  tokensAfter. The ledger records ONE estimated token count per compaction
  (`compaction/end`'s `data.tokens`), so the before/after pair the plan asks for
  is half present. It is read as `tokensBefore`, `tokensAfter` is reported as
  unavailable with its reason, and both are read straight from the record once a
  receipt carries `tokensBefore`/`tokensAfter` explicitly.

  Context overflow. There is no context-overflow error code. The kernel's
  `max-tokens` turn end maps to `runtime_session_error` and its `model_max_tokens`
  sub-code is dropped before the ledger, so an overflow and an ordinary session
  error arrive as the same string. The report counts the codes that WOULD be
  attributable separately from `runtime_session_error`, which it reports as
  indistinguishable rather than folding the two together.

Usage:
  python3 evals/context-fidelity/report.py --projects-root /var/lib/evimed/projects
  python3 evals/context-fidelity/report.py --ledger a/.openscience/runs.jsonl --usage-export account.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence


HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
LEDGER_NAME = "runs.jsonl"
META_DIR_NAME = ".openscience"
SCHEMA_VERSION = 1

TERMINAL_STATUSES = frozenset({"succeeded", "failed", "canceled"})

# Codes that would name a context failure directly. None of them is emitted
# today; they are listed so the counter starts working the day one is, instead
# of a later reader having to discover that the column was never wired.
ATTRIBUTABLE_OVERFLOW_CODES = ("context_overflow", "compaction_handle_lost", "model_max_tokens")
# The code an overflow actually lands on, together with every other kernel-side
# failure. Counted apart, and never added to the attributable total.
INDISTINGUISHABLE_OVERFLOW_CODES = ("runtime_session_error",)

# Mirror of `packages/domain/src/metering.mjs` REFERENCE_PRICE_LIST, per 1M
# tokens. Python cannot import the .mjs, so the version string travels with the
# numbers: a report that prices with a stale list says which list it used.
REFERENCE_PRICE_LIST = {
    "currency": "CNY",
    "version": "evimed-reference-2026-09-05",
    "model": {
        "deepseek-v4-pro": {"cacheHit": 0.3, "cacheMiss": 9, "output": 27},
        "deepseek-v4-flash": {"cacheHit": 0.1, "cacheMiss": 3, "output": 9},
    },
}
DEFAULT_SUMMARISER_MODEL = "deepseek-v4-flash"

# What "a real distribution" means, so the gate is a number rather than a
# feeling. Deliberately modest: 30 compacted runs over two weeks is enough to
# see a shape, and nothing like enough to claim an effect.
DEFAULT_MIN_COMPACTED_RUNS = 30
DEFAULT_MIN_WEEKS = 2


class ReportError(RuntimeError):
    """A failure with an actionable message."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def iso_week(timestamp: str | None) -> str | None:
    if not isinstance(timestamp, str) or not timestamp:
        return None
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    year, week, _weekday = moment.astimezone(timezone.utc).isocalendar()
    return f"{year}-W{week:02d}"


# ---------------------------------------------------------------------------
# Ledger reading
# ---------------------------------------------------------------------------


def find_ledgers(projects_root: Path | None, explicit: Sequence[Path]) -> list[Path]:
    found: list[Path] = [path for path in explicit]
    if projects_root is not None:
        found.extend(sorted(projects_root.glob(f"**/{META_DIR_NAME}/{LEDGER_NAME}")))
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in found:
        resolved = path.resolve()
        if resolved not in seen and resolved.is_file():
            seen.add(resolved)
            unique.append(resolved)
    return unique


def compaction_tokens(record: dict[str, Any]) -> tuple[int | None, int | None]:
    """(before, after) for one compaction receipt.

    `tokensBefore`/`tokensAfter` win when a receipt carries them. The shipped
    receipt carries only `tokens` — the estimate `compaction/end` reported — so
    that is read as the before side and the after side stays unknown. Calling
    the one number "after" would invent the very improvement this report exists
    to measure.
    """
    before = record.get("tokensBefore")
    after = record.get("tokensAfter")
    if isinstance(before, int) and not isinstance(before, bool):
        return before, after if isinstance(after, int) and not isinstance(after, bool) else None
    tokens = record.get("tokens")
    if isinstance(tokens, int) and not isinstance(tokens, bool):
        return tokens, None
    return None, None


def fold_ledger(lines: Iterable[str]) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    """Fold `runs.jsonl` the way `agentRuns.mjs` folds it, minus the corruption checks.

    This is a reader of a file another process is appending to, so a malformed
    or truncated tail line is counted and skipped. The writer raises on the same
    input, and that asymmetry is deliberate: a measurement that refuses to run
    because the last line was half-written measures nothing at all.
    """
    runs: dict[str, dict[str, Any]] = {}
    problems = {"unparsable": 0, "orphaned": 0, "duplicateStart": 0}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            problems["unparsable"] += 1
            continue
        if not isinstance(event, dict) or not isinstance(event.get("id"), str):
            problems["unparsable"] += 1
            continue
        kind = event.get("event")
        run_id = event["id"]
        if kind == "started":
            if run_id in runs:
                problems["duplicateStart"] += 1
            runs[run_id] = {
                "id": run_id,
                "mode": event.get("mode"),
                "model": event.get("model"),
                "status": "running",
                "startedAt": event.get("startedAt"),
                "finishedAt": None,
                "durationMs": None,
                "errorCode": None,
                "qualityNotices": [],
                "compaction": [],
                "repairRounds": {"content": 0, "structural": 0},
                "transcript": None,
                "methodsLoaded": [],
            }
            continue
        current = runs.get(run_id)
        if current is None:
            if kind in ("finished", "learning", "notice", "progress", "dispatch"):
                problems["orphaned"] += 1
            continue
        if kind == "finished":
            current["status"] = event.get("status")
            current["finishedAt"] = event.get("finishedAt")
            current["durationMs"] = event.get("durationMs")
            current["errorCode"] = event.get("errorCode")
            notices = event.get("qualityNotices")
            if isinstance(notices, list):
                current["qualityNotices"] = [item for item in notices if isinstance(item, str)] + current["qualityNotices"]
        elif kind == "learning":
            # A gauge: every writer sends the whole cumulative value, so the
            # last row for a field wins rather than accumulating.
            if isinstance(event.get("compaction"), list):
                current["compaction"] = [item for item in event["compaction"] if isinstance(item, dict)]
            if isinstance(event.get("repairRounds"), dict):
                current["repairRounds"] = event["repairRounds"]
            if isinstance(event.get("transcript"), dict):
                current["transcript"] = event["transcript"]
            if isinstance(event.get("methodsLoaded"), list):
                current["methodsLoaded"] = event["methodsLoaded"]
        elif kind == "notice":
            notices = event.get("qualityNotices")
            if isinstance(notices, list):
                current["qualityNotices"].extend(item for item in notices if isinstance(item, str))
    return runs, problems


def read_ledger(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    payload = path.read_bytes()
    runs, problems = fold_ledger(payload.decode("utf-8", "replace").splitlines())
    receipt = {
        "path": str(path),
        "bytes": len(payload),
        "sha256": sha256_bytes(payload),
        "runs": len(runs),
        "problems": problems,
    }
    return runs, receipt


# ---------------------------------------------------------------------------
# Usage export (optional): cost and cache-hit ratio, joined by runId
# ---------------------------------------------------------------------------


def load_usage_rows(path: Path | None) -> dict[str, dict[str, float]]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows: Any = payload
    for key in ("tables", "data"):
        if isinstance(rows, dict) and key in rows:
            rows = rows[key]
    if isinstance(rows, dict):
        rows = rows.get("usage", [])
    totals: dict[str, dict[str, float]] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("status") != "settled":
            continue
        run_id = row.get("runId")
        if not isinstance(run_id, str):
            continue
        entry = totals.setdefault(run_id, {"cost": 0.0, "cacheHitTokens": 0.0, "cacheMissTokens": 0.0, "outputTokens": 0.0, "calls": 0.0})
        for source, target in (("actualCost", "cost"), ("cacheHitTokens", "cacheHitTokens"),
                               ("cacheMissTokens", "cacheMissTokens"), ("outputTokens", "outputTokens")):
            try:
                entry[target] += float(row.get(source) or 0)
            except (TypeError, ValueError):
                continue
        entry["calls"] += 1
    return totals


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def distribution_block(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        return {"n": 0, "mean": None, "median": None, "min": None, "max": None, "total": None}
    return {
        "n": len(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "min": min(values),
        "max": max(values),
        "total": sum(values),
    }


def summariser_cost(tokens: float, model: str, prices: dict[str, Any]) -> dict[str, Any]:
    """What the summariser calls cost, and on what assumption.

    The ledger has no per-compaction usage row, so this prices the estimated
    compacted tokens as cache-miss input for the summariser model. An unknown
    model costs nothing and says so, the same rule `priceUsage` follows: a
    guessed price on a report is worse than a visible gap.
    """
    rate = (prices.get("model") or {}).get(model)
    if not rate:
        return {"model": model, "tokens": tokens, "cost": None, "priced": False,
                "priceVersion": prices.get("version"), "currency": prices.get("currency"),
                "reason": f"{model} is not in the price list"}
    return {
        "model": model,
        "tokens": tokens,
        "cost": round((tokens / 1_000_000) * float(rate["cacheMiss"]), 6),
        "priced": True,
        "priceVersion": prices.get("version"),
        "currency": prices.get("currency"),
        "assumption": "estimated compacted tokens billed as cache-miss input; the ledger carries no per-compaction usage row",
    }


def week_block(runs: Sequence[dict[str, Any]], usage: dict[str, dict[str, float]], model: str, prices: dict[str, Any]) -> dict[str, Any]:
    terminal = [run for run in runs if run["status"] in TERMINAL_STATUSES]
    compacted = [run for run in terminal if run["compaction"]]
    untouched = [run for run in terminal if not run["compaction"]]

    per_run_counts = [float(len(run["compaction"])) for run in terminal]
    before_values: list[float] = []
    after_values: list[float] = []
    missing_after = 0
    for run in terminal:
        for record in run["compaction"]:
            before, after = compaction_tokens(record)
            if before is not None:
                before_values.append(float(before))
            if after is None:
                missing_after += 1
            else:
                after_values.append(float(after))

    def success_rate(subset: Sequence[dict[str, Any]]) -> dict[str, Any]:
        succeeded = sum(1 for run in subset if run["status"] == "succeeded")
        return {"runs": len(subset), "succeeded": succeeded,
                "rate": (succeeded / len(subset)) if subset else None}

    compacted_rate = success_rate(compacted)
    untouched_rate = success_rate(untouched)
    delta = None
    if compacted_rate["rate"] is not None and untouched_rate["rate"] is not None:
        delta = compacted_rate["rate"] - untouched_rate["rate"]

    attributable: dict[str, int] = {}
    indistinguishable: dict[str, int] = {}
    for run in terminal:
        code = run.get("errorCode")
        if not isinstance(code, str) or not code:
            continue
        if code in ATTRIBUTABLE_OVERFLOW_CODES:
            attributable[code] = attributable.get(code, 0) + 1
        elif code in INDISTINGUISHABLE_OVERFLOW_CODES:
            indistinguishable[code] = indistinguishable.get(code, 0) + 1

    def cache_block(subset: Sequence[dict[str, Any]]) -> dict[str, Any]:
        rows = [usage[run["id"]] for run in subset if run["id"] in usage]
        if not rows:
            return {"runs": 0, "available": False,
                    "reason": "no usage export joined; per-run token usage has no HTTP surface"}
        hit = sum(row["cacheHitTokens"] for row in rows)
        miss = sum(row["cacheMissTokens"] for row in rows)
        prompt = hit + miss
        return {"runs": len(rows), "available": True, "cacheHitTokens": hit, "cacheMissTokens": miss,
                "cacheHitRatio": (hit / prompt) if prompt else None,
                "cost": sum(row["cost"] for row in rows)}

    return {
        "runs": len(runs),
        "terminalRuns": len(terminal),
        "compactions": {
            "runsCompacted": len(compacted),
            "total": int(sum(per_run_counts)),
            "perRun": distribution_block(per_run_counts),
        },
        "tokens": {
            "before": distribution_block(before_values),
            "after": distribution_block(after_values) if after_values else {
                "n": 0, "available": False,
                "reason": "the compaction receipt records one estimated token count; tokensAfter is not written yet",
                "missingRecords": missing_after,
            },
        },
        "successRate": {"compacted": compacted_rate, "notCompacted": untouched_rate, "delta": delta},
        "contextOverflow": {
            "attributable": {"total": sum(attributable.values()), "byCode": attributable},
            "indistinguishable": {
                "total": sum(indistinguishable.values()),
                "byCode": indistinguishable,
                "reason": "the kernel's max-tokens turn end maps to runtime_session_error and the model_max_tokens "
                          "sub-code never reaches runs.jsonl, so an overflow and a session error are the same string here",
            },
        },
        "summariser": summariser_cost(sum(before_values), model, prices),
        "cacheHit": {"compacted": cache_block(compacted), "notCompacted": cache_block(untouched)},
    }


def build_report(
    ledgers: Sequence[tuple[dict[str, dict[str, Any]], dict[str, Any]]],
    usage: dict[str, dict[str, float]],
    model: str = DEFAULT_SUMMARISER_MODEL,
    prices: dict[str, Any] | None = None,
    min_compacted_runs: int = DEFAULT_MIN_COMPACTED_RUNS,
    min_weeks: int = DEFAULT_MIN_WEEKS,
    now: Callable[[], str] = now_iso,
) -> dict[str, Any]:
    prices = prices or REFERENCE_PRICE_LIST
    all_runs: list[dict[str, Any]] = []
    receipts: list[dict[str, Any]] = []
    for runs, receipt in ledgers:
        all_runs.extend(runs.values())
        receipts.append(receipt)

    by_week: dict[str, list[dict[str, Any]]] = {}
    undated = 0
    for run in all_runs:
        week = iso_week(run.get("finishedAt")) or iso_week(run.get("startedAt"))
        if week is None:
            undated += 1
            continue
        by_week.setdefault(week, []).append(run)

    weeks = [{"week": week, **week_block(by_week[week], usage, model, prices)} for week in sorted(by_week)]
    overall = week_block(all_runs, usage, model, prices)
    compacted_runs = overall["compactions"]["runsCompacted"]
    weeks_with_compaction = sum(1 for week in weeks if week["compactions"]["runsCompacted"] > 0)
    sufficient = compacted_runs >= min_compacted_runs and weeks_with_compaction >= min_weeks
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now(),
        "plan": "docs/superpowers/plans/2026-09-07-self-evolving-agent-loop.md §6.5 step one",
        "policyFreeze": "No compaction policy — threshold, retainRatio, template or handle set — may change while "
                        "distribution.sufficient is false. §6.5: 没有分布不改策略.",
        "inputs": {"ledgers": receipts, "usageExportRuns": len(usage), "undatedRuns": undated},
        "weeks": weeks,
        "overall": overall,
        "distribution": {
            "sufficient": sufficient,
            "compactedRuns": compacted_runs,
            "requiredCompactedRuns": min_compacted_runs,
            "weeksWithCompaction": weeks_with_compaction,
            "requiredWeeks": min_weeks,
            "reason": None if sufficient else (
                f"{compacted_runs} compacted runs across {weeks_with_compaction} week(s); "
                f"the gate needs {min_compacted_runs} across {min_weeks}. "
                "Expected while the declared context window (1,000,000) sits above the run budget (400,000), "
                "which makes pressure compaction unreachable."
            ),
        },
    }


def print_summary(report: dict[str, Any]) -> None:
    header = ("week", "terminal", "compacted", "comp/run", "tokensBefore", "succ(comp)", "succ(none)", "overflow a/i", "summariser")

    def fmt(value: Any, digits: int = 2) -> str:
        if value is None:
            return "-"
        if isinstance(value, float):
            return f"{value:.{digits}f}"
        return str(value)

    rows = [header]
    for week in report["weeks"] + [{"week": "ALL", **report["overall"]}]:
        rows.append((
            week["week"],
            fmt(week["terminalRuns"]),
            fmt(week["compactions"]["runsCompacted"]),
            fmt(week["compactions"]["perRun"]["mean"]),
            fmt(week["tokens"]["before"]["mean"], 0),
            fmt(week["successRate"]["compacted"]["rate"]),
            fmt(week["successRate"]["notCompacted"]["rate"]),
            f"{week['contextOverflow']['attributable']['total']}/{week['contextOverflow']['indistinguishable']['total']}",
            fmt(week["summariser"]["cost"], 4),
        ))
    widths = [max(len(row[index]) for row in rows) for index in range(len(header))]
    for row in rows:
        print("  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)))
    distribution = report["distribution"]
    print(f"distribution.sufficient: {distribution['sufficient']}")
    if not distribution["sufficient"]:
        print(f"  {distribution['reason']}")
        print("  Until this is true, no compaction policy changes. (§6.5)")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="No compaction policy may change before distribution.sufficient is true (plan §6.5).",
    )
    parser.add_argument("--projects-root", type=Path, default=None,
                        help=f"directory searched for **/{META_DIR_NAME}/{LEDGER_NAME}")
    parser.add_argument("--ledger", type=Path, action="append", default=[], help="an explicit runs.jsonl (repeatable)")
    parser.add_argument("--usage-export", type=Path, default=None,
                        help="account export JSON; joins per-run cost and cache-hit tokens by runId")
    parser.add_argument("--summariser-model", default=DEFAULT_SUMMARISER_MODEL)
    parser.add_argument("--price-list", type=Path, default=None, help="override the mirrored reference price list")
    parser.add_argument("--min-compacted-runs", type=int, default=DEFAULT_MIN_COMPACTED_RUNS)
    parser.add_argument("--min-weeks", type=int, default=DEFAULT_MIN_WEEKS)
    parser.add_argument("--out", type=Path, default=None, help="where to write the report (default: results/context-fidelity-<stamp>.json)")
    args = parser.parse_args(argv)

    ledger_paths = find_ledgers(args.projects_root, args.ledger)
    if not ledger_paths:
        raise SystemExit(
            "No run ledger found. Pass --projects-root <dir> (searched for "
            f"**/{META_DIR_NAME}/{LEDGER_NAME}) or --ledger <path>."
        )
    prices = json.loads(args.price_list.read_text(encoding="utf-8")) if args.price_list else REFERENCE_PRICE_LIST
    ledgers = [read_ledger(path) for path in ledger_paths]
    report = build_report(
        ledgers,
        load_usage_rows(args.usage_export),
        model=args.summariser_model,
        prices=prices,
        min_compacted_runs=args.min_compacted_runs,
        min_weeks=args.min_weeks,
    )
    out = args.out or (RESULTS_DIR / f"context-fidelity-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print_summary(report)
    print(f"report: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
