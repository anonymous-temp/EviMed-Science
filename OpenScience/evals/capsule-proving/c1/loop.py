"""C1's direct ReAct loop. No product runtime, learning, or gold trajectories."""
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Protocol

import requests

STEP_CAPS = {"alfworld": 50, "scienceworld": 100}


class SkillProvider(Protocol):
    def cards_for(self, task_description, env_name, phase):
        """Return [{name, level, text}] for this episode."""
        ...


class NoSkillProvider:
    def cards_for(self, task_description, env_name, phase):
        return []


class JsonSkillProvider:
    """Flat mounts all cards; pyramid picks matching abstracts and their dependencies.

    Matching is deterministic word overlap with `when`, not a learned selector.
    The product selector can replace this provider through the same interface.
    Libraries without abstract cards select matching atomic cards in pyramid mode.
    """
    def __init__(self, path, mode="flat"):
        if mode not in ("flat", "pyramid"):
            raise ValueError("Unknown skill selection mode")
        self.skills = json.loads(Path(path).read_text())["skills"]
        self.mode = mode
        self.by_name = {}
        for card in self.skills:
            if card["name"] in self.by_name or card["level"] not in ("atomic", "abstract"):
                raise ValueError("Duplicate name or invalid skill level")
            if not isinstance(card["body"], str) or not isinstance(card.get("when", ""), str):
                raise ValueError("Skill body and when must be strings")
            self.by_name[card["name"]] = card
        for card in self.skills:
            if any(name not in self.by_name for name in card.get("depends_on", [])):
                raise ValueError("Missing skill dependency")

    def cards_for(self, task_description, env_name, phase):
        selected = set(self.by_name) if self.mode == "flat" else set()
        if self.mode == "pyramid":
            words = set(re.findall(r"[a-z0-9]+", f"{task_description} {env_name} {phase}".lower()))
            roots = [c for c in self.skills if c["level"] == "abstract"] or self.skills

            def add(name):
                if name in selected:
                    return
                selected.add(name)
                for dep in self.by_name[name].get("depends_on", []):
                    add(dep)

            for card in roots:
                trigger = set(re.findall(r"[a-z0-9]+", card.get("when", "").lower()))
                if not trigger or words & trigger:
                    add(card["name"])
        return [{"name": c["name"], "level": c["level"], "text": c["body"]}
                for c in self.skills if c["name"] in selected]


def first_line(error):
    return (str(error).splitlines() or [type(error).__name__])[0][:500]


class DeepSeekModel:
    def __init__(self, key_file, attempts=6, sleep=time.sleep):
        # The key is used only in the Authorization header, never in saved metadata.
        self._key = Path(key_file).read_text().strip()
        self.attempts = attempts
        self.sleep = sleep
        self.session = requests.Session()

    def complete(self, messages):
        for attempt in range(self.attempts):
            try:
                response = self.session.post(
                    "https://api.deepseek.com/chat/completions",
                    headers={"Authorization": f"Bearer {self._key}"},
                    json={"model": "deepseek-flash", "messages": messages,
                          "temperature": 0, "thinking": {"type": "disabled"},
                          "max_tokens": 512, "stream": False}, timeout=(15, 180))
            except requests.RequestException:
                if attempt + 1 == self.attempts:
                    raise RuntimeError("DeepSeek transport error") from None
                self.sleep(min(60, 2 ** attempt))
                continue
            if response.status_code == 429 or 500 <= response.status_code < 600:
                if attempt + 1 < self.attempts:
                    try:
                        delay = float(response.headers.get("Retry-After", 2 ** attempt))
                    except ValueError:
                        delay = 2 ** attempt
                    self.sleep(max(0, min(60, delay)))
                    continue
            if not response.ok:
                # Do not print response bodies or request headers, even on error.
                raise RuntimeError(f"DeepSeek HTTP {response.status_code}")
            data = response.json()
            return {"text": data["choices"][0]["message"]["content"],
                    "usage": data.get("usage", {}), "id": data.get("id"),
                    "model": data.get("model"), "attempts": attempt + 1}
        raise RuntimeError("DeepSeek retries exhausted")


def parse_action(text):
    matches = re.findall(r"^\s*(?:Action|Act)\s*:\s*(.+)$", text, re.I | re.M)
    action = matches[-1] if matches else text.strip().splitlines()[-1] if text.strip() else ""
    action = action.strip().strip('`').removeprefix('> ').strip()
    if not action:
        raise ValueError("Model returned no action")
    return action


def run_episode(env, model, env_name, phase, provider=None, checkpoint=None):
    """Adapters expose reset -> (observation, task), step -> (obs, score, done, won).

    One model call and one environment action per step; full untruncated history.
    Thought text never consumes a separate environment step. ScienceWorld uses
    the upstream default 100, with an explicit 100-call bound even for invalid moves.
    """
    start = time.monotonic()
    record = {"env": env_name, "phase": phase, "stepCap": STEP_CAPS[env_name],
              "steps": [], "messages": [], "cards": [], "promptTokens": 0,
              "completionTokens": 0, "score": 0, "success": False, "error": None,
              "terminationReason": None, "cardExposure": []}
    try:
        obs, task = env.reset()
        record["task"] = task
        record["initialObservation"] = obs
        provider = provider or NoSkillProvider()
        # A provider that reads the opening observation (the product's selection queries the first message) is given it.
        select = getattr(provider, "cards_for_episode", None)
        cards = select(task, obs, env_name, phase) if select else provider.cards_for(task, env_name, phase)
        record["cards"] = cards
        record["cardExposure"] = [{"name": card["name"], "shown": True, "textIncluded": bool(card.get("text")),
                                   "textSha256": hashlib.sha256(card.get("text", "").encode()).hexdigest(),
                                   "textRead": None, "detailRead": False} for card in cards]
        # Prompt inclusion is observable; the model's internal attention is not.

        if getattr(provider, "last", None) is not None:
            record["selection"] = provider.last
        system = ("You are solving a text game. Complete the task using observations and actions.\n"
                  "At each turn write a brief Thought: then exactly one Action: <game command>.\n"
                  "Use only game commands; do not invent observations. Do not restart the game.\n"
                  f"Environment: {env_name}. Task: {task}\n" + env.instructions)
        if cards:
            system += "\nSkill cards:\n" + "\n\n".join(
                f"[{c['level']}] {c['name']}\n{c['text']}" for c in cards)
        if any(card.get("detailAvailable") for card in cards):
            system += ("\nFor a mounted card with attached scripts/detail.md, Action: read_skill <card name> "
                       "reads that file only when needed. It uses one of the same bounded calls; other actions are game commands.")
        messages = record["messages"]
        messages.extend([{"role": "system", "content": system}, {"role": "user", "content": obs}])
        invalid_streak = 0
        for step in range(STEP_CAPS[env_name]):
            admissible_read = getattr(env, "admissible_commands", None)
            admissible = admissible_read() if admissible_read else None
            step_start = time.monotonic()
            reply = model.complete(messages)
            usage = reply.get("usage", {})
            record["promptTokens"] += usage.get("prompt_tokens", 0)
            record["completionTokens"] += usage.get("completion_tokens", 0)
            messages.append({"role": "assistant", "content": reply["text"]})
            # Preserve billed replies even when parsing or stepping fails.
            entry = {"step": step + 1, "reply": reply, "action": None}
            record["steps"].append(entry)
            action = parse_action(reply["text"])
            entry["action"] = action
            entry["admissibleCommands"] = admissible
            entry["admissible"] = action in admissible if admissible is not None else None
            entry["admissibilityMissing"] = None if admissible is not None else "environment-admissible-commands"

            if action.startswith("read_skill ") and any(card.get("detailAvailable") for card in cards):
                obs = provider.read_detail(action.removeprefix("read_skill ").strip())
                score, done, won = record["score"], False, record["success"]
                entry["detailRead"] = True
                name = action.removeprefix("read_skill ").strip()
                entry["admissible"] = any(c["name"] == name and c.get("detailAvailable") for c in cards)
                for exposure in record["cardExposure"]:
                    if exposure["name"] == name and entry["admissible"]:
                        exposure["detailRead"] = True
                        exposure["detailReadStep"] = step + 1
            else:
                obs, score, done, won = env.step(action)
            entry.update(observation=obs, score=score, done=done, success=won,
                         seconds=time.monotonic() - step_start)
            record.update(score=score, success=won)
            next_read = getattr(env, "admissible_commands", None)
            next_commands = next_read() if next_read else None
            vocabulary = "\nAdmissible commands: " + "; ".join(next_commands) if next_commands is not None else ""
            messages.append({"role": "user", "content": obs + vocabulary})
            invalid_streak = invalid_streak + 1 if entry["admissible"] is False else 0
            if checkpoint:
                checkpoint(record)
            if done:
                record["terminationReason"] = "success" if won else "early-terminal-state"
                break
        if record["terminationReason"] is None:
            record["terminationReason"] = "invalid-action-loop" if invalid_streak >= 3 else "step-limit"
    except Exception as error:
        record["error"] = first_line(error)
        record["terminationReason"] = "unobserved"
        record["missingRecords"] = ["completed-episode"]
    record["terminationScore"] = record["score"]
    record["outcome"] = "unobserved" if record["error"] else "success" if record["success"] else "task-failed"
    record["seconds"] = time.monotonic() - start
    if checkpoint:
        checkpoint(record)
    return record


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
