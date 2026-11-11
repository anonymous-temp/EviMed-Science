"""Skill cards chosen by the product's own selection code, not by Python.

Each worker process keeps one long-lived bridge, `node learn/offlineLoop.mjs serve --library FILE`, which answers one JSON line per
episode with `selectMethodsForTask` (learnedMethodMount.mjs): "flat" = every switch off, "pyramid" = the pyramid switch on. The bridge
reloads the library when the file changes (the evolving arm). The query is the episode's opening request in the same form the library
was learnt from (learn/gameTranscript.mjs `requestText`): the opening observation, with the task stated first when it does not carry it.
A selection is cached per task in the arm's output directory, so a rerun of an episode is shown the same cards.
"""
import hashlib
import json
from pathlib import Path
import subprocess

LOOP = Path(__file__).resolve().parent.parent / "learn" / "offlineLoop.mjs"
ROLES = ("atomic", "functional", "abstract")


def request_text(task, observation):
    observation = (observation or "").strip()
    task = (task or "").strip()
    return f"Your task is to: {task}\n\n{observation}" if task and task not in observation else observation


def render(skill):
    parts = [skill.get("description", "").strip()]
    if skill.get("when"):
        parts.append(f"When to use: {skill['when'].strip()}")
    return "\n".join(p for p in parts if p) + "\n\n" + skill.get("body", "").strip()


class ProductSkillProvider:
    def __init__(self, library, mode, remove_roles=(), embed_key_file=None, cache_dir=None, node="node"):
        if mode not in ("flat", "pyramid"):
            raise ValueError("Unknown skill selection mode")
        if any(role not in ROLES for role in remove_roles):
            raise ValueError("Unknown method role")
        self.library = str(library)
        self.mode = mode
        self.remove_roles = list(remove_roles)
        self.embed_key_file = embed_key_file
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.node = node
        self.proc = None
        self.last = None

    def _bridge(self):
        if self.proc is None or self.proc.poll() is not None:
            command = [self.node, str(LOOP), "serve", "--library", self.library]
            if self.embed_key_file:
                command += ["--embed-key-file", str(self.embed_key_file)]
            # stderr is inherited: the similarity module's fallback warnings land in the run log.
            self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        return self.proc

    def _select(self, text):
        proc = self._bridge()
        proc.stdin.write(json.dumps({"taskText": text, "mode": self.mode, "removeRoles": self.remove_roles}) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("Selection bridge closed")
        answer = json.loads(line)
        if not answer.get("ok"):
            raise RuntimeError("Selection failed: " + str(answer.get("error", ""))[:200])
        return answer

    def cards_for_episode(self, task, observation, env_name, phase):
        text = request_text(task, observation)
        key = hashlib.sha256(json.dumps([self.mode, self.remove_roles, text]).encode()).hexdigest()[:32]
        cached = self.cache_dir / f"{key}.json" if self.cache_dir else None
        if cached and cached.exists():
            answer = json.loads(cached.read_text())
        else:
            answer = self._select(text)
            if cached:
                cached.parent.mkdir(parents=True, exist_ok=True)
                temp = cached.with_suffix(".tmp")
                temp.write_text(json.dumps(answer))
                temp.replace(cached)
        self.last = {"mode": self.mode, "removeRoles": self.remove_roles, "ranking": answer.get("mode"),
                     "topScore": answer.get("topScore"), "libraryMethods": answer.get("libraryMethods"),
                     "embedModel": answer.get("embedModel"), "cacheKey": key, "budget": answer.get("budget"),
                     "selected": [{k: s.get(k) for k in ("name", "role", "levelNumber", "reason", "digest")}
                                  for s in answer.get("skills", [])]}
        return [{"name": s["name"], "level": s.get("role", s.get("level")), "text": render(s), "reason": s.get("reason")}
                for s in answer.get("skills", [])]

    def cards_for(self, task_description, env_name, phase):
        return self.cards_for_episode(task_description, "", env_name, phase)

    def close(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.proc is not None and self.proc.stdout and not self.proc.stdout.closed:
            self.proc.stdout.close()
