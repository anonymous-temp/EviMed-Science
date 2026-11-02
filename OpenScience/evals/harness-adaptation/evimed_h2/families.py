"""The seven domains of the round and the tasks inside them.

A domain is a registered development pool of one benchmark family (`bench/pools/*.json`, role "development" only: nothing in this module
reads the confirmation list). A task is built from the family's raw data the way `bench/tools/build_*.py` built the baseline items, so the
solver receives byte-identical prompts and input-file lists; `tests/test_families.py` checks that against the baseline queue when the data
is on the box. Only the fields a solver is given are ever kept: the raw files also hold gold answers, rubrics and references, and every
loader projects the few columns it needs at the moment it reads them.

`select_ppc()` takes the first N feasible development tasks of each domain in order of sha256("rsi1-ppc|<id>") and writes them to
`bench/rsi/ppc-tasks.json`, so the development gate can leave them out.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import config
from .errors import ContaminationRefused

# --------------------------------------------------------------------------------------------------------------------------------
# What a task is

BENCH_NAMES = {
    "medcalc": "medcalc", "arb-deep": "arb", "arb-wide": "arb", "bixbench": "bixbench",
    "mbc": "medbrowsecomp", "drb": "drb", "rcb": "researchclawbench",
}
POOL_FILES = {
    "medcalc": ("medcalc.json", "main"), "arb-deep": ("arb.json", "deep"), "arb-wide": ("arb.json", "wide"),
    "bixbench": ("bixbench.json", "main"), "mbc": ("medbrowsecomp.json", "main"), "drb": ("drb.json", "main"), "rcb": ("rcb.json", "main"),
}
TIMEOUT_MIN = {"medcalc": 10, "arb-deep": 20, "arb-wide": 20, "bixbench": 40, "mbc": 15, "drb": 30, "rcb": 60}
HOST_DATA = "/srv/evimed-science/shared/benchmarks/data"
HF_BIXBENCH_SHA = None  # read from hf_sizes.json
RCB_REV = "fa82414b2ead64ea3a4df2c0688512198c42ba59"
RCB_BASE = f"https://huggingface.co/datasets/InternScience/ResearchClawBench/resolve/{RCB_REV}/"
RCB_TREE_API = f"https://huggingface.co/api/datasets/InternScience/ResearchClawBench/tree/{RCB_REV}/"
DRB_QUERY_URL = "https://raw.githubusercontent.com/Ayanami0730/deep_research_bench/f2735b5c/data/prompt_data/query.jsonl"
# Tasks the baseline builder already ruled out as not feasible in the hosted runtime (build_rcb.py), plus a data-size ceiling.
RCB_INFEASIBLE = {"Life_003", "Life_004", "Neuroscience_001"}
RCB_MAX_BYTES = 300 * 1024 * 1024
BIX_MAX_BYTES = 250 * 1024 * 1024  # the 380 MB capsules hold files over the product's 50 MB upload limit

CALC_FINAL = "End with a final line: Final answer: <value>"
ARB_DEEP_LINE = "End with a final line: Final answer: <paper title> (arXiv:<id>), or None if no paper satisfies the conditions"
ARB_WIDE_LINE = ("End with a section that starts with a line \"Final answer:\" followed by one line per paper "
                 "in the form: <paper title> (arXiv:<id>); write None if no paper satisfies the conditions")
BIX_LINE = 'End with a final section that starts with a line "Final answers:" followed by one numbered line per question: <number>. <answer>'


class DataUnavailable(RuntimeError):
    """A raw file the family needs is not on this box and fetching is off."""


@dataclass(frozen=True)
class Task:
    """What the solver is given, and nothing else. `facts` are non-gold descriptors used for selection and reporting only."""

    domain: str
    id: str
    prompt: str
    files: tuple[dict, ...] = ()
    timeout_min: int = 15
    settle_seconds: int | None = None
    facts: dict = field(default_factory=dict)

    @property
    def bench(self) -> str:
        return BENCH_NAMES[self.domain]

    @property
    def key(self) -> str:
        return f"{self.bench}/{self.id}"

    def queue_line(self) -> dict:
        """The bench-driver queue line of the baseline form (see bench/queue/v1-*.jsonl): the base run's item, before a probe edits it."""
        line = {
            "key": self.key, "bench": self.bench, "id": self.id, "group": self.default_group(), "prompt": self.prompt, "line": None,
            "timeoutMin": self.timeout_min, "files": [dict(f) for f in self.files],
            "deleteGroupAfter": self.domain in ("bixbench", "rcb"), "collect": True,
        }
        if self.settle_seconds:
            line["settleSeconds"] = self.settle_seconds
        # The product's own deadline field (phase 1.1): the model is told the time, every arm alike. MedCalc ends in seconds and has none.
        if self.domain != "medcalc":
            line["timeBudgetMinutes"] = self.timeout_min
        return line

    def default_group(self) -> str:
        if self.domain == "bixbench":
            return f"bixbench-{self.id}"
        if self.domain == "rcb":
            return f"researchclawbench-{self.id}"
        return {"medcalc": "medcalc-main", "arb-deep": "arb-main", "arb-wide": "arb-main", "mbc": "medbrowsecomp-main", "drb": "drb-main"}[self.domain]


# --------------------------------------------------------------------------------------------------------------------------------
# Fetching (cached, small text only; tests inject a fake)


class Fetcher:
    def __init__(self, cache: Path | None = None, enabled: bool = True):
        self.cache = Path(cache or (config.RUNS_ROOT / "cache"))
        self.enabled = enabled

    def text(self, url: str, name: str) -> str:
        path = self.cache / name
        if path.is_file():
            return path.read_text(encoding="utf-8")
        if not self.enabled:
            raise DataUnavailable(f"{name} is not cached under {self.cache} and fetching is off")
        request = urllib.request.Request(url, headers={"User-Agent": "evimed-rsi1/0.1"})
        with urllib.request.urlopen(request, timeout=60) as response:  # follows the redirect HF answers with
            body = response.read().decode("utf-8")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        return body


# --------------------------------------------------------------------------------------------------------------------------------
# Pools


def load_pool(domain: str, root: Path | None = None) -> dict:
    root = Path(root or config.BENCH_ROOT)
    name, pool = POOL_FILES[domain]
    document = json.loads((root / "pools" / name).read_text(encoding="utf-8"))
    entry = document["pools"][pool]
    # Only the development list is ever returned: the confirmation list is not read into any structure this package keeps.
    return {"development": [str(i) for i in entry["development"]], "digest": document.get("digest"), "rule": document.get("rule")}


# --------------------------------------------------------------------------------------------------------------------------------
# Per-family builders. Each returns {id: Task} for the requested ids, projecting only solver-visible columns.


def _build_medcalc(root: Path, ids: list[str], fetcher: Fetcher) -> dict[str, Task]:
    want = set(ids)
    out: dict[str, Task] = {}
    with open(root / "data/medcalc/test_data.csv", newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            rid = row["Row Number"]
            if rid not in want:
                continue
            prompt = f"Here is the patient note:\n{row['Patient Note']}\n\nHere is the task:\n{row['Question']}\n\n{CALC_FINAL}"
            out[rid] = Task("medcalc", rid, prompt, (), TIMEOUT_MIN["medcalc"], facts={"calculator": row["Calculator Name"], "output_type": row["Output Type"]})
    return out


def _arb_rows(root: Path) -> list[dict]:
    rows = []
    with open(root / "data/autoresearchbench_data/AutoResearchBench.jsonl", encoding="utf-8") as handle:
        for index, line in enumerate(handle):
            raw = json.loads(line)
            rows.append({"idx": index, "type": raw["type"], "question": raw["question"], "category": raw.get("category")})  # no answer, no arxiv id
    return rows


def _build_arb(kind: str):
    def build(root: Path, ids: list[str], fetcher: Fetcher) -> dict[str, Task]:
        want = set(ids)
        domain = f"arb-{kind}"
        out: dict[str, Task] = {}
        for row in _arb_rows(root):
            tid = f"{row['type']}-{row['idx']}"
            if row["type"] != kind or tid not in want:
                continue
            tail = ARB_DEEP_LINE if kind == "deep" else ARB_WIDE_LINE
            out[tid] = Task(domain, tid, row["question"].strip() + "\n\n" + tail, (), TIMEOUT_MIN[domain], facts={"category": row["category"]})
        return out
    return build


def _bix_context(root: Path):
    meta = root / "data/bixbench_meta"
    questions: dict[str, list[dict]] = {}
    with open(meta / "BixBench.jsonl", encoding="utf-8") as handle:
        for line in handle:
            raw = json.loads(line)
            projected = {"short_id": raw["short_id"], "qid": raw["question_id"], "question": raw["question"], "uuid": raw["capsule_uuid"], "folder": raw["data_folder"]}
            questions.setdefault(raw["short_id"], []).append(projected)  # ideal, answer, distractors, hypothesis, paper: never kept
    return questions, json.loads((meta / "zip_index.json").read_text()), json.loads((meta / "zip_lfs.json").read_text()), json.loads((meta / "hf_sizes.json").read_text())


def _build_bixbench(root: Path, ids: list[str], fetcher: Fetcher) -> dict[str, Task]:
    questions, index, _lfs, _hf = _bix_context(root)
    out: dict[str, Task] = {}
    for short in ids:
        qs = sorted(questions.get(short, []), key=lambda q: q["qid"])
        if not qs:
            continue
        uuid, folder = qs[0]["uuid"], qs[0]["folder"]
        entry = index.get(folder)
        entries = [e for e in (entry or {}).get("entries", []) if e["name"].startswith("CapsuleData-") and not e["name"].endswith("/")]
        prefix = f"CapsuleData-{uuid}/"
        qtxt = "\n\n".join(f"{n}. {q['question'].strip()}" for n, q in enumerate(qs, 1))
        prompt = "The data for this analysis is in the workspace folder inputs/. Answer the numbered questions below using that data.\n\n" + qtxt + "\n\n" + BIX_LINE
        files = tuple(
            {"src": f"/bench/data/bixbench/{short}/{e['name'][len(prefix):]}", "dest": f"inputs/{e['name'][len(prefix):]}"}
            for e in sorted(entries, key=lambda e: e["name"])
        )
        out[short] = Task("bixbench", short, prompt, files, TIMEOUT_MIN["bixbench"], facts={
            "uuid": uuid, "n_questions": len(qs), "n_files": len(files),
            "data_bytes": sum(e["size"] for e in entries), "zip_bytes": (entry or {}).get("zip_bytes"),
        })
    return out


def _build_mbc(root: Path, ids: list[str], fetcher: Fetcher) -> dict[str, Task]:
    want = set(ids)
    out: dict[str, Task] = {}
    with open(root / "data/medbrowsecomp/MedBrowseComp_605.csv", newline="", encoding="utf-8") as handle:
        for index, row in enumerate(csv.DictReader(handle)):
            if str(index) not in want:
                continue
            out[str(index)] = Task("mbc", str(index), row["prompt"], (), TIMEOUT_MIN["mbc"], facts={"task_name": row["task_name"]})  # gold column never kept
    return out


def _build_drb(root: Path, ids: list[str], fetcher: Fetcher) -> dict[str, Task]:
    want = set(ids)
    text = fetcher.text(DRB_QUERY_URL, "drb-query.jsonl")
    out: dict[str, Task] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        raw = json.loads(line)
        rid = str(raw["id"])
        if rid in want:
            out[rid] = Task("drb", rid, raw["prompt"], (), TIMEOUT_MIN["drb"], facts={"language": raw.get("language"), "topic": raw.get("topic")})
    return out


def _rcb_task_info(root: Path, tid: str, fetcher: Fetcher) -> dict:
    local = root / "data/rcb_meta" / tid / "task_info.json"  # checklist.json beside it is the rubric: never opened
    if local.is_file():
        return json.loads(local.read_text(encoding="utf-8"))
    return json.loads(fetcher.text(RCB_BASE + urllib.parse.quote(f"tasks/{tid}/task_info.json"), f"rcb/{tid}/task_info.json"))


def _rcb_tree(root: Path, tid: str, fetcher: Fetcher) -> list[dict]:
    local = root / "data/rcb_meta/tree.json"
    if local.is_file():
        tree = json.loads(local.read_text(encoding="utf-8"))
        if tid in tree:
            return tree[tid]
    listing = json.loads(fetcher.text(RCB_TREE_API + f"tasks/{tid}?recursive=1", f"rcb/{tid}/tree.json"))
    return [{"path": e["path"], "size": e.get("size", 0), "sha256": (e.get("lfs") or {}).get("oid")} for e in listing if e.get("type") == "file"]


def _build_rcb(root: Path, ids: list[str], fetcher: Fetcher) -> dict[str, Task]:
    out: dict[str, Task] = {}
    for tid in ids:
        ti = _rcb_task_info(root, tid, fetcher)
        files_meta = _rcb_tree(root, tid, fetcher)
        pref = f"tasks/{tid}/"
        dfiles = sorted([f for f in files_meta if "/data/" in f["path"]], key=lambda f: f["path"])
        rfiles = sorted([f for f in files_meta if "/related_work/" in f["path"]], key=lambda f: f["path"])
        lines = []
        for e in ti["data"]:
            p = e["path"].lstrip("./")
            lines.append(f"- inputs/{p}: {e.get('name', '')}. {e.get('description', '')}".rstrip())
        prompt = (
            ti["task"].strip() + "\n\nData files (read-only, under inputs/data/):\n" + "\n".join(lines)
            + "\n\nRelated papers are in inputs/related_work/.\n\n"
            "Carry the research through end to end: write your code in code/, intermediate results in outputs/, and the final "
            "research report to report/report.md (methodology, results with figures, discussion). Save every figure as a PNG in "
            "report/images/ and reference it in the report with a relative path such as images/figure_name.png."
        )
        files = tuple(
            {"src": f"/bench/data/researchclawbench/{tid}/{f['path'][len(pref):]}", "dest": f"inputs/{f['path'][len(pref):]}"}
            for f in dfiles + rfiles
        )
        out[tid] = Task("rcb", tid, prompt, files, TIMEOUT_MIN["rcb"], 240, facts={
            "area": tid.split("_")[0], "data_bytes": sum(f["size"] for f in dfiles), "related_bytes": sum(f["size"] for f in rfiles),
            "n_files": len(files),
        })
    return out


BUILDERS: dict[str, Callable[[Path, list[str], Fetcher], dict[str, Task]]] = {
    "medcalc": _build_medcalc, "arb-deep": _build_arb("deep"), "arb-wide": _build_arb("wide"), "bixbench": _build_bixbench,
    "mbc": _build_mbc, "drb": _build_drb, "rcb": _build_rcb,
}


def feasible(task: Task) -> bool:
    """The same eligibility the baseline builders used, so a probe never asks the lab for something the hosted runtime cannot do."""
    if task.domain == "bixbench":
        f = task.facts
        return (f.get("n_questions", 0) >= 1 and (f.get("data_bytes") or 0) <= BIX_MAX_BYTES and (f.get("zip_bytes") or 0) <= BIX_MAX_BYTES
                and f.get("n_files", 0) > 0)
    if task.domain == "rcb":
        return task.id not in RCB_INFEASIBLE and (task.facts.get("data_bytes", 0) + task.facts.get("related_bytes", 0)) <= RCB_MAX_BYTES
    return True


def order_key(task_id: str, salt: str = config.PPC_SALT) -> str:
    return hashlib.sha256(f"{salt}|{task_id}".encode()).hexdigest()


class Family:
    """One domain: its development tasks, loaded lazily and only from the development list."""

    def __init__(self, domain: str, *, root: Path | None = None, fetcher: Fetcher | None = None):
        if domain not in config.DOMAINS:
            raise ValueError(f"unknown domain {domain!r}; expected one of {config.DOMAINS}")
        self.domain = domain
        self.root = Path(root or config.BENCH_ROOT)
        self.fetcher = fetcher or Fetcher()
        self._pool = None
        self._tasks: dict[str, Task] | None = None

    @property
    def pool(self) -> dict:
        if self._pool is None:
            self._pool = load_pool(self.domain, self.root)
        return self._pool

    def development_ids(self) -> list[str]:
        return list(self.pool["development"])

    def tasks(self, ids: list[str] | None = None) -> dict[str, Task]:
        """Tasks by id. Asking for an id outside the development list is refused: this module never builds a confirmation prompt."""
        allowed = set(self.development_ids())
        wanted = list(ids) if ids is not None else self.development_ids()
        outside = [i for i in wanted if i not in allowed]
        if outside:
            raise ContaminationRefused(f"{self.domain}: {outside[:3]} are not development tasks; only the development pool is read")
        if self._tasks is None:
            self._tasks = {}
        missing = [i for i in wanted if i not in self._tasks]
        if missing:
            built = BUILDERS[self.domain](self.root, missing, self.fetcher)
            lost = [i for i in missing if i not in built]
            # Asked for the whole pool: a row with no raw data is simply not a task. Asked for it by id: that is an error.
            if ids is None:
                wanted = [i for i in wanted if i not in lost]
                lost = []
            if lost:
                raise DataUnavailable(f"{self.domain}: no raw data for {lost[:5]}")
            self._tasks.update(built)
        return {i: self._tasks[i] for i in wanted}

    def select(self, n: int = config.PPC_PER_DOMAIN, salt: str = config.PPC_SALT) -> list[str]:
        """The first n feasible development tasks in hash order. Deterministic; same pool and salt give the same ids."""
        ordered = sorted(self.development_ids(), key=lambda i: order_key(i, salt))
        chosen: list[str] = []
        # Build in hash order, in small batches, so a network family does not fetch the whole pool for four tasks.
        for start in range(0, len(ordered), 8):
            batch = ordered[start:start + 8]
            built = self.tasks(batch)
            for tid in batch:
                if feasible(built[tid]):
                    chosen.append(tid)
                    if len(chosen) == n:
                        return chosen
        return chosen


def select_ppc(domains=config.DOMAINS, *, root: Path | None = None, fetcher: Fetcher | None = None, n: int = config.PPC_PER_DOMAIN) -> dict:
    document = {
        "schema": "rsi1-ppc-tasks/1", "salt": config.PPC_SALT, "perDomain": n,
        "rule": "development ids of the registered pool, feasible per the baseline builders, ordered by sha256(salt|id), first n",
        "domains": {},
    }
    for domain in domains:
        family = Family(domain, root=root, fetcher=fetcher)
        ids = family.select(n)
        tasks = family.tasks(ids)
        document["domains"][domain] = {
            "poolDigest": family.pool["digest"], "developmentSize": len(family.development_ids()), "ids": ids,
            "facts": {i: tasks[i].facts for i in ids},
        }
    return document


def write_ppc(document: dict, path: Path | None = None, *, force: bool = False) -> Path:
    path = Path(path or config.PPC_TASKS_FILE)
    if path.is_file():
        existing = json.loads(path.read_text(encoding="utf-8"))
        same = {d: v["ids"] for d, v in existing.get("domains", {}).items()} == {d: v["ids"] for d, v in document["domains"].items()}
        if not same and not force:
            raise RuntimeError(f"{path} exists with different ids; the development gate already excludes those. Use --force to replace it")
        if same:
            return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(document, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def read_ppc(path: Path | None = None) -> dict[str, list[str]]:
    document = json.loads(Path(path or config.PPC_TASKS_FILE).read_text(encoding="utf-8"))
    return {domain: list(v["ids"]) for domain, v in document["domains"].items()}


# --------------------------------------------------------------------------------------------------------------------------------
# Public-data fetch lists for the chosen tasks (the format bench/fetch/*.json and brokerctl --fetch use)


def fetch_entries(domain: str, ids: list[str], *, root: Path | None = None, fetcher: Fetcher | None = None) -> list[dict]:
    root = Path(root or config.BENCH_ROOT)
    fetcher = fetcher or Fetcher()
    entries: list[dict] = []
    if domain == "bixbench":
        questions, _index, lfs, hf = _bix_context(root)
        for short in ids:
            qs = questions[short]
            uuid, folder = qs[0]["uuid"], qs[0]["folder"]
            entries.append({
                "url": f"https://huggingface.co/datasets/futurehouse/BixBench/resolve/{hf['sha']}/{folder}",
                "bytes": lfs[folder]["size"], "sha256": lfs[folder]["sha256"],
                "dest": f"{HOST_DATA}/bixbench/_zips/{folder}",
                "unzip": {"into": f"{HOST_DATA}/bixbench/{short}", "only_prefix": f"CapsuleData-{uuid}/", "strip_prefix": True, "delete_zip": True},
            })
    elif domain == "rcb":
        for tid in ids:
            pref = f"tasks/{tid}/"
            for f in _rcb_tree(root, tid, fetcher):
                if "/data/" in f["path"] or "/related_work/" in f["path"]:
                    entries.append({
                        "url": RCB_BASE + urllib.parse.quote(f["path"]), "bytes": f["size"], "sha256": f.get("sha256"),
                        "dest": f"{HOST_DATA}/researchclawbench/{tid}/{f['path'][len(pref):]}", "unzip": None,
                    })
    return entries


_NCT = re.compile(r"NCT\d{8}")
