"""Harness2's BenchmarkAdapter over the lab broker: a rollout is a request to the lab, a harness is a probe.

One adapter serves one domain. `execute()` turns (task, harness tree, run id) into one broker request, submits it, waits for its bundle and
returns the run directory; the same inputs give the same request id, so asking twice is asking once.

How a tree becomes a probe (RSI1-PLAN, "Probe channels"): `guidance.md` is the `probe.preamble` (the lab places it as a marked block in front of
the task); every skill of the tree is merged into ONE personal skill (`item.groupSkill`, because the driver mounts one per group and a group
here is one run); `probe.line` pins the dispatch route to the one the base run took, so the router is not moved by the preamble. The base
run itself has no probe text and lets the router decide.

What a run is allowed to say about itself is fixed at the boundary: the request passes `guard.assert_request_clean`; the bundle is read for
the answer, the report-like files, the transcript and the settled cost, and nothing else; any grading file that ever appeared in a bundle is
removed before anyone can read it.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tarfile
import tempfile
import time
from pathlib import Path

from . import bench_prompts, config, guard, surface as surface_mod, trajectory, upstream
from .broker import BrokerClient, Inbox
from .errors import IdentityMismatch, InfrastructureFailure
from .families import Task
from .ledger import Ledger

up = upstream.load()
RM = up.runmark
HT = up.tree

IMAGE_BASE = "base"
LEAK_GLOBS = ("scores.json", "judge.json", "judge.log", "gold.json", "criteria.json", "checklist.json", "rubric.json", "task.json")
SKILL_TITLE = "Task procedures"
MAX_SKILLS = 6
MAX_SKILL_CHARS = 8000
GRADING_NAMES = re.compile(r"^(scores?|judge[^/]*|gold[^/]*|rubric[^/]*|criteria[^/]*|checklist[^/]*|verdict[^/]*)(\.[a-z]+)?$", re.I)


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def slug(text: str, limit: int = 70) -> str:
    out = re.sub(r"[^A-Za-z0-9._-]+", ".", text).strip(".")
    if len(out) > limit:
        out = out[: limit - 9] + "." + hashlib.sha1(out.encode()).hexdigest()[:8]
    return out


def split_frontmatter(text: str) -> tuple[dict, str]:
    match = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not match:
        return {}, text
    meta = {}
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        if key.strip():
            meta[key.strip()] = value.strip()
    return meta, match.group(2)


def merge_skills(tree: dict[str, str]) -> dict | None:
    """All skills of a harness as the single `groupSkill` the driver can mount: title, one-line description, sections as instructions."""
    names = sorted({m.group(1) for rel in tree if (m := re.fullmatch(r"skills/([a-z0-9][a-z0-9_\-]*)/SKILL\.md", rel))})
    if not names:
        return None
    described, sections = [], []
    for name in names:
        meta, body = split_frontmatter(tree[f"skills/{name}/SKILL.md"])
        described.append(f"{name}: {meta.get('description', '').strip()}")
        sections.append(f"## {name}\n\n{body.strip()}")
    description = ("Load when the situation matches one of these procedures. " + " | ".join(described))[:900]
    return {"title": SKILL_TITLE, "description": description, "instructions": "\n\n".join(sections) + "\n"}


class DshSubstrate:
    name = "dsh"

    def __init__(self):
        self._surface = None

    def surface(self):
        if self._surface is None:
            self._surface = surface_mod.build_surface()
        return self._surface


class DshAdapter:
    def __init__(self, domain: str, tasks: dict[str, Task], *, all_prompts: list[str], names: list[str], runs_root: Path, client: BrokerClient,
                 channels: dict, ledger: Ledger | None = None, balance=None, image: str = IMAGE_BASE, poll_s: float = 30.0,
                 max_wait_s: float = 6 * 3600, clock=time.monotonic, sleep=time.sleep, max_numerals: int = 12):
        surface_mod.register_prompts()
        self.domain = domain
        self.task_map = dict(tasks)
        self.runs_root = Path(runs_root)
        self.rollouts_root = self.runs_root / "rollouts" / domain
        self.ledger, self.balance, self.image = ledger, balance, image
        self.max_wait_s = max_wait_s
        self.inbox = Inbox(self.runs_root / "inbox", client, poll_s=poll_s, clock=clock, sleep=sleep)
        self.substrate = DshSubstrate()
        self.guard = guard.TreeGuard(all_prompts, names, max_numerals=max_numerals)
        self._routes_path = self.runs_root / "routes" / f"{domain}.json"
        self._routes = self._load_routes()
        proposer = channels["stages"]["inv"]
        selector = channels["stages"]["select"]
        self.spec = up.spec.BenchSpec(
            name=f"rsi1-{domain}", runs_root=self.runs_root, install_mode="workspace_config",
            prompts=bench_prompts.for_domain(domain, up.spec.BenchPrompts),
            channels={"proposer": up.spec.ChannelSpec(proposer["kind"], proposer["model"], effort=proposer.get("effort", "high"), timeout=proposer.get("timeout", 2400)),
                      "selector": up.spec.ChannelSpec(selector["kind"], selector["model"], effort=selector.get("effort", "high"), timeout=selector.get("timeout", 2400))},
            domain_word="task family", leak_globs=LEAK_GLOBS, allow_subagents=False, reserved_scripts=frozenset(),
            proposer_deliverables="contents", state_deliverable=False, obs_trunc=12_000,
        )
        self.rollouts_root.mkdir(parents=True, exist_ok=True)

    # ---- task side ---------------------------------------------------------------------------------------------------------
    def tasks(self, split: str = "all") -> list[str]:
        return list(self.task_map)

    def domain_of(self, task_id: str) -> str:
        return self.domain

    def prompts_for(self, task_id: str):
        return self.spec.prompts

    def task_prompt(self, task_id: str) -> str:
        task = self.task_map[task_id]
        note = ""
        if task.files:
            kinds: dict[str, int] = {}
            for entry in task.files:
                suffix = "".join(Path(entry["dest"]).suffixes[-2:]) or "(none)"
                kinds[suffix] = kinds.get(suffix, 0) + 1
            note = ("\n\n---\nThe solver's workspace also holds " + str(len(task.files)) + " input file(s) under inputs/ ("
                    + ", ".join(f"{n} x {k}" for k, n in sorted(kinds.items())) + "); their names and contents are not shown to you.")
        return task.prompt + note

    def task_files(self, task_id: str):
        return None  # inputs live on the lab host; the editors reason from the trajectories

    def base_harness(self) -> Path:
        path = self.runs_root / "_base_harness" / self.domain
        surface = self.substrate.surface()
        if not HT.is_tree(surface, path):
            HT.write_tree(surface, {surface_mod.GUIDANCE: ""}, path)
        return path

    # ---- routes ------------------------------------------------------------------------------------------------------------
    def _load_routes(self) -> dict:
        try:
            return json.loads(self._routes_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _remember_route(self, task_id: str, route: str | None) -> None:
        if route and self._routes.get(task_id) != route:
            self._routes[task_id] = route
            self._routes_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._routes_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._routes, indent=1, sort_keys=True), encoding="utf-8")
            tmp.replace(self._routes_path)

    def route_of(self, task_id: str) -> str | None:
        return self._routes.get(task_id)

    # ---- the request -------------------------------------------------------------------------------------------------------
    def build_request(self, task_id: str, tree: dict[str, str] | None, run_id: str) -> tuple[dict, str]:
        """(request, digest). The digest covers everything that decides what the lab runs, so a changed input is a different request."""
        task = self.task_map[task_id]
        item = task.queue_line()
        item.pop("key"), item.pop("group")
        item["deleteGroupAfter"], item["keepRuntime"] = True, False
        probe = {"preamble": None, "line": None}
        item["groupSkill"] = None
        if tree is not None:
            guidance = (tree.get(surface_mod.GUIDANCE) or "").strip()
            probe["preamble"] = guidance or None
            item["groupSkill"] = merge_skills(tree)
            route = self.route_of(task_id)
            if route is None:
                raise IdentityMismatch(f"{task_id}: a probe was asked for before the base run's route is known; roll the base run first")
            probe["line"] = route
            item["line"] = route
        core = {"image": self.image, "item": item, "probe": probe}
        digest = hashlib.sha256(canonical(core).encode("utf-8")).hexdigest()
        rid = f"h2.{slug(run_id)}.{digest[:10]}"
        item["key"] = f"{task.bench}/{task.id}#{rid}"
        item["group"] = f"h2-{digest[:12]}"
        request = {"rid": rid, "image": self.image, "item": item, "probe": probe}
        guard.assert_request_clean(request)
        if len(rid) > 120:
            raise ValueError(f"request id too long: {rid}")
        return request, digest

    def tree_of(self, harness_dir: Path | None) -> dict[str, str] | None:
        if harness_dir is None:
            return None
        return HT.read_tree(self.substrate.surface(), harness_dir)

    # ---- executing ---------------------------------------------------------------------------------------------------------
    def execute(self, task_id: str, harness_dir: Path | None, run_id: str, *, timeout: int | None = None) -> Path:
        request, digest = self.build_request(task_id, self.tree_of(harness_dir), run_id)
        rid = request["rid"]
        run_dir = self.rollouts_root / rid
        mark = RM.read_mark(run_dir)
        if mark and mark.get("rid") == rid and mark.get("digest") == digest and (run_dir / "result.json").is_file():
            self._remember_route(task_id, mark.get("route") if harness_dir is None else None)
            return run_dir  # finished before, by this very request: nothing is paid or asked again
        if run_dir.exists():
            shutil.rmtree(run_dir)  # an unfinished extraction from a killed process
        if not self.inbox.bundle(rid).is_file():
            if self.balance is not None:
                self.balance.ensure(f"rollout {rid}")
            self._prepare_marker(rid)
            # A task with input files carries where the lane fetches them from (public data, never through this box).
            manifests = [config.PPC_FETCH_FILE] if request["item"].get("files") and config.PPC_FETCH_FILE.exists() else None
            self.inbox.client.submit(request, manifests)
        state = self.inbox.wait_for(rid, max_wait_s=float(self.max_wait_s))
        if state == "infra":
            marker = json.loads(self.inbox.marker(rid).read_text(encoding="utf-8"))
            self.inbox.archive(rid, f"infra-{int(time.time())}")
            reasons = ", ".join(str(r.get("reason")) for r in marker.get("reasons", [])[-3:]) or "unknown"
            raise InfrastructureFailure("lab", f"request {rid} never ran to an answer ({marker.get('attempts')} attempts: {reasons}); ask again to resubmit it")
        return self._accept_bundle(task_id, harness_dir, rid, digest, request)

    def _prepare_marker(self, rid: str) -> None:
        stale = self.inbox.marker(rid)
        if stale.is_file():
            self.inbox.archive(rid, f"stale-{int(time.time())}")  # an earlier failure that was already reported; this is a fresh ask

    def _accept_bundle(self, task_id: str, harness_dir: Path | None, rid: str, digest: str, request: dict) -> Path:
        bundle = self.inbox.bundle(rid)
        staging = Path(tempfile.mkdtemp(prefix=f"{rid[:40]}.", dir=self.rollouts_root))
        try:
            with tarfile.open(bundle, "r:gz") as archive:
                archive.extractall(staging, filter="data")
            root = self._bundle_root(staging)
            removed = self._strip_grading_files(root)
            result = trajectory.result_of(root)
            status = result.get("status")
            if status not in trajectory.FINAL_STATUSES:
                self.inbox.archive(rid, f"driver-{int(time.time())}")
                raise InfrastructureFailure(
                    "driver", f"request {rid} ended as {status!r} ({result.get('infrastructureFailure') and 'infrastructure' or result.get('errorCode')}); "
                              f"the run did not happen, so it is neither a result nor a harness failure")
            run_dir = self.rollouts_root / rid
            if run_dir.exists():
                shutil.rmtree(run_dir)
            shutil.move(str(root), str(run_dir))
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        route = trajectory.route_of(result)
        if harness_dir is None:
            self._remember_route(task_id, route)
        cost = trajectory.cost_of(result)
        (run_dir / "request.json").write_text(json.dumps(request, ensure_ascii=False, indent=1), encoding="utf-8")
        RM.mark_complete(run_dir, run_id=rid, harness_dir=None, extra={
            "rid": rid, "digest": digest, "route": route, "status": status, "removed_grading_files": removed, "cost_cny": cost["cny"]})
        if self.ledger is not None:
            self.ledger.append(
                f"rollout:{rid}", kind="rollout", cached=False, domain=self.domain, task=task_id, rid=rid, status=status, route=route,
                probe=bool(request["probe"]["preamble"] or request["item"].get("groupSkill")), cny=cost["cny"], calls=cost["calls"],
                cost_uncertain=cost["uncertain"], cost_captured=cost["captured"], currency=cost["currency"],
            )
        self.inbox.archive(rid, "done")
        return run_dir

    @staticmethod
    def _bundle_root(staging: Path) -> Path:
        if (staging / "result.json").is_file():
            return staging
        for found in sorted(staging.rglob("result.json"), key=lambda p: len(p.parts)):
            if len(found.relative_to(staging).parts) <= 3:
                return found.parent
        raise InfrastructureFailure("bundle", "the bundle has no result.json: the lab returned something that is not a run")

    @staticmethod
    def _strip_grading_files(root: Path) -> list[str]:
        """Nothing that looks like a grade is ever kept next to a run. Removal is recorded, never silent."""
        removed = []
        for path in sorted(root.rglob("*"), reverse=True):
            if path.is_file() and path.parent == root and GRADING_NAMES.match(path.name):
                removed.append(path.name)
                path.unlink()
        return removed

    # ---- reading a run -----------------------------------------------------------------------------------------------------
    def delivered(self, run_dir: Path) -> bool:
        return trajectory.has_deliverable(run_dir)

    def trajectory(self, run_dir: Path, *, obs_trunc: int) -> str:
        return trajectory.render_trajectory(run_dir, obs_trunc=obs_trunc)

    def deliverable_files(self, run_dir: Path) -> dict[str, str]:
        return trajectory.deliverable_files(run_dir)

    def deliverable_text(self, run_dir: Path) -> str:
        return trajectory.deliverable_text(run_dir)

    # ---- trees -------------------------------------------------------------------------------------------------------------
    def validate_tree(self, tree: dict[str, str]) -> None:
        problems: list[str] = []
        for rel in sorted(tree):
            if rel.startswith("scripts/") or "/scripts/" in rel:
                problems.append(f"{rel}: scripts are not on this surface (the lab mounts a skill's instructions only); describe the step in the skill")
            if rel.startswith("sub_agents/"):
                problems.append(f"{rel}: sub-agent definitions are not on this surface")
        skills = [r for r in tree if re.fullmatch(r"skills/[^/]+/SKILL\.md", r)]
        if len(skills) > MAX_SKILLS:
            problems.append(f"{len(skills)} skills; keep at most {MAX_SKILLS}")
        for rel in skills:
            if len(tree[rel]) > MAX_SKILL_CHARS:
                problems.append(f"{rel} is {len(tree[rel])} characters, over {MAX_SKILL_CHARS}; split it or cut it")
        problems += self.guard.problems(tree)
        if problems:
            raise ValueError(" | ".join(problems))

    def score(self, run_dir: Path, task_id: str):
        raise NotImplementedError("the method never scores here; scoring belongs to the framework, after selection is frozen")
