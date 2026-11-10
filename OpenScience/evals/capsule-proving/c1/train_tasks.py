"""Deterministic C1 training sample: ALFWorld `train` games and ScienceWorld train variations.

Writes the pool file the training pass and the library builds read. Never draws from the evaluation
folds: ALFWorld `train` is a different split from valid_seen/valid_unseen, ScienceWorld train variations
are disjoint from dev/test by the upstream split, and every id is checked against the evaluation pool.

    python train_tasks.py --pool ../pools/c-samples-20261110.json --out ../pools/c1-train-20261110.json
"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path

DATA = Path(os.environ.get("C1_DATA", "/srv/evimed/c1/data"))
SEED = "capsule-proving-20261110-v1:c1-train"
ALFWORLD_TYPES = ["look_at_obj_in_light", "pick_and_place_simple", "pick_clean_then_place_in_recep",
                  "pick_cool_then_place_in_recep", "pick_heat_then_place_in_recep", "pick_two_obj_and_place"]


def rank(key):
    return hashlib.sha256(f"{SEED}|{key}".encode()).hexdigest()


def alfworld_games(split):
    root = DATA / "alfworld/json_2.1.1"
    games = []
    # The same filter as run_c1.sample_tasks (upstream AlfredTWEnv.collect_game_files).
    for game in sorted((root / split).glob("*/*/game.tw-pddl")):
        if "movable" in str(game) or "Sliced" in str(game):
            continue
        if not game.with_name("traj_data.json").is_file():
            continue
        if json.loads(game.read_text()).get("solvable"):
            games.append(str(game.parent.relative_to(root)))
    return games


def alfworld_sample(per_type, evaluation):
    games = alfworld_games("train")
    by_type = collections.defaultdict(list)
    for game in games:
        by_type[game.split("/")[1].split("-")[0]].append(game)
    if sorted(by_type) != sorted(ALFWORLD_TYPES):
        raise SystemExit(f"Unexpected ALFWorld task types: {sorted(by_type)}")
    chosen = []
    for task_type in ALFWORLD_TYPES:
        chosen += sorted(by_type[task_type], key=rank)[:per_type]
    # A train game never shares its type/trial path with an evaluation game.
    tails = {"/".join(game.split("/")[1:]) for game in evaluation}
    assert not any("/".join(game.split("/")[1:]) in tails for game in chosen)
    return sorted(chosen, key=rank), {t: len(v) for t, v in sorted(by_type.items())}


def scienceworld_sample(pool_sets, per_type, extra_types):
    from scienceworld import ScienceWorldEnv
    evaluation = set(pool_sets["seen"]) | set(pool_sets["unseen"])
    index_of = {}
    for task_id in sorted(evaluation):
        index, name, _ = task_id.split(":")
        index_of[name] = index
    env = ScienceWorldEnv(serverPath=str(DATA / "scienceworld/scienceworld.jar"), envStepLimit=100)
    chosen, universe = [], {}
    try:
        for name in sorted(index_of):
            env.load(name, 0, "")
            train = env.get_variations_train()
            held = set(env.get_variations_dev()) | set(env.get_variations_test())
            assert not held & set(train), name
            universe[name] = len(train)
            ranked = sorted(train, key=lambda variation: rank(f"{name}:{variation}"))
            take = per_type + (1 if name in extra_types else 0)
            chosen += [f"{index_of[name]}:{name}:var{variation}" for variation in ranked[:take]]
    finally:
        env.close()
    assert not evaluation & set(chosen)
    return sorted(chosen, key=rank), universe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pool", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--alfworld-per-type", type=int, default=10)
    parser.add_argument("--scienceworld-per-type", type=int, default=2)
    args = parser.parse_args()
    pool = json.loads(Path(args.pool).read_text())
    evaluation = alfworld_games("valid_seen") + alfworld_games("valid_unseen")
    alfworld, alf_universe = alfworld_sample(args.alfworld_per_type, evaluation)
    # The two ScienceWorld types the evaluation pool samples three times get a third training variation (60 in all).
    sw_counts = collections.Counter(t.split(":")[1] for t in pool["sets"]["scienceworld"]["seen"])
    extra = {name for name, count in sw_counts.items() if count > 2}
    scienceworld, sw_universe = scienceworld_sample(pool["sets"]["scienceworld"], args.scienceworld_per_type, extra)
    doc = {"schema": "capsule-proving-c1-train/1", "seed": SEED,
           "note": "Training tasks only; disjoint from c-samples-20261110.json (checked when written).",
           "evaluationPoolSha256": hashlib.sha256(Path(args.pool).read_bytes()).hexdigest(),
           "sets": {"alfworld": {"train": alfworld, "universe": alf_universe, "perType": args.alfworld_per_type},
                    "scienceworld": {"train": scienceworld, "universe": sw_universe,
                                     "perType": args.scienceworld_per_type, "extraTypes": sorted(extra)}}}
    Path(args.out).write_text(json.dumps(doc, indent=2) + "\n")
    print(json.dumps({"alfworld": len(alfworld), "scienceworld": len(scienceworld)}))


if __name__ == "__main__":
    main()
