"""The improver channels: upstream's `claude_cli` Proposer, run on this box's own Claude login and, for one stage, on DeepSeek through
the same CLI.

What this module changes about upstream's Proposer, all by subclassing (see PATCHES.md, "overrides"):

  * env()          no Vertex, no inherited ANTHROPIC_* / CLAUDE_CODE_* variables from whatever shell started the round; a provider row adds its
                   endpoint and key (read from the key file at spawn, never stored, never logged).
  * _claude_cli()  the session runs `--safe-mode --restricted` with five file tools and `acceptEdits`: no shell, no web, no settings or
                   CLAUDE.md of this box, file access confined to the scratch directory upstream gives each session; one JSON result is
                   parsed for usage; failures are classified (quota / transport / timeout are infrastructure, a spent budget is the stage's own).
  * call()         every paid attempt lands in the ledger; an infrastructure failure is raised as InfrastructureFailure, which `_run_stage`
                   does not catch, so it can never become an inherited-harness candidate.

The per-stage model is chosen by `StageRouter` from the label upstream gives each call (inv1, dom1, agg1, select.agg1, experience.agg1).
Cache identity: upstream keys a cached reply on label, mission and evidence; the router gives each (stage, provider, model, effort) its own
audit directory, so a reply produced by one model is never served as another's.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import config, upstream
from .errors import InfrastructureFailure, QuotaExhausted
from .ledger import Ledger, deepseek_cny

up = upstream.load()
Proposer = up.proposer.Proposer
ProposerError = up.proposer.ProposerError

STAGES = ("inv", "dom", "agg", "select", "experience")
INFRA_KINDS = {"quota", "auth", "transport", "timeout", "spawn"}
CLI_TOOLS = "Read,Write,Edit,Glob,Grep"

# Variables a parent shell may carry that would change which account, endpoint or session the CLI uses.
_SCRUB_PREFIXES = ("ANTHROPIC_", "CLAUDE_CODE_", "CLAUDE_AGENT_", "CLAUDE_CONFIG", "CLAUDE_EFFORT", "CLAUDE_PID", "AWS_BEARER", "GOOGLE_CLOUD_", "VERTEX")
_SCRUB_EXACT = {"CLAUDECODE", "AI_AGENT", "CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION"}
_QUOTA_TEXT = re.compile(r"usage limit|rate limit|limit reached|quota|credit balance|too many requests|overloaded|resets? at", re.I)


def stage_of(label: str) -> str:
    head = re.split(r"[.\d]", label, maxsplit=1)[0]
    if head not in STAGES:
        raise KeyError(f"no improver stage for call label {label!r}; this round runs parallel mode only (labels inv/dom/agg/select/experience)")
    return head


def load_channels(path: Path | None = None) -> dict:
    document = json.loads(Path(path or config.CHANNELS_FILE).read_text(encoding="utf-8"))
    missing = [s for s in STAGES if s not in document.get("stages", {})]
    if missing:
        raise ValueError(f"channels file has no row for {missing}")
    for stage, row in document["stages"].items():
        up.spec.ChannelSpec(row["kind"], row["model"], effort=row.get("effort", "high"), timeout=int(row.get("timeout", 2400)))
        if row.get("provider") and row["provider"] not in document.get("providers", {}):
            raise ValueError(f"stage {stage} names provider {row['provider']!r} that the file does not define")
    return document


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip("-")


class H2Proposer(Proposer):
    """One stage's session runner. Built by `build_router`; carries its stage row, the ledger and the balance guard."""

    def __init__(self, stage: str, row: dict, provider: dict | None, *, cli: str = "claude", audit_dir: Path, ledger: Ledger | None = None,
                 balance=None, domain: str = "", attempts: int = 2):
        spec = up.spec.ChannelSpec(row["kind"], row["model"], effort=row.get("effort", "high"), timeout=int(row.get("timeout", 2400)))
        super().__init__(spec=spec, audit_dir=Path(audit_dir), attempts=attempts, project="", region="")
        self.stage, self.row, self.provider, self.cli = stage, row, provider, cli
        self.ledger, self.balance, self.domain = ledger, balance, domain
        self._tls = threading.local()

    # -- environment -------------------------------------------------------------------------------------------------------
    def env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not (k in _SCRUB_EXACT or k.startswith(_SCRUB_PREFIXES))}
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        env["DISABLE_TELEMETRY"] = "1"
        env["ANTHROPIC_MODEL"] = self.spec.model
        if self.provider:
            key = Path(self.provider["key_file"]).read_text(encoding="utf-8").strip()
            env["ANTHROPIC_BASE_URL"] = self.provider["base_url"]
            env["ANTHROPIC_AUTH_TOKEN"] = key
            small = self.provider.get("small_model") or self.spec.model
            env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = self.spec.model
            env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = self.spec.model
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = small
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = small
        return env

    def argv(self, system: str, stdin_has_system: bool) -> list[str]:
        cmd = [
            self.cli, "-p", "--output-format", "json", "--model", self.spec.model, "--effort", self.spec.effort,
            "--safe-mode", "--restricted", "--tools", CLI_TOOLS, "--permission-mode", "acceptEdits",
            "--permission-prompts", "none", "--no-session-persistence",
        ]
        if self.row.get("max_budget_usd"):
            cmd += ["--max-budget-usd", str(self.row["max_budget_usd"])]
        if system:
            if stdin_has_system:
                cmd += ["--append-system-prompt", "Follow the SYSTEM INSTRUCTIONS block at the top of the message."]
            else:
                cmd += ["--append-system-prompt", system]
        return cmd

    # -- one session -------------------------------------------------------------------------------------------------------
    def _claude_cli(self, cwd: Path, mission: str, system: str, wall: int):
        stdin = mission
        stdin_has_system = bool(system) and len(system) > up.proposer.SYSTEM_ARG_MAX
        if stdin_has_system:
            stdin = f"# SYSTEM INSTRUCTIONS\n\n{system}\n\n# END\n\n{mission}"
        record = {"stage": self.stage, "model": self.spec.model, "provider": (self.row.get("provider") or "claude-login")}
        started = time.time()
        try:
            done = subprocess.run(self.argv(system, stdin_has_system), input=stdin, cwd=cwd, env=self.env(), text=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=wall)
        except subprocess.TimeoutExpired:
            self._note({**record, "kind": "timeout", "wall_s": round(time.time() - started, 1)})
            raise
        except OSError as exc:
            self._note({**record, "kind": "spawn", "error": type(exc).__name__})
            raise
        payload = up.proposer._parse_json(done.stdout)
        text = str(payload.get("result") or payload.get("text") or "")
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        record.update({
            "wall_s": round(time.time() - started, 1), "usage": {k: usage.get(k) for k in (
                "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")},
            "usd_reported": float(payload.get("total_cost_usd") or 0.0), "turns": payload.get("num_turns"), "subtype": payload.get("subtype"),
            "denials": len(payload.get("permission_denials") or []),
        })
        err = ""
        if payload.get("is_error") or payload.get("subtype") not in (None, "success"):
            record["kind"], retry = classify(payload, text, done.returncode)
            record["retry_after_s"] = retry
            err = f"CLI error: {payload.get('subtype')} {text[:200]}"
            text = ""
        elif done.returncode != 0 and not text.strip():
            record["kind"] = "transport"
            err = f"rc={done.returncode}: {(done.stderr or '')[-300:]}"
        elif not text.strip():
            record["kind"] = "empty"
            err = "empty reply"
        else:
            record["kind"] = "ok"
        self._note(record)
        return text, record["usd_reported"], err

    # -- bookkeeping -------------------------------------------------------------------------------------------------------
    def _note(self, record: dict) -> None:
        if not hasattr(self._tls, "attempts"):
            self._tls.attempts = []
        self._tls.attempts.append(record)

    def call(self, mission, context_dir, label, *, system="", timeout=None, max_attempts=None, harvest=None):
        key = up.proposer._call_fingerprint(label, mission, system, context_dir)
        cached = self._cached(label, key, require_workspace=bool(harvest))
        if cached is None and self.provider and self.balance is not None:
            self.balance.ensure(f"the {self.stage} session {label}")
        self._tls.attempts = []
        self._tls.task = task_of(context_dir)
        base = f"improver:{self.domain}:{self.stage}:{label}:{key}"
        try:
            reply = super().call(mission, context_dir, label, system=system, timeout=timeout, max_attempts=max_attempts, harvest=harvest)
        except ProposerError as exc:
            self._log_attempts(base, "failed")
            last = self._tls.attempts[-1] if self._tls.attempts else None
            infra = last if last is not None and last.get("kind") in INFRA_KINDS else None  # the last word decides, not an earlier hiccup
            if infra is not None:
                if infra["kind"] == "quota":
                    raise QuotaExhausted(f"{self.stage} ({self.spec.model}): {str(exc)[:200]}", retry_after_s=infra.get("retry_after_s")) from exc
                raise InfrastructureFailure(infra["kind"], f"{self.stage} ({self.spec.model}) {label}: {str(exc)[:240]}", cost_usd=exc.cost_usd) from exc
            raise
        if reply.cached:
            if self.ledger:
                self.ledger.append(f"{base}:cached", kind="improver", cached=True, stage=self.stage, label=label, domain=self.domain,
                                   task=self._tls.task, model=self.spec.model, cny=0.0)
        else:
            self._log_attempts(base, "ok")
        return reply

    def _log_attempts(self, base: str, outcome: str) -> None:
        if not self.ledger:
            return
        for index, attempt in enumerate(self._tls.attempts, 1):
            usage = attempt.get("usage") or {}
            cny = deepseek_cny(self.spec.model, usage) if self.row.get("provider") == "deepseek" else None
            self.ledger.append(
                f"{base}:a{index}", kind="improver", cached=False, stage=self.stage, domain=self.domain, task=self._tls.task, model=self.spec.model,
                provider=attempt.get("provider"), outcome=attempt.get("kind"), call_outcome=outcome, attempt=index, usage=usage,
                usd_reported=attempt.get("usd_reported"), cny=cny, cny_basis=("estimate at the platform reference rate, peak" if cny is not None else None),
                wall_s=attempt.get("wall_s"), turns=attempt.get("turns"), denials=attempt.get("denials"),
            )


def task_of(context_dir) -> str | None:
    """The task a session works on, read from the evidence path (`.../tasks/<domain>/<task>/...`), for the ledger."""
    if not context_dir:
        return None
    parts = Path(context_dir).parts
    return parts[parts.index("tasks") + 2] if "tasks" in parts and len(parts) > parts.index("tasks") + 2 else None


def classify(payload: dict, text: str, returncode: int) -> tuple[str, int | None]:
    """(kind, retry_after_s) of a failed CLI result: status first, then the few phrases a quota message carries."""
    status = payload.get("api_error_status")
    subtype = str(payload.get("subtype") or "")
    retry = None
    found = re.search(r"(\d+)\s*(?:seconds|s)\b", text)
    if found:
        retry = int(found.group(1))
    if status == 429 or _QUOTA_TEXT.search(text or ""):
        return "quota", retry
    if status in (401, 403):
        return "auth", None
    if isinstance(status, int) and (status >= 500):
        return "transport", retry
    if subtype in ("error_max_budget_usd", "error_max_turns"):
        return "budget", None
    return "error", None


class StageRouter:
    """The object handed to upstream as `prop`: it only needs `.call(...)`, `.spec` and `.audit_dir`."""

    def __init__(self, stages: dict[str, H2Proposer], audit_dir: Path):
        self.stages = stages
        self.audit_dir = Path(audit_dir)
        self.spec = stages["inv"].spec
        self.attempts = stages["inv"].attempts

    @property
    def _calls(self):
        return [c for p in self.stages.values() for c in p._calls]

    def call(self, mission, context_dir, label, **kwargs):
        return self.stages[stage_of(label)].call(mission, context_dir, label, **kwargs)

    def identity(self) -> dict:
        return {s: {"kind": p.spec.kind, "provider": p.row.get("provider"), "model": p.spec.model, "effort": p.spec.effort,
                    "timeout": p.spec.timeout, "max_budget_usd": p.row.get("max_budget_usd")} for s, p in self.stages.items()}


def build_router(audit_root: Path, *, domain: str = "", ledger: Ledger | None = None, balance=None, channels: dict | None = None,
                 cli: str | None = None) -> StageRouter:
    document = channels or load_channels()
    cli = cli or os.environ.get("RSI1_CLAUDE_BIN") or document.get("cli", "claude")
    if os.sep not in cli:
        cli = shutil.which(cli) or cli
    stages: dict[str, H2Proposer] = {}
    for stage in STAGES:
        row = document["stages"][stage]
        provider = document["providers"][row["provider"]] if row.get("provider") else None
        identity = slug(f"{stage}-{row.get('provider') or 'claude'}-{row['model']}-{row.get('effort', 'high')}")
        stages[stage] = H2Proposer(stage, row, provider, cli=cli, audit_dir=Path(audit_root) / identity, ledger=ledger, balance=balance, domain=domain)
    return StageRouter(stages, Path(audit_root))
