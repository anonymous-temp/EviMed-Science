#!/usr/bin/env python3
"""Verify the X seed list once against SocialData (fr-social, 2026-10-22).

For each candidate of ``registry/research/x-accounts-candidates-<date>.json``: ``GET /twitter/user/{handle}`` (one
object) — does the account exist, is it public —, then one page of ``from:<handle> -filter:replies since:<90 days ago>``
(at most 20 objects) — did it post in the last 90 days (a retweet is someone else's post and does not count). The result
of every candidate, kept or dropped and why, is written to ``x-accounts-verified-<date>.json`` beside it; the registry
rows are built from that file by ``tools/build_social_registry.py``.

The key is read from the file named by ``--key-file`` by the plugin's own transport (``Authorization: Bearer``) and is
never printed; the output is status lines only. Every call's cost (``objects × US$0.0002``) is counted and the run stops
at ``--max-usd``. Progress is appended to ``--progress`` (JSON lines) and a candidate already there is not asked again,
so an interrupted run resumes without paying twice.

    python tools/verify_x_accounts.py --key-file <path> [--max-usd 2.0] [--today 2026-10-22]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from knowledge_plugin.budget import HostBudget, host_rules  # noqa: E402
from knowledge_plugin.fetch import ProtectedFetcher  # noqa: E402
from knowledge_plugin.settings import Settings  # noqa: E402
from knowledge_plugin.social.providers import ProviderError, SocialDataClient  # noqa: E402
from knowledge_plugin.social.spend import SpendCapReached  # noqa: E402
from knowledge_plugin.social.x import published  # noqa: E402


class MemoryCounters:
    async def reserve(self, host, day, cap):
        return True

    async def pause(self, host, until, reason):
        return None

    async def load_pauses(self):
        return {}

    async def counts(self, day):
        return {}


class MemoryLedger:
    """The provider ledger's interface, in memory: a cap for the whole run."""

    def __init__(self, max_usd: float) -> None:
        self.max_usd, self.spent, self.calls, self.objects = max_usd, 0.0, 0, 0

    async def check(self, cap, estimate, now=None):
        if self.spent + estimate > self.max_usd:
            raise SpendCapReached("socialdata", datetime.now(timezone.utc))

    async def record(self, provider, *, purpose, outcome, objects=0, amount=0.0, remaining=None, error=None, now=None):
        self.calls += 1
        self.objects += objects
        self.spent += amount


async def verify(candidate: dict, client: SocialDataClient, since: date) -> dict:
    handle = candidate["handle"]
    result = {"handle": handle}
    try:
        user = await client.user(handle)
    except ProviderError as error:
        return {**result, "decision": "dropped", "reason": f"user_{error.kind}"}
    if not user or not user.get("id_str"):
        return {**result, "decision": "dropped", "reason": "not_found"}
    result.update(user_id=str(user["id_str"]), screen_name=user.get("screen_name") or handle, name=user.get("name"),
                  followers=user.get("followers_count"), protected=bool(user.get("protected")))
    if result["protected"]:
        return {**result, "decision": "dropped", "reason": "protected"}
    screen = result["screen_name"]
    try:
        tweets, _ = await client.search(f"from:{screen} -filter:replies since:{since.isoformat()}")
    except ProviderError as error:
        return {**result, "decision": "dropped", "reason": f"search_{error.kind}"}
    own = [t for t in tweets if not t.get("retweeted_status") and str((t.get("user") or {}).get("id_str")) == result["user_id"]]
    dates = [published(t) for t in own]
    dates = [d for d in dates if d]
    if not own:
        return {**result, "decision": "dropped", "reason": "only_retweets_90d" if tweets else "silent_90d"}
    result.update(last_post_at=max(dates).isoformat().replace("+00:00", "Z") if dates else None, posts_on_page=len(own))
    return {**result, "decision": "kept"}


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--today", default=date.today().isoformat())
    parser.add_argument("--max-usd", type=float, default=2.0)
    parser.add_argument("--candidates", default=None)
    parser.add_argument("--progress", default=None)
    args = parser.parse_args()
    today = date.fromisoformat(args.today)
    research = ROOT / "registry" / "research"
    candidates_path = Path(args.candidates) if args.candidates else research / f"x-accounts-candidates-{today.isoformat()}.json"
    out_path = candidates_path.with_name(candidates_path.name.replace("candidates", "verified"))
    progress_path = Path(args.progress) if args.progress else Path("/tmp") / f"x-verify-progress-{today.isoformat()}.jsonl"
    candidates = json.loads(candidates_path.read_text(encoding="utf-8"))["candidates"]
    done = {}
    if progress_path.exists():
        for line in progress_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                done[row["handle"].lower()] = row
    settings = Settings(database_url="postgresql://unused", socialdata_key_file=args.key_file)
    if not settings.secret("socialdata_key"):
        print("no key in the key file: nothing asked")
        return 1
    ledger = MemoryLedger(args.max_usd)
    fetcher = ProtectedFetcher(settings, HostBudget(MemoryCounters(), host_rules(ncbi_key=False, openfda_key=False)))
    client = SocialDataClient(fetcher, ledger, settings, lambda: datetime.now(timezone.utc))
    since = today - timedelta(days=90)
    try:
        with progress_path.open("a", encoding="utf-8") as progress:
            for index, candidate in enumerate(candidates, 1):
                if candidate["handle"].lower() in done:
                    continue
                try:
                    result = await verify(candidate, client, since)
                except SpendCapReached:
                    print(f"stopped at the run's cap (US${args.max_usd}) after {index - 1} candidates")
                    break
                result["verified_at"] = today.isoformat()
                done[candidate["handle"].lower()] = result
                progress.write(json.dumps(result, ensure_ascii=False) + "\n")
                progress.flush()
                print(f"{index:3d}/{len(candidates)} {candidate['handle']}: {result['decision']}"
                      + (f" ({result['reason']})" if result.get("reason") else ""), flush=True)
    finally:
        await fetcher.aclose()
    results = [done[c["handle"].lower()] for c in candidates if c["handle"].lower() in done]
    # The spend of earlier runs (a resumed run, a later batch) stays on the record beside this run's.
    runs = []
    if out_path.exists():
        runs = list(json.loads(out_path.read_text(encoding="utf-8")).get("spend", {}).get("runs") or [])
    runs.append({"on": today.isoformat(), "calls": ledger.calls, "objects": ledger.objects, "usd": round(ledger.spent, 4)})
    kept = [r for r in results if r["decision"] == "kept"]
    reasons: dict[str, int] = {}
    for row in results:
        if row["decision"] == "dropped":
            reasons[row["reason"]] = reasons.get(row["reason"], 0) + 1
    document = {
        "_doc": "One verification of every X candidate against SocialData (tools/verify_x_accounts.py): GET /twitter/user/{handle}, then one page of 'from:<handle> -filter:replies since:<90 days before>'. Kept: the account exists, is public and posted (not only retweeted) within 90 days. Followers and the newest post date are as SocialData answered that day.",
        "verified_on": today.isoformat(), "since": since.isoformat(),
        "spend": {"calls": sum(r["calls"] for r in runs), "objects": sum(r["objects"] for r in runs),
                  "usd": round(sum(r["usd"] for r in runs), 4), "runs": runs},
        "counts": {"candidates": len(candidates), "verified": len(results), "kept": len(kept), "dropped": len(results) - len(kept),
                   "dropped_by_reason": dict(sorted(reasons.items()))},
        "results": results,
    }
    if len(results) == len(candidates):
        out_path.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"written {out_path.name}: {len(kept)} kept of {len(candidates)}; this run: {ledger.calls} calls, "
              f"{ledger.objects} objects, US${ledger.spent:.4f}")
    else:
        print(f"incomplete ({len(results)} of {len(candidates)}); this run: {ledger.calls} calls, US${ledger.spent:.4f}; "
              "run again to resume")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
