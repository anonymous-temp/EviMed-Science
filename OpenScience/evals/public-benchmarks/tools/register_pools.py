#!/usr/bin/env python3
"""Register the development / confirmation item pools of the public benchmarks (RSI phase 0.5).

  python3 -I register_pools.py [--root DIR] [--bench NAME ...] [--force]     write pools/<bench>.json
  python3 -I register_pools.py [--root DIR] [--bench NAME ...] --check        verify what is registered, exit 1 on any problem

DIR is the benchmark work directory (BENCH_ROOT, default $BENCH_ROOT or the current directory). The pools are written to
DIR/pools/<bench>.json, outside the repository, and hold ids only (no question, no gold). Benches: bixbench, drb, rcb, arb,
medbrowsecomp, medcalc.

The rule (one rule, recorded in every file)
  A pool is a set of ids. Baseline v1 and everything built from it is excluded first: every item of items/*.jsonl (the
  v1 items and the rsi-* arms alike) and items/medcalc_used_rows.json. The remaining ids are split by
      role(id) = sha256("<salt>|<id>")[0]  even -> development, odd -> confirmation
  with the salt SEED = "20261028" (the registration seed of baseline v1: python random.Random(20261028) in every builder).
  One bench keeps another salt on purpose: medcalc uses "rsi-capability-skill-2026-11", the salt of rsi/pools.json, so the
  registration the 2026-11 skill campaign drew its dev and confirmation rows from is continued, not replaced: `legacy`
  in the file compares the two (development: the rows used since leave the pool; confirmation: only rows that share a note
  with a baseline-v1 row, which rsi/pools.json did not look at, leave it).
  The role of an id depends on the id and the salt only: adding or removing other ids never moves it.

Groups that share source material (the unit of independence)
  medcalc: rows with the same `Note ID` are one note; bixbench: capsules with the same data (the file list and sizes of
  CapsuleData-*/ in zip_index.json) are one data family. A confirmation id that shares its group with a development id or
  with an excluded (used) id is not independent of what the improver reads, so it is dropped from confirmation and listed
  under `dropped` (the same rule rsi/pools.json applied to notes: 199 rows). The other benches have no group.

Pools per bench
  bixbench       one pool, by capsule (id = short_id, short_id-<uuid8> where the short_id is shared by several capsules)
  drb            one pool, task ids 1..100 (1..50 zh, 51..100 en)
  rcb            one pool, the 40 leaderboard tasks (data/rcb_leaderboard.json); `extra` lists the tasks of the dataset that
                 are not on the leaderboard (data/rcb_meta/tree.json), not split
  arb            two pools, deep and wide (id = <type>-<line index in the decoded bundle>, as the item ids are)
  medbrowsecomp  one pool, id = row index of MedBrowseComp_605.csv
  medcalc        one pool, id = `Row Number` of the original test set (1,100 rows); `verified` records the MedCalc-Bench
                 Verified test set (same ids, corrected labels) when data/medcalc_verified/test_data.csv is present, "to-do"
                 otherwise. Fetch it with
                   curl -sSL -o data/medcalc_verified/test_data.csv \\
                     https://raw.githubusercontent.com/nikhilk7153/MedCalc-Bench-Verified/HEAD/datasets/test_data.csv

The file
  {schema, tool, bench, seed, rule, sources[{path, sha256}], baseline{files{name: sha256}}, pools{<name>: {universe,
   development[], confirmation[], dropped[], excludedBaseline[], counts{}}}, ..., registeredAt, digest}
  digest = sha256 of the canonical JSON (sorted keys, compact separators, UTF-8) of the file without `digest` and
  `registeredAt`, so the same inputs always give the same digest. A registered file is never overwritten without --force;
  --force keeps the superseded file under pools/superseded/ and prints the old and the new digest.

--check, per file: the digest; no id twice or in two lists; every id's role follows from its salt; no development or
confirmation id is an excluded id; and, where the sources are present, the baseline files are unchanged and a fresh
registration from them gives the same digest. Python 3.10 compatible.
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import Counter, OrderedDict, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SEED = "20261028"
LEGACY_MEDCALC_SALT = "rsi-capability-skill-2026-11"
TOOL = "register_pools.py/1"
SCHEMA = "bench-pools/1"
BENCHES = ["bixbench", "drb", "rcb", "arb", "medbrowsecomp", "medcalc"]
DRB_TASKS = 100
# The `bench` field of the items files that belong to each registered bench.
ITEM_BENCH = {
    "bixbench": {"bixbench"},
    "drb": {"drb"},
    "rcb": {"researchclawbench", "rcb"},
    "arb": {"arb"},
    "medbrowsecomp": {"medbrowsecomp"},
    "medcalc": {"medcalc", "medcalc-rsi"},
}
RULE_TEXT = "role = sha256(salt|id)[0]: even -> development, odd -> confirmation"


class Problem(Exception):
    """A registration that cannot be made or a file that does not verify; the message says why."""


# ------------------------------------------------------------------------------------------------ small helpers

def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def content_digest(doc):
    body = {k: v for k, v in doc.items() if k not in ("digest", "registeredAt")}
    return sha256_hex(canonical(body))


def natural_key(text):
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", str(text))]


def nsorted(ids):
    return sorted(ids, key=natural_key)


def role(salt, ident):
    return "development" if hashlib.sha256(f"{salt}|{ident}".encode("utf-8")).digest()[0] % 2 == 0 else "confirmation"


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError as error:
                    raise Problem(f"{path}:{number} is not JSON ({error})")
    return rows


def need(root, relative):
    path = root / relative
    if not path.exists():
        raise Problem(f"missing source {relative} under {root}")
    return path


def source_entries(root, relatives):
    return [{"path": r, "sha256": file_sha256(root / r)} for r in relatives]


# ------------------------------------------------------------------------------------------------ baseline v1 (excluded)

def baseline_items(root, bench, only_files=None):
    """Every item of the baseline files that belongs to `bench`: [(file name, item dict)], plus medcalc's used-row list.

    only_files: the file names a registration recorded (a later items file never joins a registered baseline); None reads
    every items/*.jsonl and items/medcalc_used_rows.json now.
    """
    found = []
    folder = root / "items"
    names = sorted(p.name for p in folder.glob("*.jsonl")) if folder.is_dir() else []
    extra = ["medcalc_used_rows.json"] if (folder / "medcalc_used_rows.json").exists() else []
    if only_files is not None:
        names = [n for n in names if n in only_files]
        extra = [n for n in extra if n in only_files]
        missing = [n for n in only_files if n not in names and n not in extra]
        if missing:
            raise Problem(f"baseline file(s) no longer present: {', '.join(sorted(missing))}")
    for name in names:
        for item in read_jsonl(folder / name):
            if str(item.get("bench")) in ITEM_BENCH[bench]:
                found.append((name, item))
    if bench == "medcalc":
        for name in extra:
            data = json.loads((folder / name).read_text(encoding="utf-8"))
            for number in data.get("row_numbers", []):
                found.append((name, {"bench": "medcalc", "id": str(number)}))
    return found


# ------------------------------------------------------------------------------------------------ per-bench universes

class Universe:
    """What a bench offers: pools of ids (with optional groups) and the facts the registration records about them."""

    def __init__(self, salt=SEED):
        self.salt = salt
        self.pools = OrderedDict()   # name -> list of ids
        self.groups = {}             # pool name -> {id: group} or absent
        self.sources = []
        self.extra = {}              # extra top-level keys of the file
        self.resolve = {}            # (pool name) -> function(item) -> id or None, for the baseline items

    def used(self, items):
        """{pool name: set of ids} the baseline items occupy; ids that match no pool go to `unmatched`."""
        used = {name: set() for name in self.pools}
        unmatched = []
        for _file, item in items:
            hit = None
            for name, ids in self.pools.items():
                ident = self.resolve[name](item)
                if ident is not None and ident in self._index[name]:
                    hit = (name, ident)
                    break
            if hit:
                used[hit[0]].add(hit[1])
            else:
                unmatched.append(str(item.get("id")))
        return used, unmatched

    def finish(self):
        self._index = {name: set(ids) for name, ids in self.pools.items()}
        return self


def load_bixbench(root):
    uni = Universe()
    meta = "data/bixbench_meta/BixBench.jsonl"
    rows = read_jsonl(need(root, meta))
    capsules = OrderedDict()
    for row in rows:
        capsules.setdefault(row["capsule_uuid"], row)
    short_count = Counter(row["short_id"] for row in capsules.values())
    ids, uuid_of, folder_of = [], {}, {}
    for uuid, row in capsules.items():
        ident = row["short_id"] if short_count[row["short_id"]] == 1 else f"{row['short_id']}-{uuid[:8]}"
        ids.append(ident)
        uuid_of[ident] = uuid
        folder_of[ident] = row.get("data_folder")
    sources = [meta]
    families = {}
    index_path = root / "data/bixbench_meta/zip_index.json"
    zip_index = {}
    if index_path.exists():
        zip_index = json.loads(index_path.read_text(encoding="utf-8"))
        sources.append("data/bixbench_meta/zip_index.json")
    groups = {}
    for ident in ids:
        entry = zip_index.get(folder_of[ident])
        if entry:
            files = [e for e in entry["entries"] if e["name"].startswith("CapsuleData-") and not e["name"].endswith("/")]
            sig = hashlib.sha1("|".join(sorted(e["name"].split("/", 1)[1] + str(e["size"]) for e in files)).encode()).hexdigest()[:8]
            groups[ident] = "family-" + sig
        else:
            groups[ident] = "capsule-" + uuid_of[ident]
    members = defaultdict(list)
    for ident, group in groups.items():
        members[group].append(ident)
    families = sorted((nsorted(v) for v in members.values() if len(v) > 1), key=lambda v: natural_key(v[0]))
    uni.pools["main"] = ids
    uni.groups["main"] = groups
    by_uuid = {v: k for k, v in uuid_of.items()}

    def resolve(item):
        uuid = (item.get("meta") or {}).get("capsule_uuid")
        if uuid in by_uuid:
            return by_uuid[uuid]
        return str(item.get("id")) if str(item.get("id")) in uuid_of else None

    uni.resolve["main"] = resolve
    uni.sources = source_entries(root, sources)
    uni.extra = {"capsuleUuids": {k: uuid_of[k] for k in nsorted(uuid_of)}, "dataFamilies": families,
                 "unit": "capsule (all of its questions)"}
    return uni.finish()


def load_drb(root):
    uni = Universe()
    ids = [str(i) for i in range(1, DRB_TASKS + 1)]
    uni.pools["main"] = ids
    uni.resolve["main"] = lambda item: str(item.get("id"))
    uni.extra = {"language": "ids 1..50 are zh, 51..100 are en (query.jsonl of Ayanami0730/deep_research_bench)", "unit": "task"}
    return uni.finish()


def load_rcb(root):
    uni = Universe()
    board = need(root, "data/rcb_leaderboard.json")
    tasks = json.loads(board.read_text(encoding="utf-8"))["tasks"]
    uni.pools["main"] = [str(t) for t in tasks]
    uni.resolve["main"] = lambda item: str(item.get("id"))
    sources = ["data/rcb_leaderboard.json"]
    extra_tasks = []
    tree = root / "data/rcb_meta/tree.json"
    if tree.exists():
        extra_tasks = nsorted(t for t in json.loads(tree.read_text(encoding="utf-8")) if t not in set(uni.pools["main"]))
        sources.append("data/rcb_meta/tree.json")
    uni.sources = source_entries(root, sources)
    uni.extra = {"extraTasks": extra_tasks, "unit": "task",
                 "extraNote": "tasks of the dataset that are not among the 40 leaderboard tasks; listed, never split"}
    return uni.finish()


def load_arb(root):
    uni = Universe()
    path = need(root, "data/autoresearchbench_data/AutoResearchBench.jsonl")
    rows = read_jsonl(path)
    for index, row in enumerate(rows):
        uni.pools.setdefault(row["type"], []).append(f"{row['type']}-{index}")
    for name in list(uni.pools):
        uni.resolve[name] = (lambda n: lambda item: str(item.get("id")) if str(item.get("id")).startswith(n + "-") else None)(name)
    uni.pools = OrderedDict(sorted(uni.pools.items()))
    uni.sources = source_entries(root, ["data/autoresearchbench_data/AutoResearchBench.jsonl"])
    uni.extra = {"unit": "question (deep and wide are separate pools)"}
    return uni.finish()


def load_medbrowsecomp(root):
    uni = Universe()
    path = need(root, "data/medbrowsecomp/MedBrowseComp_605.csv")
    with open(path, newline="", encoding="utf-8") as handle:
        count = sum(1 for _ in csv.DictReader(handle))
    uni.pools["main"] = [str(i) for i in range(count)]
    uni.resolve["main"] = lambda item: str(item.get("id"))
    uni.sources = source_entries(root, ["data/medbrowsecomp/MedBrowseComp_605.csv"])
    uni.extra = {"unit": "question (id = row index of the csv)"}
    return uni.finish()


def load_medcalc(root):
    uni = Universe(salt=LEGACY_MEDCALC_SALT)
    path = need(root, "data/medcalc/test_data.csv")
    with open(path, newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    ids = [r["Row Number"] for r in rows]
    uni.pools["main"] = ids
    uni.groups["main"] = {r["Row Number"]: "note-" + r["Note ID"] for r in rows}
    uni.resolve["main"] = lambda item: str((item.get("meta") or {}).get("row_number", item.get("id")))
    sources = ["data/medcalc/test_data.csv"]
    verified = "to-do"
    vpath = root / "data/medcalc_verified/test_data.csv"
    if vpath.exists():
        with open(vpath, newline="", encoding="utf-8") as handle:
            vrows = {r["Row Number"]: r for r in csv.DictReader(handle)}
        sources.append("data/medcalc_verified/test_data.csv")
        original = {r["Row Number"]: r for r in rows}
        columns = ["Calculator ID", "Note ID", "Output Type", "Patient Note", "Question", "Ground Truth Answer", "Lower Limit", "Upper Limit"]
        same_ids = set(vrows) == set(original)
        changed = nsorted(k for k in original if k in vrows and any(original[k][c] != vrows[k][c] for c in columns)) if same_ids else []
        note = root / "data/medcalc_verified/SOURCE.txt"
        verified = {"sameIdsAsOriginal": same_ids, "rows": len(vrows), "changedRowIds": changed,
                    "changedColumns": columns, "pools": "the same ids and the same split as pools.main"
                    if same_ids else "ids differ from the original: register separately",
                    "source": note.read_text(encoding="utf-8").strip() if note.exists() else None}
    uni.sources = source_entries(root, sources)
    uni.extra = {"verified": verified, "unit": "row (Note ID is the group)"}
    return uni.finish()


LOADERS = {"bixbench": load_bixbench, "drb": load_drb, "rcb": load_rcb, "arb": load_arb,
           "medbrowsecomp": load_medbrowsecomp, "medcalc": load_medcalc}


# ------------------------------------------------------------------------------------------------ the split

def split_pool(ids, groups, used, salt):
    used = set(used) & set(ids)
    candidates = [i for i in ids if i not in used]
    development = [i for i in candidates if role(salt, i) == "development"]
    pending = [i for i in candidates if role(salt, i) == "confirmation"]
    dropped = []
    confirmation = pending
    if groups:
        exposed = {groups[i] for i in used} | {groups[i] for i in development}
        confirmation = [i for i in pending if groups[i] not in exposed]
        dropped = [i for i in pending if groups[i] in exposed]
    return {
        "universe": len(ids),
        "development": nsorted(development),
        "confirmation": nsorted(confirmation),
        "dropped": nsorted(dropped),
        "excludedBaseline": nsorted(used),
        "counts": {"universe": len(ids), "excludedBaseline": len(used), "development": len(development),
                   "confirmation": len(confirmation), "dropped": len(dropped)},
    }


def build(root, bench, only_files=None):
    """The registration of `bench` as a dict (no digest, no time)."""
    uni = LOADERS[bench](root)
    items = baseline_items(root, bench, only_files)
    used, unmatched = uni.used(items)
    if bench == "rcb":
        # Tasks outside the 40 (the dataset's extra ones) are listed under extraTasks, they are not unmatched.
        unmatched = [u for u in unmatched if u not in set(uni.extra.get("extraTasks", []))]
    pools = OrderedDict()
    for name, ids in uni.pools.items():
        pools[name] = split_pool(ids, uni.groups.get(name), used[name], uni.salt)
    contributing = sorted({file for file, _ in items})
    doc = OrderedDict()
    doc["schema"] = SCHEMA
    doc["tool"] = TOOL
    doc["bench"] = bench
    doc["seed"] = SEED
    doc["salt"] = uni.salt
    doc["rule"] = RULE_TEXT
    doc["sources"] = uni.sources
    doc["baseline"] = {"files": OrderedDict((n, file_sha256(root / "items" / n)) for n in contributing),
                       "unmatched": nsorted(unmatched)}
    doc["pools"] = pools
    for key, value in uni.extra.items():
        doc[key] = value
    if bench == "rcb":
        extra_tasks = doc.get("extraTasks", [])
        doc["extraUsedInBaseline"] = nsorted(set(extra_tasks) & {str(i.get("id")) for _f, i in items})
    if bench == "drb":
        for name, pool in pools.items():
            pool["byLanguage"] = {split: {"zh": sum(1 for i in pool[split] if int(i) <= 50),
                                          "en": sum(1 for i in pool[split] if int(i) > 50)}
                                  for split in ("development", "confirmation")}
    if bench == "medcalc":
        doc["legacy"] = legacy_medcalc(root, pools["main"])
    return doc


def legacy_medcalc(root, pool):
    """Does the registration agree with rsi/pools.json, the pools the 2026-11 skill campaign drew from?"""
    path = root / "rsi/pools.json"
    if not path.exists():
        return {"file": "rsi/pools.json", "present": False}
    old = json.loads(path.read_text(encoding="utf-8"))
    old_dev, old_conf = set(map(str, old.get("development", []))), set(map(str, old.get("confirmation", [])))
    dev, conf = set(pool["development"]), set(pool["confirmation"])
    return {"file": "rsi/pools.json", "present": True, "rule": old.get("rule"),
            "confirmationIsSubset": conf <= old_conf, "developmentIsSubset": dev <= old_dev,
            "removedFromConfirmation": len(old_conf - conf), "removedFromDevelopment": len(old_dev - dev),
            "newInConfirmation": len(conf - old_conf), "newInDevelopment": len(dev - old_dev)}


def stamp(doc):
    doc = OrderedDict(doc)
    doc["registeredAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc["digest"] = content_digest(doc)
    return doc


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as out:
        out.write(text)
    mask = os.umask(0)
    os.umask(mask)
    os.chmod(temp, 0o666 & ~mask)
    os.replace(temp, path)


def render(doc):
    return json.dumps(doc, ensure_ascii=False, indent=1) + "\n"


# ------------------------------------------------------------------------------------------------ register

def summary_rows(doc):
    for name, pool in doc["pools"].items():
        c = pool["counts"]
        yield (doc["bench"] if len(doc["pools"]) == 1 else f"{doc['bench']}/{name}", c["universe"], c["excludedBaseline"],
               c["development"], c["confirmation"], c["dropped"])


def register(root, bench, force):
    target = root / "pools" / f"{bench}.json"
    note = ""
    if target.exists():
        try:
            old = json.loads(target.read_text(encoding="utf-8"))
        except ValueError:
            raise Problem(f"{target} exists and is not JSON; not overwritten")
        if content_digest(old) != old.get("digest"):
            raise Problem(f"{target} exists and its digest does not verify; not overwritten")
        if not force:
            return old, f"kept (registered {old.get('registeredAt')}, digest {old['digest'][:16]})"
    doc = stamp(build(root, bench))
    if target.exists():
        keep = root / "pools" / "superseded" / f"{bench}-{old['digest'][:12]}.json"
        write_atomic(keep, render(old))
        same = "same digest" if doc["digest"] == old["digest"] else "DIFFERENT digest"
        note = f"re-registered (--force): old {old['digest'][:16]}, new {doc['digest'][:16]} ({same}); old copy {keep.relative_to(root)}"
    else:
        note = f"registered (digest {doc['digest'][:16]})"
    write_atomic(target, render(doc))
    return doc, note


# ------------------------------------------------------------------------------------------------ check

def check_file(root, bench):
    """(problems, notes) of pools/<bench>.json: no problem means it verifies; notes say which checks could not run."""
    target = root / "pools" / f"{bench}.json"
    if not target.exists():
        return ["not registered (pools/%s.json is missing)" % bench], []
    try:
        doc = json.loads(target.read_text(encoding="utf-8"))
    except ValueError as error:
        return [f"not JSON ({error})"], []
    problems, notes = [], []
    if content_digest(doc) != doc.get("digest"):
        problems.append("digest does not match the content")
    if doc.get("bench") != bench:
        problems.append(f"file says bench {doc.get('bench')!r}")
    salt = doc.get("salt")
    for name, pool in (doc.get("pools") or {}).items():
        lists = {k: pool.get(k, []) for k in ("development", "confirmation", "dropped", "excludedBaseline")}
        seen = {}
        for key, ids in lists.items():
            for ident in ids:
                if ident in seen:
                    problems.append(f"{name}: id {ident} is in {seen[ident]} and {key}")
                seen[ident] = key
        for ident in lists["development"]:
            if role(salt, ident) != "development":
                problems.append(f"{name}: development id {ident} has the confirmation role")
        for ident in lists["confirmation"] + lists["dropped"]:
            if role(salt, ident) != "confirmation":
                problems.append(f"{name}: confirmation id {ident} has the development role")
        counts = pool.get("counts", {})
        for key in ("development", "confirmation", "dropped"):
            if counts.get(key) != len(lists[key]):
                problems.append(f"{name}: counts.{key} says {counts.get(key)}, the list has {len(lists[key])}")
        accounted = len(lists["development"]) + len(lists["confirmation"]) + len(lists["dropped"]) + len(lists["excludedBaseline"])
        if accounted != pool.get("universe"):
            problems.append(f"{name}: lists hold {accounted} ids, the universe is {pool.get('universe')}")
    files = (doc.get("baseline") or {}).get("files", {})
    for fname, digest in files.items():
        path = root / "items" / fname
        if path.exists() and file_sha256(path) != digest:
            problems.append(f"baseline file items/{fname} changed since registration")
    if (doc.get("baseline") or {}).get("unmatched"):
        problems.append(f"baseline items that match no id: {', '.join(doc['baseline']['unmatched'][:5])}")
    sources_present = all((root / s["path"]).exists() for s in doc.get("sources", [])) and all(
        (root / "items" / f).exists() for f in files)
    if not sources_present:
        notes.append("sources or baseline files are not present: structural checks only, no fresh registration compared")
    elif not problems:
        try:
            fresh = stamp(build(root, bench, only_files=set(files)))
        except Problem as error:
            problems.append(f"cannot re-derive: {error}")
        else:
            if fresh["digest"] != doc["digest"]:
                problems.append("a fresh registration from the recorded baseline gives digest %s, not %s (sources or tool changed)"
                                % (fresh["digest"][:16], doc["digest"][:16]))
                for name, pool in (doc.get("pools") or {}).items():
                    now = set(fresh["pools"].get(name, {}).get("excludedBaseline", []))
                    inside = sorted(now & (set(pool.get("development", [])) | set(pool.get("confirmation", []))), key=natural_key)
                    if inside:
                        problems.append(f"{name}: baseline v1 item(s) inside a pool: {', '.join(inside[:8])}")
            else:
                notes.append("a fresh registration from the recorded baseline gives the same digest")
    return problems, notes


# ------------------------------------------------------------------------------------------------ cli

def table(rows):
    header = ("bench", "universe", "baseline", "development", "confirmation", "dropped")
    widths = [max(len(str(r[i])) for r in [header] + rows) for i in range(6)]
    lines = ["  ".join(str(v).ljust(widths[i]) if i == 0 else str(v).rjust(widths[i]) for i, v in enumerate(r)) for r in [header] + rows]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Register the development / confirmation pools of the public benchmarks.")
    parser.add_argument("--root", default=os.environ.get("BENCH_ROOT", "."), help="benchmark work directory (BENCH_ROOT)")
    parser.add_argument("--bench", action="append", choices=BENCHES, help="bench to register or check (default: all)")
    parser.add_argument("--check", action="store_true", help="verify the registered files; exit 1 on any problem")
    parser.add_argument("--force", action="store_true", help="re-register a bench that already has a pools file")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    benches = args.bench or BENCHES
    if args.check:
        failed = 0
        for bench in benches:
            problems, notes = check_file(root, bench)
            print(f"{bench}: {'ok' if not problems else 'FAILED'}")
            for problem in problems:
                print(f"  - {problem}")
            for note in notes:
                print(f"  ({note})")
            failed += bool(problems)
        return 1 if failed else 0
    rows = []
    for bench in benches:
        try:
            doc, note = register(root, bench, args.force)
        except Problem as error:
            print(f"{bench}: {error}", file=sys.stderr)
            return 2
        print(f"{bench}: {note}")
        unmatched = doc["baseline"]["unmatched"]
        if unmatched:
            print(f"  WARNING: baseline items that match no pool id: {', '.join(unmatched)}")
        if bench == "medcalc":
            legacy = doc.get("legacy", {})
            if legacy.get("present"):
                print(f"  rsi/pools.json: confirmation subset={legacy['confirmationIsSubset']} (-{legacy['removedFromConfirmation']}), "
                      f"development subset={legacy['developmentIsSubset']} (-{legacy['removedFromDevelopment']}: rows used since)")
        rows += list(summary_rows(doc))
    print()
    print(table(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
