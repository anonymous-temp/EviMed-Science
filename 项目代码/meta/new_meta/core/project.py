"""Project management: directory structure, persistence, PRISMA flow tracking, checkpointing."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path

from new_meta.config import OUTPUT_DIR

logger = logging.getLogger("metaagent.project")
STEP_MANIFEST_FILE = "step_manifest.json"

# Step IDs for checkpoint tracking
PIPELINE_STEPS = [
    "protocol", "search_query", "search", "ta_screening", "pdf_download",
    "pdf_parsing", "ft_screening", "extraction", "rob", "evidence_understanding",
    "effect_sizes", "meta_analysis", "grade", "figures", "manuscript",
]

DOWNSTREAM_STEPS = {
    "protocol": [
        "search_query", "search", "ta_screening", "pdf_download", "pdf_parsing",
        "ft_screening", "extraction", "rob", "evidence_understanding",
        "effect_sizes", "meta_analysis", "grade", "figures", "manuscript",
    ],
    "search_query": [
        "search", "ta_screening", "pdf_download", "pdf_parsing", "ft_screening",
        "extraction", "rob", "evidence_understanding", "effect_sizes",
        "meta_analysis", "grade", "figures", "manuscript",
    ],
    "search": [
        "ta_screening", "pdf_download", "pdf_parsing", "ft_screening",
        "extraction", "rob", "evidence_understanding", "effect_sizes",
        "meta_analysis", "grade", "figures", "manuscript",
    ],
    "ta_screening": [
        "pdf_download", "pdf_parsing", "ft_screening", "extraction", "rob",
        "evidence_understanding", "effect_sizes", "meta_analysis", "grade",
        "figures", "manuscript",
    ],
    "pdf_download": [
        "pdf_parsing", "ft_screening", "extraction", "rob",
        "evidence_understanding", "effect_sizes", "meta_analysis", "grade",
        "figures", "manuscript",
    ],
    "pdf_parsing": [
        "ft_screening", "extraction", "rob", "evidence_understanding",
        "effect_sizes", "meta_analysis", "grade", "figures", "manuscript",
    ],
    "ft_screening": [
        "extraction", "rob", "evidence_understanding", "effect_sizes",
        "meta_analysis", "grade", "figures", "manuscript",
    ],
    "extraction": [
        "rob", "evidence_understanding", "effect_sizes", "meta_analysis",
        "grade", "figures", "manuscript",
    ],
    "rob": ["evidence_understanding", "grade", "manuscript"],
    "evidence_understanding": ["manuscript"],
    "effect_sizes": ["meta_analysis", "grade", "figures", "manuscript"],
    "meta_analysis": ["grade", "figures", "manuscript"],
    "grade": ["manuscript"],
    "figures": ["manuscript"],
    "manuscript": [],
}


class Project:
    """Manages the output directory and persistence for a meta-analysis project."""

    def __init__(self, topic: str, output_dir: Path = None, resume_dir: Path = None,
                 skip_disk: bool = False):
        self.topic = topic
        self.skip_disk = skip_disk
        is_resume = bool(resume_dir and resume_dir.exists())
        if resume_dir and resume_dir.exists():
            self.base_dir = resume_dir
        else:
            if output_dir and not skip_disk and self._looks_like_project_root(Path(output_dir)):
                raise ValueError(
                    f"{output_dir} looks like an existing MetaAgent project directory; "
                    "pass it as resume_dir instead of output_dir to avoid nesting a new project."
                )
            ts = time.strftime("%Y%m%d_%H%M%S")
            safe_topic = "".join(c if c.isalnum() or c in "-_ " else "" for c in topic)[:50].strip().replace(" ", "_")
            self.base_dir = (output_dir or OUTPUT_DIR) / f"{ts}_{safe_topic}"
        if not skip_disk:
            self._init_dirs()
            if not is_resume:
                self._record_topic()
        self.prisma = PRISMAFlow()
        if not skip_disk:
            prisma_data = self.load_json("prisma_flow.json")
            if prisma_data:
                self.prisma = PRISMAFlow.from_dict(prisma_data)
        try:
            from new_meta.core.llm import set_llm_usage_scope
            set_llm_usage_scope(self)
        except Exception:
            logger.debug("Could not set LLM usage scope for project.", exc_info=True)

    @staticmethod
    def _looks_like_project_root(path: Path) -> bool:
        """Detect accidental use of an existing project directory as output parent."""
        if not path.exists() or not path.is_dir():
            return False
        marker_files = [
            "protocol.json",
            "search_query.txt",
            "references.bib",
            "prisma_flow.json",
            ".checkpoint",
        ]
        if any((path / marker).exists() for marker in marker_files):
            return True
        project_subdirs = {"papers", "screening", "extraction", "risk_of_bias", "analysis", "manuscript"}
        existing_subdirs = {child.name for child in path.iterdir() if child.is_dir()}
        return len(project_subdirs & existing_subdirs) >= 4

    def _init_dirs(self):
        """Create the full project directory tree."""
        subdirs = [
            "papers", "screening", "extraction", "risk_of_bias",
            "analysis", "manuscript", "evidence", "package",
        ]
        for d in subdirs:
            (self.base_dir / d).mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Checkpoint management
    # ------------------------------------------------------------------

    TOPIC_FILE = "project_topic.json"

    @staticmethod
    def _fingerprint(topic: str) -> str:
        return hashlib.sha256(str(topic).strip().casefold().encode("utf-8")).hexdigest()[:16]

    def _record_topic(self) -> None:
        """Write the project's own topic once, when its directory is created.

        Resume entry points construct Project with a placeholder label
        ("resume project", "override", ...) because the real topic lives on
        disk, so the constructor argument cannot be the authority for what this
        directory is about.
        """
        if self.skip_disk:
            return
        path = self.base_dir / self.TOPIC_FILE
        if path.exists():
            return
        payload = {"topic": self.topic, "fingerprint": self._fingerprint(self.topic)}
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def topic_fingerprint(self) -> str:
        """Stable id of the topic this project directory belongs to."""
        if not self.skip_disk:
            path = self.base_dir / self.TOPIC_FILE
            if path.exists():
                try:
                    recorded = json.loads(path.read_text(encoding="utf-8"))
                    if isinstance(recorded, dict) and recorded.get("fingerprint"):
                        return str(recorded["fingerprint"])
                except (json.JSONDecodeError, OSError):
                    logger.warning("Ignoring unreadable topic record at %s", path)
        return self._fingerprint(self.topic)

    def _write_checkpoint(self, completed: list[str]) -> None:
        """Atomically replace .checkpoint, recording the topic it belongs to.

        The file used to be a bare list written in place: a kill during the
        write left a truncated list, and resuming with a different topic reused
        another run's completed steps without noticing.
        """
        cp_path = self.base_dir / ".checkpoint"
        payload = {
            "schema_version": 2,
            "topic_fingerprint": self.topic_fingerprint(),
            "completed": list(completed),
        }
        temporary = cp_path.with_suffix(".checkpoint.tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(temporary, cp_path)

    def save_checkpoint(self, step: str):
        """Mark a pipeline step as completed."""
        if self.skip_disk:
            return
        completed = self._load_completed_steps()
        if step not in completed:
            completed.append(step)
        self._write_checkpoint(completed)
        self.save_step_manifest(step, status="complete")

    def save_step_manifest(
        self,
        step: str,
        *,
        status: str,
        artifacts: list[str] | None = None,
        warnings: list[str] | None = None,
        metadata: dict | None = None,
    ) -> None:
        """Persist structured step state alongside the legacy checkpoint list."""
        if self.skip_disk:
            return
        path = self.base_dir / STEP_MANIFEST_FILE
        manifest: dict = {}
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    manifest = loaded
            except (json.JSONDecodeError, OSError):
                logger.warning("Ignoring unreadable step manifest at %s", path)
        steps = manifest.setdefault("steps", {})
        steps[step] = {
            "step": step,
            "status": status,
            "updated_at": time.time(),
            "artifacts": artifacts or steps.get(step, {}).get("artifacts", []),
            "warnings": warnings or steps.get(step, {}).get("warnings", []),
            "metadata": metadata or steps.get(step, {}).get("metadata", {}),
        }
        manifest["schema_version"] = 1
        manifest["pipeline_steps"] = PIPELINE_STEPS
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    def load_step_manifest(self) -> dict:
        """Load structured step manifest; returns an empty manifest when absent."""
        path = self.base_dir / STEP_MANIFEST_FILE
        if not path.exists():
            return {"schema_version": 1, "pipeline_steps": PIPELINE_STEPS, "steps": {}}
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise RuntimeError(f"Could not read step manifest at {path}") from exc
        if not isinstance(loaded, dict):
            raise RuntimeError(f"Invalid step manifest at {path}")
        loaded.setdefault("schema_version", 1)
        loaded.setdefault("pipeline_steps", PIPELINE_STEPS)
        loaded.setdefault("steps", {})
        return loaded

    def get_completed_steps(self) -> list[str]:
        """Return list of completed pipeline steps."""
        return self._load_completed_steps()

    def get_resume_step(self) -> str | None:
        """Return the first incomplete step, or None if all done."""
        completed = set(self._load_completed_steps())
        for step in PIPELINE_STEPS:
            if step not in completed:
                return step
        return None

    def is_step_done(self, step: str) -> bool:
        """Check if a specific step is already completed."""
        return step in self._load_completed_steps()

    def clear_checkpoint(self, step: str):
        """Remove a checkpoint to allow re-running a step."""
        completed = self._load_completed_steps()
        if step in completed:
            completed.remove(step)
            self._write_checkpoint(completed)
        self.save_step_manifest(step, status="invalidated")

    def clear_downstream(self, step: str, include_self: bool = False) -> list[str]:
        """Remove checkpoints invalidated by re-running or editing a pipeline step."""
        if step not in PIPELINE_STEPS:
            raise ValueError(f"Unknown pipeline step: {step}")
        targets = ([step] if include_self else []) + DOWNSTREAM_STEPS.get(step, [])
        cleared: list[str] = []
        for target in targets:
            if self.is_step_done(target):
                self.clear_checkpoint(target)
                cleared.append(target)
        return cleared

    def add_warning(
        self,
        stage: str,
        message: str,
        *,
        code: str = "",
        severity: str = "warning",
        context: dict | None = None,
    ) -> None:
        """Append a user-visible pipeline warning to pipeline_warnings.json."""
        if self.skip_disk:
            return
        path = self.base_dir / "pipeline_warnings.json"
        warnings = []
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, list):
                    warnings = loaded
            except (json.JSONDecodeError, OSError):
                warnings = []
        warnings.append({
            "timestamp": time.time(),
            "stage": stage,
            "code": code,
            "severity": severity,
            "message": message,
            "context": context or {},
        })
        path.write_text(json.dumps(warnings, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    def clear_warnings(self, *, stage: str | None = None, code: str | None = None) -> int:
        """Remove matching pipeline warnings and return the number removed."""
        if self.skip_disk:
            return 0
        path = self.base_dir / "pipeline_warnings.json"
        if not path.exists():
            return 0
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return 0
        if not isinstance(loaded, list):
            return 0

        def matches(item: dict) -> bool:
            if not isinstance(item, dict):
                return False
            if stage is not None and item.get("stage") != stage:
                return False
            if code is not None and item.get("code") != code:
                return False
            return stage is not None or code is not None

        kept = [item for item in loaded if not matches(item)]
        removed = len(loaded) - len(kept)
        if removed:
            path.write_text(json.dumps(kept, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        return removed

    def _load_completed_steps(self) -> list[str]:
        cp_path = self.base_dir / ".checkpoint"
        if not cp_path.exists():
            return []
        try:
            loaded = json.loads(cp_path.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                return loaded  # schema 1: a bare list, no topic binding
            if not isinstance(loaded, dict):
                raise json.JSONDecodeError("checkpoint is not a list or object", "", 0)
            recorded = str(loaded.get("topic_fingerprint") or "")
            if recorded and recorded != self.topic_fingerprint():
                raise RuntimeError(
                    f"checkpoint at {cp_path} belongs to a different topic "
                    f"({recorded} != {self.topic_fingerprint()}); refusing to resume"
                )
            completed = loaded.get("completed")
            return list(completed) if isinstance(completed, list) else []
        except (json.JSONDecodeError, OSError) as exc:
            corrupt_path = self.base_dir / f".checkpoint.corrupt.{int(time.time())}"
            try:
                cp_path.replace(corrupt_path)
            except OSError:
                logger.exception("Could not quarantine corrupt checkpoint at %s", cp_path)
            raise RuntimeError(f"Could not read checkpoint at {cp_path}") from exc

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save_json(self, filename: str, data, subdir: str = None):
        """Save data as JSON to the project directory."""
        if self.skip_disk:
            return
        path = self.base_dir / subdir / filename if subdir else self.base_dir / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            if hasattr(data, "model_dump"):
                json.dump(data.model_dump(), f, ensure_ascii=False, indent=2, default=str)
            elif isinstance(data, list):
                serialized = []
                for item in data:
                    if hasattr(item, "model_dump"):
                        serialized.append(item.model_dump())
                    else:
                        serialized.append(item)
                json.dump(serialized, f, ensure_ascii=False, indent=2, default=str)
            else:
                json.dump(data, f, ensure_ascii=False, indent=2, default=str)

    def load_json(self, filename: str, subdir: str = None):
        """Load JSON data from the project directory. Returns None if file doesn't exist."""
        path = self.base_dir / subdir / filename if subdir else self.base_dir / filename
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save_text(self, filename: str, text: str, subdir: str = None):
        """Save text to the project directory."""
        if self.skip_disk:
            return
        path = self.base_dir / subdir / filename if subdir else self.base_dir / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def load_text(self, filename: str, subdir: str = None) -> str | None:
        """Load text from the project directory. Returns None if file doesn't exist."""
        path = self.base_dir / subdir / filename if subdir else self.base_dir / filename
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def get_path(self, filename: str, subdir: str = None) -> Path:
        """Get an absolute path within the project."""
        return self.base_dir / subdir / filename if subdir else self.base_dir / filename


# Reason labels (keys of the PRISMA reasons dicts) meaning a ranking removed
# the record: PRISMA 2020 "records marked as ineligible by automation tools".
# Mirrors record_drops.LABEL_RELEVANCE_CAP / LABEL_SUPPLEMENT_RELEVANCE_CAP;
# files written before 2026-09-29 only ever used the first.
_AUTOMATION_REASON_LABELS = frozenset({
    "relevance cap before screening",
    "supplementary-source relevance cap",
})


def _count_dict(value) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    counts: dict[str, int] = {}
    for key, count in value.items():
        try:
            number = int(count or 0)
        except (TypeError, ValueError):
            continue
        if number > 0:
            counts[str(key)] = number
    return counts


class PRISMAFlow:
    """Track PRISMA 2020 flow diagram counts.

    Identification arithmetic (Page et al., BMJ 2021;372:n71, flow template):
        records_identified - duplicates_removed = records_after_dedup
        records_after_dedup - automation_excluded - records_removed_other
            - records_from_user_upload = title_abstract_screened
    (uploaded full texts that matched no screened record join at full text).
        full_text_sought - not_retrieved = full_text_assessed
    Every record behind these counts is listed in screening/records_removed.json
    (core/record_drops.py).
    """

    def __init__(self):
        self.records_identified = 0
        self.records_after_dedup = 0
        # Records removed after identification and before anyone screened them,
        # on the PRISMA 2020 lines other than duplicates: a ranking (automation
        # tools) and everything else (date filter, source retrieval limit,
        # missing source metadata), each with its reasons. Until 2026-09-29 one
        # counter held both and was also reported as automation_excluded.
        self.automation_excluded = 0
        self.automation_excluded_reasons: dict[str, int] = {}
        self.records_removed_other = 0
        self.records_removed_other_reasons: dict[str, int] = {}
        # Records identified per source, and per database the hits it reported
        # against what was retrieved ({source: {hits, retrieved, not_retrieved}}).
        self.identified_by_source: dict[str, int] = {}
        self.database_hits: dict[str, dict] = {}
        # The relevance-cap rule with its inputs, when the search applied it.
        self.screening_cap: dict = {}
        self.title_abstract_screened = 0
        self.title_abstract_excluded = 0
        self.title_abstract_exclusion_reasons: dict[str, int] = {}
        # Reports sought for retrieval and why some were not retrieved; None
        # until full-text handling ran (older files never recorded them).
        self.full_text_sought: int | None = None
        self.full_text_not_retrieved_reasons: dict[str, int] = {}
        self.full_text_assessed = 0
        self.full_text_excluded = 0
        self.full_text_exclusion_reasons: dict[str, int] = {}
        self.studies_included = 0
        # Source tracking
        self.records_from_database: int = 0
        self.records_from_user_upload: int = 0

    @property
    def records_not_screened(self) -> int:
        """Records removed before screening other than duplicates (automation + other)."""
        return self.automation_excluded + self.records_removed_other

    @property
    def records_not_screened_reasons(self) -> dict[str, int]:
        merged = dict(self.automation_excluded_reasons)
        for reason, count in self.records_removed_other_reasons.items():
            merged[reason] = merged.get(reason, 0) + count
        return merged

    @property
    def full_text_not_retrieved(self) -> int | None:
        if self.full_text_sought is None:
            return None
        return sum(self.full_text_not_retrieved_reasons.values())

    def set_records_not_screened(self, count: int, reason: str) -> None:
        """Add records dropped after deduplication but before screening."""
        count = max(0, int(count))
        if not count:
            return
        if reason in _AUTOMATION_REASON_LABELS:
            self.automation_excluded += count
            self.automation_excluded_reasons[reason] = self.automation_excluded_reasons.get(reason, 0) + count
        else:
            self.records_removed_other += count
            self.records_removed_other_reasons[reason] = self.records_removed_other_reasons.get(reason, 0) + count

    def set_search_counts(
        self,
        *,
        identified_by_source: dict[str, int],
        duplicates_removed: int,
        automation_reasons: dict[str, int],
        other_reasons: dict[str, int],
        database_hits: dict[str, dict] | None = None,
        screening_cap: dict | None = None,
    ) -> None:
        """Replace the identification counts with those of one search run.

        A search starts identification afresh: uploads and full-text counts of
        an earlier run belong to steps the search invalidates.
        """
        self.identified_by_source = {str(k): max(0, int(v or 0)) for k, v in identified_by_source.items()}
        identified = sum(self.identified_by_source.values())
        self.records_identified = identified
        self.records_from_database = identified
        self.records_from_user_upload = 0
        self.records_after_dedup = max(0, identified - max(0, int(duplicates_removed or 0)))
        self.automation_excluded_reasons = _count_dict(automation_reasons)
        self.automation_excluded = sum(self.automation_excluded_reasons.values())
        self.records_removed_other_reasons = _count_dict(other_reasons)
        self.records_removed_other = sum(self.records_removed_other_reasons.values())
        self.database_hits = {str(k): dict(v) for k, v in (database_hits or {}).items()}
        self.screening_cap = dict(screening_cap or {})
        self.full_text_sought = None
        self.full_text_not_retrieved_reasons = {}

    def set_full_text_retrieval(self, *, sought: int, not_retrieved_reasons: dict[str, int]) -> None:
        """Reports sought for retrieval, and the reasons some were not retrieved (replaces)."""
        self.full_text_sought = max(0, int(sought or 0))
        self.full_text_not_retrieved_reasons = _count_dict(not_retrieved_reasons)

    def to_dict(self) -> dict:
        dup_removed = max(0, self.records_identified - self.records_after_dedup)
        identification = {
            "records_identified": self.records_identified,
            "records_after_dedup": self.records_after_dedup,
            "duplicates_removed": dup_removed,
            "records_not_screened": self.records_not_screened,
            "automation_excluded": self.automation_excluded,
            "records_not_screened_reasons": self.records_not_screened_reasons,
            "automation_excluded_reasons": dict(self.automation_excluded_reasons),
            "records_removed_other": self.records_removed_other,
            "records_removed_other_reasons": dict(self.records_removed_other_reasons),
            "records_from_database": self.records_from_database,
            "records_from_user_upload": self.records_from_user_upload,
        }
        if self.identified_by_source:
            identification["identified_by_source"] = dict(self.identified_by_source)
        if self.database_hits:
            identification["database_hits"] = {k: dict(v) for k, v in self.database_hits.items()}
        if self.screening_cap:
            identification["screening_cap"] = dict(self.screening_cap)
        eligibility: dict = {}
        if self.full_text_sought is not None:
            eligibility["full_text_sought"] = self.full_text_sought
            eligibility["not_retrieved"] = self.full_text_not_retrieved
            eligibility["not_retrieved_reasons"] = dict(self.full_text_not_retrieved_reasons)
        eligibility.update({
            "full_text_assessed": self.full_text_assessed,
            "full_text_excluded": self.full_text_excluded,
            "exclusion_reasons": self.full_text_exclusion_reasons,
        })
        return {
            "identification": identification,
            "screening": {
                "title_abstract_screened": self.title_abstract_screened,
                "title_abstract_excluded": self.title_abstract_excluded,
                "exclusion_reasons": self.title_abstract_exclusion_reasons,
            },
            "eligibility": eligibility,
            "included": {
                "studies_included": self.studies_included,
            },
        }

    @classmethod
    def from_dict(cls, data: dict) -> PRISMAFlow:
        """Restore PRISMAFlow from a saved dict (current or pre-2026-09-29 layout)."""
        pf = cls()
        ident = data.get("identification", {}) or {}
        pf.records_identified = ident.get("records_identified", 0)
        pf.records_after_dedup = ident.get("records_after_dedup", 0)
        if "records_removed_other" in ident or "automation_excluded_reasons" in ident:
            pf.automation_excluded = int(ident.get("automation_excluded") or 0)
            pf.automation_excluded_reasons = _count_dict(ident.get("automation_excluded_reasons"))
            pf.records_removed_other = int(ident.get("records_removed_other") or 0)
            pf.records_removed_other_reasons = _count_dict(ident.get("records_removed_other_reasons"))
        else:
            # Older files kept one counter, mirrored into automation_excluded;
            # the only reason ever written was the relevance cap.
            for reason, count in _count_dict(ident.get("records_not_screened_reasons")).items():
                pf.set_records_not_screened(count, reason)
            remainder = int(ident.get("records_not_screened") or 0) - pf.records_not_screened
            if remainder > 0:
                pf.automation_excluded += remainder
        pf.identified_by_source = _count_dict(ident.get("identified_by_source"))
        hits = ident.get("database_hits")
        pf.database_hits = {str(k): dict(v) for k, v in hits.items() if isinstance(v, dict)} if isinstance(hits, dict) else {}
        cap = ident.get("screening_cap")
        pf.screening_cap = dict(cap) if isinstance(cap, dict) else {}
        pf.records_from_database = ident.get("records_from_database", 0)
        pf.records_from_user_upload = ident.get("records_from_user_upload", 0)
        screen = data.get("screening", {}) or {}
        pf.title_abstract_screened = screen.get("title_abstract_screened", 0)
        pf.title_abstract_excluded = screen.get("title_abstract_excluded", 0)
        pf.title_abstract_exclusion_reasons = screen.get("exclusion_reasons", {})
        elig = data.get("eligibility", {}) or {}
        if elig.get("full_text_sought") is not None:
            pf.full_text_sought = int(elig.get("full_text_sought") or 0)
            pf.full_text_not_retrieved_reasons = _count_dict(elig.get("not_retrieved_reasons"))
            not_retrieved = int(elig.get("not_retrieved") or 0)
            unexplained = not_retrieved - sum(pf.full_text_not_retrieved_reasons.values())
            if unexplained > 0:
                pf.full_text_not_retrieved_reasons["not retrieved"] = unexplained
        pf.full_text_assessed = elig.get("full_text_assessed", 0)
        pf.full_text_excluded = elig.get("full_text_excluded", 0)
        pf.full_text_exclusion_reasons = elig.get("exclusion_reasons", {})
        incl = data.get("included", {}) or {}
        pf.studies_included = incl.get("studies_included", 0)
        return pf
