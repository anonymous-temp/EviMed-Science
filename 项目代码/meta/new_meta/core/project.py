"""Project management: directory structure, persistence, PRISMA flow tracking, checkpointing."""
from __future__ import annotations

import json
import logging
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

    def save_checkpoint(self, step: str):
        """Mark a pipeline step as completed."""
        if self.skip_disk:
            return
        cp_path = self.base_dir / ".checkpoint"
        completed = self._load_completed_steps()
        if step not in completed:
            completed.append(step)
        cp_path.write_text(json.dumps(completed), encoding="utf-8")
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
            cp_path = self.base_dir / ".checkpoint"
            cp_path.write_text(json.dumps(completed), encoding="utf-8")
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
            return json.loads(cp_path.read_text(encoding="utf-8"))
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


class PRISMAFlow:
    """Track PRISMA 2020 flow diagram counts."""

    def __init__(self):
        self.records_identified = 0
        self.records_after_dedup = 0
        # Relevance caps and date filters remove records before anyone screens
        # them. PRISMA 2020 keeps that separate from duplicate removal.
        self.records_not_screened = 0
        self.records_not_screened_reasons: dict[str, int] = {}
        self.title_abstract_screened = 0
        self.title_abstract_excluded = 0
        self.title_abstract_exclusion_reasons: dict[str, int] = {}
        self.full_text_assessed = 0
        self.full_text_excluded = 0
        self.full_text_exclusion_reasons: dict[str, int] = {}
        self.studies_included = 0
        # Source tracking
        self.records_from_database: int = 0
        self.records_from_user_upload: int = 0

    def set_records_not_screened(self, count: int, reason: str) -> None:
        """Record records dropped after deduplication but before screening."""
        count = max(0, int(count))
        if not count:
            return
        self.records_not_screened += count
        self.records_not_screened_reasons[reason] = (
            self.records_not_screened_reasons.get(reason, 0) + count
        )

    def to_dict(self) -> dict:
        dup_removed = max(0, self.records_identified - self.records_after_dedup)
        return {
            "identification": {
                "records_identified": self.records_identified,
                "records_after_dedup": self.records_after_dedup,
                "duplicates_removed": dup_removed,
                "records_not_screened": self.records_not_screened,
                "automation_excluded": self.records_not_screened,
                "records_not_screened_reasons": self.records_not_screened_reasons,
                "records_from_database": self.records_from_database,
                "records_from_user_upload": self.records_from_user_upload,
            },
            "screening": {
                "title_abstract_screened": self.title_abstract_screened,
                "title_abstract_excluded": self.title_abstract_excluded,
                "exclusion_reasons": self.title_abstract_exclusion_reasons,
            },
            "eligibility": {
                "full_text_assessed": self.full_text_assessed,
                "full_text_excluded": self.full_text_excluded,
                "exclusion_reasons": self.full_text_exclusion_reasons,
            },
            "included": {
                "studies_included": self.studies_included,
            },
        }

    @classmethod
    def from_dict(cls, data: dict) -> PRISMAFlow:
        """Restore PRISMAFlow from a saved dict."""
        pf = cls()
        ident = data.get("identification", {})
        pf.records_identified = ident.get("records_identified", 0)
        pf.records_after_dedup = ident.get("records_after_dedup", 0)
        pf.records_not_screened = ident.get("records_not_screened", 0)
        pf.records_not_screened_reasons = ident.get("records_not_screened_reasons", {})
        pf.records_from_database = ident.get("records_from_database", 0)
        pf.records_from_user_upload = ident.get("records_from_user_upload", 0)
        screen = data.get("screening", {})
        pf.title_abstract_screened = screen.get("title_abstract_screened", 0)
        pf.title_abstract_excluded = screen.get("title_abstract_excluded", 0)
        pf.title_abstract_exclusion_reasons = screen.get("exclusion_reasons", {})
        elig = data.get("eligibility", {})
        pf.full_text_assessed = elig.get("full_text_assessed", 0)
        pf.full_text_excluded = elig.get("full_text_excluded", 0)
        pf.full_text_exclusion_reasons = elig.get("exclusion_reasons", {})
        incl = data.get("included", {})
        pf.studies_included = incl.get("studies_included", 0)
        return pf
