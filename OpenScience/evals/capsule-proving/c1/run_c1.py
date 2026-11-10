"""Resumable C1 runner; each worker owns one game and direct model client."""
import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import time

from loop import (DeepSeekModel, JsonSkillProvider, NoSkillProvider, STEP_CAPS,
                  file_digest, first_line, run_episode)

DATA = Path(os.environ.get("C1_DATA", "/srv/evimed/c1/data"))


class AlfWorld:
    instructions = ("Commands include look, inventory, go to <receptacle>, open <receptacle>, "
                    "take <object> from <receptacle>, put <object> in/on <receptacle>, "
                    "clean <object> with <sinkbasin>, heat <object> with <microwave>, "
                    "cool <object> with <fridge>, use <lamp>. Use the numbered names observed.")

    def __init__(self, task_id, fold):
        import textworld
        from alfworld.agents.environment.alfred_tw_env import AlfredDemangler
        self.game = str(DATA / "alfworld/json_2.1.1" / task_id / "game.tw-pddl")
        self.env = textworld.start(self.game, textworld.EnvInfos(won=True),
                                   wrappers=[AlfredDemangler()])

    def reset(self):
        state = self.env.reset()
        observation = state.feedback
        # ALFWorld puts the task in the rendered initial observation.
        task = observation.split("Your task is to:")[-1].strip()
        return observation, task

    def step(self, action):
        state, score, done = self.env.step(action)
        won = bool(state.won)
        return state.feedback, float(score), bool(done or won), won

    def close(self):
        self.env.close()


class ScienceWorld:
    instructions = ("Commands include look around, inventory, task, open <door>, go to <room>, "
                    "look at <object>, examine <object>, pick up <object>, move <object> to <container>, "
                    "activate <object>, deactivate <object>, use <object> on <object>, "
                    "focus on <object>, wait, wait1. Use observed names. Focus as the task requests.")

    def __init__(self, task_id, fold):
        from scienceworld import ScienceWorldEnv
        self.env = ScienceWorldEnv(serverPath=str(DATA / "scienceworld/scienceworld.jar"),
                                   envStepLimit=STEP_CAPS["scienceworld"])
        try:
            index, name, variation = task_id.split(":")
            # Use the frozen name through upstream legacy-name normalization.
            # Never substitute a task merely because its list index is nearby.
            self.env.load(name, int(variation.removeprefix("var")), "")
            variations = (self.env.get_variations_dev() if fold == "seen"
                          else self.env.get_variations_test())
            if int(variation.removeprefix("var")) not in variations:
                raise ValueError("Variation is outside the requested ScienceWorld fold")
        except Exception:
            self.close()
            raise

    def reset(self):
        observation, _ = self.env.reset()
        return observation, self.env.get_task_description()

    def step(self, action):
        observation, _, done, info = self.env.step(action)
        score = float(info["score"])
        return observation, score, bool(done), score >= 100

    def close(self):
        self.env.close()


def sample_tasks(pool, env_name, fold):
    pool_doc = json.loads(Path(pool).read_text())
    spec = pool_doc["sets"][env_name]
    if env_name == "scienceworld":
        return spec[fold]
    if spec["run"] != "whole":
        raise ValueError("Expected ALFWorld whole-split sample specification")
    root = DATA / "alfworld/json_2.1.1"
    split = "valid_seen" if fold == "seen" else "valid_unseen"
    tasks = []
    # Match upstream AlfredTWEnv.collect_game_files: six task types, no movable
    # or sliced variants, preserved trajectory metadata, and solvable game flag.
    for game in sorted((root / split).glob("*/*/game.tw-pddl")):
        if "movable" in str(game) or "Sliced" in str(game):
            continue
        if not game.with_name("traj_data.json").is_file():
            continue
        if json.loads(game.read_text()).get("solvable"):
            tasks.append(str(game.parent.relative_to(root)))
    expected = 140 if fold == "seen" else 134
    if len(tasks) != expected:
        raise ValueError(f"ALFWorld {split}: expected {expected}, found {len(tasks)}")
    # Whole split membership is fixed; hash ordering makes limited smokes diverse.
    seed = pool_doc.get("seed", "c1")
    return sorted(tasks, key=lambda task: hashlib.sha256(f"{seed}|{task}".encode()).hexdigest())


def write_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def episode_key(env_name, fold, arm, task_id):
    digest = hashlib.sha256(task_id.encode()).hexdigest()[:20]
    return f"{env_name}-{fold}-{arm}-{digest}"


def execute(job):
    env_name, fold, arm, task_id, library, mode, key_file, out = job
    key = episode_key(env_name, fold, arm, task_id)
    path = Path(out) / "trajectories" / f"{key}.json"
    start = time.monotonic()
    env = None
    try:
        provider = JsonSkillProvider(library, mode) if library else NoSkillProvider()
        env = (AlfWorld if env_name == "alfworld" else ScienceWorld)(task_id, fold)
        record = run_episode(env, DeepSeekModel(key_file), env_name, fold, provider,
                             checkpoint=lambda row: write_json(path, row))
    except Exception as error:
        record = {"steps": [], "success": False, "score": 0, "promptTokens": 0,
                  "completionTokens": 0, "error": first_line(error)}
    finally:
        if env is not None:
            try:
                env.close()
            except Exception as error:
                record["closeError"] = first_line(error)
    record.update(taskId=task_id, arm=arm, fold=fold, env=env_name,
                  seconds=time.monotonic() - start)
    write_json(path, record)
    return {"env": env_name, "fold": fold, "taskId": task_id, "arm": arm,
            "success": record["success"], "score": record["score"], "steps": len(record["steps"]),
            "promptTokens": record["promptTokens"], "completionTokens": record["completionTokens"],
            "seconds": record["seconds"], "error": record["error"]}


def append_sync(path, text):
    with Path(path).open("a") as stream:
        stream.write(text + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=STEP_CAPS, required=True)
    parser.add_argument("--fold", choices=["seen", "unseen"], required=True)
    parser.add_argument("--samples", required=True)
    parser.add_argument("--arm", required=True)
    parser.add_argument("--library")
    parser.add_argument("--mode", choices=["flat", "pyramid"], default="flat")
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--key-file", default="/srv/evimed/secrets/deepseek.api-key")
    args = parser.parse_args()
    if args.workers < 1 or (args.limit is not None and args.limit < 0):
        parser.error("workers must be positive and limit nonnegative")
    if (args.arm == "no-skill" and args.library) or (args.arm != "no-skill" and not args.library):
        parser.error("no-skill forbids a library; other arm labels require --library")
    if args.library:
        JsonSkillProvider(args.library, args.mode)
    out = Path(args.out)
    (out / "trajectories").mkdir(parents=True, exist_ok=True)
    # One writer per output directory. Different envs/folds may share it sequentially.
    with (out / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        start = time.monotonic()
        identity = {"env": args.env, "fold": args.fold, "arm": args.arm, "mode": args.mode,
                    "poolSha256": file_digest(args.samples),
                    "librarySha256": file_digest(args.library) if args.library else None,
                    "runnerSha256": file_digest(__file__),
                    "loopSha256": file_digest(Path(__file__).with_name("loop.py")),
                    "setupManifestSha256": file_digest(DATA.parent / "setup-manifest.json")
                    if (DATA.parent / "setup-manifest.json").exists() else None,
                    "stepCap": STEP_CAPS[args.env], "model": "deepseek-flash", "temperature": 0,
                    "thinking": "disabled", "scienceworldSimplifications": ""}
        manifest = out / f"config-{args.env}-{args.fold}-{args.arm}.json"
        if manifest.exists() and json.loads(manifest.read_text()) != identity:
            raise ValueError("Resume configuration changed; use a new output directory")
        write_json(manifest, identity)
        tasks = sample_tasks(args.samples, args.env, args.fold)
        if args.limit is not None:
            tasks = tasks[:args.limit]
        status_path = out / "STATUS"
        done = {line[5:] for line in status_path.read_text().splitlines() if line.startswith("DONE ")} if status_path.exists() else set()
        rows_path = out / "episodes.jsonl"
        rows = [json.loads(line) for line in rows_path.read_text().splitlines() if line.strip()] if rows_path.exists() else []
        # Recover a crash between the durable row append and STATUS append.
        for row in rows:
            key = episode_key(row["env"], row["fold"], row["arm"], row["taskId"])
            if key not in done:
                append_sync(status_path, "DONE " + key)
                done.add(key)
        jobs = [(args.env, args.fold, args.arm, task, args.library, args.mode, args.key_file, str(out))
                for task in tasks if episode_key(args.env, args.fold, args.arm, task) not in done]
        print(json.dumps({"selected": len(tasks), "skipped": len(tasks) - len(jobs), "pending": len(jobs)}), flush=True)
        if jobs:
            with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers,
                    mp_context=multiprocessing.get_context("spawn")) as executor:
                futures = {executor.submit(execute, job): job for job in jobs}
                for future in concurrent.futures.as_completed(futures):
                    row = future.result()
                    append_sync(rows_path, json.dumps(row))
                    append_sync(status_path, "DONE " + episode_key(row["env"], row["fold"], row["arm"], row["taskId"]))
                    rows.append(row)
                    print(json.dumps(row), flush=True)
        selected = [r for r in rows if r["env"] == args.env and r["fold"] == args.fold
                    and r["arm"] == args.arm and r["taskId"] in set(tasks)]
        n = len(selected)
        metric = "successRate" if args.env == "alfworld" else "meanScore"
        summary = {"env": args.env, "fold": args.fold, "arm": args.arm, "n": n,
                   metric: sum(r["success"] if args.env == "alfworld" else r["score"] for r in selected) / n if n else None,
                   "errors": sum(r["error"] is not None for r in selected),
                   "promptTokens": sum(r["promptTokens"] for r in selected),
                   "completionTokens": sum(r["completionTokens"] for r in selected),
                   "episodeSeconds": sum(r["seconds"] for r in selected),
                   "invocationWallSeconds": time.monotonic() - start, "workers": args.workers,
                   "skipped": len(tasks) - len(jobs)}
        append_sync(out / "summaries.jsonl", json.dumps(summary))
        print(json.dumps({"summary": summary}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(first_line(error)) from None
