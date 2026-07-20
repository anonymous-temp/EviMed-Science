"""In-memory job registry for asynchronous analyses.

Jobs are process-local by design (the platform drives one agent instance;
no multi-replica state sharing is required at this stage). Artifacts are
written to ``<project>/jobs/<jobId>/`` and entries live for the process
lifetime — after a restart, unknown job ids get a clean 404.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from safety_agent.analysis.models import AnalysisResult

JobStatus = Literal["queued", "running", "succeeded", "failed"]

#: pipeline stage -> (progress % when the stage starts)
STAGE_PROGRESS: dict[str, int] = {
    "normalize": 5,
    "overview": 15,
    "signals": 45,
    "evidence": 65,
    "interpret": 80,
    "assemble": 90,
    "write": 95,
}

STAGE_LABELS_ZH: dict[str, str] = {
    "normalize": "输入归一化",
    "overview": "FAERS 病例概览",
    "signals": "失比例信号计算",
    "evidence": "说明书对照与证据交叉",
    "interpret": "LLM 解读",
    "assemble": "报告组装",
    "write": "报告导出",
}


@dataclass
class Job:
    id: str
    drug: str
    reactions: list[str]
    language: str
    indication: str | None = None
    status: JobStatus = "queued"
    progress: int = 0
    stage: str = "queued"
    error: str | None = None
    result: AnalysisResult | None = None
    artifacts: dict[str, Path | None] = field(default_factory=dict)
    task: asyncio.Task | None = field(default=None, repr=False)
    exception: Exception | None = field(default=None, repr=False)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def summary(self) -> dict | None:
        """Compact result summary for the status endpoint."""
        if self.result is None:
            return None
        result = self.result
        return {
            "drug": result.drug_normalized,
            "reactions": [r.normalized for r in result.reactions],
            "totalReports": result.overview.total_reports,
            "signalRows": len(result.signals),
            "signalsFound": sum(1 for row in result.signals if row.is_signal),
            "llmStatus": result.llm_status,
            "degradationNotes": result.degradation_notes,
            "artifacts": sorted(
                name for name, path in self.artifacts.items() if path is not None
            ),
            "generatedAt": result.generated_at.isoformat(),
        }


class JobStore:
    """Process-local job registry with a small bounded capacity."""

    def __init__(self, jobs_dir: Path, *, capacity: int = 200) -> None:
        self._jobs: dict[str, Job] = {}
        self._dir = jobs_dir
        self._capacity = capacity

    def create(self, drug: str, reactions: list[str], language: str, indication: str | None) -> Job:
        self._evict_oldest()
        job = Job(
            id=uuid.uuid4().hex[:12],
            drug=drug,
            reactions=reactions,
            language=language,
            indication=indication,
        )
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def job_dir(self, job: Job) -> Path:
        return self._dir / job.id

    def update_stage(self, job: Job, stage: str, status: str) -> None:
        job.stage = stage
        if status in ("started", "degraded"):
            job.progress = max(job.progress, STAGE_PROGRESS.get(stage, job.progress))
        if stage == "interpret" and status == "finished":
            job.progress = max(job.progress, 90)

    def _evict_oldest(self) -> None:
        if len(self._jobs) < self._capacity:
            return
        oldest = min(self._jobs.values(), key=lambda j: j.created_at)
        if oldest.task is not None and not oldest.task.done():
            oldest.task.cancel()
        del self._jobs[oldest.id]
