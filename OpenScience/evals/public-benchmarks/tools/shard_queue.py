#!/usr/bin/env python3
"""Split one benchmark queue into per-lane shards, check the split, and merge the shards' answers back.

  shard_queue.py split --queue queue/NAME.jsonl -k K [--out-dir DIR] [--split-groups] [--replace-pending lane/pending.txt]
  shard_queue.py check --queue queue/NAME.jsonl (--manifest DIR/NAME.shards.json | --shards S1.jsonl S2.jsonl ...) [--split-groups]
  shard_queue.py merge-answers --manifest DIR/NAME.shards.json --answers-dir answers --out answers/NAME.jsonl [--require-all]

`split` writes DIR/NAME.s1.jsonl .. NAME.sM.jsonl (M <= K: a shard that would be empty is not written), each a queue of its
own (queue name NAME.sN, so `lane.sh` runs it as results/NAME.sN) made of the original lines byte for byte and in their
original relative order, plus DIR/NAME.shards.json (counts, weights, groups, the rule). DIR defaults to the queue's folder.
With --replace-pending the queue's line in pending.txt is replaced by the shard names, in place and under pending.lock.

What stays together (the unit of a shard)
  Each lane is one driver process with ONE throwaway account, and the driver keeps one project, one personal skill and one
  runtime per `group` inside that account. Two things are therefore kept in one shard:
    1. items of one `group`;
    2. the paired arms of one row: items of different groups with the same bench and the same id once a trailing `#r<n>`
       (the repeat) is taken off, which is how tools/build_rsi_items.py names a row in every arm
       (key medcalc-rsi/<arm>/<row>[#r<n>], id <row>[#r<n>]). A paired design only controls drift when both arms of a row run
       in the same lane, at the same time and load.
  Units are the connected pieces of "same group" and "same pair"; they are balanced over K shards by estimated work (the sum of
  timeoutMin, 15 where absent) with a deterministic greedy rule: heaviest unit first (ties: earlier in the queue), onto the
  lightest shard (ties: lower number).

  WHEN THE TWO CANNOT BE KEPT TOGETHER: queues built as one group per arm over the same rows (the rsi-* arm queues:
  group rsi-base, rsi-cand-xxx, ...) and v1-style queues with one group for the whole benchmark (medcalc-main, drb-main,
  arb-main, medbrowsecomp-main) are ONE unit under this rule, so the default split gives a single shard and says so in the
  manifest and on stderr. That is not a failure of the tool but of the rule: a group is only a project inside one account,
  and its items are independent runs, so a group may be spread over lanes at the price of one more project, one more copy of
  the group's personal skill and one more runtime start per lane. `--split-groups` accepts that price: the unit is then the
  row (the paired arms of a row stay together, the group is split across shards), and the manifest lists every group that
  spans several shards. Queues with one item per group (bixbench, researchclawbench) split either way.

`check` verifies that the shards are a partition of the queue: the same keys, each once, every line byte-identical to the
original, original order inside each shard, and (unless --split-groups) no group and no pair in two shards; with --manifest also
that the queue and the shard files are the ones the split wrote. Exit 1 on any problem.

`merge-answers` joins answers/<shard>.jsonl (the output of collect.sh for each shard) into one answers file in the queue's
original order, refusing a key twice or a key the queue does not have; shards not collected yet are listed (an error with
--require-all). Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

DEFAULT_TIMEOUT_MIN = 15
SCHEMA = "bench-queue-shards/1"


class Refused(Exception):
    """Input the tool will not guess about."""


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def folder_of(key):
    """The driver's result folder of a key: `/` becomes `__`, anything outside [A-Za-z0-9_.-] becomes `_`."""
    return re.sub(r"[^\w.\-]", "_", key.replace("/", "__"))


def read_queue(path):
    """[(line text, item)] of a queue file, blank lines skipped. Duplicate keys and colliding result folders are refused."""
    entries, keys, folders = [], {}, {}
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").split("\n"), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except ValueError:
            raise Refused(f"{path}: line {number} is not JSON")
        key = item.get("key") if isinstance(item, dict) else None
        if not isinstance(key, str) or not key:
            raise Refused(f"{path}: line {number} has no key")
        if key in keys:
            raise Refused(f"{path}: key {key} is on line {keys[key]} and on line {number}")
        folder = folder_of(key)
        if folder in folders:
            raise Refused(f"{path}: keys {folders[folder]} and {key} are the same result folder {folder}")
        keys[key], folders[folder] = number, key
        entries.append((line, item))
    return entries


def group_of(item):
    return item.get("group") if isinstance(item.get("group"), str) and item.get("group") else "bench"


def pair_of(item):
    ident = item.get("id")
    if not isinstance(ident, str) or not ident:
        ident = str(item["key"]).rsplit("/", 1)[-1]
    return f"{item.get('bench') or ''}\0{re.sub(r'#r[0-9]+$', '', ident)}"


def weight_of(item):
    value = item.get("timeoutMin")
    return float(value) if isinstance(value, (int, float)) and value > 0 else float(DEFAULT_TIMEOUT_MIN)


class Union:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def join(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def units_of(items, split_groups):
    """[(first index, weight, [item indexes])] - the pieces that go to one shard whole."""
    union = Union()
    if not split_groups:
        for item in items:
            union.join(("g", group_of(item)), ("p", pair_of(item)))
    cells = {}
    for index, item in enumerate(items):
        root = union.find(("p", pair_of(item)) if split_groups else ("g", group_of(item)))
        cells.setdefault(root, []).append(index)
    return [(members[0], sum(weight_of(items[i]) for i in members), members) for members in cells.values()]


def assign(units, k):
    """Deterministic greedy: heaviest unit first (ties: the earlier one), onto the lightest shard (ties: the lower number)."""
    loads = [0.0] * k
    owner = {}
    for first, weight, members in sorted(units, key=lambda u: (-u[1], u[0])):
        target = min(range(k), key=lambda s: (loads[s], s))
        loads[target] += weight
        for index in members:
            owner[index] = target
    return owner, loads


def write_atomic(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as out:
        out.write(text)
    mask = os.umask(0)
    os.umask(mask)
    os.chmod(temp, 0o666 & ~mask)
    os.replace(temp, path)


def num(value):
    return int(value) if float(value).is_integer() else round(float(value), 3)


def split(queue_path, k, out_dir, split_groups, force=False):
    queue_path = Path(queue_path)
    name = queue_path.name[:-len(".jsonl")] if queue_path.name.endswith(".jsonl") else queue_path.stem
    entries = read_queue(queue_path)
    if not entries:
        raise Refused(f"{queue_path} has no items")
    if k < 1:
        raise Refused("-k must be at least 1")
    items = [item for _line, item in entries]
    units = units_of(items, split_groups)
    owner, loads = assign(units, k)
    used = sorted(set(owner.values()))
    number = {shard: n for n, shard in enumerate(used, 1)}  # empty shards are not written; the rest are s1..sM
    out_dir = Path(out_dir)
    old = sorted(out_dir.glob(f"{name}.s[0-9]*.jsonl")) + ([out_dir / f"{name}.shards.json"] if (out_dir / f"{name}.shards.json").exists() else [])
    if old and not force:
        raise Refused(f"{', '.join(p.name for p in old)} already exist: a split is not redone once lanes may have run it (--force replaces it)")
    for path in old:
        path.unlink()
    shards = []
    for shard in used:
        indexes = [i for i in range(len(entries)) if owner[i] == shard]
        shard_name = f"{name}.s{number[shard]}"
        text = "".join(entries[i][0] + "\n" for i in indexes)
        write_atomic(out_dir / f"{shard_name}.jsonl", text)
        shards.append({"name": shard_name, "file": f"{shard_name}.jsonl", "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                       "items": len(indexes), "weight": num(sum(weight_of(items[i]) for i in indexes)),
                       "units": sum(1 for u in units if owner[u[2][0]] == shard), "groups": sorted({group_of(items[i]) for i in indexes})})
    where = {}
    for shard_index, shard in zip(used, shards):
        for i in range(len(entries)):
            if owner[i] == shard_index:
                where.setdefault(group_of(items[i]), set()).add(shard["name"])
    spanning = {g: sorted(s) for g, s in where.items() if len(s) > 1}
    arms = {}
    for item in items:
        arms.setdefault(pair_of(item), set()).add(group_of(item))
    paired = [p for p, groups in arms.items() if len(groups) > 1]  # rows that more than one group holds: the arms of a row
    weights = [s["weight"] for s in shards]
    notes = []
    if len(shards) < k:
        notes.append(f"requested {k} shards, wrote {len(shards)}: the queue has {len(units)} unit(s) that cannot be split under the "
                     f"{'row' if split_groups else 'group and pair'} rule")
        if not split_groups and len(shards) == 1:
            notes.append("one group, or arms of the same rows in separate groups, make one unit: use --split-groups to spread the group "
                         "over lanes (each lane then opens its own project, skill copy and runtime for it)")
    manifest = {
        "schema": SCHEMA, "queue": name, "file": queue_path.name, "sha256": sha256_file(queue_path), "items": len(entries),
        "weight": num(sum(weight_of(i) for i in items)), "requested": k, "written": len(shards),
        "mode": "split-groups" if split_groups else "keep-groups",
        "rule": ("unit = row (bench + id without #r<n>); a group may span shards" if split_groups
                 else "unit = group, joined with every group that holds the same row (bench + id without #r<n>)"),
        "weightIs": f"sum of timeoutMin ({DEFAULT_TIMEOUT_MIN} where absent)",
        "shards": shards, "groupsSpanning": spanning, "pairedRows": len(paired),
        "imbalance": {"maxWeight": max(weights), "minWeight": min(weights), "ratio": round(max(weights) / min(weights), 3) if min(weights) else None},
        "notes": notes,
    }
    write_atomic(out_dir / f"{name}.shards.json", json.dumps(manifest, ensure_ascii=False, indent=1) + "\n")
    return manifest, [s["name"] for s in shards]


def replace_pending(pending_path, queue_name, shard_names):
    """Replace the queue's line in pending.txt with the shard names, in place, under the lanes' own lock (lane/pending.lock).
    A queue a lane has claimed is refused: its claim and its results are the queue's, not the shards'."""
    import fcntl
    pending_path = Path(pending_path)
    if (pending_path.parent / "claims" / queue_name).exists():
        raise Refused(f"queue {queue_name} is claimed by a lane; shard a queue that is not running")
    with open(pending_path.with_name("pending.lock"), "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        lines = [line for line in (pending_path.read_text(encoding="utf-8").split("\n") if pending_path.exists() else []) if line != ""]
        found = queue_name in lines
        if found:
            at = lines.index(queue_name)
            lines[at:at + 1] = shard_names
        else:
            lines += shard_names
        write_atomic(pending_path, "\n".join(lines) + "\n")
    return found


def check(queue_path, shard_paths, split_groups, manifest=None):
    problems = []
    original = read_queue(queue_path)
    order = {item["key"]: n for n, (_line, item) in enumerate(original)}
    text = {item["key"]: line for line, item in original}
    seen, group_in, pair_in = {}, {}, {}
    for shard_path in shard_paths:
        shard = Path(shard_path).name
        if not Path(shard_path).exists():
            problems.append(f"{shard} is missing")
            continue
        try:
            entries = read_queue(shard_path)
        except Refused as error:
            problems.append(str(error))
            continue
        last = -1
        for line, item in entries:
            key = item["key"]
            if key not in order:
                problems.append(f"{shard}: key {key} is not in the queue")
                continue
            if key in seen:
                problems.append(f"key {key} is in {seen[key]} and {shard}")
            seen[key] = shard
            if line != text[key]:
                problems.append(f"{shard}: line of {key} differs from the queue's")
            if order[key] < last:
                problems.append(f"{shard}: {key} is out of the queue's order")
            last = max(last, order[key])
            group_in.setdefault(group_of(item), set()).add(shard)
            pair_in.setdefault(pair_of(item), set()).add(shard)
    for key in order:
        if key not in seen:
            problems.append(f"key {key} is in no shard")
    if not split_groups:
        for group, where in sorted(group_in.items()):
            if len(where) > 1:
                problems.append(f"group {group} is in {len(where)} shards ({', '.join(sorted(where))})")
    for pair, where in sorted(pair_in.items()):
        if len(where) > 1:
            bench, ident = pair.split("\0")
            problems.append(f"row {ident} ({bench}) has its arms in {len(where)} shards")
    if manifest:
        if sha256_file(queue_path) != manifest["sha256"]:
            problems.append("the queue changed since the split")
        for shard in manifest["shards"]:
            path = Path(queue_path).with_name(shard["file"])
            if path.exists() and sha256_file(path) != shard["sha256"]:
                problems.append(f"{shard['file']} changed since the split")
    return problems


def merge_answers(manifest_path, answers_dir, out_path, require_all):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    queue = Path(manifest_path).with_name(manifest["file"])
    order = {item["key"]: n for n, (_l, item) in enumerate(read_queue(queue))}
    rows, missing, problems = {}, [], []
    for shard in manifest["shards"]:
        path = Path(answers_dir) / f"{shard['name']}.jsonl"
        if not path.exists():
            missing.append(shard["name"])
            continue
        for line in path.read_text(encoding="utf-8").split("\n"):
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("key") not in order:
                problems.append(f"{path.name}: key {row.get('key')} is not in the queue")
            elif row["key"] in rows:
                problems.append(f"key {row['key']} is in more than one answers file")
            else:
                rows[row["key"]] = line
    if problems or (require_all and missing):
        raise Refused("; ".join(problems + ([f"answers not collected for {', '.join(missing)}"] if require_all and missing else [])))
    write_atomic(out_path, "".join(rows[k] + "\n" for k in sorted(rows, key=order.get)))
    return len(rows), len(order), missing


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("split")
    s.add_argument("--queue", required=True)
    s.add_argument("-k", type=int, required=True)
    s.add_argument("--out-dir")
    s.add_argument("--split-groups", action="store_true")
    s.add_argument("--replace-pending")
    s.add_argument("--force", action="store_true", help="replace the shards of an earlier split of this queue")
    c = sub.add_parser("check")
    c.add_argument("--queue", required=True)
    c.add_argument("--manifest")
    c.add_argument("--shards", nargs="+")
    c.add_argument("--split-groups", action="store_true")
    m = sub.add_parser("merge-answers")
    m.add_argument("--manifest", required=True)
    m.add_argument("--answers-dir", required=True)
    m.add_argument("--out", required=True)
    m.add_argument("--require-all", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "split":
            manifest, names = split(args.queue, args.k, args.out_dir or Path(args.queue).parent, args.split_groups, args.force)
            for shard in manifest["shards"]:
                print(f"{shard['name']}: {shard['items']} items, weight {shard['weight']}, groups {len(shard['groups'])}")
            print(f"{manifest['written']} of {manifest['requested']} shards, imbalance max/min = {manifest['imbalance']['ratio']}, "
                  f"{len(manifest['groupsSpanning'])} group(s) span several shards, {manifest['pairedRows']} paired row(s) kept together")
            for note in manifest["notes"]:
                print(f"NOTE: {note}", file=sys.stderr)
            if args.replace_pending:
                found = replace_pending(args.replace_pending, manifest["queue"], names)
                print(f"{args.replace_pending}: {manifest['queue']} {'replaced by' if found else 'was not pending, appended:'} {', '.join(names)}")
            return 0
        if args.command == "check":
            manifest = None
            if args.manifest:
                manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
                folder = Path(args.manifest).parent
                shard_paths = [str(folder / s["file"]) for s in manifest["shards"]]
                split_groups = manifest["mode"] == "split-groups"
            elif args.shards:
                shard_paths, split_groups = args.shards, args.split_groups
            else:
                raise Refused("check needs --manifest or --shards")
            problems = check(args.queue, shard_paths, split_groups, manifest)
            for problem in problems:
                print(f"- {problem}")
            print("ok: the shards are a partition of the queue" if not problems else f"{len(problems)} problem(s)")
            return 1 if problems else 0
        kept, total, missing = merge_answers(args.manifest, args.answers_dir, args.out, args.require_all)
        print(f"{args.out}: {kept} of {total} answers" + (f"; not collected yet: {', '.join(missing)}" if missing else ""))
        return 0
    except Refused as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
