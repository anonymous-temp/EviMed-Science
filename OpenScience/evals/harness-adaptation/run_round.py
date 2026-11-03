#!/usr/bin/env python3
"""RSI round 1: task-level recursion (Harness2 core, k=1, parallel mode) over the four development tasks of each domain.

  run_round.py --dry-run                         the plan: domains, tasks, request counts, channels, paths; touches nothing
  run_round.py --domains medcalc,drb             run these domains (default: all seven); domains run concurrently, tasks within one in order
  run_round.py --max-tasks 2                     at most two tasks per domain
  run_round.py --select-ppc                      choose the tasks (hash order, salt rsi1-ppc) and write bench/rsi/ppc-tasks.json + ppc-fetch.json
  run_round.py --ledger-report                   the totals of rsi1-ledger.jsonl

Resumable by construction: every rollout is a content-addressed broker request, every improver reply is cached by content under its own
(stage, model, effort) directory, and a task with a final summary is skipped. Run it again after any stop. Exit 0 all tasks adopted or
honestly excluded; 2 some task failed for a reason of its own; 3 infrastructure stopped it (quota, lab, balance): ask again later; 1 usage.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evimed_h2 import config  # noqa: E402
from evimed_h2.errors import BudgetStop, IdentityMismatch, InfrastructureFailure, QuotaExhausted  # noqa: E402

FINAL = {"adopted", "excluded"}


def utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True, default=str) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def copy_tree_text(src: Path, dst: Path) -> None:
    """Small text outputs only; caches, binaries and the heavy run directories stay in the runs root."""
    if dst.exists():
        shutil.rmtree(dst)
    if src.is_dir():
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.workspace"))


class Round:
    def __init__(self, args, *, client=None, fetcher=None, balance=None, ledger=None, channels=None, clock=time.monotonic, sleep=time.sleep):
        from evimed_h2 import balance as balance_mod, channels as channels_mod, families, guard
        from evimed_h2.broker import BrokerctlClient
        from evimed_h2.ledger import Ledger

        self.args = args
        self.runs_root = Path(args.runs_root)
        self.out_root = Path(args.out)
        self.families, self.channels_mod, self.guard_module = families, channels_mod, guard
        self.fetcher = fetcher or families.Fetcher(self.runs_root / "cache", enabled=not args.offline)
        self.channels = channels or channels_mod.load_channels(args.channels)
        self.ledger = ledger or Ledger(args.ledger)
        self.balance = balance or balance_mod.BalanceGuard(floor=args.balance_floor, cap_cny=args.cap_cny, spent=lambda: self.ledger.totals()["solver_cny"],
                                                           clock=clock, sleep=sleep, log=self.log)
        self.client = client or BrokerctlClient(
            [sys.executable, os.environ.get("RSI1_BROKERCTL", str(config.PACKAGE_ROOT / "lab" / "brokerctl.py"))])
        self.clock, self.sleep = clock, sleep
        self.stop = threading.Event()
        self.log_lock = threading.Lock()

    # ---- plumbing ----------------------------------------------------------------------------------------------------------
    def log(self, line: str) -> None:
        with self.log_lock:
            print(f"{utc()} {line}", flush=True)
            status = self.out_root / "STATUS"
            status.parent.mkdir(parents=True, exist_ok=True)
            with open(status, "a", encoding="utf-8") as handle:
                handle.write(f"{utc()} H2 {line}\n")

    def plan(self) -> dict[str, list[str]]:
        chosen = self.families.read_ppc(Path(self.args.tasks_file))
        wanted = [d.strip() for d in self.args.domains.split(",") if d.strip()] if self.args.domains else list(config.DOMAINS)
        unknown = [d for d in wanted if d not in chosen]
        if unknown:
            raise ValueError(f"no chosen tasks for {unknown}; run --select-ppc first (file: {self.args.tasks_file})")
        return {d: chosen[d][: self.args.max_tasks] if self.args.max_tasks else chosen[d] for d in wanted}

    def identity(self, domain: str, adapter, router, ids: list[str]) -> dict:
        from evimed_h2 import surface, upstream

        up = upstream.load()
        return {
            "round": "rsi1", "pin": config.PIN, "patches": upstream.patch_digests(), "mode": "parallel", "k": 1, "domain": domain, "image": adapter.image,
            "channels": router.identity(), "prompt_pack_version": up.prompts.VERSION,
            "surface": hashlib.sha256((surface.SURFACE_TTS + surface.SURFACE_ADAPT).encode()).hexdigest()[:16],
            "tasks": {t: hashlib.sha256(json.dumps([adapter.task_map[t].prompt, adapter.task_map[t].files], sort_keys=True).encode()).hexdigest()[:16] for t in ids},
            "guard": {"window": adapter.guard.window, "max_numerals": adapter.guard.max_numerals},
        }

    def check_identity(self, domain: str, identity: dict) -> None:
        path = self.runs_root / "tasks" / domain / "identity.json"
        existing = read_json(path)
        wanted = json.loads(json.dumps(identity))
        if existing is None:
            write_json(path, identity)
            return
        # More or fewer tasks than the first run is fine (a round may be extended); a task both runs have must be byte for byte the same.
        old_tasks, new_tasks = existing.get("tasks", {}), wanted.get("tasks", {})
        differing_tasks = sorted(t for t in set(old_tasks) & set(new_tasks) if old_tasks[t] != new_tasks[t])
        changed = sorted(k for k in set(existing) | set(wanted) if k != "tasks" and existing.get(k) != wanted.get(k))
        if differing_tasks:
            changed.append("tasks " + ", ".join(differing_tasks))
        if not changed:
            if set(new_tasks) - set(old_tasks):
                write_json(path, {**existing, "tasks": {**old_tasks, **new_tasks}})
        else:
            raise IdentityMismatch(
                f"{path.parent} belongs to different inputs, models or tasks (differs in: {', '.join(changed)}). "
                f"Use a new --runs-root for a new experiment; nothing was run.")

    # ---- one domain --------------------------------------------------------------------------------------------------------
    def build_adapter(self, domain: str, ids: list[str]):
        from evimed_h2.adapter import DshAdapter

        family = self.families.Family(domain, fetcher=self.fetcher, root=Path(self.args.bench_root))
        tasks = family.tasks(ids)
        everything = family.tasks()  # the whole development pool, for the tree guard only
        names = self.guard_names(everything)
        return DshAdapter(
            domain, tasks, all_prompts=[t.prompt for t in everything.values()], names=names, reference=self.guard_module.platform_prose(config.OPENSCIENCE_ROOT),
            runs_root=self.runs_root, client=self.client,
            channels=self.channels, ledger=self.ledger, balance=self.balance, poll_s=self.args.poll_s, max_wait_s=self.args.max_wait_s,
            clock=self.clock, sleep=self.sleep, max_numerals=self.args.max_numerals)

    @staticmethod
    def guard_names(tasks) -> list[str]:
        from evimed_h2 import guard

        return guard.candidate_names(tasks.values())

    def run_domain(self, domain: str, ids: list[str]) -> dict:
        from evimed_h2 import upstream

        up = upstream.load()
        adapter = self.build_adapter(domain, ids)
        router = self.channels_mod.build_router(self.runs_root / "audit" / domain, domain=domain, ledger=self.ledger, channels=self.channels)
        self.check_identity(domain, self.identity(domain, adapter, router, ids))
        surface = adapter.substrate.surface()
        library = up.library.Library(root=self.runs_root / "library", domain=domain, surface=surface)
        report = {"domain": domain, "tasks": [], "stopped": None}

        def summary_of(task: str) -> dict:
            return read_json(self.runs_root / "tasks" / domain / up.library.slug(task) / "summary.json") or {}

        for position, tid in enumerate(ids):
            if self.stop.is_set():
                report["stopped"] = "another domain hit a stop that every domain shares"
                break
            summary_path = self.runs_root / "tasks" / domain / up.library.slug(tid) / "summary.json"
            existing = summary_of(tid)
            if existing and existing.get("status") in FINAL:
                report["tasks"].append({"task": tid, "status": existing["status"], "resumed": True})
                self.mirror(domain, library, tid, existing)
                continue
            # The library a task reads holds the adopted tasks that come before it in the stream, whether this process or an earlier one ran them.
            library.retain([t for t in ids[:position] if summary_of(t).get("status") == "adopted"])
            try:
                summary = self.run_task(domain, adapter, router, library, tid)
            except (QuotaExhausted, BudgetStop) as exc:
                self.stop.set()
                return self.infra(report, tid, exc, summary_path)
            except InfrastructureFailure as exc:
                return self.infra(report, tid, exc, summary_path)
            write_json(summary_path, summary)
            report["tasks"].append({"task": tid, "status": summary["status"], "reasons": summary.get("reasons", [])})
            self.mirror(domain, library, tid, summary)
            self.log(f"{domain}/{tid} {summary['status']}" + (f" ({'; '.join(summary.get('reasons', []))[:160]})" if summary.get("reasons") else ""))
        return report

    def infra(self, report: dict, tid: str, exc: InfrastructureFailure, summary_path: Path) -> dict:
        previous = read_json(summary_path) or {}
        write_json(summary_path, {**previous, "task": tid, "status": "infra", "infrastructure": {"kind": exc.kind, "detail": exc.detail, "at": utc()}})
        report["tasks"].append({"task": tid, "status": "infra", "kind": exc.kind})
        report["stopped"] = f"{exc.kind}: {exc.detail[:200]}"
        self.log(f"{report['domain']}/{tid} INFRA {exc.kind}: {exc.detail[:200]} (resume by running again)")
        return report

    # ---- one task ----------------------------------------------------------------------------------------------------------
    def run_task(self, domain: str, adapter, router, library, tid: str) -> dict:
        from evimed_h2 import upstream
        from evimed_h2.ledger import Ledger  # noqa: F401

        up = upstream.load()
        surface = adapter.substrate.surface()
        task_dir = self.runs_root / "tasks" / domain / up.library.slug(tid)
        task_dir.mkdir(parents=True, exist_ok=True)
        started = time.time()
        ns = f"rsi1/{domain}/{tid}"
        run_id_of = lambda label: f"{ns}/{label}"  # noqa: E731

        base_dir = adapter.execute(tid, None, run_id_of("base1"))
        base = up.spec.RunView(label="base1", run_id=run_id_of("base1"), run_dir=base_dir, ok=True, delivered=adapter.delivered(base_dir))
        base_tree = up.tree.read_tree(surface, adapter.base_harness())

        result = up.recursion.run_parallel(
            tid, 1, [base], adapter=adapter, prop=router, work_dir=task_dir, run_id_of=run_id_of, base_tree=base_tree,
            library_dir=library.context_dir(), propose_workers=2, rollout_workers=2)

        reasons: list[str] = []
        for stage in result.stages:
            if stage.fell_back:
                reasons.append(f"stage {stage.label} fell back to the inherited harness: {(stage.error or 'no reason recorded')[:160]}")
        dead = sorted(label for label, rv in result.rollouts.items() if not rv.ok)
        if dead:
            reasons.append(f"rollout(s) {', '.join(dead)} produced no run directory")

        pool = {"base1": base}
        if "agg1" in result.rollouts:
            pool["agg1"] = result.rollouts["agg1"]
        sel = up.selection.run_selection(tid, 1, "agg", pool, adapter=adapter, prop=router, work_dir=task_dir, pool_kind="mixed")
        if not sel.ok:
            reasons.append(f"selection did not complete: {(sel.error or 'no candidate delivered')[:160]}")
        chosen = pool.get(sel.chosen_label)
        if sel.ok and (chosen is None or not chosen.delivered):
            reasons.append("the selected run delivered nothing")

        experience: dict = {}
        added = False
        if sel.ok and not reasons:
            decisions = {stage.label: stage.notes or stage.error for stage in result.stages}
            experience = up.selection.reflect_adoption(tid, sel, result.rollouts, adapter=adapter, prop=router, work_dir=task_dir, decisions=decisions)
            if up.library.has_experience(experience):
                chosen_tree = result.trees.get(sel.chosen_label, base_tree)
                library.add(tid, chosen_tree, why=sel.why, label=sel.chosen_label, run_id=sel.chosen_run_id, experience=experience)
                added = True
            else:
                reasons.append("the reflector wrote no supported lesson (NO_ENTRY); the adopted harness is kept, the library gets no entry")

        status = "adopted" if added else "excluded"  # an entry-less task teaches the library nothing; it is reported, not hidden
        adopted_tree = result.trees.get(sel.chosen_label, base_tree) if sel.chosen_label else base_tree
        mine = [r for r in self.ledger.rows() if r.get("task") == up.library.slug(tid) or r.get("task") == tid]
        spent = {
            "rollouts": len([r for r in mine if r.get("kind") == "rollout" and not r.get("cached")]),
            "solver_cny": round(sum(float(r.get("cny") or 0) for r in mine if r.get("kind") == "rollout" and not r.get("cached")), 6),
            "improver_calls": len([r for r in mine if r.get("kind") == "improver" and not r.get("cached")]),
            "claude_usd_reported": round(sum(float(r.get("usd_reported") or 0) for r in mine if r.get("kind") == "improver" and not r.get("cached")), 4),
        }
        return {
            "task": tid, "domain": domain, "status": status, "reasons": reasons, "mode": "parallel", "k": 1, "finished": utc(),
            "wall_s": round(time.time() - started, 1),
            "stages": [{"label": s.label, "dim": s.dim, "fell_back": s.fell_back, "kept_base": s.kept_base, "attempts": s.attempts,
                        "error": (s.error or "")[:300], "notes": (s.notes or "")[:600]} for s in result.stages],
            "rollouts": {label: {"run_id": rv.run_id, "ok": rv.ok, "delivered": rv.delivered, "error": rv.error} for label, rv in result.rollouts.items()},
            "ledger": result.ledger.to_dict() if result.ledger else None,
            "selection": {"ok": sel.ok, "chosen_label": sel.chosen_label, "chosen_is_base": sel.chosen_is_base, "fallback": sel.fallback,
                          "why": sel.why, "error": sel.error, "id_map": sel.id_map, "dropped": sel.dropped},
            "experience": experience, "library_entry": added, "adopted_tree": adopted_tree,
            "adopted_tree_is_base": adopted_tree == base_tree,
            "spent": spent,
        }

    # ---- output ------------------------------------------------------------------------------------------------------------
    def mirror(self, domain: str, library, tid: str, summary: dict) -> None:
        from evimed_h2 import upstream

        up = upstream.load()
        base = self.out_root / domain
        task_out = base / "tasks" / up.library.slug(tid)
        write_json(task_out / "summary.json", {k: v for k, v in summary.items() if k != "adopted_tree"})
        tree = summary.get("adopted_tree") or {}
        if tree:
            for rel, text in tree.items():
                target = task_out / "adopted" / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")
        copy_tree_text(library.dir, base / "library")

    # ---- whole round -------------------------------------------------------------------------------------------------------
    def run(self) -> int:
        plan = self.plan()
        self.log(f"round start: {', '.join(f'{d}={len(v)}' for d, v in plan.items())}; concurrency {self.args.concurrency}")
        reports: list[dict] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, self.args.concurrency)) as pool:
            futures = {pool.submit(self.run_domain, d, ids): d for d, ids in plan.items()}
            for future in concurrent.futures.as_completed(futures):
                domain = futures[future]
                try:
                    reports.append(future.result())
                except IdentityMismatch as exc:
                    self.log(f"{domain} REFUSED: {exc}")
                    reports.append({"domain": domain, "tasks": [], "stopped": f"identity: {exc}", "config_error": True})
                except Exception as exc:  # a bug in this domain must not take the other domains down; it is reported and fails the round
                    self.log(f"{domain} ERROR {type(exc).__name__}: {str(exc)[:240]}")
                    reports.append({"domain": domain, "tasks": [], "stopped": f"{type(exc).__name__}: {exc}", "error": True})
        write_json(self.out_root / "round-report.json", {"at": utc(), "reports": reports, "ledger": self.ledger.totals()})
        statuses = [t["status"] for r in reports for t in r["tasks"]]
        if any(r.get("config_error") for r in reports):
            return 1
        if "infra" in statuses or any(r.get("stopped") and not r.get("error") and not r.get("config_error") for r in reports):
            return 3
        if any(r.get("error") for r in reports) or "excluded" in statuses:
            return 2
        return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--domains", default="")
    p.add_argument("--max-tasks", type=int, default=config.PPC_PER_DOMAIN)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--select-ppc", action="store_true")
    p.add_argument("--force", action="store_true", help="with --select-ppc: replace an existing ppc-tasks.json with different ids")
    p.add_argument("--ledger-report", action="store_true")
    p.add_argument("--concurrency", type=int, default=2, help="domains run at once (each runs at most two rollouts at once)")
    p.add_argument("--runs-root", default=str(config.RUNS_ROOT))
    p.add_argument("--out", default=str(config.OUT_ROOT))
    p.add_argument("--ledger", default=str(config.LEDGER_FILE))
    p.add_argument("--tasks-file", default=str(config.PPC_TASKS_FILE))
    p.add_argument("--bench-root", default=str(config.BENCH_ROOT))
    p.add_argument("--channels", default=str(config.CHANNELS_FILE))
    p.add_argument("--balance-floor", type=float, default=config.BALANCE_FLOOR_CNY)
    p.add_argument("--cap-cny", type=float, default=config.ROUND_CAP_CNY)
    p.add_argument("--poll-s", type=float, default=30.0)
    p.add_argument("--max-wait-s", type=float, default=6 * 3600)
    p.add_argument("--max-numerals", type=int, default=12)
    p.add_argument("--offline", action="store_true", help="never fetch public task metadata (DRB queries, RCB task info); use the cache only")
    return p


def dry_run(rnd: Round) -> int:
    plan = rnd.plan()
    channels = rnd.channels["stages"]
    print(f"# RSI round 1 dry run: parallel mode, k=1, {len(plan)} domain(s)")
    print(f"# runs root   {rnd.runs_root}\n# out         {rnd.out_root}\n# ledger      {rnd.ledger.path}\n# tasks file  {rnd.args.tasks_file}")
    print("# channels    " + "; ".join(f"{s}={row['model']}" for s, row in channels.items()) + " (improvers: this box's Claude login; solver: DSH + DeepSeek Flash)")
    print(f"# balance floor {rnd.args.balance_floor} CNY (read at most once a minute), round cap {rnd.args.cap_cny} CNY, concurrency {rnd.args.concurrency}")
    total = 0
    for domain, ids in plan.items():
        family = rnd.families.Family(domain, fetcher=rnd.fetcher, root=Path(rnd.args.bench_root))
        tasks = family.tasks(ids)
        for position, tid in enumerate(ids, 1):
            t = tasks[tid]
            total += 1
            print(f"{domain:9} {position}/{len(ids)} {tid:16} timeout {t.timeout_min:>3} min  inputs {len(t.files):>3}  prompt {len(t.prompt):>6} chars")
    print(f"# {total} tasks: per task 4 rollouts (base, inv, dom, agg) and 5 improver sessions (inv, dom, agg, select, reflect); "
          f"{4 * total} rollouts, {5 * total} improver sessions at most")
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    os.makedirs(args.runs_root, exist_ok=True)
    tmp = Path(args.runs_root) / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    os.environ["TMPDIR"] = str(tmp)  # upstream's session scratch directories (mkdtemp) live under the runs root, never in a checkout
    import tempfile

    tempfile.tempdir = str(tmp)
    try:
        if args.select_ppc:
            from evimed_h2 import families

            fetcher = families.Fetcher(Path(args.runs_root) / "cache", enabled=not args.offline)
            document = families.select_ppc(root=Path(args.bench_root), fetcher=fetcher)
            path = families.write_ppc(document, Path(args.tasks_file), force=args.force)
            entries = []
            for domain in ("bixbench", "rcb"):
                entries += families.fetch_entries(domain, document["domains"][domain]["ids"], root=Path(args.bench_root), fetcher=fetcher)
            write_json(config.PPC_FETCH_FILE if args.tasks_file == str(config.PPC_TASKS_FILE) else Path(args.tasks_file).with_name("ppc-fetch.json"), entries)
            for domain, v in document["domains"].items():
                print(f"{domain:9} {v['ids']}")
            print(f"wrote {path}")
            return 0
        rnd = Round(args)
        if args.ledger_report:
            print(json.dumps(rnd.ledger.totals(), indent=1))
            return 0
        if args.dry_run:
            return dry_run(rnd)
        return rnd.run()
    except IdentityMismatch as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (ValueError, FileNotFoundError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
