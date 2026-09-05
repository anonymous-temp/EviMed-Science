"""A bounded MemTensor composition: embed/index exact facts, never evolve them autonomously."""
from __future__ import annotations
import json
import os
from pathlib import Path
import stat

# Exact upstream task_schemas labels. Query/answer/status machinery is preserved;
# there is no blanket queue discard and no patch to the upstream storage/search code.
MUTATING_HANDLERS = ("add", "mem_read", "mem_organize", "mem_dream", "mem_update", "mem_archive", "pref_add", "mem_feedback", "api_mix_search")
PROVIDER_FIELDS = frozenset({
    "OPENAI_API_KEY", "OPENAI_API_BASE", "MOS_CHAT_MODEL", "MEMRADER_API_KEY", "MEMRADER_API_BASE", "MEMRADER_MODEL",
    "MEMREADER_GENERAL_MODEL", "MOS_EMBEDDER_BACKEND", "MOS_EMBEDDER_PROVIDER", "MOS_EMBEDDER_API_KEY",
    "MOS_EMBEDDER_API_BASE", "MOS_EMBEDDER_MODEL", "EMBEDDING_DIMENSION", "NEO4J_PASSWORD",
})


def load_provider_config(file: Path) -> None:
    """Read only the engine's private provider file; never print its values."""
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 16384:
            raise ValueError("Protected MemOS provider configuration is invalid")
        with os.fdopen(descriptor, "r", closefd=False) as stream:
            values = json.load(stream)
        if not isinstance(values, dict) or set(values) - PROVIDER_FIELDS or any(not isinstance(value, str) for value in values.values()):
            raise ValueError("MemOS provider configuration contains unsupported fields")
        os.environ.update(values)
    finally:
        os.close(descriptor)


def configure_scheduler(api_config) -> None:
    original = api_config.get_scheduler_config
    def configured():
        result = original()
        config = {**result["config"], "thread_pool_max_workers": 2, "enable_activation_memory": False}
        config["disabled_handlers"] = sorted(set(config.get("disabled_handlers") or ()) | set(MUTATING_HANDLERS))
        return {**result, "config": config}
    api_config.get_scheduler_config = staticmethod(configured)


def prepare_environment() -> None:
    load_provider_config(Path(os.environ["EVIMED_MEMOS_PROVIDER_CONFIG"]))
    os.environ.update({"ENABLE_CHAT_API": "false", "ENABLE_INTERNET": "false", "MOS_ENABLE_REORGANIZE": "false"})
    root = Path(os.environ.get("MEMOS_BASE_PATH", "/var/lib/memos"))
    (root / "files").mkdir(parents=True, exist_ok=True)
    os.environ["FILE_LOCAL_PATH"] = str(root / "files")
